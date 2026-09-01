import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JobHost,
  describeJobRun,
  jobDeadlineMs,
  jobStatus,
  type JobPoster,
  type JobRun,
} from "../src/job-host.ts";
import type { EventRef } from "../src/events.ts";
import type { SwitchLookup, SwitchSource } from "../src/kill-switch.ts";
import { loadManifest, type JobAnnounce, type JobConfig } from "../src/manifest.ts";
import { combineVerdicts, describeVerdict } from "../src/verdict.ts";

const base =
  "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n" +
  "brains: [{preset: local}]\n";

const declared = {
  slug: "sweep",
  archetype: "sweep",
  description: "'Whole-repo pass for logic that should live in a shared package.'",
  trigger: '{schedules: ["0 3 * * 0"], onRequest: true, webhook: true}',
  killSwitch: "{failDirection: open}",
  budget: "{wallClockMs: 3600000}",
  run: "{command: node, args: [runner/src/sweep.ts]}",
};

/** One declared job, through the real schema so the bounds and the switch key are derived. */
const job = (over: Record<string, string | undefined> = {}): JobConfig =>
  loadManifest(
    `${base}jobs: [{${Object.entries({ ...declared, ...over })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join(", ")}}]\n`,
  ).jobs[0];

/**
 * A real job body: a node process this host knows nothing about beyond its argv, its exit
 * code, and the file it writes. Every test below drives the envelope through one.
 */
const body = (script: string, over: Record<string, string | undefined> = {}): JobConfig => {
  const declared = job(over);
  return {
    ...declared,
    run: {
      ...declared.run,
      command: process.execPath,
      args: ["-e", `const fs=require("fs");${script}`],
      // `MARKER` is ambient on the host's base env, so every body below has to name it.
      passthrough: [...declared.run.passthrough, "MARKER"],
    },
  };
};

const WRITE = 'fs.writeFileSync(process.env.JOB_VERDICT_PATH,';
const MARK = 'fs.appendFileSync(process.env.MARKER,"x");';

/** Reports one gate it actually ran, and exits 0. */
const PROVES = `${MARK}${WRITE}JSON.stringify({gates:[{gate:"ci",executed:true,exitCode:0}]}))`;
/** Runs, exits 0, and says nothing about what it proved. */
const SILENT = MARK;

const answers = (lookup: SwitchLookup): SwitchSource => async () => lookup;

let workDir: string;
let secretsDir: string;
let marker: string;
let runs: JobRun[];
const host = (source?: SwitchSource, post?: JobPoster) =>
  new JobHost({
    workDir,
    switchSource: source,
    post,
    // What the gateway's own process carries. `resolveSecret` falls back to the environment,
    // so on an env-mounted deployment a surface credential really does sit here —
    // `GATEWAY_SECRET` stands in for one.
    env: { ...process.env, MARKER: marker, GATEWAY_SECRET: "nsec1thegatewaysown" },
    secretOpts: { dir: secretsDir },
    onRun: (run) => runs.push(run),
  });

/** How many times a body actually started. The count no outcome word can fake. */
const spawns = () => (existsSync(marker) ? readFileSync(marker, "utf8").length : 0);

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "job-host-"));
  secretsDir = join(workDir, "secrets");
  await mkdir(secretsDir);
  marker = join(workDir, "spawns");
  runs = [];
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("exit semantics", () => {
  it("distinguishes a job that proved something from one that only exited 0", async () => {
    const proved = await host().tick(body(PROVES));
    expect(proved.outcome).toBe("completed");
    expect(proved.verdict.status).toBe("PASS");

    const silent = await host().tick(body(SILENT));
    expect(silent.outcome).toBe("completed");
    // Ran, exited 0, reported nothing — which has proven nothing.
    expect(silent.verdict.status).toBe("UNKNOWN");
  });

  it("does not read an empty gate list as a clean run", async () => {
    const run = await host().tick(body(`${WRITE}JSON.stringify({gates:[]}))`));
    expect(run.outcome).toBe("completed");
    expect(run.verdict.status).toBe("UNKNOWN");
  });

  it("refuses a body that tries to compose its own verdict instead of reporting a gate", async () => {
    const run = await host().tick(
      body(`${WRITE}JSON.stringify({gates:[{gate:"ci",executed:true,exitCode:0,status:"PASS"}]}))`),
    );
    expect(run.verdict.status).toBe("UNKNOWN");
  });

  it("reads an unparseable artifact as unproven rather than as an error", async () => {
    const run = await host().tick(body(`${WRITE}"{not json")`));
    expect(run.outcome).toBe("completed");
    expect(run.verdict.status).toBe("UNKNOWN");
  });

  it("never lets a body that exited non-zero report success", async () => {
    const run = await host().tick(body(`${PROVES};process.exit(1)`));
    expect(run.outcome).toBe("completed"); // the envelope worked; the work did not
    expect(run.verdict.status).toBe("FAIL");
  });

  it("records a body that could not be started as crashed, and does not throw", async () => {
    const declared = job();
    const missing: JobConfig = {
      ...declared,
      run: { ...declared.run, command: "no-such-job-body", args: [] },
    };
    const run = await host().tick(missing);

    expect(run.outcome).toBe("crashed");
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(spawns()).toBe(0);
  });

  it("keeps `verdict` exactly the sum of `gates`, so a reader can check it", async () => {
    const run = await host().tick(body(PROVES));
    expect(run.gates).toHaveLength(2); // the host's process gate, then the body's
    expect(combineVerdicts(run.gates).status).toBe(run.verdict.status);
  });
});

