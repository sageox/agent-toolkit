import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeypair } from "@sageox/agent-toolkit-adapter-buzz";
import { CLI } from "./cli-harness.ts";

/**
 * `--rehearse` through the real entry point. Every Buzz surface below names a relay that does
 * not exist, so a run that reached for it could not answer, and the shell exports credentials
 * the bundles declare, so a run that inherited them would hand them on.
 */

let home: string;
let bundle: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sageox-agent-rehearse-"));
  bundle = join(home, "demo");
  mkdirSync(bundle);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** What a rehearsal left in the temporary directory it was given. */
const leftovers = () => readdirSync(home).filter((name) => name.startsWith("sageox-agent-rehearsal-"));

function cli(args: string[], input = "") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: home,
    GITHUB_TOKEN: "from-the-shell",
    WRITE_TOKEN: "also-from-the-shell",
  };
  delete env.AGENT_TOOLKIT_HOME;
  delete env.XDG_CONFIG_HOME;
  const { status, stdout, stderr } = spawnSync(CLI, args, { env, input, encoding: "utf8", timeout: 25_000 });
  return { status, output: `${stdout}${stderr}` };
}

describe("run --rehearse", () => {
  it("answers each line of stdin through a relay of its own, then exits", () => {
    writeFileSync(
      join(bundle, "agent.yaml"),
      `name: demo
brain: {provider: mock}
respondTo: allowlist
allowlist: ["${generateKeypair().hex}"]
surfaces:
  - kind: buzz
    relayUrl: wss://relay.invalid
    identity: BUZZ_NSEC
    channels: [{ id: c1, name: hive, reply: private }]
`,
    );

    const { status, output } = cli(["run", "--bundle", bundle, "--rehearse"], "hello there\n");

    // Answered, so the line reached it from someone the allowlist admits — the rehearsal
    // made the person at the terminal its owner — over a relay that was not the declared one.
    expect(output).toContain("#hive demo> echo: hello there");
    expect(status).toBe(0);
    // The resume cursor belongs to the real relay.
    expect(existsSync(join(bundle, "state.json"))).toBe(false);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it("answers a line typed twice, twice", () => {
    writeFileSync(
      join(bundle, "agent.yaml"),
      `name: demo
brain: {provider: mock}
respondTo: anyone
surfaces:
  - kind: buzz
    relayUrl: wss://relay.invalid
    identity: BUZZ_NSEC
    channels: [{ id: c1, name: hive, reply: private }]
`,
    );

    // Signed in the same second, the two lines would otherwise be one event id: the second
    // dropped as already seen, and the command waiting on it for ever.
    const { status, output } = cli(["run", "--bundle", bundle, "--rehearse"], "same\nsame\n");

    expect(output.split("#hive demo> echo: same").length - 1).toBe(2);
    expect(status).toBe(0);
  }, 30_000);

  it("refuses Buzz surfaces on two relays, which one stand-in would merge", () => {
    writeFileSync(
      join(bundle, "agent.yaml"),
      `name: demo
brain: {provider: mock}
respondTo: anyone
surfaces:
  - kind: buzz
    relayUrl: wss://one.invalid
    identity: BUZZ_NSEC
    channels: [{ id: c1, reply: private }]
  - kind: buzz
    relayUrl: wss://two.invalid
    identity: BUZZ_NSEC_TWO
    channels: [{ id: c1, reply: private }]
`,
    );

    const { status, output } = cli(["run", "--bundle", bundle, "--rehearse"]);

    expect(output).toContain("--rehearse stands in for one Buzz relay");
    expect(status).toBe(1);
  }, 30_000);

  it("refuses a surface it has no stand-in for, before connecting anything", () => {
    writeFileSync(
      join(bundle, "agent.yaml"),
      `name: demo
brain: {provider: mock}
respondTo: anyone
surfaces: [{ kind: slack, identity: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN }]
`,
    );

    const { status, output } = cli(["run", "--bundle", bundle, "--rehearse"]);

    expect(output).toContain("no local stand-in for the slack surface");
    expect(status).toBe(1);
  }, 30_000);
});

describe("job run --rehearse", () => {
  it("runs a fail-closed job without the shell's credentials, and tells it so", () => {
    writeFileSync(
      join(bundle, "agent.yaml"),
      `name: demo
brain: {provider: mock}
respondTo: anyone
brains: [{preset: private, owner: "${generateKeypair().hex}"}]
killSwitchParkBy: []
surfaces:
  - kind: buzz
    relayUrl: wss://relay.invalid
    identity: BUZZ_NSEC
    channels: [{ id: hive, reply: private }]
jobs:
  - slug: announce
    archetype: shift
    description: Says what it was given.
    trigger: {schedules: ["0 3 * * *"]}
    killSwitch: {failDirection: closed}
    budget: {wallClockMs: 20000, deadlineHeadroomMs: 1000}
    report: {surface: buzz, channel: hive, announce: always}
    run:
      command: node
      args: [body.cjs]
      secrets: {GITHUB_TOKEN: GITHUB_TOKEN}
      jobSecrets: {WRITE_TOKEN: WRITE_TOKEN}
`,
    );
    writeFileSync(
      join(bundle, "body.cjs"),
      `const seen = ["JOB_REHEARSAL", "GITHUB_TOKEN", "WRITE_TOKEN"]
  .map((name) => name + "=" + (process.env[name] ?? "unset")).join(" ");
require("fs").writeFileSync(process.env.JOB_VERDICT_PATH,
  JSON.stringify({ gates: [{ gate: "env", executed: true, exitCode: 0, detail: seen }] }));
`,
    );

    const { status, output } = cli(["job", "run", "announce", "--bundle", bundle, "--rehearse"]);

    // Ran at all: a fresh relay holds no switch, and this one fails closed.
    expect(output).toContain("armed mem/announce/enabled");
    // Both refs resolve from the shell outside a rehearsal, and neither is in the
    // agent's own store, so neither is handed on.
    expect(output).toContain("running without GITHUB_TOKEN, WRITE_TOKEN");
    expect(output).toContain("PROVEN: JOB_REHEARSAL=1 GITHUB_TOKEN=unset WRITE_TOKEN=unset");
    // The status post, through the stand-in, read back at the terminal.
    expect(output).toContain("#hive demo> job announce completed");
    expect(status).toBe(0);
    expect(leftovers()).toEqual([]);
  }, 30_000);

  it("refuses a job that runs on an external worker, even with a dispatcher in .env", () => {
    writeFileSync(
      join(bundle, "agent.yaml"),
      `name: demo
brain: {provider: mock}
respondTo: anyone
brains: [{preset: local}]
killSwitchParkBy: []
surfaces: [{kind: console}]
jobs:
  - slug: task
    archetype: queue
    description: Runs on a worker.
    trigger: {schedules: ["0 * * * *"]}
    killSwitch: {failDirection: open}
    budget: {wallClockMs: 10000, deadlineHeadroomMs: 1000}
    worker: {image: "example/worker@sha256:${"a".repeat(64)}", directory: /work}
    run: {command: node, args: [task.cjs]}
`,
    );
    // Restored by the agent's own .env after the shell is left behind, and real: the
    // dispatcher would run the body with the cluster's secrets and no rehearsal flag.
    writeFileSync(
      join(bundle, ".env"),
      "AGENT_JOB_DISPATCHER_URL=http://127.0.0.1:9\nAGENT_JOB_DISPATCHER_TOKEN=dispatch-token\n",
    );

    const { output } = cli(["job", "run", "task", "--bundle", bundle, "--rehearse"]);

    expect(output).toContain("job task requires an external dispatcher");
  }, 30_000);

  it("is refused by every other job subcommand, which would act on the real agent", () => {
    writeFileSync(join(bundle, "agent.yaml"), "name: demo\nbrain: {provider: mock}\nrespondTo: anyone\nsurfaces: [{kind: console}]\n");

    const { status, output } = cli(["job", "arm", "announce", "--bundle", bundle, "--rehearse"]);

    expect(output).toContain("--rehearse applies to `run` and `job run` only");
    expect(status).toBe(1);
  }, 30_000);
});
