import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ScheduledTurns,
  nextFire,
  readJobPrompt,
  type ScheduledTurn,
  type ScheduledTurnsOptions,
} from "../src/scheduled-turn.ts";
import { Gateway, type TickOutcome } from "../src/gateway.ts";
import { MockBrain } from "../src/brain.ts";
import type { SurfaceAdapter } from "../src/adapter.ts";
import type { ChannelRef, GuardedMessage, InboundEvent } from "../src/events.ts";
import { isPromptJob, loadManifest, type PromptJob } from "../src/manifest.ts";
import { JOB_ARTIFACT_LIMIT_BYTES } from "../src/job-output.ts";
import type { JobPoster, JobRun } from "../src/job-host.ts";
import type { SwitchLookup, SwitchSource } from "../src/kill-switch.ts";
import { combineVerdicts } from "../src/verdict.ts";
import { jobWorkEvents } from "../src/work-events.ts";

const LA = "America/Los_Angeles";

/** Formatted in the zone under test, because an ISO instant proves nothing about one. */
const wall = (at: Date | undefined, zone: string) =>
  at?.toLocaleString("sv-SE", { timeZone: zone });

describe("nextFire", () => {
  it("answers in the declared zone, not the host's", () => {
    const at = nextFire(["0 18 * * *"], LA, new Date("2026-09-10T13:00:00Z"));
    expect(wall(at, LA)).toBe("2026-09-10 18:00:00");
    expect(at?.toISOString()).toBe("2026-09-11T01:00:00.000Z");
  });

  it("reads the descriptors, the steps, the names, and the ranges", () => {
    const from = new Date("2026-09-10T13:07:00Z"); // a Thursday
    expect(wall(nextFire(["@daily"], "UTC", from), "UTC")).toBe("2026-09-11 00:00:00");
    expect(wall(nextFire(["*/15 * * * *"], "UTC", from), "UTC")).toBe("2026-09-10 13:15:00");
    expect(wall(nextFire(["0 9 * * MON-FRI"], "UTC", from), "UTC")).toBe("2026-09-11 09:00:00");
    expect(wall(nextFire(["0 0 1 JAN *"], "UTC", from), "UTC")).toBe("2027-01-01 00:00:00");
  });

  it("takes the earliest of several schedules", () => {
    const from = new Date("2026-09-10T13:00:00Z");
    expect(wall(nextFire(["0 20 * * *", "0 14 * * *"], "UTC", from), "UTC")).toBe(
      "2026-09-10 14:00:00",
    );
  });

  // Vixie's rule, which Kubernetes' own parser also implements: restrict both day fields
  // and the expression matches when either does. 2026-09-14 is the first Monday after.
  it("matches either day field when both are restricted", () => {
    const from = new Date("2026-09-10T13:00:00Z");
    expect(wall(nextFire(["0 0 1 * 1"], "UTC", from), "UTC")).toBe("2026-09-14 00:00:00");
    expect(wall(nextFire(["0 0 1 * *"], "UTC", from), "UTC")).toBe("2026-10-01 00:00:00");
  });

  it("skips a local time the spring-forward transition deletes", () => {
    // 2027-03-14 in Los Angeles runs 01:59 → 03:00, so 02:30 is not an instant that day.
    // A digest scheduled inside the gap is not moved to 03:30; it runs the next day.
    const at = nextFire(["30 2 * * *"], LA, new Date("2027-03-13T12:00:00Z"));
    expect(wall(at, LA)).toBe("2027-03-15 02:30:00");
  });

  it("fires once in the hour the fall-back transition repeats", () => {
    // 2026-11-01 in Los Angeles runs 01:59 PDT → 01:00 PST, so 01:30 is two real instants.
    // A daily digest must not be posted twice on one evening.
    const first = nextFire(["30 1 * * *"], LA, new Date("2026-11-01T00:00:00Z"));
    expect(first?.toISOString()).toBe("2026-11-01T08:30:00.000Z"); // 01:30 PDT
    const second = nextFire(["30 1 * * *"], LA, first!);
    expect(wall(second, LA)).toBe("2026-11-02 01:30:00");
    expect(second?.toISOString()).not.toBe("2026-11-01T09:30:00.000Z"); // 01:30 PST
  });

  it("answers `never` for an expression that parses and names no day", () => {
    expect(nextFire(["30 2 31 2 *"], "UTC", new Date("2026-09-10T13:00:00Z"))).toBeUndefined();
  });

  it("reaches a leap day, which is the sparsest a real schedule gets", () => {
    // Two years out, so a one-year horizon would report this as never firing — and the
    // ticker arms nothing for a schedule that comes back empty.
    expect(wall(nextFire(["0 0 29 2 *"], "UTC", new Date("2026-03-01T00:00:00Z")), "UTC")).toBe(
      "2028-02-29 00:00:00",
    );
    // And the eight-year gap a non-leap century opens between two of them.
    expect(wall(nextFire(["0 0 29 2 *"], "UTC", new Date("2096-03-01T00:00:00Z")), "UTC")).toBe(
      "2104-02-29 00:00:00",
    );
  });

  it("refuses an expression it cannot parse, rather than never firing", () => {
    expect(() => nextFire(["0 3 * *"], "UTC", new Date())).toThrow(/five cron fields/);
    expect(() => nextFire(["0 3 * * 1-"], "UTC", new Date())).toThrow(/not a value or a range/);
    expect(() => nextFire(["0 9-5 * * *"], "UTC", new Date())).toThrow(/counts backwards/);
  });

  it("takes a decimal field and refuses every other way to write a number", () => {
    // `Number` reads all of these, and the Kubernetes parser refuses all of them — so a
    // `run` job and a `prompt` job carrying one expression would have disagreed.
    const from = new Date("2026-09-10T13:00:00Z");
    expect(wall(nextFire(["0 16 * * *"], "UTC", from), "UTC")).toBe("2026-09-10 16:00:00");
    for (const bad of ["0 0x10 * * *", "0 1e1 * * *", "0 0-0x5 * * *"]) {
      expect(() => nextFire([bad], "UTC", from), bad).toThrow(/not a value or a range/);
    }
  });

  it("takes a three-letter name and refuses anything that merely starts like one", () => {
    // Truncating to three would read `MONSOON` as Monday and schedule an expression nobody
    // meant. Kubernetes' own parser takes the abbreviations and nothing longer, so one
    // expression has to mean the same thing to a `run` job and to a `prompt` job.
    const from = new Date("2026-09-10T13:00:00Z");
    expect(wall(nextFire(["0 0 * * MON"], "UTC", from), "UTC")).toBe("2026-09-14 00:00:00");
    for (const bad of ["0 0 * * MONSOON", "0 0 * * MONDAY", "0 0 1 JUNX *", "0 0 * * MO"]) {
      expect(() => nextFire([bad], "UTC", from), bad).toThrow(/not a value or a range/);
    }
  });
});