describe("single-flight", () => {
  const SLOW = `${MARK}setTimeout(()=>{},300)`;

  it("drops an overlapping tick loudly — a record, and no second body", async () => {
    const h = host();
    const slow = body(SLOW);
    const first = h.tick(slow);
    const second = await h.tick(slow);

    expect(second.outcome).toBe("skipped-overlap");
    expect(second.verdict.status).toBe("UNKNOWN");
    expect(second.reason).toMatch(/still in flight/);
    await first;
    expect(spawns()).toBe(1);
  });

  it("releases the slug when the run ends, so the next tick is not dropped forever", async () => {
    const h = host();
    await h.tick(body(PROVES));
    expect((await h.tick(body(PROVES))).outcome).toBe("completed");
    expect(spawns()).toBe(2);
  });

  it("holds one job per slug, not one job at a time", async () => {
    const h = host();
    const [a, b] = await Promise.all([
      h.tick(body(SLOW)),
      h.tick(body(SLOW, { slug: "shift", archetype: "shift" })),
    ]);
    expect([a.outcome, b.outcome]).toEqual(["completed", "completed"]);
    expect(spawns()).toBe(2);
  });
});

describe("bounding", () => {
  // Small enough to finish a test run, and the same two numbers the platform deadline is
  // derived from.
  const bounded = { budget: "{wallClockMs: 150, deadlineHeadroomMs: 400}" };

  it("derives the platform deadline from the budget, and never sets it twice", () => {
    expect(jobDeadlineMs(job(bounded))).toBe(550);
  });

  it("stops a body that outlives its wall clock, and proves nothing for it", async () => {
    const run = await host().tick(body(`${MARK}setTimeout(()=>{},30000)`, bounded));

    expect(run.outcome).toBe("budget-bowout");
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(run.endedAt - run.startedAt).toBeLessThan(jobDeadlineMs(job(bounded)) + 2000);
  });

  it("asks first and kills second, so the body gets its headroom to finish writing", async () => {
    const cleanup = join(workDir, "cleanup");
    const run = await host().tick(
      body(
        `${MARK}process.on("SIGTERM",()=>{fs.writeFileSync(${JSON.stringify(cleanup)},"released");` +
          `process.exit(0)});setTimeout(()=>{},30000)`,
        bounded,
      ),
    );

    expect(readFileSync(cleanup, "utf8")).toBe("released");
    // It cleaned up, and it still ran out of budget: a stopped run proves nothing whatever
    // it managed to say on the way out.
    expect(run.outcome).toBe("budget-bowout");
    expect(run.verdict.status).toBe("UNKNOWN");
  });

  it("stops what the body left behind when the body exits under its budget", async () => {
    // The guarded case is the body that runs long. This is the one that does not: it
    // finishes early having left a harness up, so both timers are cleared and the run is
    // recorded `completed` while that harness is still running — unbounded, rather than
    // merely past the deadline.
    const survivor = join(workDir, "survivor-after-exit");
    const run = await host().tick(
      body(
        `${MARK}require("child_process").spawn(process.execPath,["-e",` +
          `'setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(survivor)},"alive"),700)'],` +
          // `unref` is what makes this the case under test: the body stops waiting on what
          // it launched and exits, which is how a harness outlives the job that ran it.
          `{stdio:"ignore"}).unref();setTimeout(()=>process.exit(0),100)`,
      ),
    );
    await new Promise((r) => setTimeout(r, 1100));

    expect(run.outcome).toBe("completed"); // the body was fine; what it left behind was not
    expect(existsSync(survivor)).toBe(false);
  });

  it("stops what the body started, not just the body", async () => {
    // Every real job body shells out. A budget that signalled only the body would leave
    // the harness it launched running, still spending and still able to act.
    const survivor = join(workDir, "survivor");
    const run = await host().tick(
      body(
        `${MARK}require("child_process").spawn(process.execPath,["-e",` +
          `'setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(survivor)},"alive"),900)'],` +
          `{stdio:"ignore"});setTimeout(()=>{},30000)`,
        bounded,
      ),
    );
    await new Promise((r) => setTimeout(r, 1200));

    expect(run.outcome).toBe("budget-bowout");
    expect(existsSync(survivor)).toBe(false);
  });

  it("still ends a body that ignores the ask, at the deadline the headroom buys", async () => {
    const run = await host().tick(
      body(`${MARK}process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`, bounded),
    );

    expect(run.outcome).toBe("budget-bowout");
    expect(run.endedAt - run.startedAt).toBeGreaterThanOrEqual(150);
  });

  it("hands the body the bounds it cannot enforce for it, rather than dropping them", async () => {
    const envelope = join(workDir, "envelope");
    const run = await host().tick(
      body(
        `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));${PROVES}`,
        { budget: "{wallClockMs: 5000, maxSpendUsd: 5}", model: "claude-sonnet-5" },
      ),
    );
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;

    expect(seen.JOB_SLUG).toBe("sweep");
    expect(seen.JOB_RUN_ID).toBe(run.runId);
    expect(seen.JOB_TRIGGER).toBe("schedule");
    expect(seen.JOB_VERDICT_PATH).toContain(run.runId);
    // A clock the host holds it to, and the three counters plus the tier it cannot: the
    // runtime can time a job without knowing what it does, but it cannot count an
    // iteration or a dollar.
    expect(Number(seen.JOB_DEADLINE_AT)).toBeGreaterThanOrEqual(run.startedAt);
    expect(seen.JOB_HARNESS_TIMEOUT_MS).toBe("600000");
    expect(seen.JOB_MAX_ITERATIONS).toBe("2");
    expect(seen.JOB_MAX_ATTEMPTS).toBe("3");
    expect(seen.JOB_MAX_SPEND_USD).toBe("5");
    expect(seen.JOB_MODEL).toBe("claude-sonnet-5");
  });

  it("hands a body the allowlist and what it declared, never the gateway's environment", async () => {
    const envelope = join(workDir, "envelope");
    await writeFile(join(secretsDir, "GH_TOKEN"), "github_pat_the_job_was_granted\n");
    const declared = body(
      `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));${PROVES}`,
    );
    await host().tick({
      ...declared,
      run: {
        ...declared.run,
        env: { LOG_FORMAT: "json" },
        secrets: { GITHUB_TOKEN: "GH_TOKEN" },
        passthrough: [...declared.run.passthrough, "AWS_ROLE_ARN"],
      },
    });
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;

    // Asserted, not assumed: the base env above carried this and the body cannot see it.
    expect(seen.GATEWAY_SECRET).toBeUndefined();
    expect(seen.PATH).toBe(process.env.PATH); // it is still a process that has to run
    expect(seen.LOG_FORMAT).toBe("json");
    expect(seen.GITHUB_TOKEN).toBe("github_pat_the_job_was_granted");
  });

  it("resolves a jobSecrets ref out of the directory only this process was given", async () => {
    const envelope = join(workDir, "envelope");
    const jobSecretsDir = join(workDir, "job-secrets");
    await mkdir(jobSecretsDir);
    await writeFile(join(secretsDir, "GH_TOKEN"), "github_pat_the_agents_own");
    await writeFile(join(jobSecretsDir, "GH_APP_PEM"), "-----BEGIN PRIVATE KEY-----\n");
    // No `onRequest`: the manifest refuses that beside `jobSecrets`.
    const declared = body(
      `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));${PROVES}`,
      { trigger: '{schedules: ["0 3 * * 0"]}' },
    );
    await new JobHost({
      workDir,
      env: { ...process.env, MARKER: marker },
      secretOpts: { dir: [jobSecretsDir, secretsDir] },
    }).tick({
      ...declared,
      run: {
        ...declared.run,
        secrets: { GITHUB_TOKEN: "GH_TOKEN" },
        jobSecrets: { GH_APP_PEM: "GH_APP_PEM" },
      },
    });
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;

    // Both, in one envelope: splitting a credential out never costs a job the agent's own,
    // which is what its status post is signed with and its switch read with.
    expect(seen.GITHUB_TOKEN).toBe("github_pat_the_agents_own");
    expect(seen.GH_APP_PEM).toBe("-----BEGIN PRIVATE KEY-----");
  });

  it("names an unresolvable jobSecrets ref exactly as it names an unresolvable secret", async () => {
    const declared = body(PROVES, { trigger: '{schedules: ["0 3 * * 0"]}' });
    const run = await host().tick({
      ...declared,
      run: { ...declared.run, jobSecrets: { GH_APP_PEM: "NEVER_MOUNTED" } },
    });

    expect(run.outcome).toBe("crashed");
    expect(run.reason).toContain("NEVER_MOUNTED");
    expect(spawns()).toBe(0);
  });

  it("cannot see an ambient variable it did not declare — cloud identity included", async () => {
    const envelope = join(workDir, "envelope");
    // This body writes no `MARKER`: the case below declares nothing but `AWS_ROLE_ARN`, and
    // a body reaching for an undeclared variable would crash rather than report it.
    const read = `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));`;
    const seen = async (job: JobConfig) => {
      await host().tick(job);
      return JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;
    };
    const declared = body(read);
    const irsa = { ...declared, run: { ...declared.run, passthrough: ["AWS_ROLE_ARN"] } };

    process.env.AWS_ROLE_ARN = "arn:aws:iam::1:role/agent";
    try {
      expect((await seen(declared)).AWS_ROLE_ARN).toBeUndefined();
      // `passthrough` is what keeps the scrub from breaking IRSA: the value is injected at
      // admission, so no literal `env:` map in a bundle could have carried it.
      expect((await seen(irsa)).AWS_ROLE_ARN).toBe("arn:aws:iam::1:role/agent");
      // And it grants the one name, not the rest of the base env alongside it.
      expect((await seen(irsa)).MARKER).toBeUndefined();
    } finally {
      delete process.env.AWS_ROLE_ARN;
    }
  });

  it("hands a body the target it was given, and nothing when it was given none", async () => {
    const envelope = join(workDir, "envelope");
    const read = `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));`;
    const declared = body(`${read}${PROVES}`, {
      trigger: "{onRequest: true}",
      parameters: "{issue: {type: integer, minimum: 1, required: true, description: 'Which issue.'}}",
    });

    const run = await host().request(declared, { kind: "system", id: "cli" }, { issue: 41 });
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;
    expect(seen.JOB_PARAM_ISSUE).toBe("41");
    // On the record too: a slug does not say which one a run acted on.
    expect(run.parameters).toEqual({ issue: 41 });

    // A job that declares none is handed none, and its record says so.
    const plain = await host().tick(body(`${read}${PROVES}`));
    const after = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;
    expect(Object.keys(after).filter((name) => name.startsWith("JOB_PARAM_"))).toEqual([]);
    expect(plain.parameters).toEqual({});
  });

  it("keeps the target the caller's, not the bundle's", async () => {
    const envelope = join(workDir, "envelope");
    const read = `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));`;
    const declared = body(`${read}${PROVES}`, {
      trigger: "{onRequest: true}",
      parameters: "{issue: {type: integer, required: true, description: 'Which issue.'}}",
    });
    await host().request(
      { ...declared, run: { ...declared.run, env: { ...declared.run.env, JOB_PARAM_ISSUE: "1" } } },
      { kind: "system", id: "cli" },
      { issue: 41 },
    );
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;
    // A body that could set its own target through `run.env` would be choosing what the
    // person who asked was supposed to choose.
    expect(seen.JOB_PARAM_ISSUE).toBe("41");
  });

  it("records a run when a value does not match what the job declared, on any door", async () => {
    const declared = body(PROVES, {
      trigger: "{onRequest: true}",
      parameters: "{issue: {type: integer, minimum: 1, required: true, description: 'Which issue.'}}",
    });
    // Past the tool, which refuses first — this is the CLI's door, and the bound has to
    // hold on it too or it is a bound only one caller obeys.
    const run = await host().request(declared, { kind: "system", id: "cli" }, { issue: 0 });

    expect(run.outcome).toBe("crashed");
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(run.reason).toContain('parameter "issue" must be >= 1');
    expect(spawns()).toBe(0);
  });

  it("lets a secret win over config of the same name, never the other way round", async () => {
    const envelope = join(workDir, "envelope");
    await writeFile(join(secretsDir, "GH_TOKEN"), "github_pat_the_real_one");
    const declared = body(
      `fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));${PROVES}`,
    );
    await host().tick({
      ...declared,
      run: {
        ...declared.run,
        env: { GITHUB_TOKEN: "placeholder", JOB_SLUG: "not-this" },
        secrets: { GITHUB_TOKEN: "GH_TOKEN" },
      },
    });
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;

    // Otherwise a placeholder left in a bundle silently downgrades a working credential.
    expect(seen.GITHUB_TOKEN).toBe("github_pat_the_real_one");
    // The envelope outranks both: a body that could redefine where its verdict goes could
    // point this host at a file it wrote in advance.
    expect(seen.JOB_SLUG).toBe("sweep");
  });

  it("records a run when a declared secret does not resolve, rather than throwing on a timer", async () => {
    const declared = body(PROVES);
    const run = await host().tick({
      ...declared,
      run: { ...declared.run, secrets: { GITHUB_TOKEN: "NEVER_MOUNTED" } },
    });

    // The tick path, not a startup path — nothing here is waiting on an exit code, so an
    // unhandled rejection would be the whole of what anyone saw.
    expect(run.outcome).toBe("crashed");
    expect(run.verdict.status).toBe("UNKNOWN"); // never a pass, and never a silent skip
    expect(run.reason).toContain("NEVER_MOUNTED"); // named, so an operator can mount it
    expect(spawns()).toBe(0);
  });

  it("leaves an undeclared bound unset rather than inventing a default for the body", async () => {
    const envelope = join(workDir, "envelope");
    await host().tick(
      body(`fs.writeFileSync(${JSON.stringify(envelope)},JSON.stringify(process.env));${PROVES}`),
    );
    const seen = JSON.parse(readFileSync(envelope, "utf8")) as Record<string, string>;

    expect(seen.JOB_MAX_SPEND_USD).toBeUndefined();
    expect(seen.JOB_MODEL).toBeUndefined();
  });
});

