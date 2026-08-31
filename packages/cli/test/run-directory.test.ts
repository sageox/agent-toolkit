import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_KIND,
  generateKeypair,
  resolveBuzzSigner,
} from "@sageox/agent-toolkit-adapter-buzz";
import { FakeRelay } from "../../adapter-buzz/test/fake-relay.ts";
import { CLI } from "./cli-harness.ts";

const identity = generateKeypair();
const owner = generateKeypair().hex;
const reviewer = generateKeypair().hex;
/** The principal a later manifest edit added, and the record never learned about. */
const added = generateKeypair().hex;

/** The relay's copy of the record, signed by the agent whose record it is. */
async function held(content: Record<string, unknown>) {
  const signer = await resolveBuzzSigner("BUZZ_NSEC", { env: { BUZZ_NSEC: identity.nsec } });
  return signer.signEvent({
    kind: DIRECTORY_KIND,
    created_at: 1786000000,
    tags: [],
    content: JSON.stringify(content),
  });
}

describe("run reconciles the directory record", () => {
  let relay: FakeRelay;
  let home: string;
  let agent: ChildProcess | undefined;

  afterEach(async () => {
    agent?.kill("SIGKILL");
    await relay?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** Writes the bundle, starts the real CLI, and hands back a reader for its output. */
  function start(agentHome: string, yaml: string): () => string {
    const secrets = join(agentHome, "secrets");
    mkdirSync(join(agentHome, "demo"));
    mkdirSync(secrets);
    writeFileSync(join(secrets, "BUZZ_NSEC"), `${identity.nsec}\n`, { mode: 0o600 });
    // A second name for the same key. Nothing stops a manifest from having one, and the
    // record is filed under the key, not under the name.
    writeFileSync(join(secrets, "BUZZ_ALIAS"), `${identity.nsec}\n`, { mode: 0o600 });
    writeFileSync(join(agentHome, "demo", "agent.yaml"), yaml);

    let output = "";
    agent = spawn(CLI, ["run", "--agent", "demo", "--secrets", secrets], {
      env: { ...process.env, AGENT_TOOLKIT_HOME: agentHome },
    });
    agent.stdout?.on("data", (chunk) => (output += String(chunk)));
    agent.stderr?.on("data", (chunk) => (output += String(chunk)));
    return () => output;
  }

  // A manifest edit reached the gateway on the next deploy and reached clients only when
  // somebody re-ran `identity register` by hand. Nothing reported the gap, because the two
  // principals the record still listed went on being answered.
  //
  // Both edits the record can lose at once: a principal added to `allowlist`, and a channel
  // added to `channels`. The channel here is a consented public one, because the record is
  // where a client looks to decide whether a mention may be sent at all — a distinction that
  // has nothing to do with whether the channel is private.
  it("publishes the allowlist and channels the manifest names, with no re-registration", async () => {
    relay = await FakeRelay.start({
      requireAuth: true,
      backlog: [
        await held({
          name: "demo",
          display_name: "Demo",
          channel_ids: ["c1"],
          respond_to: "allowlist",
          respond_to_allowlist: [owner, reviewer],
          agent_type: "claude-agent-acp",
        }),
      ],
    });

    home = mkdtempSync(join(tmpdir(), "sageox-agent-run-directory-"));
    const output = start(
      home,
      `name: demo
brain:
  provider: mock
respondTo: allowlist
allowlist:
  - ${owner}
  - ${reviewer}
  - ${added}
surfaces:
  - kind: buzz
    relayUrl: ${relay.url}
    identity: BUZZ_NSEC
    channels:
      - { id: c1, reply: private }
      - { id: c2, reply: public }
`,
    );

    expect(await waitForRecord(relay, output)).toEqual({
      name: "demo",
      // Not rewritten to the handle: nothing in the manifest names it, so the record holds
      // the only copy.
      display_name: "Demo",
      channel_ids: ["c1", "c2"],
      respond_to: "allowlist",
      respond_to_allowlist: [owner, reviewer, added],
      // Written by another tool, and not this toolkit's to delete.
      agent_type: "claude-agent-acp",
    });
  }, 30_000);

  // The record is filed under the signing pubkey, so these two surfaces are one record even
  // though they name the key differently and spell the relay differently. Publishing them in
  // turn would leave it listing `late` alone, and a mention in `early` would be stripped at
  // send — the exact failure this reconcile exists to prevent, caused by the reconcile.
  it("unions the channels of two surfaces that resolve to one record", async () => {
    relay = await FakeRelay.start({
      requireAuth: true,
      backlog: [
        await held({ name: "demo", channel_ids: [], respond_to: "anyone" }),
      ],
    });

    home = mkdtempSync(join(tmpdir(), "sageox-agent-run-shared-"));
    const output = start(
      home,
      `name: demo
brain:
  provider: mock
respondTo: anyone
surfaces:
  - kind: buzz
    relayUrl: ${relay.url}
    identity: BUZZ_NSEC
    channels: [{ id: early, reply: private }]
  - kind: buzz
    relayUrl: ${relay.url}/
    identity: BUZZ_ALIAS
    channels: [{ id: late, reply: private }]
`,
    );

    const record = (await waitForRecord(relay, output)) as { channel_ids: string[] };
    expect([...record.channel_ids].sort()).toEqual(["early", "late"]);
    // One record, so one write. A second publish here is the overwrite, not a retry.
    expect(relay.published.filter((e) => e.kind === DIRECTORY_KIND)).toHaveLength(1);
  }, 30_000);
});

/** What `run` published, or the launch output that explains why it never did. */
async function waitForRecord(relay: FakeRelay, output: () => string): Promise<unknown> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const record = relay.published.find((event) => event.kind === DIRECTORY_KIND);
    if (record) return JSON.parse(record.content);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run published no directory record. Its output was:\n${output()}`);
}