const base =
  "name: x\nbrain: {provider: mock}\nrespondTo: anyone\nbrains: [{preset: local}]\n" +
  "killSwitchParkBy: []\n" +
  "surfaces: [{kind: slack, channels: [{id: C01, name: hive, reply: private}]}]\n";

/** One declared prompt job, through the real schema so every default is the real one. */
function promptJob(over: Record<string, string> = {}): PromptJob {
  const declared = {
    slug: "daily-digest",
    archetype: "watch",
    description: "'One short post per day.'",
    trigger: '{schedules: ["0 18 * * *"], timezone: UTC}',
    killSwitch: "{failDirection: closed}",
    prompt: "'Summarize the day.'",
    report: "{surface: slack, channel: C01}",
    ...over,
  };
  const [job] = loadManifest(
    `${base}jobs: [{${Object.entries(declared)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ")}}]\n`,
  ).jobs;
  if (!job || !isPromptJob(job)) throw new Error("this fixture declares no prompt body");
  return job;
}

describe("readJobPrompt", () => {
  let dir: string;
  /** Writes `skills/<name>/SKILL.md`, the one layout the manifest can address. */
  const writeSkill = async (name: string, body: string, frontmatterName = name) => {
    await mkdir(join(dir, "skills", name), { recursive: true });
    await writeFile(
      join(dir, "skills", name, "SKILL.md"),
      `---\nname: ${frontmatterName}\ndescription: One short post per day.\n---\n${body}\n`,
    );
    return join(dir, "skills", name, "SKILL.md");
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "prompt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("takes a one-liner inline, verbatim", () => {
    const prompt = readJobPrompt(promptJob(), dir);
    expect(prompt).toEqual({ source: "inline", bytes: 18, body: "Summarize the day." });
  });

  it("finds a named skill at its standard path and sends only the body", async () => {
    const path = await writeSkill("daily-digest", "Read the channel.");
    const prompt = readJobPrompt(promptJob({ prompt: "{skill: daily-digest}" }), dir);
    expect(prompt.body).toBe("Read the channel.");
    expect(prompt.source).toBe(path);
    expect(prompt.bytes).toBeGreaterThan(prompt.body.length);
  });

  it("refuses a skill whose frontmatter calls it something else", async () => {
    // Two spellings of one name is how a skill is found under one and announces itself as
    // another — and whichever the chat face later reads would be a coin toss.
    await writeSkill("daily-digest", "Read the channel.", "nightly-digest");
    expect(() => readJobPrompt(promptJob({ prompt: "{skill: daily-digest}" }), dir)).toThrow(
      /frontmatter says `name: nightly-digest`/,
    );
  });

  it("refuses a skill that is missing, oversized, or not UTF-8", async () => {
    const job = promptJob({ prompt: "{skill: daily-digest}" });
    expect(() => readJobPrompt(job, dir)).toThrow(/ENOENT|no such file/i);

    const head = "---\nname: daily-digest\ndescription: d\n---\n";
    await mkdir(join(dir, "skills", "daily-digest"), { recursive: true });
    const path = join(dir, "skills", "daily-digest", "SKILL.md");
    await writeFile(path, head + "x".repeat(JOB_ARTIFACT_LIMIT_BYTES));
    expect(() => readJobPrompt(job, dir)).toThrow(/over the \d+-byte limit/);

    // A lone 0x80 continuation byte. `readFileSync(…, "utf8")` would hand back U+FFFD and
    // the agent would post a prompt nobody wrote.
    await writeFile(path, Buffer.concat([Buffer.from(head), Buffer.from([0x80])]));
    expect(() => readJobPrompt(job, dir)).toThrow(/not valid UTF-8/);
  });

  it("refuses a path that is not a regular file, rather than blocking the load on it", async () => {
    // A FIFO would hang `readFileSync` forever, and the load path this runs on is `run`,
    // `doctor` and `validate` — a startup that never returns and never says why.
    const job = promptJob({ prompt: "{skill: daily-digest}" });
    await mkdir(join(dir, "skills", "daily-digest"), { recursive: true });
    const path = join(dir, "skills", "daily-digest", "SKILL.md");
    execFileSync("mkfifo", [path]);
    expect(() => readJobPrompt(job, dir)).toThrow(/not a regular file/);

    await rm(path);
    await mkdir(path);
    expect(() => readJobPrompt(job, dir)).toThrow(/not a regular file|EISDIR/);
  });

  it("refuses a skill linked out of the bundle, including into the runtime's own subtree", async () => {
    // A name cannot traverse, so this is the only way left out — and it is the one a
    // reviewed diff shows as a path and never as the content it will resolve to.
    const job = promptJob({ prompt: "{skill: daily-digest}" });
    await mkdir(join(dir, "skills", "daily-digest"), { recursive: true });

    await writeFile(join(dir, "outside.md"), "---\nname: daily-digest\ndescription: d\n---\nelsewhere\n");
    await symlink(join(dir, "outside.md"), join(dir, "skills", "daily-digest", "SKILL.md"));
    expect(() => readJobPrompt(job, dir)).toThrow(/outside the bundle's skills\/ tree/);

    // `workspace/` holds clones refreshed from their remotes, so a link into one is words
    // whoever can merge to that repository chose. Out by construction now: it is not under
    // `skills/`, so no carve-out per subtree is needed to exclude it.
    await rm(join(dir, "skills", "daily-digest", "SKILL.md"));
    await mkdir(join(dir, "workspace", "repos", "acme"), { recursive: true });
    await writeFile(
      join(dir, "workspace", "repos", "acme", "SKILL.md"),
      "---\nname: daily-digest\ndescription: d\n---\nfrom a clone\n",
    );
    await symlink(
      join(dir, "workspace", "repos", "acme", "SKILL.md"),
      join(dir, "skills", "daily-digest", "SKILL.md"),
    );
    expect(() => readJobPrompt(job, dir)).toThrow(/outside the bundle's skills\/ tree/);
  });

  it("follows a link that stays inside the tree, and an agent directory that is itself one", async () => {
    // Real-path on both sides, so a bundle reached through a symlinked home — which is how
    // a mount usually arrives — is not mistaken for an escape.
    await writeSkill("shared-digest", "inside");
    await mkdir(join(dir, "skills", "daily-digest"), { recursive: true });
    await symlink(
      join(dir, "skills", "shared-digest", "SKILL.md"),
      join(dir, "skills", "daily-digest", "SKILL.md"),
    );
    const linkedHome = join(dir, "home");
    await symlink(dir, linkedHome);

    for (const home of [dir, linkedHome]) {
      // The frontmatter still has to agree with the name it was found under.
      expect(() => readJobPrompt(promptJob({ prompt: "{skill: daily-digest}" }), home), home).toThrow(
        /frontmatter says `name: shared-digest`/,
      );
      expect(readJobPrompt(promptJob({ prompt: "{skill: shared-digest}" }), home).body, home).toBe(
        "inside",
      );
    }
  });

  it("refuses a file that is not shaped like a skill", async () => {
    const job = promptJob({ prompt: "{skill: daily-digest}" });
    await mkdir(join(dir, "skills", "daily-digest"), { recursive: true });
    const path = join(dir, "skills", "daily-digest", "SKILL.md");

    await writeFile(path, "Read the channel.\n");
    expect(() => readJobPrompt(job, dir)).toThrow(/no frontmatter/);

    await writeFile(path, "---\nname: daily-digest\n---\nRead the channel.\n");
    expect(() => readJobPrompt(job, dir)).toThrow(/needs a `name` and a `description`/);

    await writeFile(path, "---\nname: daily-digest\ndescription: d\n---\n");
    expect(() => readJobPrompt(job, dir)).toThrow(/there is no prompt/);
  });
});

type Clock = Pick<Gateway, "tick">;

/** A gateway stand-in: the ticker's one seam, so no brain or turn clock is in the way. */
function fakeGateway(outcome: TickOutcome = { asked: 1, sent: 1 }) {
  const ticks: { event: InboundEvent; to: { surface: string; channel: string }; timeoutMs?: number }[] = [];
  const gateway: Clock = {
    tick: async (event, to, timeoutMs) => {
      ticks.push({ event, to, timeoutMs });
      return outcome;
    },
  };
  return { ticks, gateway };
}

function ticker(
  job: PromptJob,
  opts: Pick<ScheduledTurnsOptions, "switchSource" | "post" | "onStart" | "onRun"> & {
    gateway: Clock;
  },
): ScheduledTurns {
  const turn: ScheduledTurn = {
    job,
    prompt: readJobPrompt(job, "/nowhere"),
    channel: { surface: "slack", id: "C01", isPublic: false, name: "hive" },
  };
  return new ScheduledTurns({ ...opts, turns: [turn], turnTimeoutMs: 120_000 });
}

/** Runs the clock to just past one 18:00 UTC tick and lets the tick settle. */
async function runOneTick(turns: ScheduledTurns): Promise<void> {
  vi.setSystemTime(new Date("2026-09-10T17:59:30Z"));
  turns.start();
  await vi.advanceTimersByTimeAsync(31_000);
  await vi.advanceTimersByTimeAsync(0);
  turns.stop();
}

const armed: SwitchSource = async () => ({ origin: "set", state: "on", value: "arming" });

describe("ScheduledTurns", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the prompt as a tick addressed by the clock, and records the run", async () => {
    const gw = fakeGateway({ asked: 1, sent: 1 });
    const runs: JobRun[] = [];
    const started: { jobSlug: string }[] = [];
    const post = vi.fn<JobPoster>(async () => undefined);
    await runOneTick(
      ticker(promptJob(), {
        gateway: gw.gateway,
        switchSource: armed,
        post,
        onStart: (run) => started.push(run),
        onRun: (run) => runs.push(run),
      }),
    );

    expect(gw.ticks).toHaveLength(1);
    expect(gw.ticks[0]).toMatchObject({
      to: { surface: "slack", channel: "C01" },
      timeoutMs: 120_000,
      event: {
        text: "Summarize the day.",
        mentionsMe: true,
        // The clock, and an id no surface issues: nothing can be addressed to it, nothing
        // answers as it, and the author gate has nobody to weigh.
        author: { id: "schedule:daily-digest", isSelf: false, isAgent: false },
        channel: { surface: "slack", id: "C01" },
      },
    });
    expect(gw.ticks[0]!.event.threadRoot).toBeUndefined();
    expect(started.map((run) => run.jobSlug)).toEqual(["daily-digest"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ jobSlug: "daily-digest", trigger: "schedule", requestedBy: null });
    expect(runs[0]!.verdict.status).toBe("PASS");
    // The sum a reader can check: `JobRun.verdict` is exactly `combineVerdicts(gates)`.
    expect(runs[0]!.verdict).toEqual(combineVerdicts(runs[0]!.gates));
    // A turn that spoke has already said everything the channel needed.
    expect(post).not.toHaveBeenCalled();
  });

  it("posts nothing when the turn chose to say nothing", async () => {
    const runs: JobRun[] = [];
    const post = vi.fn<JobPoster>(async () => undefined);
    await runOneTick(
      ticker(promptJob(), {
        gateway: fakeGateway({ asked: 0, sent: 0 }).gateway,
        switchSource: armed,
        post,
        onRun: (run) => runs.push(run),
      }),
    );
    expect(runs[0]!.verdict.status).toBe("PASS");
    expect(post).not.toHaveBeenCalled();
  });

  it("says so itself when the turn never finished, and stays quiet when it did", async () => {
    for (const [outcome, said] of [
      [{ asked: 0, sent: 0, error: new Error("turn timed out after 120000ms") }, true],
      [{ asked: 2, sent: 0 }, true],
      [{ asked: 1, sent: 1 }, false],
    ] as const) {
      const post = vi.fn<JobPoster>(async () => undefined);
      const runs: JobRun[] = [];
      await runOneTick(
        ticker(promptJob(), {
          gateway: fakeGateway(outcome).gateway,
          switchSource: armed,
          post,
          onRun: (run) => runs.push(run),
        }),
      );
      expect(post.mock.calls.length, JSON.stringify(outcome)).toBe(said ? 1 : 0);
      if (said) expect(post.mock.calls[0]![1]).toContain("job daily-digest");
    }
  });

  it("announces a tick that went fine when the job asked to be heard either way", async () => {
    const post = vi.fn<JobPoster>(async () => undefined);
    await runOneTick(
      ticker(promptJob({ report: "{surface: slack, channel: C01, announce: always}" }), {
        gateway: fakeGateway({ asked: 1, sent: 1 }).gateway,
        switchSource: armed,
        post,
      }),
    );
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["closed", { origin: "unreadable", failure: "unreachable" } as SwitchLookup],
    ["open", { origin: "set", state: "off", value: "parking" } as SwitchLookup],
  ])("skips a tick the switch denies (failDirection %s), and posts nothing", async (direction, lookup) => {
    const gw = fakeGateway();
    const runs: JobRun[] = [];
    const post = vi.fn<JobPoster>(async () => undefined);
    await runOneTick(
      ticker(promptJob({ killSwitch: `{failDirection: ${direction}}` }), {
        gateway: gw.gateway,
        switchSource: async () => lookup,
        post,
        onRun: (run) => runs.push(run),
      }),
    );
    expect(gw.ticks).toHaveLength(0);
    expect(runs[0]!.outcome).toBe("denied-switch");
    // Refusing to start a parked job is the posture somebody chose, not news.
    expect(post).not.toHaveBeenCalled();
  });

  it("records a tick the gateway would not start, and posts nothing for it", async () => {
    const runs: JobRun[] = [];
    const post = vi.fn<JobPoster>(async () => undefined);
    await runOneTick(
      ticker(promptJob(), {
        gateway: { tick: async () => ({ asked: 0, sent: 0, skipped: "limit:perChannelPerMinute" }) },
        switchSource: armed,
        post,
        onRun: (run) => runs.push(run),
      }),
    );
    expect(runs[0]).toMatchObject({ outcome: "skipped-overlap" });
    expect(runs[0]!.reason).toContain("limit:perChannelPerMinute");
    expect(post).not.toHaveBeenCalled();
  });

  it("does not replay the ticks that fell while it was not running", async () => {
    const gw = fakeGateway();
    const turns = ticker(promptJob(), { gateway: gw.gateway, switchSource: armed });
    // Two days after the last fire, which is what a restart after an outage looks like.
    vi.setSystemTime(new Date("2026-09-12T19:00:00Z"));
    turns.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gw.ticks).toHaveLength(0);
    // And then the next one lands on time rather than at once.
    await vi.advanceTimersByTimeAsync(23 * 60 * 60_000);
    expect(gw.ticks).toHaveLength(1);
    turns.stop();
  });

  it("shortens the turn to a declared budget, and never lengthens it", async () => {
    for (const [budget, timeoutMs] of [
      ["{wallClockMs: 30000}", 30_000],
      ["{wallClockMs: 600000}", 120_000],
    ] as const) {
      const gw = fakeGateway();
      await runOneTick(ticker(promptJob({ budget }), { gateway: gw.gateway, switchSource: armed }));
      expect(gw.ticks[0]!.timeoutMs, budget).toBe(timeoutMs);
    }
  });

  it("writes the same work events a process job's tick writes", async () => {
    const lines: Record<string, unknown>[] = [];
    const { onStart, onRun } = jobWorkEvents("demo", { AGENT_WORK_EVENTS: "1" }, (line) =>
      lines.push(JSON.parse(line).sageox_work_event),
    );
    await runOneTick(
      ticker(promptJob(), {
        gateway: fakeGateway({ asked: 1, sent: 1 }).gateway,
        switchSource: armed,
        onStart,
        onRun,
      }),
    );

    expect(lines.map((line) => line.event)).toEqual(["run.started", "run.completed"]);
    expect(lines[1]).toMatchObject({
      schema_version: 1,
      agent: "demo",
      job: "daily-digest",
      trigger: "schedule",
      outcome: "completed",
      verdict: "PASS",
      // The turn is the gate, under the name every other job's host gate carries.
      checks: [{ gate: "job:daily-digest", executed: true, exit_code: 0, source: "host" }],
      partial: false,
    });
  });

  it("refuses a tick that was still being admitted when it was told to stop", async () => {
    const gw = fakeGateway();
    const runs: JobRun[] = [];
    // A switch read that has not answered yet is where a shutdown lands: the timer has
    // fired, so `stop()` has nothing left to clear, and without the check inside `fire` the
    // tick would submit a turn into surfaces that are closing.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turns = ticker(promptJob(), {
      gateway: gw.gateway,
      switchSource: async () => {
        await held;
        return { origin: "set", state: "on", value: "arming" };
      },
      onRun: (run) => runs.push(run),
    });

    vi.setSystemTime(new Date("2026-09-10T17:59:30Z"));
    turns.start();
    await vi.advanceTimersByTimeAsync(31_000);
    turns.stop();
    release();
    await turns.drained();

    expect(gw.ticks).toHaveLength(0);
    expect(runs[0]).toMatchObject({ outcome: "abandoned" });
    expect(runs[0]!.reason).toContain("never started");
  });

  it("waits out a tick that had already reached the gateway", async () => {
    const runs: JobRun[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turns = ticker(promptJob(), {
      gateway: {
        tick: async () => {
          await held;
          return { asked: 1, sent: 1 };
        },
      },
      switchSource: armed,
      onRun: (run) => runs.push(run),
    });

    vi.setSystemTime(new Date("2026-09-10T17:59:30Z"));
    turns.start();
    await vi.advanceTimersByTimeAsync(31_000);
    turns.stop();

    let settled = false;
    const drained = turns.drained().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // the turn is still going, so the record is still owed
    release();
    await drained;
    expect(runs[0]).toMatchObject({ outcome: "completed" });
  });

  it("arms nothing after it is stopped", async () => {
    const gw = fakeGateway();
    const turns = ticker(promptJob(), { gateway: gw.gateway, switchSource: armed });
    vi.setSystemTime(new Date("2026-09-10T17:59:30Z"));
    turns.start();
    turns.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60_000);
    expect(gw.ticks).toHaveLength(0);
  });
});
/**
 * The whole path, with nothing stubbed between the clock and the surface: the ticker fires,
 * the gateway runs the turn, and the answer leaves as a top-level post through the guard.
 */