describe("declared triggers", () => {
  const onRequestOnly = { trigger: "{onRequest: true}", killSwitch: undefined };
  const scheduleOnly = { trigger: '{schedules: ["0 3 * * 0"]}' };

  it("refuses a door the job never declared, through every entry point", async () => {
    const h = host();
    const cases = [
      [await h.tick(body(PROVES, onRequestOnly)), "schedule"],
      [await h.request(body(PROVES, scheduleOnly), { kind: "human", id: "npub1x" }), "on-request"],
      [await h.webhook(body(PROVES, scheduleOnly)), "webhook"],
    ] as const;

    for (const [run, trigger] of cases) {
      expect(run.outcome).toBe("denied-trigger");
      expect(run.verdict.status).toBe("UNKNOWN");
      expect(run.reason).toContain(`does not arm the ${trigger} trigger`);
    }
    expect(spawns()).toBe(0);
  });

  it("closes the hole where an on-request job could be run as unattended work", async () => {
    // `loadManifest` refuses a job that takes a schedule without a kill switch. This job
    // arms only `onRequest`, so it legally has none — and running it on a schedule anyway
    // would be exactly the unattended-and-unstoppable shape the manifest makes unwritable.
    const job = body(PROVES, onRequestOnly);
    expect(job.killSwitch).toBeUndefined();

    expect((await host().tick(job)).outcome).toBe("denied-trigger");
    expect((await host().request(job, { kind: "human", id: "npub1x" })).outcome).toBe("completed");
    expect(spawns()).toBe(1);
  });

  it("still runs every door the job did declare", async () => {
    const h = host();
    expect((await h.tick(body(PROVES))).outcome).toBe("completed");
    expect((await h.webhook(body(PROVES))).outcome).toBe("completed");
    expect((await h.request(body(PROVES), { kind: "human", id: "npub1x" })).outcome).toBe(
      "completed",
    );
  });
});

