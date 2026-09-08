import { describe, expect, it } from "vitest";
import { jobWorkEvents, MAX_WORK_EVENT_BYTES, workEventLine, WorkReportSchema } from "../src/work-events.ts";
import { verdictFromGate } from "../src/verdict.ts";
import type { JobRun } from "../src/job-host.ts";

const run: JobRun = {
  jobSlug: "shift", runId: "opaque-upstream-run", trigger: "schedule", requestedBy: { kind: "human", id: "secret-requester" },
  startedAt: 1000, endedAt: 2000, outcome: "completed", switch: null, bypassedSwitch: false,
  parameters: { private: "secret-param" }, reason: "secret-reason", gates: [],
  verdict: verdictFromGate({ gate: "ci", executed: true, exitCode: 0 }),
  checks: [{ gate: "ci", executed: true, exitCode: 0 }],
  work: { artifacts: [{ subject: { provider: "github", scope: "example/repo", kind: "pull_request", id: "42" }, action: "created" }] },
};

describe("work events", () => {
  it("requires opt-in and drops free text while preserving facts", () => {
    expect(jobWorkEvents("worker", {})).toEqual({});
    const lines: string[] = [];
    const opts = jobWorkEvents("worker", { AGENT_WORK_EVENTS: "1" }, (line) => lines.push(line));
    opts.onStart!({ ...run, admittedAt: 1000, deadlineMs: 6000 });
    opts.onRun!(run);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).not.toContain("secret");
    const event = JSON.parse(lines[1]!).sageox_work_event;
    expect(event.artifacts[0].subject.id).toBe("42");
    expect(event.checks).toEqual([{ gate: "ci", executed: true, exit_code: 0, source: "host" }]);
    expect(event.verdict).toBe("PASS");
    expect(event.partial).toBe(false);
  });

  it("rejects untyped fields and impossible counts", () => {
    for (const value of [ { summary: "secret" }, { artifacts: [{ ...run.work!.artifacts![0], repository: "../repo" }] }, { usage: { model_calls: -1 } },
      { artifacts: [{ ...run.work!.artifacts![0], title: "secret" }] },
      { health: [{ coworker: "worker", pod: "fine", chat: "RUNNING", lanes: [] }] } ]) {
      expect(WorkReportSchema.safeParse(value).success).toBe(false);
    }
  });

  it("counts UTF-8 bytes including wrapper and newline at the exact boundary", () => {
    const base = { run_id: "id", event: "run.completed", artifacts: ["🚀"] };
    const overhead = Buffer.byteLength(workEventLine(base));
    const exact = { ...base, artifacts: ["🚀" + "a".repeat(MAX_WORK_EVENT_BYTES - overhead)] };
    expect(Buffer.byteLength(workEventLine(exact))).toBe(MAX_WORK_EVENT_BYTES);
    const overflow = JSON.parse(workEventLine({ ...exact, artifacts: [exact.artifacts[0] + "a"] })).sageox_work_event;
    expect(overflow).toEqual({ run_id: "id", event: "run.completed", partial: true });
  });

  it("marks omitted unsafe check names and report overflow as partial", () => {
    const lines: string[] = [];
    const opts = jobWorkEvents("worker", { AGENT_WORK_EVENTS: "1" }, (line) => lines.push(line));
    opts.onRun!({ ...run, checks: [{ gate: "a secret sentence", executed: true, exitCode: 0 }] });
    expect(JSON.parse(lines[0]!).sageox_work_event.partial).toBe(true);
    expect(lines[0]).not.toContain("secret");
    opts.onRun!({ ...run, work: { partial: true } });
    expect(JSON.parse(lines[1]!).sageox_work_event.partial).toBe(true);
  });
});

it("preserves zero versus absent usage and rejects free text in every work field", () => {
  expect(WorkReportSchema.parse({ usage: { scanned: 0, cost_usd: 0 } })).toEqual({ usage: { scanned: 0, cost_usd: 0 } });
  expect(WorkReportSchema.parse({})).not.toHaveProperty("usage");
  for (const usage of [{ scanned: 0.5 }, { input_tokens: Infinity }, { outputs: Number.MAX_SAFE_INTEGER + 1 }, { cost_usd: -1 }]) {
    expect(WorkReportSchema.safeParse({ usage }).success).toBe(false);
  }
  expect(WorkReportSchema.safeParse({ work_observations: [{ subject: { provider: "github", kind: "issue", id: "53", scope: "sageox/agent-toolkit" }, state: "unknown" }] }).success).toBe(true);
});

it("contains output failures and keeps identity/outcome when optional facts overflow", () => {
  const opts = jobWorkEvents("Agent with a display name", { AGENT_WORK_EVENTS: "1" }, () => { throw new Error("sink offline"); });
  expect(() => opts.onRun!(run)).not.toThrow();
  const event = { schema_version: 1, agent: "worker", run_id: "opaque-id", event: "run.completed", outcome: "completed", verdict: "FAIL",
    health: Array.from({ length: 100 }, () => ({ subject: "🚀".repeat(100) })) };
  const line = workEventLine(event);
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_WORK_EVENT_BYTES);
  expect(JSON.parse(line).sageox_work_event).toMatchObject({ run_id: "opaque-id", event: "run.completed", outcome: "completed", verdict: "FAIL", partial: true });
  expect(event.health).toHaveLength(100);
});

it("contains asynchronous sink failures", async () => {
  let calls = 0;
  const opts = jobWorkEvents("worker", { AGENT_WORK_EVENTS: "1" }, async () => {
    calls++;
    throw new Error("sink unavailable");
  });
  opts.onRun!(run);
  await new Promise((resolve) => setImmediate(resolve));
  expect(calls).toBe(1);
});

it.each(["id", "scope"])("rejects URI delimiters in subject %s values", (field) => {
  const artifact = run.work!.artifacts![0]!;
  for (const value of ["https://example.com/private-token", "mailto:private-token", "urn:private-token",
    "file:/tmp/private-token", "FILE:/tmp/private-token", "issue:42"]) {
    expect(WorkReportSchema.safeParse({ artifacts: [{ ...artifact,
      subject: { ...artifact.subject, [field]: value },
    }] }).success, value).toBe(false);
  }
  for (const value of ["42", "issue-42", "example/repo", "a_b.c"]) {
    expect(WorkReportSchema.safeParse({ artifacts: [{ ...artifact,
      subject: { ...artifact.subject, [field]: value },
    }] }).success, value).toBe(true);
  }
});
