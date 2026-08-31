import { describe, expect, it } from "vitest";

import {
  admitJob,
  describeSwitch,
  interpretSwitchValue,
  type JobRequest,
  type SwitchLookup,
  type SwitchSource,
} from "../src/kill-switch.ts";
import { loadManifest, type JobConfig } from "../src/manifest.ts";

const base =
  "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n" +
  "brains: [{preset: local}]\n";

const declared = {
  slug: "sweep",
  archetype: "sweep",
  description: "'Whole-repo pass for logic that should live in a shared package.'",
  trigger: '{schedules: ["0 3 * * 0"]}',
  killSwitch: "{failDirection: open}",
  budget: "{wallClockMs: 3600000}",
  run: "{command: node, args: [runner/src/sweep.ts]}",
};

const jobEntry = (over: Record<string, string | undefined> = {}) =>
  `{${Object.entries({ ...declared, ...over })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ")}}`;

/** One declared job, parsed through the real schema so the switch key is the derived one. */
const job = (over: Record<string, string | undefined> = {}): JobConfig =>
  loadManifest(`${base}jobs: [${jobEntry(over)}]\n`).jobs[0];

const answers = (lookup: SwitchLookup): SwitchSource => async () => lookup;

const human: JobRequest = { trigger: "on-request", requestedBy: { kind: "human", id: "npub1x" } };
const agent: JobRequest = { trigger: "on-request", requestedBy: { kind: "agent", id: "bunyan" } };
const tick: JobRequest = { trigger: "schedule" };

describe("switch values", () => {
  it("arms only on a value that says so, in any of the spellings a human writes", () => {
    for (const value of ["on", "ON", " true ", "yes", "1", "enabled", "armed"]) {
      expect(interpretSwitchValue(value)).toEqual({ origin: "set", state: "on" });
    }
  });

  it("parks on anything else, including a typo of `on`", () => {
    // A value nobody can interpret is not intent to run. The direction is deliberate: a
    // typo in the arming direction costs idle time somebody notices, while a typo in the
    // parking direction leaves automation running that somebody was trying to stop.
    for (const value of ["off", "false", "no", "0", "onn", "", "paused until Monday"]) {
      expect(interpretSwitchValue(value)).toEqual({ origin: "set", state: "off" });
    }
  });
});

describe("fail-direction", () => {
  it("turns one unreadable read into opposite outcomes on two jobs", async () => {
    const unreadable = answers({ origin: "unreadable", failure: "timeout" });

    const open = await admitJob(job({ killSwitch: "{failDirection: open}" }), tick, unreadable);
    const closed = await admitJob(
      job({ killSwitch: "{failDirection: closed}" }),
      tick,
      unreadable,
    );

    expect(open.admitted).toBe(true);
    expect(open.switch).toEqual({ state: "on", origin: "unreadable", failure: "timeout" });
    expect(closed.admitted).toBe(false);
    expect(closed.outcome).toBe("denied-switch");
    expect(closed.switch).toEqual({ state: "off", origin: "unreadable", failure: "timeout" });
  });

  it("holds both directions in one manifest under a single unreadable read", async () => {
    // Two jobs, one source, no shared mutable default between them — the failure mode a
    // fail-direction copied into five runners has, and the reason it is declared per job.
    const manifest = loadManifest(
      `${base}jobs: [${jobEntry()}, ${jobEntry({
        slug: "merge",
        archetype: "shift",
        killSwitch: "{failDirection: closed}",
      })}]\n`,
    );
    const unreadable = answers({ origin: "unreadable", failure: "unreachable" });

    const [reporting, merging] = await Promise.all(
      manifest.jobs.map((declared) => admitJob(declared, tick, unreadable)),
    );

    expect(reporting.admitted).toBe(true);
    expect(merging.admitted).toBe(false);
  });

  it("decides an unset key the same way, so a fail-closed job is never armed by absence", async () => {
    const never = answers({ origin: "never-set" });

    expect((await admitJob(job(), tick, never)).admitted).toBe(true);
    expect(
      (await admitJob(job({ killSwitch: "{failDirection: closed}" }), tick, never)).admitted,
    ).toBe(false);
  });
});

describe("what could not be read is never what nobody set", () => {
  it("renders the three origins as three different sentences", () => {
    const rendered = [
      describeSwitch({ state: "off", origin: "set" }),
      describeSwitch({ state: "off", origin: "never-set" }),
      describeSwitch({ state: "off", origin: "unreadable", failure: "auth-failed" }),
    ];
    expect(new Set(rendered).size).toBe(3);
    // The failure class is what sends a human somewhere; the backend's own words never are.
    expect(rendered[2]).toContain("auth-failed");
  });

  it("never hangs a failure off a reading that reached the key", async () => {
    const admission = await admitJob(job(), tick, answers({ origin: "never-set" }));
    expect(admission.switch).toEqual({ state: "on", origin: "never-set" });
    expect(admission.switch?.failure).toBeUndefined();
  });

  it("calls a switch with no backend behind it unreadable, not unset", async () => {
    const missing = await admitJob(job({ killSwitch: "{failDirection: closed}" }), tick, null);
    expect(missing.switch).toEqual({
      state: "off",
      origin: "unreadable",
      failure: "backend-missing",
    });
    expect(missing.admitted).toBe(false);
  });

  it("treats a source that throws as unreadable rather than as an empty key", async () => {
    const throwing: SwitchSource = async () => {
      throw new Error("relay exploded: token=hunter2");
    };
    const admission = await admitJob(
      job({ killSwitch: "{failDirection: closed}" }),
      tick,
      throwing,
    );
    expect(admission.switch).toMatchObject({ origin: "unreadable", failure: "backend-error" });
    expect(admission.reason).not.toContain("hunter2");
  });
});

