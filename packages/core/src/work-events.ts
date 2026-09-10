import { z } from "zod";
import type { JobHostOptions, JobRun } from "./job-host.ts";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,255}$/);
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const subject = z.object({
  provider: slug,
  kind: z.enum(["issue", "pull_request", "document", "artifact", "agent", "service", "job"]),
  id: identifier,
  scope: identifier.optional(),
}).strict();
const facts = {
  observed_at: z.iso.datetime({ offset: true }).optional(),
  related_to: subject.optional(),
  next_actor: slug.optional(),
};

// Identifiers and measured facts only: never titles, prose, URLs, or diagnostics.
// These are producer reports, not independently confirmed external outcomes.
export const WorkReportSchema = z.object({
  artifacts: z.array(z.object({
    subject, ...facts,
    action: z.enum(["created", "updated", "commented", "completed"]),
  }).strict()).max(100).optional(),
  work_observations: z.array(z.object({
    subject, ...facts,
    state: z.enum(["open", "in_progress", "waiting", "blocked", "completed", "closed", "unknown"]),
  }).strict()).max(100).optional(),
  usage: z.object({
    model_calls: count.optional(),
    input_tokens: count.optional(),
    output_tokens: count.optional(),
    cost_usd: z.number().nonnegative().optional(),
    scanned: count.optional(),
    candidates: count.optional(),
    recommendations: count.optional(),
    findings: count.optional(),
    outputs: count.optional(),
  }).strict().optional(),
  health: z.array(z.object({
    subject,
    check: slug,
    status: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
    observed_at: z.iso.datetime({ offset: true }),
  }).strict()).max(100).optional(),
  partial: z.boolean().optional(),
}).strict();
export type WorkReport = z.infer<typeof WorkReportSchema>;

// Preserve the strict gates-only transport, including historical free-form details.
// Only the host mints verdicts; a producer-supplied `status` invalidates the file.
export const VerdictArtifactSchema = WorkReportSchema.extend({
  // Validated and delivered independently; application answers never enter work events.
  output: z.unknown().optional(),
  gates: z.array(z.object({
    gate: z.string().min(1),
    executed: z.boolean(),
    exitCode: z.number().int().nullable(),
    detail: z.string().optional(),
  }).strict()),
}).strict();
export type WorkCheck = { gate: string; executed: boolean; exitCode: number | null };
export type WorkStart = Pick<JobRun, "jobSlug" | "runId" | "trigger" | "startedAt"> & {
  admittedAt: number;
  deadlineMs: number;
};

/**
 * Why the host let this run start, or did not. Host-minted, from the reading `admitJob`
 * took — never from the verdict file. `WorkReportSchema` is strict and rejects this key,
 * and {@link jobWorkEvents} spreads the report ahead of this so that a report which ever
 * did carry one would still lose to the host's.
 *
 * `switch: null` means this record carries no reading: the job declares no kill switch, or
 * — on a `denied-trigger` or `skipped-overlap` outcome — the run was refused before one was
 * read. `value: "unavailable"` means a value was retrieved by a source that predates the
 * classification, which is not the same as, and must never be counted as, `parking`.
 *
 * None of it is derived from `outcome`: a run denied by `suspend` still reports the switch
 * it read, because lifting `suspend` takes a reviewed manifest diff and clearing the switch
 * takes a key write — an operator meeting a denial has to know which one is holding it.
 */
function admission(run: JobRun): Record<string, unknown> {
  return {
    bypassed_switch: run.bypassedSwitch,
    switch: run.switch && {
      state: run.switch.state,
      origin: run.switch.origin,
      ...(run.switch.origin === "set" ? { value: run.switch.value ?? "unavailable" } : {}),
      ...(run.switch.failure ? { failure: run.switch.failure } : {}),
    },
  };
}

// Includes the reserved wrapper and newline, below common container log buffers.
export const MAX_WORK_EVENT_BYTES = 8 * 1024;
export { JOB_ARTIFACT_LIMIT_BYTES as MAX_WORK_REPORT_BYTES } from "./job-output.ts";

