import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "@sageox/agent-toolkit-core";
import { AGENT_YAML } from "../src/init.ts";

/** Answers handed to `promptLine`, in order, by whichever test is running. */
const answers: string[] = [];
/** Answers handed to `promptConfirm` — only the membership retry asks one here. */
const confirms: boolean[] = [];
const relayChannels: Array<{ channel_id: string; name: string }> = [];
/** Refusals to serve before the listing succeeds, oldest first. */
const listRefusals: Error[] = [];

vi.mock("../src/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prompt.ts")>()),
  isInteractive: () => true,
  promptLine: async () => answers.shift() ?? "",
  promptConfirm: async () => confirms.shift() ?? false,
}));

vi.mock("../src/register.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/register.ts")>()),
  listChannels: async () => {
    const refusal = listRefusals.shift();
    if (refusal) throw refusal;
    return relayChannels;
  },
}));

const { surfaceCmd } = await import("../src/commands.ts");

function buzzSurface(dir: string): Record<string, unknown> {
  const manifest = loadManifest(readFileSync(join(dir, "agent.yaml"), "utf8"));
  return manifest.surfaces.find((s) => s.kind === "buzz") as Record<string, unknown>;
}

describe("surface buzz channel menu", () => {
  let root: string;
  let agentDir: string;
  const savedHome = process.env.AGENT_TOOLKIT_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sageox-agent-pick-"));
    agentDir = join(root, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "agent.yaml"), AGENT_YAML("demo"));
    writeFileSync(join(agentDir, ".env"), "BUZZ_NSEC=nsec1agentlocal\n");
    process.env.AGENT_TOOLKIT_HOME = root;
    answers.length = 0;
    confirms.length = 0;
    listRefusals.length = 0;
    relayChannels.length = 0;
    relayChannels.push(
      { channel_id: "6f1c-aaa", name: "hive" },
      { channel_id: "9a3b-bbb", name: "town" },
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = savedHome;
  });

  // Both questions are numbered off the same menu. Asking for ids after showing a list
  // is how a channel someone picked becomes one the guard has never heard of.
  it("takes both the channels and their privacy as menu numbers", async () => {
    // The third answer is the consent the public one now needs: `reply: public` is the
    // grant the guard reads, so it is given before the channel is written down.
    answers.push("1,2", "1", "y");

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    expect(buzzSurface(agentDir)).toMatchObject({
      channels: [
        { id: "6f1c-aaa", name: "hive", reply: "private" },
        { id: "9a3b-bbb", name: "town", reply: "public" },
      ],
    });
  });

  // Declining is not "listen there anyway": a channel the agent may not answer in is
  // advertised as mentionable, wakes it, and swallows the reply.
  it("leaves a public channel out of the list when consent is declined", async () => {
    answers.push("1,2", "1", "n");

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    expect(buzzSurface(agentDir).channels).toEqual([
      { id: "6f1c-aaa", name: "hive", reply: "private" },
    ]);
  });

  it("configures no channels when nothing is picked, and asks nothing further", async () => {
    answers.push("");

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    // `channels` is absent rather than empty: the adapter reads a missing list as "hear
    // mentions instead", which is what an agent with no channels is for.
    expect(readFileSync(join(agentDir, "agent.yaml"), "utf8")).not.toContain("channels:");
    expect(buzzSurface(agentDir).channels).toEqual([]);
    // The privacy question was never reached, so its answer is still queued.
    expect(answers).toHaveLength(0);
  });

  it("refuses the whole selection when a number is not on the menu", async () => {
    answers.push("1,5");

    await expect(surfaceCmd(["buzz", "--relay", "wss://relay.example"])).rejects.toThrow(
      /no channel numbered 5/,
    );
  });

  // Offering a menu and then ignoring what was typed on the command line would be worse
  // than never offering one.
  it("skips the menu when either channel flag is given", async () => {
    await surfaceCmd(
      ["buzz", "--relay", "wss://relay.example", "--private-channels", "6f1c-aaa", "--channels", "6f1c-aaa"],
    );

    expect(buzzSurface(agentDir).channels).toEqual([{ id: "6f1c-aaa", reply: "private" }]);
  });

  // The surface step is where a guided `create` meets a gated relay first. Falling back
  // here would ask for ids the relay just refused to show, and leave the grant to be
  // discovered one step later anyway.
  it("offers the grant and waits, rather than asking for ids the relay would not list", async () => {
    listRefusals.push(new Error("relay error 403: relay_membership_required"));
    confirms.push(true);
    answers.push("1", "1");
    let written = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written += String(chunk);
      return true;
    });

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    expect(written).toContain("buzz-admin add-member --pubkey");
    // The menu came from the relay on the retry, so the id was never typed by hand.
    expect(buzzSurface(agentDir).channels).toEqual([{ id: "6f1c-aaa", name: "hive", reply: "private" }]);
  });

  it("still falls back to typed ids when the wait is declined", async () => {
    listRefusals.push(new Error("relay error 403: relay_membership_required"));
    confirms.push(false);
    answers.push("6f1c-aaa", "6f1c-aaa");

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    expect(buzzSurface(agentDir).channels).toEqual([{ id: "6f1c-aaa", reply: "private" }]);
  });

  it("falls back to typed ids when the relay cannot be listed", async () => {
    relayChannels.length = 0;
    answers.push("6f1c-aaa", "6f1c-aaa");

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    expect(buzzSurface(agentDir).channels).toEqual([{ id: "6f1c-aaa", reply: "private" }]);
  });
});
