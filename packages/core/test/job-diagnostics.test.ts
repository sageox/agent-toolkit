import { afterEach, expect, it, vi } from "vitest";
import { diagnosticOutput, DIAGNOSTIC_LIMIT_BYTES, type WorkerDiagnostics } from "../src/job-diagnostics.ts";
import { JobHost } from "../src/job-host.ts";
import { JobSchema } from "../src/manifest.ts";
import { jobDefinition, type ExternalRequest } from "../src/external-jobs.ts";

afterEach(() => vi.restoreAllMocks());

it("redacts split credentials, literal regex characters, and partial terminal writes before forwarding", () => {
  const secret = "key.with+$[literal]";
  const forwarded: string[] = [];
  const output = diagnosticOutput([secret], (text) => forwarded.push(text));
  output.write("trace: " + secret.slice(0, 7));
  expect(output.snapshot().text).toBe("trace: [REDACTED]");
  output.write(secret.slice(7) + "\nnext: " + secret.slice(0, 10));
  output.end();
  expect(output.snapshot().text).toBe("trace: [REDACTED]\nnext: [REDACTED]");
  expect(forwarded.join("")).toBe(output.snapshot().text);
});

it("redacts before keeping a bounded UTF-8 tail, with no credential fragments at the cut", () => {
  const secret = "private-credential-".repeat(1000);
  const forwarded: string[] = [];
  const output = diagnosticOutput([secret], (text) => forwarded.push(text));
  output.write("old\n".repeat(10000) + secret + "\n");
  output.write("🦊".repeat(10000) + "\n" + secret + "\nfinal line\n");
  output.end();
  const snapshot = output.snapshot();
  expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(DIAGNOSTIC_LIMIT_BYTES);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.text).toContain("[REDACTED]\nfinal line\n");
  expect(snapshot.text).not.toContain("credential");
  expect(snapshot.text).not.toContain("\ufffd");
  expect(forwarded.join("")).not.toContain(secret);
});

it("preserves Unicode when the credential buffer cuts through a surrogate pair", () => {
  const forwarded: Buffer[] = [];
  const output = diagnosticOutput(["ab"], (text) => forwarded.push(Buffer.from(text)));
  output.write("🦊");
  expect(output.snapshot().text).toBe("🦊");
  output.write("🔎");
  output.end();
  expect(output.snapshot().text).toBe("🦊🔎");
  expect(Buffer.concat(forwarded).toString("utf8")).toBe("🦊🔎");
});

it.each(["timeout", "missing-executable"])("captures %s diagnostics automatically without an artifact", async (failure) => {
  // This host's output is already redacted; silence synthetic diagnostics in this test.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const job = JobSchema.parse({ slug: "task", archetype: "queue", description: "test", trigger: { onRequest: true },
    worker: { image: `example/worker@sha256:${"a".repeat(64)}`, directory: "/tmp" },
    budget: { wallClockMs: 250, deadlineHeadroomMs: 100 },
    run: failure === "timeout" ? { command: process.execPath, args: ["-e", 'console.error("waiting for upstream"); setInterval(() => {}, 1000)'] }
      : { command: "/no-such-worker-runtime" },
  });
  const req: ExternalRequest = { runId: "a".repeat(40), jobSlug: job.slug, definition: jobDefinition(job), trigger: "on-request",
    requestedBy: { kind: "human", id: "owner" }, startedAt: Date.now(), parameters: {}, switch: null, bypassedSwitch: false };
  const snapshots: WorkerDiagnostics[] = [];
  const run = await new JobHost({ onDiagnostics: (snapshot) => snapshots.push(snapshot) }).executeWorker(job, req);
  expect(run.verdict.status).toBe("UNKNOWN");
  const final = snapshots.at(-1)!;
  expect(final.complete).toBe(true);
  expect(final.execution.state).toBe(failure === "timeout" ? "timed-out" : "not-started");
  expect(final.stderr.text).toContain(failure === "timeout" ? "waiting for upstream" : "ENOENT");
});

it("checkpoints a running script's output before termination, masking a partially written credential", async () => {
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const job = JobSchema.parse({ slug: "task", archetype: "queue", description: "test", trigger: { onRequest: true },
    worker: { image: `example/worker@sha256:${"a".repeat(64)}`, directory: "/tmp" },
    budget: { wallClockMs: 1500, deadlineHeadroomMs: 100 },
    run: { command: process.execPath, args: ["-e", 'process.stderr.write("connecting: " + process.env.TOKEN.slice(0, 10)); setInterval(() => {}, 1000)'], secrets: { TOKEN: "TASK_TOKEN" } },
  });
  const req: ExternalRequest = { runId: "c".repeat(40), jobSlug: job.slug, definition: jobDefinition(job), trigger: "on-request",
    requestedBy: { kind: "human", id: "owner" }, startedAt: Date.now(), parameters: {}, switch: null, bypassedSwitch: false };
  const snapshots: WorkerDiagnostics[] = [];
  await new JobHost({ onDiagnostics: (snapshot) => snapshots.push(snapshot), secretOpts: { env: { TASK_TOKEN: "private-credential-value" } } }).executeWorker(job, req);
  const checkpoint = snapshots.find((snapshot) => !snapshot.complete && snapshot.stderr.text.includes("connecting"));
  expect(checkpoint?.stderr.text).toBe("connecting: [REDACTED]");
  expect(snapshots.at(-1)!.sequence).toBeGreaterThan(checkpoint!.sequence);
  expect(snapshots.at(-1)!.complete).toBe(true);
});