describe("provenance", () => {
  it("stamps the trigger from the entry point that was called, never from the job", async () => {
    const h = host();
    expect((await h.tick(body(PROVES))).trigger).toBe("schedule");
    expect((await h.webhook(body(PROVES))).trigger).toBe("webhook");

    const asked = await h.request(body(PROVES), { kind: "human", id: "npub1x" });
    expect(asked.trigger).toBe("on-request");
    expect(asked.requestedBy).toEqual({ kind: "human", id: "npub1x" });
  });

  it("tells the body which trigger started it, so it cannot claim a different one", async () => {
    const echo = `${WRITE}JSON.stringify({gates:[{gate:process.env.JOB_TRIGGER,executed:true,exitCode:0}]}))`;
    const run = await host().webhook(body(echo));
    expect(run.gates[1].gate).toBe("webhook");
  });
});

describe("admission", () => {
  const parked = answers({ origin: "set", state: "off" });

  it("writes a record for a denied run, and starts nothing", async () => {
    const run = await host(parked).tick(body(PROVES));

    expect(run.outcome).toBe("denied-switch");
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(run.switch).toEqual({ state: "off", origin: "set" });
    expect(spawns()).toBe(0);
  });

  it("names `suspend` as the denial when the hard switch is the one that is down", async () => {
    const run = await host().tick(body(PROVES, { suspend: "true" }));
    expect(run.outcome).toBe("denied-suspend");
    expect(spawns()).toBe(0);
  });

  it("runs a parked job for the human who asked, and records that it did", async () => {
    const run = await host(parked).request(body(PROVES), { kind: "human", id: "npub1x" });

    expect(run.outcome).toBe("completed");
    expect(run.bypassedSwitch).toBe(true);
    expect(run.switch).toEqual({ state: "off", origin: "set" });
    expect(spawns()).toBe(1);
  });

  it("does not let a sibling agent's request bypass a parked job", async () => {
    const run = await host(parked).request(body(PROVES), { kind: "agent", id: "bunyan" });
    expect(run.outcome).toBe("denied-switch");
    expect(run.bypassedSwitch).toBe(false);
    expect(spawns()).toBe(0);
  });

  it("reports every run to `onRun`, including the ones that never started", async () => {
    const h = host(parked);
    await h.tick(body(PROVES));
    await h.request(body(PROVES), { kind: "human", id: "npub1x" });

    expect(runs.map((r) => r.outcome)).toEqual(["denied-switch", "completed"]);
    expect(new Set(runs.map((r) => r.runId)).size).toBe(2);
  });
});