describe("a scheduled turn end to end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts what the brain wrote into the channel the job reports to", async () => {
    const posts: { channel: ChannelRef; msg: GuardedMessage }[] = [];
    const adapter: SurfaceAdapter = {
      kind: "slack",
      start: async () => {},
      // A tick has no inbound event to thread onto, so the reply path is the wrong one.
      send: async () => {
        throw new Error("a scheduled turn must not reply through the inbound path");
      },
      postTargets: () => [{ surface: "slack", id: "C01", isPublic: false, name: "hive" }],
      post: async (channel, msg) => {
        posts.push({ channel, msg });
        return { surface: "slack", nativeId: "p1" };
      },
      stop: async () => {},
    };
    const job = promptJob();
    const manifest = loadManifest(
      `${base}jobs: [{slug: daily-digest, archetype: watch, description: 'One post.', ` +
        `trigger: {schedules: ["0 18 * * *"], timezone: UTC}, killSwitch: {failDirection: closed}, ` +
        `prompt: 'Summarize the day.', report: {surface: slack, channel: hive}}]\n`,
    );
    const gateway = new Gateway({ manifest, adapters: [adapter], brain: new MockBrain() });
    await gateway.start();

    const runs: JobRun[] = [];
    const turns = new ScheduledTurns({
      turns: [
        {
          job,
          prompt: readJobPrompt(job, "/nowhere"),
          // Declared by name in `report` above and resolved to its id here, which is what
          // the tick is queued on.
          channel: { surface: "slack", id: "C01", isPublic: false, name: "hive" },
        },
      ],
      gateway,
      turnTimeoutMs: manifest.limits.turnTimeoutMs,
      switchSource: armed,
      onRun: (run) => runs.push(run),
    });

    vi.setSystemTime(new Date("2026-09-10T17:59:30Z"));
    turns.start();
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.advanceTimersByTimeAsync(0);
    turns.stop();

    expect(posts).toHaveLength(1);
    expect(posts[0]!.msg.text).toBe("echo: Summarize the day.");
    expect(posts[0]!.channel.id).toBe("C01");
    expect(runs[0]).toMatchObject({ outcome: "completed", trigger: "schedule" });
    expect(runs[0]!.verdict.status).toBe("PASS");
  });
});