/** Bound a JSONL record by dropping optional facts while preserving lifecycle identity. */
export function workEventLine(event: Record<string, unknown>): string {
  const bounded = { ...event };
  const encode = () => JSON.stringify({ sageox_work_event: bounded }) + "\n";
  let line = encode();
  // Omit whole optional items, never truncate JSON or lose lifecycle identity/outcome.
  for (const field of ["health", "work_observations", "artifacts", "checks", "usage"]) {
    if (Buffer.byteLength(line) <= MAX_WORK_EVENT_BYTES) break;
    bounded.partial = true;
    const value = bounded[field];
    if (Array.isArray(value)) {
      const remaining = [...value];
      bounded[field] = remaining;
      do {
        remaining.pop();
        if (!remaining.length) delete bounded[field];
        line = encode();
      } while (remaining.length && Buffer.byteLength(line) > MAX_WORK_EVENT_BYTES);
    } else {
      delete bounded[field];
      line = encode();
    }
  }
  if (Buffer.byteLength(line) > MAX_WORK_EVENT_BYTES) throw new Error("work event identity exceeds byte limit");
  return line;
}

const resumeAfterOutputError = () => { process.stdout.emit("drain"); };

/** Output errors (including asynchronous EPIPE) are observation loss, never job failure. */
function writeWorkLine(line: string): boolean {
  try {
    if (process.stdout.destroyed || !process.stdout.writable) return true;
    if (!process.stdout.listeners("error").includes(resumeAfterOutputError)) {
      process.stdout.on("error", resumeAfterOutputError);
    }
    return process.stdout.write(line);
  } catch { return true; }
}

/** The stream is decoded as UTF-8 before calling this. Never parse diagnostic text. */
export function writeJobDiagnostic(stream: "stdout" | "stderr" | "host", text: string): boolean {
  let ready = true;
  // 1,024 code units fit even at JSON's 6x escape expansion. Do not split a code point.
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 1024);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    ready = writeWorkLine(JSON.stringify({ job_diagnostic: { stream, text: text.slice(offset, end) } }) + "\n") && ready;
    offset = end;
  }
  return ready;
}

/** Both CLI hosts bind this; logging is independent of any downstream reader. */
export function jobWorkEvents(
  agent: string,
  env: NodeJS.ProcessEnv = process.env,
  write: (line: string) => void = writeWorkLine,
): Pick<JobHostOptions, "onStart" | "onRun" | "workEvents"> {
  if (env.AGENT_WORK_EVENTS !== "1") return {};
  const emit = (event: Record<string, unknown>) => {
    try { Promise.resolve(write(workEventLine(event))).catch(() => {}); } catch { /* Best-effort observation only. */ }
  };
  const identity = (run: WorkStart | JobRun) => ({
    schema_version: 1, agent, job: run.jobSlug, run_id: run.runId,
    trigger: run.trigger, started_at: new Date(run.startedAt).toISOString(),
    ...(run.deadlineMs === undefined ? {} : { deadline_ms: run.deadlineMs }),
  });
  return {
    workEvents: true,
    onStart: (run) => emit({ ...identity(run), event: "run.started",
      occurred_at: new Date(run.admittedAt).toISOString() }),
    onRun: (run) => {
      const report = WorkReportSchema.safeParse(run.work ?? {});
      // Gate names are identifiers; historical free-text names are omitted, not copied.
      const checks = (run.checks ?? []).map(({ gate, executed, exitCode }, index) => ({
        gate, executed, exit_code: exitCode, source: index === 0 ? "host" : "producer",
      })).filter((c) => /^[a-zA-Z0-9_.:-]{1,128}$/.test(c.gate));
      emit({ ...identity(run), event: "run.completed", occurred_at: new Date(run.endedAt).toISOString(),
        outcome: run.outcome, verdict: run.verdict.status, checks,
        execution: run.execution,
        report_status: run.reportStatus,
        ...(report.success ? report.data : {}),
        // After the report, so a producer key that ever became valid still loses to the host.
        admission: admission(run),
        partial: !report.success || report.data.partial === true ||
          (run.reportStatus !== undefined && run.reportStatus !== "valid") ||
          run.checks === undefined || checks.length !== run.checks.length,
      });
    },
  };
}
