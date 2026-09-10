import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUZZ_DEFAULTS,
  generateKeypair,
  resolveBuzzSigner,
} from "@sageox/agent-toolkit-adapter-buzz";
import { FakeRelay } from "../../adapter-buzz/test/fake-relay.ts";
import { CLI, run as exec } from "./cli-harness.ts";

/**
 * What a probing body really gets from `sageox-agent job run`, over a real relay.
 *
 * The gateway is not the only door onto a job: a scheduled one runs through this command,
 * which connects a surface of its own. `job-channel.test.ts` hands `JobHost` its
 * capabilities directly, so nothing there can catch a capability this door mints and never
 * passes on — a body would be offered the verb and refused on every call.
 */

const identity = generateKeypair();
/** Whoever else was talking in the room. Never this agent: the point is a line it did not post. */
const stranger = generateKeypair();
const now = Math.floor(Date.now() / 1000);

let home: string;
let bundle: string;
let secrets: string;
let relay: FakeRelay;

/** A line somebody else left in the report channel, before this run existed. */
async function inChannel(text: string, at: number) {
  const signer = await resolveBuzzSigner("K", { env: { K: stranger.nsec } });
  return signer.signEvent({
    kind: BUZZ_DEFAULTS.kind,
    created_at: at,
    tags: [["h", "hive"]],
    content: text,
  });
}

/** A body that reads its channel back and reports what it found, or why it could not. */
const reads = `
const call = async (name, args) => {
  const answered = await fetch(process.env.JOB_CHANNEL_URL, {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.JOB_CHANNEL_TOKEN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }).then((r) => r.json());
  if (answered.error) throw new Error(answered.error.message);
  return JSON.parse(answered.result.content[0].text);
};
// The refusal is written into the gate rather than thrown away, so a run that could not
// read says why in the verdict instead of only failing.
call("channel_history", { limit: 50 })
  .then((h) => h.messages.map((m) => m.text).join(" | "))
  .catch((error) => "could not read: " + error.message)
  .then((detail) =>
    require("fs").writeFileSync(
      process.env.JOB_VERDICT_PATH,
      JSON.stringify({ gates: [{ gate: "read", executed: true, exitCode: 0, detail }] }),
    ),
  );
`;

/** A thunk, not a constant: the relay picks its port in `beforeEach`. */
const manifest = () =>
  `name: demo
brain: {provider: mock}
respondTo: anyone
brains: [{preset: local}]
killSwitchParkBy: []
surfaces:
  - kind: buzz
    relayUrl: ${relay.url}
    identity: BUZZ_NSEC
    channels: [{ id: hive, reply: private }]
jobs:
  - slug: announce
    archetype: shift
    description: Announces each new item once.
    trigger: {schedules: ["0 3 * * *"], onRequest: true}
    killSwitch: {failDirection: open}
    budget: {wallClockMs: 20000, deadlineHeadroomMs: 1000}
    report: {surface: buzz, channel: hive, probe: true, history: true}
    run: {command: node, args: [body.cjs]}
`;

/** The real command: what it printed either way, and the status a CronJob would act on. */
const runAnnounce = async () => {
  const argv = ["job", "run", "announce", "--bundle", bundle, "--secrets", secrets];
  const env = { ...process.env };
  delete env.AGENT_TOOLKIT_HOME;
  delete env.XDG_CONFIG_HOME;
  try {
    return { stdout: (await exec(CLI, argv, { cwd: tmpdir(), env })).stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout: string; stderr: string; code: number };
    return { stdout: `${failed.stdout}${failed.stderr}`, code: failed.code };
  }
};

beforeEach(async () => {
  relay = await FakeRelay.start({ backlog: [await inChannel("new: item-41", now - 60)] });
  home = mkdtempSync(join(tmpdir(), "sageox-agent-job-probe-"));
  bundle = join(home, "demo");
  secrets = join(home, "secrets");
  mkdirSync(bundle);
  mkdirSync(secrets);
  writeFileSync(join(secrets, "BUZZ_NSEC"), `${identity.nsec}\n`, { mode: 0o600 });
  writeFileSync(join(bundle, "agent.yaml"), manifest());
  writeFileSync(join(bundle, "body.cjs"), reads);
});

afterEach(async () => {
  await relay?.stop();
  // Guarded for `relay?.stop()`'s reason: `home` is assigned after the relay binds a port,
  // so a relay that failed to start would leave teardown throwing over the real failure.
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("a probing job run from the command line", () => {
  it("reads its report channel back through the surface this door connected", async () => {
    const { stdout, code } = await runAnnounce();

    // The line was in the channel before the run started and nothing in this process
    // published it, so reaching it is the whole of what `report.history` grants — and it
    // can only be reached if this door handed the host the capability it minted.
    //
    // On the gate rather than anywhere in the output: the body writes back what it read,
    // so the host's `PROVEN:` in front of it is the run agreeing the read happened. A run
    // that died before the body, or after it, does not print this line.
    expect(stdout).toContain("PROVEN: new: item-41");
    expect(code).toBe(0);
  }, 30_000);
});
