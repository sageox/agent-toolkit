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

  async function doctor(backlog: Awaited<ReturnType<typeof signed>>[]) {
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
    identity: BUZZ_NSEC
    channels:
      - { id: c1, reply: private }
`,
    );
    return doctorRun(home, { BUZZ_NSEC: key.nsec });
  }

  // Ron's case on buzz.test.sageox.ai: the profile was renamed and the record kept the old
  // name, so `@Ron Weasley` bound to nobody while every check said the agent was mentionable.
  it("warns, naming both names and the fix, when the record kept a name the profile dropped", async () => {
    const { stdout } = await doctor([
      await record("Ron Weasley"),
      await signed(0, { name: "Ron" }),
    ]);
    expect(stdout).toContain(
      `surface buzz: the directory record's display_name is "Ron Weasley" but the profile names it "Ron"`,
    );
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
    expect(stdout).not.toContain("display_name is");
  }, 30_000);
});
