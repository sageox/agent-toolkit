import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobHost, publishPhase, stageOutputDir, workPhaseRecordPath, type JobRun } from "../src/job-host.ts";
import { isProcessJob, loadManifest, type ProcessJob } from "../src/manifest.ts";

const base =
  "name: x\nbrain: {provider: mock}\nsurfaces: [{kind: console}]\nrespondTo: anyone\n" +
  "brains: [{preset: local}]\nkillSwitchParkBy: []\n";

const manifest = (over: Record<string, string> = {}) => {
  const fields = {
    slug: "fix",
    archetype: "shift",
    description: "Fixes a labelled issue and opens a pull request for it.",
    trigger: '{schedules: ["0 * * * *"]}',
    killSwitch: "{failDirection: open}",
    budget: "{wallClockMs: 600000, deadlineHeadroomMs: 60000}",
    run: "{command: node, secrets: {GH_TOKEN: GH_TOKEN}, jobSecrets: {GH_APP_PEM: GH_APP_PEM}, work: {command: node, wallClockMs: 300000}}",
    ...over,
  };
  return `${base}jobs: [{${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(", ")}}]\n`;
};

const parsed = (over: Record<string, string> = {}): ProcessJob => {
  const [job] = loadManifest(manifest(over)).jobs;
  if (!job || !isProcessJob(job)) throw new Error("this fixture declares no run body");
  return job;
};

/** Each phase writes the environment it was handed to a file of its own. */
const DUMP = (file: string) =>
  `require("fs").writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env));`;

const phases = (work: string, publish: string, over: Record<string, string> = {}): ProcessJob => {
  const job = parsed(over);
  return {
    ...job,
    run: {
      ...job.run,
      command: process.execPath,
      args: ["-e", publish],
      work: { ...job.run.work!, command: process.execPath, args: ["-e", work] },
    },
  };
};

const PROVES = 'require("fs").writeFileSync(process.env.JOB_VERDICT_PATH, JSON.stringify({gates:[{gate:"pushed",executed:true,exitCode:0}]}));';

let dir: string;
let secretsDir: string;
let stageDir: string;
let runs: JobRun[];
const host = (stage: string | null = stageDir) =>
  new JobHost({
    workDir: dir,
    env: { ...process.env, PASSED_ON: "ambient-identity" },
    secretOpts: { dir: secretsDir },
    onRun: (run) => runs.push(run),
    ...(stage ? { stageDir: stage } : {}),
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "job-phases-"));
  secretsDir = join(dir, "secrets");
  stageDir = join(dir, "stage");
  await mkdir(secretsDir);
  await writeFile(join(secretsDir, "GH_TOKEN"), "ghs_publishonly");
  await writeFile(join(secretsDir, "GH_APP_PEM"), "-----BEGIN PRIVATE KEY-----\n");
  runs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("run.work in the manifest", () => {
  it("is a phase of a scheduled run body", () => {
    expect(parsed().run.work).toEqual({ command: "node", args: [], wallClockMs: 300000 });
  });

  it("refuses an on-request trigger, which runs inside the gateway", () => {
    expect(() => loadManifest(manifest({ trigger: '{schedules: ["0 * * * *"], onRequest: true}' })))
      .toThrow(/run\.work and arms trigger\.onRequest/);
  });

  it("refuses an external worker, whose single container the dispatcher builds", () => {
    expect(() => loadManifest(manifest({
      worker: `{image: "ghcr.io/x/task@sha256:${"a".repeat(64)}", directory: /task}`,
      run: "{command: node, work: {command: node, wallClockMs: 300000}}",
    }))).toThrow(/run\.work and a worker/);
  });

  it("refuses a work clock that leaves the publish phase nothing", () => {
    expect(() => loadManifest(manifest({
      run: "{command: node, work: {command: node, wallClockMs: 540000}}",
    }))).toThrow(/must be less than budget\.wallClockMs/);
  });

  it("gives the publish phase what the work phase and the headroom leave", () => {
    expect(publishPhase(parsed()).budget.wallClockMs).toBe(600000 - 300000 - 60000);
  });
});

