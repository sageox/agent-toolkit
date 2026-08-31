import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, toHexPubkey } from "@sageox/agent-toolkit-adapter-buzz";

/** Membership refusals to serve, oldest first; anything after them succeeds. */
const refusals: Error[] = [];
const registerCalls: number[] = [];
/** What the confirm prompts answer, in order — the membership retry, then the channel offer. */
const confirmAnswers: boolean[] = [];
/** The key typed at the hidden channel-owner prompt, and what `addBotToChannel` saw. */
const ownerKey: string[] = [];
const botAdds: Array<{ channel: string; channelOwnerNsec: string }> = [];

vi.mock("../src/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompt.ts")>()),
  isInteractive: () => true,
  promptConfirm: async () => confirmAnswers.shift() ?? false,
  promptSecret: async () => ownerKey.shift() ?? "",
}));

vi.mock("../src/register.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/register.ts")>()),
  registerAgent: async () => {
    registerCalls.push(Date.now());
    const refusal = refusals.shift();
    if (refusal) throw refusal;
  },
  addBotToChannel: async (opts: { channel: string; channelOwnerNsec: string }) => {
    botAdds.push({ channel: opts.channel, channelOwnerNsec: opts.channelOwnerNsec });
  },
}));

const { identityCmd } = await import("../src/commands.ts");

const key = generateKeypair();

describe("identity register buzz, against a membership-gated relay", () => {
  let root: string;
  let written: string;
  const savedHome = process.env.AGENT_TOOLKIT_HOME;
  const savedCwd = process.cwd();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sageox-agent-membership-"));
    const agent = join(root, "demo");
    mkdirSync(agent);
    // No agent.yaml on purpose: the directory record is published from one, and its
    // absence keeps this test off the relay entirely.
    writeFileSync(join(agent, ".env"), `BUZZ_NSEC=${key.nsec}\n`);
    writeFileSync(join(agent, "profile.json"), '{"display_name":"demo"}\n');
    process.env.AGENT_TOOLKIT_HOME = root;

    written = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });

    refusals.length = 0;
    registerCalls.length = 0;
    confirmAnswers.length = 0;
    ownerKey.length = 0;
    botAdds.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(savedCwd);
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = savedHome;
  });

  const register = () =>
    identityCmd([
      "register", "buzz",
      "--agent", "demo",
      "--relay", "wss://closed.example",
      "--channel", "9a3b-town",
      "--name", "demo",
    ]);

  it("hands over both admin commands and finishes the registration once they land", async () => {
    refusals.push(new Error("restricted: not a relay member"));
    confirmAnswers.push(true, false); // retry the relay, then decline the channel offer

    await register();

    // Both grants, named together: they are run by different people in different places,
    // and an operator who learns of the second afterwards has to find an admin twice.
    expect(written).toContain(`buzz-admin add-member --pubkey ${key.npub}`);
    // Complete, not just named: `channels add-member` carries neither the relay nor the
    // key, and an omitted --relay is localhost. The pubkey is hex there, as
    // `--add-as-bot` sends it; an npub matches nobody.
    expect(written).toContain("BUZZ_PRIVATE_KEY=<channel owner or admin nsec>");
    expect(written).toContain("buzz --relay https://closed.example channels add-member");
    expect(written).toContain(`--channel 9a3b-town --pubkey ${toHexPubkey(key.npub)} --role bot`);

    // Retried after the human said the grant landed, and the registration then completed
    // rather than telling them to run the whole command again.
    expect(registerCalls).toHaveLength(2);
    expect(written).toContain('profile set to "demo"');
  });

  // The alternative is printing a command with a private key pasted into it, which is a
  // key in someone's shell history for a grant the CLI could make itself.
  it("offers the channel grant at the prompt instead of only printing the command", async () => {
    const owner = generateKeypair();
    confirmAnswers.push(true);
    ownerKey.push(owner.nsec);

    await register();

    expect(botAdds).toEqual([{ channel: "9a3b-town", channelOwnerNsec: owner.nsec }]);
    expect(written).toContain("added to channel 9a3b-town as a bot");
    expect(written).not.toContain("Human action required");
  });

  it("prints the command when the offer is declined", async () => {
    confirmAnswers.push(false);

    await register();

    expect(botAdds).toEqual([]);
    expect(written).toContain("Human action required");
    expect(written).toContain("channels add-member --channel 9a3b-town");
  });

  it("re-reads the relay rather than trusting the answer, and keeps offering", async () => {
    refusals.push(
      new Error("restricted: not a relay member"),
      new Error("restricted: not a relay member"),
    );
    confirmAnswers.push(true, true, false); // two relay retries, then decline the channel

    await register();

    expect(registerCalls).toHaveLength(3);
    expect(written).toContain("still does not admit this key");
    expect(written).toContain('profile set to "demo"');
  });

  it("stops without failing when the grant has not happened yet", async () => {
    refusals.push(new Error("restricted: not a relay member"));
    confirmAnswers.push(false);

    await expect(register()).resolves.toBeUndefined();

    expect(registerCalls).toHaveLength(1);
    expect(written).toContain("The rest of setup can continue");
    expect(written).not.toContain('profile set to "demo"');
  });

  it("does not offer a human grant for a failure no grant fixes", async () => {
    refusals.push(new Error("relay unreachable"));

    await expect(register()).rejects.toThrow(/relay unreachable/);

    expect(registerCalls).toHaveLength(1);
    expect(written).not.toContain("buzz-admin add-member");
  });
});
