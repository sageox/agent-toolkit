import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_KIND,
  generateKeypair,
  LocalRelay,
  resolveBuzzSigner,
} from "@sageox/agent-toolkit-adapter-buzz";
import { doctorRun } from "./cli-harness.ts";

const key = generateKeypair();

async function signed(kind: number, content: Record<string, unknown>) {
  const signer = await resolveBuzzSigner("BUZZ_NSEC", { env: { BUZZ_NSEC: key.nsec } });
  return signer.signEvent({ kind, created_at: 1786000000, tags: [], content: JSON.stringify(content) });
}

const record = (displayName: string) =>
  signed(DIRECTORY_KIND, {
    name: "ron",
    display_name: displayName,
    channel_ids: ["c1"],
    respond_to: "anyone",
  });

describe("doctor compares the directory record's name with the agent's profile", () => {
  let home: string;
  let relay: LocalRelay;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sageox-agent-doctor-name-"));
    mkdirSync(join(home, "demo"));
  });

  afterEach(async () => {
    await relay?.stop();
    rmSync(home, { recursive: true, force: true });
  });

  async function doctor(
    backlog: Awaited<ReturnType<typeof signed>>[],
    identity = "BUZZ_NSEC",
    env: Record<string, string> = {},
  ) {
    relay = await LocalRelay.start({ requireAuth: true, backlog });
    writeFileSync(
      join(home, "demo", "agent.yaml"),
      `name: ron
brain:
  provider: mock
respondTo: anyone
surfaces:
  - kind: buzz
    relayUrl: ${relay.url}
    identity: ${identity}
    channels:
      - { id: c1, reply: private }
`,
    );
    return doctorRun(home, { [identity]: key.nsec, ...env });
  }

  // Ron's case on buzz.test.sageox.ai: the profile was renamed and the record kept the old
  // name, so `@Ron Weasley` bound to nobody while every check said the agent was mentionable.
  it("warns, naming both names and the fix, when the record kept a name the profile dropped", async () => {
    const { stdout } = await doctor([
      await record("Ron Weasley"),
      await signed(0, { name: "Ron" }),
    ]);
    const drift = `surface buzz: the directory record's display_name at ${relay.url} is "Ron Weasley" but the profile names it "Ron"`;
    // A warning, not a problem: the profile's name still reaches the agent, and a FAIL here
    // would block bring-up of an agent that can still be mentioned.
    expect(stdout).toContain(`  warn  ${drift}`);
    expect(stdout).not.toContain(`  FAIL  ${drift}`);
    expect(stdout).toContain("re-run `sageox-agent identity register buzz`");
    expect(stdout).not.toContain("so it is mentionable");
  }, 30_000);

  // House naming puts a space in the profile's full name ("Rip Merging", "Paul Bunyan"), and
  // clients match multi-word names, so a space alone must never be flagged.
  it("passes a multi-word name the record and profile agree on", async () => {
    const { stdout } = await doctor([
      await record("Paul Bunyan"),
      await signed(0, { name: "Paul Bunyan", display_name: "Paul Bunyan" }),
    ]);
    expect(stdout).toContain("surface buzz: directory record lists 1 channel(s), so it is mentionable");
    expect(stdout).not.toContain("display_name at");
  }, 30_000);

  // Registration signs only with BUZZ_NSEC, so for a surface on another identity the warning
  // must not hand out a fix that leaves this record as it is.
  it("does not offer re-registration for a surface that signs with another identity", async () => {
    const { stdout } = await doctor(
      [await record("Ron Weasley"), await signed(0, { name: "Ron" })],
      "BUZZ_NSEC_TWO",
    );
    expect(stdout).toContain(`  warn  surface buzz: the directory record's display_name at ${relay.url}`);
    expect(stdout).toContain("publishes only BUZZ_NSEC's record, so it cannot fix this one (identity BUZZ_NSEC_TWO)");
    expect(stdout).not.toContain("re-run `sageox-agent identity register buzz`");
  }, 30_000);

  // A second ref to the bundle's own key owns the same record, so registration does fix it.
  it("offers re-registration for a surface whose identity holds the BUZZ_NSEC key", async () => {
    const { stdout } = await doctor(
      [await record("Ron Weasley"), await signed(0, { name: "Ron" })],
      "AGENT_NSEC",
      { BUZZ_NSEC: key.nsec },
    );
    expect(stdout).toContain(`  warn  surface buzz: the directory record's display_name at ${relay.url}`);
    expect(stdout).toContain("re-run `sageox-agent identity register buzz`");
    expect(stdout).not.toContain("cannot fix this one");
  }, 30_000);
});