describe("the work phase", () => {
  it("runs with no secret resolved and no verdict path, and records how it ended", async () => {
    const seen = join(dir, "work-env.json");
    const result = await host().work(phases(DUMP(seen) + "process.exit(0)", ""));
    const env = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string>;

    expect(result).toEqual({ executed: true, exitCode: 0 });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GH_APP_PEM).toBeUndefined();
    expect(env.JOB_VERDICT_PATH).toBeUndefined();
    expect(env.JOB_PHASE).toBe("work");
    expect(env.JOB_STAGE_DIR).toBe(stageOutputDir(stageDir));
    expect(JSON.parse(readFileSync(workPhaseRecordPath(stageDir), "utf8"))).toEqual(result);
  });

  it("hands the publish phase the credentials and the stage", async () => {
    const seen = join(dir, "publish-env.json");
    const staged = 'require("fs").writeFileSync(process.env.JOB_STAGE_DIR + "/commit", "abc");';
    const reads = `if (require("fs").readFileSync(process.env.JOB_STAGE_DIR + "/commit", "utf8") !== "abc") process.exit(9);`;
    const job = phases(staged, DUMP(seen) + reads + PROVES);
    await host().work(job);
    const run = await host().tick(job);
    const env = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string>;

    expect(run.outcome).toBe("completed");
    expect(run.verdict.status).toBe("PASS");
    expect(env.GH_TOKEN).toBe("ghs_publishonly");
    expect(env.GH_APP_PEM).toContain("PRIVATE KEY");
    expect(env.JOB_STAGE_DIR).toBe(stageOutputDir(stageDir));
    expect(run.checks).toContainEqual({ gate: "job:fix:work", executed: true, exitCode: 0 });
  });

  it("holds the run at FAIL when the work phase failed, whatever the publish phase says", async () => {
    const job = phases("process.exit(3)", PROVES);
    await host().work(job);
    const run = await host().tick(job);
    expect(run.verdict.status).toBe("FAIL");
  });

  it("holds the run at UNKNOWN when no work phase left a record", async () => {
    await mkdir(stageDir);
    const run = await host().tick(phases("", PROVES));
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(run.checks).toContainEqual(expect.objectContaining({ gate: "job:fix:work", executed: false }));
  });

  it("refuses to publish a phased job without a stage, and to hand an unphased one a stage", async () => {
    const phased = await host(null).tick(phases("", PROVES));
    expect(phased.outcome).toBe("crashed");
    expect(phased.reason).toMatch(/declares run\.work, and this run was given no stage/);

    const plain = parsed({ run: `{command: ${JSON.stringify(process.execPath)}}` });
    const unphased = await host().tick(plain);
    expect(unphased.outcome).toBe("crashed");
    expect(unphased.reason).toMatch(/declares no run\.work, and this run was given a stage/);
  });
});

describe("the stage between the phases", () => {
  it("withholds the publish body's passthrough grant from the work phase", async () => {
    const seen = join(dir, "work-env.json");
    const job = phases(DUMP(seen), "");
    await host().work({ ...job, run: { ...job.run, passthrough: ["PASSED_ON"] } });
    const env = JSON.parse(readFileSync(seen, "utf8")) as Record<string, string>;
    expect(env.PASSED_ON).toBeUndefined();
    expect(env.PATH).toBeDefined();
  });

  it("makes what the work phase staged readable by another UID", async () => {
    const staged = 'const fs=require("fs");fs.chmodSync(process.env.JOB_STAGE_DIR,0o700);fs.mkdirSync(process.env.JOB_STAGE_DIR+"/d",{mode:0o700});fs.writeFileSync(process.env.JOB_STAGE_DIR+"/d/f","x",{mode:0o600});';
    await host().work(phases(staged, ""));
    const { statSync } = await import("node:fs");
    expect(statSync(stageOutputDir(stageDir)).mode & 0o055).toBe(0o055);
    expect(statSync(join(stageOutputDir(stageDir), "d")).mode & 0o055).toBe(0o055);
    expect(statSync(join(stageOutputDir(stageDir), "d", "f")).mode & 0o044).toBe(0o044);
  });

  it("refuses to start a publish body on a stage holding a symlink", async () => {
    const seen = join(dir, "publish-env.json");
    const job = phases("", DUMP(seen) + PROVES);
    await host().work(job);
    await symlink(join(secretsDir, "GH_TOKEN"), join(stageOutputDir(stageDir), "pr-body.md"));
    const run = await host().tick(job);

    expect(run.outcome).toBe("crashed");
    expect(run.reason).toMatch(/pr-body\.md, which is not a regular file or directory/);
    expect(run.verdict.status).toBe("UNKNOWN");
    expect(() => readFileSync(seen)).toThrow();
  });

  it("keeps a failed work phase's FAIL when the publish body never starts", async () => {
    const job = phases("process.exit(3)", PROVES);
    await host().work(job);
    await symlink("/proc/self/environ", join(stageOutputDir(stageDir), "env"));
    const run = await host().tick(job);

    expect(run.outcome).toBe("crashed");
    expect(run.verdict.status).toBe("FAIL");
    expect(run.checks).toContainEqual({ gate: "job:fix:work", executed: true, exitCode: 3 });
  });
});
