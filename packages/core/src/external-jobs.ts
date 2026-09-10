import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { JobRun } from "./job-host.ts";
import { verdictFromGate } from "./verdict.ts";
import { ExecutionInfoSchema } from "./job-diagnostics.ts";
import { FinalJobOutputSchema, JobOutputStatusSchema, JOB_STATUS_LIMIT_BYTES, type FinalJobOutput } from "./job-output.ts";

export const RunIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const ExternalRequestSchema = z.object({
  jobSlug: z.string().regex(/^[a-z][a-z0-9-]*$/),
  runId: RunIdSchema,
  definition: z.string().regex(/^[a-f0-9]{64}$/),
  trigger: z.enum(["schedule", "on-request", "webhook"]),
  requestedBy: z.object({ kind: z.enum(["human", "agent", "system"]), id: z.string().max(1024) }).strict().nullable(),
  startedAt: z.number().int().positive(),
  parameters: z.record(z.string(), z.union([z.string().max(1024), z.number().int()])),
  switch: z.object({
    state: z.enum(["on", "off"]),
    origin: z.enum(["set", "never-set", "unreadable"]),
    // Optional so a gateway that predates the classification still dispatches, and its
    // absence reaches the work event as `unavailable`, never as deliberate parking. That
    // is the only compatible direction: this object is strict, so a dispatcher older than
    // its gateway rejects every request carrying `value`.
    value: z.enum(["arming", "parking", "unrecognized"]).optional(),
    failure: z.enum(["no-signing-key", "no-owner", "backend-missing", "timeout", "unreachable", "auth-failed", "backend-error"]).optional(),
  }).strict().nullable(),
  bypassedSwitch: z.boolean(),
  /** Gateway-derived audience fingerprint, never a model argument. Absent for operator-only output. */
  outputReader: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ExternalRequest = z.infer<typeof ExternalRequestSchema>;

// Only host-minted facts enter model-facing results. The gateway retrieves a separate
// bounded failure report for guarded chat delivery, never for a tool response.
export const WorkerResultSchema = z.object({
  outcome: z.enum(["completed", "budget-bowout", "crashed"]),
  counts: z.object({ PASS: z.number().int().nonnegative(), FAIL: z.number().int().nonnegative(), UNKNOWN: z.number().int().nonnegative() }).strict(),
  execution: ExecutionInfoSchema.optional(),
}).strict();
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export const ExternalStatusSchema = z.object({
  runId: RunIdSchema,
  jobSlug: z.string(),
  startedAt: z.number().int().positive(),
  state: z.enum(["pending", "dispatching", "running", "cancelling", "finished"]),
  outcome: z.enum(["completed", "budget-bowout", "crashed", "cancelled", "unknown", "skipped-overlap"]).optional(),
  result: WorkerResultSchema.optional(),
  endedAt: z.number().optional(),
  execution: ExecutionInfoSchema.optional(),
  diagnostics: z.object({ ref: z.string().regex(/^run-[a-f0-9]{40}$/), complete: z.boolean() }).strict().optional(),
  output: JobOutputStatusSchema.optional(),
}).strict();
export type ExternalStatus = z.infer<typeof ExternalStatusSchema>;
export const FailureReportSchema = z.string().max(2000);

export function jobDefinition(job: unknown): string {
  // Parsing a normalized manifest can reorder nested keys (notably killSwitch.key).
  // Object order must not change the identity of an otherwise identical definition.
  const canonical = JSON.stringify(job, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
  return createHash("sha256").update(canonical).digest("hex");
}

export function workerResult(run: JobRun): WorkerResult {
  const counts = { PASS: 0, FAIL: 0, UNKNOWN: 0 };
  for (const gate of run.gates) counts[gate.status]++;
  return WorkerResultSchema.parse({ outcome: run.outcome, counts, execution: run.execution });
}

export function externalRun(request: Omit<ExternalRequest, "definition">, status: ExternalStatus): JobRun {
  if (status.state !== "finished") throw new Error("external run is not finished");
  const counts = status.result?.counts;
  const verdict = verdictFromGate({
    gate: "worker", executed: true,
    exitCode: counts?.FAIL ? 1 : !counts || counts.UNKNOWN || !counts.PASS ? null : 0,
  });
  const execution = status.result?.execution ?? status.execution;
  const diagnosis = !execution ? ""
    : execution.state === "exited" ? `; process exited with code ${execution.exitCode}`
    : execution.state === "not-started" ? "; process could not start"
    : execution.state === "timed-out" ? "; process exceeded its time budget"
    : execution.state === "signalled" || execution.state === "interrupted" ? `; process interrupted (signal ${execution.signal ?? "unknown"})` : "";
  const reason = status.outcome === "cancelled"
    ? "worker cancellation completed; external side effects are not rolled back"
    : `external worker ${status.outcome ?? "unknown"}${diagnosis}`;
  return {
    ...request,
    startedAt: status.startedAt,
    endedAt: status.endedAt ?? Date.now(),
    outcome: status.outcome ?? "unknown",
    gates: [verdict],
    verdict,
    execution,
    reason: reason + (counts ? `; ${counts.PASS} worker gates PASS; ${counts.FAIL} FAIL; ${counts.UNKNOWN} UNKNOWN` : "") +
      `; run id ${request.runId}; operator diagnostics ${status.diagnostics?.ref ?? "unavailable"}`,
  };
}

/** A gateway capability, never installed as an MCP server or passed to the brain. */
export class ExternalJobs {
  constructor(private url: string, private token: string) {}

  private async call<T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.url), {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
        redirect: "error",
      });
    } catch {
      signal?.throwIfAborted();
      throw new Error("job dispatcher unavailable; execution state is unknown, retrieve the run ID before retrying");
    }
    if (!response.ok) throw new Error(`job dispatcher refused (${response.status}); no local execution fallback`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = response.body?.getReader();
      if (!reader) throw new Error("missing dispatcher response body");
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > JOB_STATUS_LIMIT_BYTES) throw new Error("job dispatcher returned an oversized result");
        chunks.push(value);
      }
      return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    } catch {
      signal?.throwIfAborted();
      throw new Error("job dispatcher returned an invalid, incomplete or oversized result");
    } finally { await reader?.cancel().catch(() => {}); }
  }

  dispatch(request: ExternalRequest): Promise<ExternalStatus> {
    return this.call("/runs", ExternalStatusSchema, ExternalRequestSchema.parse(request));
  }

  /** Retrieve execution facts; application data requires an explicit trusted reader. */
  status(jobSlug: string, runId: string, signal?: AbortSignal, outputReader?: string): Promise<ExternalStatus> {
    const reader = outputReader === undefined ? "" : `&outputReader=${encodeURIComponent(outputReader)}`;
    return this.call(`/runs/${RunIdSchema.parse(runId)}?job=${encodeURIComponent(jobSlug)}${reader}`, ExternalStatusSchema, undefined, signal);
  }

  cancel(jobSlug: string, runId: string): Promise<ExternalStatus> {
    return this.call(`/runs/${RunIdSchema.parse(runId)}/cancel`, ExternalStatusSchema, { jobSlug });
  }

  /** Gateway reporting only. Do not expose this text through jobs MCP or JobRun. */
  failureReport(jobSlug: string, runId: string): Promise<string> {
    return this.call(`/runs/${RunIdSchema.parse(runId)}/failure-report?job=${encodeURIComponent(jobSlug)}`, FailureReportSchema);
  }

  async wait(request: ExternalRequest, signal?: AbortSignal): Promise<JobRun> {
    for (;;) {
      const status = await this.status(request.jobSlug, request.runId, signal);
      if (status.state === "finished") return externalRun(request, status);
      await delay(1000, undefined, { signal });
    }
  }
}

/**
 * Retry only delivery of the same sealed answer, never the claim or job body.
 * False means no acknowledgement: a timed-out request may still persist. Keep attempts
 * short because Kubernetes may terminate this worker at its existing job deadline.
 */
export async function publishJobOutput(url: string, token: string, runId: string, output: FinalJobOutput): Promise<boolean> {
  const body = JSON.stringify(FinalJobOutputSchema.parse(output));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(new URL(`/runs/${RunIdSchema.parse(runId)}/output`, url), {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body, signal: AbortSignal.timeout(2000), redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok) return true;
      if (response.status < 500) return false;
    } catch { /* The same publication is safe after an ambiguous response. */ }
  }
  return false;
}