describe("the status post", () => {
  const REPORTS = { report: "{surface: console, channel: hive}" };
  /** Exits 0, having run one gate and been unable to run another. */
  const MIXED =
    `${MARK}${WRITE}JSON.stringify({gates:[{gate:"unit",executed:true,exitCode:0},` +
    `{gate:"jscpd",executed:false,exitCode:null}]}))`;

  /** A surface that answers with an id, which is what makes the second line thread. */
  const named = (n: number): EventRef => ({ surface: "c", nativeId: `e${n}` });
  const feed = (
    id: (n: number) => EventRef | undefined = named,
    announce: JobAnnounce = "unproven",
  ) => {
    const posts: Array<{ text: string; threadRoot?: EventRef; mentions?: readonly string[] }> = [];
    const post: JobPoster = async (report, text, threadRoot, mentions) => {
      // Recorded before it is checked. `announce()` catches whatever a line throws and
      // charges it to that line, so an expectation that fails in here is swallowed — and a
      // test whose whole assertion is that `posts` stayed empty would then pass because the
      // check broke rather than because nothing was posted.
      posts.push({ text, threadRoot, mentions });
      // Whole-object, so a field added to the destination has to be accounted for here
      // rather than reaching every poster unnoticed.
      expect(report).toEqual({ surface: "console", channel: "hive", announce, probe: false });
      return id(posts.length);
    };
    return { posts, post };
  };

  it("addresses nobody, headline and detail alike", async () => {
    const { posts, post } = feed();
    await host(undefined, post).tick(body(MIXED, REPORTS));

    // A status line is a report, not a page. Only a probing body's own `post_message` may
    // name recipients, and it reaches this poster by a different call than this one.
    expect(posts).not.toHaveLength(0);
    expect(posts.every((line) => line.mentions === undefined)).toBe(true);
  });

  it("puts one line at top level and threads every gate beneath it", async () => {
    const { posts, post } = feed();
    const run = await host(undefined, post).tick(body(MIXED, REPORTS));

    expect(run.outcome).toBe("completed");
    // The headline is scannable on its own: what ran, what came of it, and how much of it
    // went unproven. Nothing about the count is hidden behind the click.
    expect(posts[0].text).toContain("job sweep completed");
    expect(posts[0].text).toContain("1 of 3 gates did not pass");
    expect(posts[0].text).toContain("NOT PROVEN");
    expect(posts[0].threadRoot).toBeUndefined();

    // Every gate, threaded onto the headline itself rather than onto the line before it.
    expect(posts.slice(1).map((p) => p.threadRoot)).toEqual([
      { surface: "c", nativeId: "e1" },
      { surface: "c", nativeId: "e1" },
      { surface: "c", nativeId: "e1" },
    ]);
    expect(posts.slice(1).map((p) => p.text)).toEqual(run.gates.map(describeVerdict));
  });

  it("threads the body's own sentence, and keeps the headline the host's", async () => {
    // A linked reference is the shape these lines are written in, and it has to survive
    // the whole trip — JSON artifact, schema, verdict, post — with nothing rewritten.
    const said = "could not file [#537](https://example.test/i/537), the API said 403";
    const { posts, post } = feed();
    const run = await host(undefined, post).tick(
      body(
        `${MARK}${WRITE}JSON.stringify({gates:[{gate:"triage",executed:true,exitCode:1,` +
          `detail:${JSON.stringify(said)}}]}))`,
        REPORTS,
      ),
    );

    expect(run.verdict.status).toBe("FAIL");
    expect(posts.slice(1).map((p) => p.text)).toEqual([
      "PROVEN: job:sweep passed (gate job:sweep exited 0).",
      `FAILED: ${said}`,
    ]);
    // The headline is minted from the combined verdict, which carries no body's words.
    expect(posts[0].text).not.toContain(said);
    expect(posts[0].text).toContain("FAILED: combined did not pass");
  });

  it("says nothing for a run that proved itself, and records it all the same", async () => {
    const { posts, post } = feed();
    const run = await host(undefined, post).tick(body(PROVES, REPORTS));

    expect(run.verdict.status).toBe("PASS");
    expect(posts).toEqual([]);
    // Silence is allowed for findings and never for the record.
    expect(runs).toHaveLength(1);
  });

  it("posts a run that proved itself when the job declares it announces always", async () => {
    // The job this exists for: one whose successes are the thing worth saying. Without the
    // declaration its only way to be heard is a non-zero exit, which heads every line it
    // posts `FAILED` — the words say a fix landed and the status word says it did not.
    const said = "fixed the flaky login test, draft up at [#41](https://example.test/i/41).";
    const { posts, post } = feed(named, "always");
    const run = await host(undefined, post).tick(
      body(
        `${MARK}${WRITE}JSON.stringify({gates:[{gate:"shift",executed:true,exitCode:0,` +
          `detail:${JSON.stringify(said)}}]}))`,
        { report: "{surface: console, channel: hive, announce: always}" },
      ),
    );

    expect(run.verdict.status).toBe("PASS");
    // A success reads as one, in the body's own words, with the host's own status word in
    // front of them.
    expect(posts[0].text).toContain("PROVEN: combined passed");
    expect(posts[0].text).not.toContain("FAILED");
    expect(posts.slice(1).map((p) => p.text)).toEqual([
      "PROVEN: job:sweep passed (gate job:sweep exited 0).",
      `PROVEN: ${said}`,
    ]);
    // Declaring it moves what speaks, never what the run is called: the headline is still
    // minted from the combined verdict and still carries none of the body's words.
    expect(posts[0].text).not.toContain(said);
  });

  it("stays silent on a proven run when the job declares nothing, as it always has", async () => {
    // The same body as above, one field lighter. `unproven` is the default and is today's
    // behaviour exactly — a job that declares nothing cannot be made noisier by this field
    // existing.
    const { posts, post } = feed();
    const run = await host(undefined, post).tick(
      body(
        `${MARK}${WRITE}JSON.stringify({gates:[{gate:"shift",executed:true,exitCode:0,` +
          `detail:"a landed fix"}]}))`,
        REPORTS,
      ),
    );

    expect(run.verdict.status).toBe("PASS");
    expect(posts).toEqual([]);
  });

  it("posts a proven run whose body wrote a sentence, when the job announces reported", async () => {
    // The job neither other mode fits: it ticks every half hour, most ticks find nothing,
    // and the ones that do work are clean. `always` would post the idle ticks and the
    // default posts none of them.
    const said = "felled [#3562](https://example.test/i/3562); nothing else was standing.";
    const { posts, post } = feed(named, "reported");
    const run = await host(undefined, post).tick(
      body(
        `${MARK}${WRITE}JSON.stringify({gates:[{gate:"shift",executed:true,exitCode:0,` +
          `detail:${JSON.stringify(said)}}]}))`,
        { report: "{surface: console, channel: hive, announce: reported}" },
      ),
    );

    expect(run.verdict.status).toBe("PASS");
    expect(posts[0].text).toContain("PROVEN: combined passed");
    expect(posts.slice(1).map((p) => p.text)).toEqual([
      "PROVEN: job:sweep passed (gate job:sweep exited 0).",
      `PROVEN: ${said}`,
    ]);
    // The body chose to speak; it did not choose what it is called.
    expect(posts[0].text).not.toContain(said);
  });

  it("says nothing under reported for a proven run whose gates carry no sentence", async () => {
    // Gates without prose are outcomes, and the verdict already speaks for those. This is
    // the idle tick, and it is the whole reason the mode is not `always`.
    const { posts, post } = feed(named, "reported");
    const run = await host(undefined, post).tick(
      body(PROVES, { report: "{surface: console, channel: hive, announce: reported}" }),
    );

    expect(run.verdict.status).toBe("PASS");
    expect(posts).toEqual([]);
    expect(runs).toHaveLength(1);
  });

  it("still posts a body that reported nothing at all, under reported", async () => {
    // The floor the mode must not lower: a body that wrote no gates proved nothing, and a
    // crashed job going quiet is exactly what a mode keyed on the body's own prose could
    // have bought. An unproven run announces under every mode.
    const { posts, post } = feed(named, "reported");
    const run = await host(undefined, post).tick(
      body(SILENT, { report: "{surface: console, channel: hive, announce: reported}" }),
    );

    expect(run.verdict.status).toBe("UNKNOWN");
    expect(run.gates.some((gate) => gate.detail)).toBe(false);
    expect(posts[0].text).toContain("NOT PROVEN");
  });

  it("still says nothing for a parked job that announces always", async () => {
    // `announce` weighs a verdict. A job the switch refused has no verdict to weigh — it
    // did not run — and announcing a posture somebody chose every tick is the noise the
    // silence exists to prevent.
    const { posts, post } = feed(named, "always");
    const parked = await host(answers({ origin: "set", state: "off" }), post).tick(
      body(PROVES, { report: "{surface: console, channel: hive, announce: always}" }),
    );

    expect(parked.outcome).toBe("denied-switch");
    expect(posts).toEqual([]);
    expect(runs).toHaveLength(1);
  });

  it("does not announce a parked job every tick, and does announce a mis-wired one", async () => {
    const { posts, post } = feed();
    const parked = await host(answers({ origin: "set", state: "off" }), post).tick(
      body(PROVES, REPORTS),
    );
    expect(parked.outcome).toBe("denied-switch");
    expect(posts).toEqual([]);

    // Nobody chose this one: a job started through a door it never declared is a job
    // pointed at the wrong job, not a posture.
    const miswired = await host(undefined, post).webhook(
      body(PROVES, { ...REPORTS, trigger: "{onRequest: true}", killSwitch: undefined }),
    );
    expect(miswired.outcome).toBe("denied-trigger");
    expect(posts[0].text).toContain("does not arm the webhook trigger");
  });

  it("posts detail at top level rather than losing it when the headline names no id", async () => {
    const { posts, post } = feed(() => undefined);
    await host(undefined, post).tick(body(MIXED, REPORTS));

    expect(posts).toHaveLength(4);
    expect(posts.every((p) => p.threadRoot === undefined)).toBe(true);
  });

  it("does not fail a job because its status channel did", async () => {
    const run = await host(undefined, async () => {
      throw new Error("relay unreachable");
    }).tick(body(MIXED, REPORTS));

    // The work happened and the record stands. A relay outage is not a job failure.
    expect(run.outcome).toBe("completed");
    expect(spawns()).toBe(1);
    expect(runs).toHaveLength(1);
  });

  it("keeps posting the gates, onto the same headline, after one of them is refused", async () => {
    const attempted: Array<{ text: string; threadRoot?: EventRef }> = [];
    await host(undefined, async (_report, text, threadRoot) => {
      attempted.push({ text, threadRoot });
      // One line refused, the way a surface refuses one message rather than the channel.
      if (attempted.length === 2) throw new Error("message too long");
      return named(attempted.length);
    }).tick(body(MIXED, REPORTS));

    // A rejected gate line takes nothing with it — a headline with half its reasons is the
    // failure report this exists to deliver, half-lost — and it does not re-anchor the
    // lines after it either: the root stays the headline's own id throughout.
    expect(attempted.map((p) => p.threadRoot)).toEqual([undefined, named(1), named(1), named(1)]);
    expect(attempted[3].text).toContain("jscpd");
  });

  it("says the same thing on a terminal as it does in a channel", async () => {
    const { post } = feed();
    const run = await host(undefined, post).tick(body(MIXED, REPORTS));
    const { headline, detail } = jobStatus(run);

    // The doors differ only in whether they have threads. A run that reads one way on a
    // terminal and another in a channel is two reports of one run, and the one somebody
    // acts on is whichever they happened to see.
    expect(describeJobRun(run)).toBe(`${[headline, ...detail.map((d) => `  ${d}`)].join("\n")}\n`);
  });

  it("posts nowhere when the job declares no destination", async () => {
    const { posts, post } = feed();
    const run = await host(undefined, post).tick(body(MIXED));

    expect(run.verdict.status).toBe("UNKNOWN");
    expect(posts).toEqual([]);
  });
});