describe("the switch parks automation, not the job", () => {
  const parked = answers({ origin: "set", state: "off" });
  // The fleet job that declares all three at once, which is where "who started this"
  // stops being obvious.
  const requestable = { trigger: '{schedules: ["0 3 * * 0"], onRequest: true, webhook: true}' };

  it("runs a parked job for a human, and leaves the posture exactly as it found it", async () => {
    const reads: string[] = [];
    const source: SwitchSource = async (key) => {
      reads.push(key);
      return { origin: "set", state: "off" };
    };

    const admission = await admitJob(job(requestable), human, source);

    expect(admission.admitted).toBe(true);
    expect(admission.bypassedSwitch).toBe(true);
    expect(admission.switch).toEqual({ state: "off", origin: "set" });
    expect(admission.reason).toContain("npub1x");
    // Admission reads the switch and does nothing else to it: there is no write path here,
    // so a run cannot arm the job it just bypassed.
    expect(reads).toEqual(["mem/sweep/enabled"]);
  });

  it("refuses the same request from a sibling agent — on-request is a trigger, not authority", async () => {
    const admission = await admitJob(job(requestable), agent, parked);
    expect(admission).toMatchObject({
      admitted: false,
      outcome: "denied-switch",
      bypassedSwitch: false,
    });
  });

  it("refuses a webhook and a clock tick on a parked job, whoever they name", async () => {
    const requests: JobRequest[] = [
      tick,
      { trigger: "webhook" },
      // A webhook payload can carry any author it likes, and a clock carries none. The
      // bypass is for a coworker waiting on the other end of a request, so it takes the
      // host-stamped trigger *and* the author — either alone is forgeable or absent.
      { trigger: "webhook", requestedBy: { kind: "human", id: "npub1x" } },
      { trigger: "schedule", requestedBy: { kind: "human", id: "npub1x" } },
    ];
    for (const request of requests) {
      expect((await admitJob(job(requestable), request, parked)).admitted).toBe(false);
    }
  });

  it("does not let a run nobody can be traced to bypass a park", async () => {
    // A CLI run against a cluster and a CI dispatch both arrive as `system`. Annoying for
    // the operator, and the safe direction until a run outside a chat surface can prove
    // whose it is.
    const admission = await admitJob(
      job(requestable),
      { trigger: "on-request", requestedBy: { kind: "system", id: "ci" } },
      parked,
    );
    expect(admission.admitted).toBe(false);
  });

  it("applies the same rule to the hard switch, which is how a job breaks in", async () => {
    // Whittle's four jobs ship suspended so each can be proven by hand before a clock
    // touches it — the deliberate posture the bypass exists to serve.
    const suspended = job({ ...requestable, suspend: "true" });

    const byHand = await admitJob(suspended, human, answers({ origin: "set", state: "on" }));
    expect(byHand).toMatchObject({ admitted: true, bypassedSwitch: true });
    expect(byHand.reason).toContain("suspend: true");

    const scheduled = await admitJob(suspended, tick, answers({ origin: "set", state: "on" }));
    expect(scheduled).toMatchObject({ admitted: false, outcome: "denied-suspend" });
  });

  it("runs a fail-closed job for a human even when the switch cannot be read", async () => {
    // A human is on the other end and can stop it; a webhook is automation and cannot.
    const closed = job({ ...requestable, killSwitch: "{failDirection: closed}" });
    const unreadable = answers({ origin: "unreadable", failure: "timeout" });

    expect(await admitJob(closed, human, unreadable)).toMatchObject({
      admitted: true,
      bypassedSwitch: true,
    });
    expect((await admitJob(closed, { trigger: "webhook" }, unreadable)).admitted).toBe(false);
  });

  it("marks only the runs that actually bypassed something", async () => {
    const armed = await admitJob(job(requestable), human, answers({ origin: "set", state: "on" }));
    expect(armed).toMatchObject({ admitted: true, bypassedSwitch: false });
    expect(armed.reason).toContain("someone armed it");
  });
});

describe("a job with no switch", () => {
  it("runs without one, and records that it had none to read", async () => {
    // Legal only because nothing unattended can start it — the manifest refuses a
    // schedule or a webhook without a switch.
    const admission = await admitJob(
      job({ trigger: "{onRequest: true}", killSwitch: undefined }),
      human,
      null,
    );
    expect(admission).toMatchObject({ admitted: true, bypassedSwitch: false, switch: null });
    expect(admission.reason).toBe("no kill switch declared");
  });
});
