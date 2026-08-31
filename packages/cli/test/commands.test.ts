import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest, SURFACE_EGRESS_TOOL } from "@sageox/agent-toolkit-core";
import { generateKeypair } from "@sageox/agent-toolkit-adapter-buzz";
import {
  addBuzzSurface,
  addOwnerId,
  addSlackSurface,
  hasSurface,
  readAuthorGate,
  setBrainModel,
  setBrainProvider,
  setRespondTo,
} from "../src/edit-config.ts";
import { AGENT_YAML } from "../src/init.ts";
import {
  brainCmd,
  BUZZ_AUTHOR_GATE,
  channelsByNumber,
  SLACK_AUTHOR_GATE,
  classifyChannels,
  reconcilePrivateChannels,
  settleAuthorGate,
  settleChannelReplies,
  surfaceCmd,
  identityCmd,
} from "../src/commands.ts";

describe("setBrainProvider", () => {
  const base = AGENT_YAML("demo");

  it("switches the provider and reports the change", () => {
    const { yaml, changed } = setBrainProvider(base, "claude-acp");
    expect(changed).toBe(true);
    expect(loadManifest(yaml).brain.provider).toBe("claude-acp");
  });

  it("is idempotent — setting what is already set is not an error", () => {
    const once = setBrainProvider(base, "claude-acp").yaml;
    const twice = setBrainProvider(once, "claude-acp");
    expect(twice.changed).toBe(false);
    expect(loadManifest(twice.yaml).brain.provider).toBe("claude-acp");
  });

  it("switches back to mock", () => {
    const claude = setBrainProvider(base, "claude-acp").yaml;
    expect(loadManifest(setBrainProvider(claude, "mock").yaml).brain.provider).toBe("mock");
  });

  it("leaves the rest of the config, and its comments, alone", () => {
    const { yaml } = setBrainProvider(base, "claude-acp");
    const m = loadManifest(yaml);
    expect(m.name).toBe("demo");
    expect(m.surfaces.map((s) => s.kind)).toEqual(["console"]);
    expect(yaml).toContain("This file is data");
  });

  it("reports a config with no brain block instead of silently doing nothing", () => {
    expect(() => setBrainProvider("name: x\nsurfaces: []\n", "claude-acp")).toThrow(/brain/i);
  });
});

describe("setBrainModel", () => {
  // Claude, not the scaffold's mock: the manifest refuses a pin the mock brain cannot run.
  const base = setBrainProvider(AGENT_YAML("demo"), "claude-acp").yaml;

  it("pins the model into the brain block", () => {
    const { yaml, changed } = setBrainModel(base, "claude-opus-5");
    expect(changed).toBe(true);
    expect(loadManifest(yaml).brain.model).toBe("claude-opus-5");
  });

  it("is idempotent — pinning what is already pinned is not an error", () => {
    const once = setBrainModel(base, "claude-opus-5").yaml;
    const twice = setBrainModel(once, "claude-opus-5");
    expect(twice.changed).toBe(false);
    expect(loadManifest(twice.yaml).brain.model).toBe("claude-opus-5");
  });

  it("repins to a different model", () => {
    const opus = setBrainModel(base, "claude-opus-5").yaml;
    expect(loadManifest(setBrainModel(opus, "claude-sonnet-5").yaml).brain.model)
      .toBe("claude-sonnet-5");
  });

  it("leaves the provider and the file's comments alone", () => {
    const { yaml } = setBrainModel(base, "claude-opus-5");
    expect(loadManifest(yaml).brain.provider).toBe("claude-acp");
    expect(yaml).toContain("This file is data");
  });

  it("removes the pin when given no model", () => {
    const pinned = setBrainModel(base, "claude-opus-5").yaml;

    const { yaml, changed } = setBrainModel(pinned, undefined);

    expect(changed).toBe(true);
    expect(loadManifest(yaml).brain.model).toBeUndefined();
    expect(loadManifest(yaml).brain.provider).toBe("claude-acp");
  });

  it("reports no change when there was no pin to remove", () => {
    expect(setBrainModel(base, undefined).changed).toBe(false);
  });

  it("reports a config with no brain block instead of silently doing nothing", () => {
    expect(() => setBrainModel("name: x\nsurfaces: []\n", "claude-opus-5")).toThrow(/brain/i);
  });
});

describe("addBuzzSurface", () => {
  const base = AGENT_YAML("demo");

  it("produces a config that still parses", () => {
    const updated = addBuzzSurface(base, "wss://relay.example");
    expect(() => loadManifest(updated)).not.toThrow();
  });

  it("adds the surface to `surfaces`, not wherever the file happens to end", () => {
    const m = loadManifest(addBuzzSurface(base, "wss://relay.example"));
    expect(m.surfaces.map((s) => s.kind)).toEqual(["console", "buzz"]);
    const buzz = m.surfaces.find((s) => s.kind === "buzz") as Record<string, unknown>;
    expect(buzz.relayUrl).toBe("wss://relay.example");
    expect(buzz.identity).toBe("BUZZ_NSEC");
  });

  it("leaves the rest of the config untouched", () => {
    const m = loadManifest(addBuzzSurface(base, "wss://relay.example"));
    expect(m.name).toBe("demo");
    expect(m.limits.turnTimeoutMs).toBe(120000);
  });

  it("keeps the comments a human wrote", () => {
    const updated = addBuzzSurface(base, "wss://relay.example");
    expect(updated).toContain("This file is data");
  });

  it("refuses to add a second buzz surface", () => {
    const once = addBuzzSurface(base, "wss://relay.example");
    expect(() => addBuzzSurface(once, "wss://other.example")).toThrow(/already/i);
  });

  it("records each channel with the reply it may make there", () => {
    const m = loadManifest(
      addBuzzSurface(base, "wss://relay.example", [
        { id: "hive", reply: "private" },
        { id: "town", reply: "public" },
      ]),
    );
    const buzz = m.surfaces.find((s) => s.kind === "buzz")!;
    expect(buzz.channels).toEqual([
      { id: "hive", reply: "private" },
      { id: "town", reply: "public" },
    ]);
    // The same statement, read the way the guard reads it.
    expect(m.guard.publicChannels).toEqual(["buzz:town"]);
  });

  // `channels: []` and no `channels` key mean opposite things to the adapter: the first
  // subscribes to nothing, the second falls back to a mention filter.
  it("omits `channels` entirely when none are named, rather than writing an empty list", () => {
    expect(addBuzzSurface(base, "wss://relay.example")).not.toContain("channels:");
  });

  it("refuses one channel listed twice, which would answer the reply question twice", () => {
    expect(() =>
      addBuzzSurface(base, "wss://relay.example", [
        { id: "hive", reply: "private" },
        { id: "hive", reply: "public" },
      ]),
    ).toThrow(/listed once/i);
  });

  it("records display names so a person can name a channel out loud", () => {
    const m = loadManifest(
      addBuzzSurface(base, "wss://relay.example", [
        { id: "6f1c-aaa", name: "hive", reply: "private" },
      ]),
    );
    const buzz = m.surfaces.find((s) => s.kind === "buzz")!;
    expect(buzz.channels).toEqual([{ id: "6f1c-aaa", name: "hive", reply: "private" }]);
  });

  it("omits the name entirely when none was learned", () => {
    const m = loadManifest(
      addBuzzSurface(base, "wss://relay.example", [{ id: "6f1c-aaa", reply: "private" }]),
    );
    expect(m.surfaces.find((s) => s.kind === "buzz")!.channels).toEqual([
      { id: "6f1c-aaa", reply: "private" },
    ]);
  });
});

describe("agent-local credentials", () => {
  let root: string;
  let agentDir: string;
  const savedHome = process.env.AGENT_TOOLKIT_HOME;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedNsec = process.env.BUZZ_NSEC;
  const savedBuzzPrivateKey = process.env.BUZZ_PRIVATE_KEY;
  const savedSlackBot = process.env.SLACK_BOT_TOKEN;
  const savedSlackApp = process.env.SLACK_APP_TOKEN;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sageox-agent-commands-"));
    agentDir = join(root, "demo");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "agent.yaml"), AGENT_YAML("demo"));
    process.env.AGENT_TOOLKIT_HOME = root;
    // Cleared, not merely saved: `readEnvValue` checks the environment before the agent's
    // own .env, so an inherited value would let these pass without reading the file at all.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.BUZZ_NSEC;
    delete process.env.BUZZ_PRIVATE_KEY;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.AGENT_TOOLKIT_HOME;
    else process.env.AGENT_TOOLKIT_HOME = savedHome;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedNsec === undefined) delete process.env.BUZZ_NSEC;
    else process.env.BUZZ_NSEC = savedNsec;
    if (savedBuzzPrivateKey === undefined) delete process.env.BUZZ_PRIVATE_KEY;
    else process.env.BUZZ_PRIVATE_KEY = savedBuzzPrivateKey;
    if (savedSlackBot === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedSlackBot;
    if (savedSlackApp === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = savedSlackApp;
  });

  it("brain claude resolves the key from the selected agent's .env", async () => {
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");

    await expect(brainCmd(["claude"])).resolves.toBeUndefined();

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).brain.provider)
      .toBe("claude-acp");
  });

  it("does not switch to Claude when its credential is missing", async () => {
    await expect(brainCmd(["claude"])).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).brain.provider)
      .toBe("mock");
  });

  it("brain claude --model pins the model alongside the provider", async () => {
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");

    await expect(brainCmd(["claude", "--model", "claude-opus-5"])).resolves.toBeUndefined();

    const m = loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
    expect(m.brain.provider).toBe("claude-acp");
    expect(m.brain.model).toBe("claude-opus-5");
  });

  it("repins an already-Claude agent without needing the provider to change", async () => {
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");
    await brainCmd(["claude", "--model", "claude-opus-5"]);

    await brainCmd(["claude", "--model", "claude-sonnet-5"]);

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).brain.model)
      .toBe("claude-sonnet-5");
  });

  it("refuses --model with no value rather than pinning nothing", async () => {
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");

    await expect(brainCmd(["claude", "--model"])).rejects.toThrow(/--model needs/);

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).brain.model)
      .toBeUndefined();
  });

  it("refuses to read the next option as the model id", async () => {
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");

    await expect(brainCmd(["claude", "--model", "--agent", "solo"])).rejects.toThrow(/--model needs/);

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).brain.model)
      .toBeUndefined();
  });

  it("clears the pin on the way to mock, and does not restore it on the way back", async () => {
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=sk-ant-agent-local\n");
    await brainCmd(["claude", "--model", "claude-opus-5"]);

    await brainCmd(["mock"]);
    const mocked = loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
    expect(mocked.brain.provider).toBe("mock");
    expect(mocked.brain.model).toBeUndefined();

    await brainCmd(["claude"]);
    const back = loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
    expect(back.brain.provider).toBe("claude-acp");
    expect(back.brain.model).toBeUndefined();
  });

  it("refuses --model on the mock brain, which runs no model", async () => {
    await expect(brainCmd(["mock", "--model", "claude-opus-5"])).rejects.toThrow(/mock brain/i);

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).brain.model)
      .toBeUndefined();
  });

  it("leaves the provider unswitched when the pin cannot be written", async () => {
    await expect(brainCmd(["claude", "--model", "claude-opus-5"]))
      .rejects.toThrow(/ANTHROPIC_API_KEY is not set/);

    const m = loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
    expect(m.brain.provider).toBe("mock");
    expect(m.brain.model).toBeUndefined();
  });

  it("surface buzz resolves the identity from the selected agent's .env", async () => {
    writeFileSync(join(agentDir, ".env"), "BUZZ_NSEC=nsec1agentlocal\n");

    await expect(
      surfaceCmd(["buzz", "--relay", "wss://relay.example"]),
    ).resolves.toBeUndefined();

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).surfaces)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "buzz" })]));
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
  });

  it("attaches an identity exported as BUZZ_NSEC to a rebuilt agent bundle", async () => {
    const identity = generateKeypair();
    process.env.BUZZ_NSEC = identity.nsec;

    await identityCmd(["attach"]);

    expect(readFileSync(join(agentDir, ".env"), "utf8"))
      .toBe(`BUZZ_NSEC=${identity.nsec}\n`);
  });

  it("accepts an existing identity in its hex encoding", async () => {
    const hex = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
    process.env.BUZZ_NSEC = hex;

    await identityCmd(["attach"]);

    expect(readFileSync(join(agentDir, ".env"), "utf8")).toBe(`BUZZ_NSEC=${hex}\n`);
  });

  // The `buzz` CLI's own variable usually holds the operator's personal key. Taking it
  // would sign this agent's events as that human, so it is asked for, never inherited.
  it("never inherits the buzz CLI's BUZZ_PRIVATE_KEY", async () => {
    process.env.BUZZ_PRIVATE_KEY = generateKeypair().nsec;

    await expect(identityCmd(["attach"])).rejects.toThrow(/BUZZ_NSEC is not set/);

    expect(existsSync(join(agentDir, ".env"))).toBe(false);
  });

  it("refuses a malformed ambient BUZZ_NSEC rather than saving it", async () => {
    process.env.BUZZ_NSEC = "not-a-private-key";

    await expect(identityCmd(["attach"])).rejects.toThrow(/BUZZ_NSEC is not a valid nsec/);

    expect(existsSync(join(agentDir, ".env"))).toBe(false);
  });

  // An exported key wins over .env in every later command, so an attach that reported the
  // saved identity as kept would be naming one the agent never signs as. Both of these
  // refuse instead, and leave the saved key exactly where it was.
  it("refuses an exported key that would shadow the identity already attached", async () => {
    const attached = generateKeypair();
    writeFileSync(join(agentDir, ".env"), `BUZZ_NSEC=${attached.nsec}\n`);
    process.env.BUZZ_NSEC = generateKeypair().nsec;

    await expect(identityCmd(["attach"])).rejects.toThrow(/would shadow the identity already/);

    expect(readFileSync(join(agentDir, ".env"), "utf8"))
      .toBe(`BUZZ_NSEC=${attached.nsec}\n`);
  });

  it("refuses a malformed exported key shadowing the identity already attached", async () => {
    const attached = generateKeypair();
    writeFileSync(join(agentDir, ".env"), `BUZZ_NSEC=${attached.nsec}\n`);
    process.env.BUZZ_NSEC = "not-a-private-key";

    await expect(identityCmd(["attach"])).rejects.toThrow(/BUZZ_NSEC is not a valid nsec/);

    expect(readFileSync(join(agentDir, ".env"), "utf8"))
      .toBe(`BUZZ_NSEC=${attached.nsec}\n`);
  });

  // `create` answers a request for a new identity, so it reads this agent's own .env and
  // not the shell. Reporting an exported key as "already exists" would leave the bundle
  // with no key of its own, and generating under one would be shadowed by it either way.
  it("creates this agent's own identity rather than reporting an exported one", async () => {
    await identityCmd(["create"]);

    expect(readFileSync(join(agentDir, ".env"), "utf8")).toMatch(/^BUZZ_NSEC=nsec1\S+\n$/);
  });

  it("refuses to create an identity an exported BUZZ_NSEC would shadow", async () => {
    process.env.BUZZ_NSEC = generateKeypair().nsec;

    await expect(identityCmd(["create"])).rejects.toThrow(/would shadow a newly created/);

    expect(existsSync(join(agentDir, ".env"))).toBe(false);
  });

  it("does not replace an identity already attached to the agent", async () => {
    // The same secret in both encodings: equivalent, so nothing is being shadowed.
    const nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
    const hex = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
    writeFileSync(join(agentDir, ".env"), `BUZZ_NSEC=${nsec}\n`);
    process.env.BUZZ_NSEC = hex;

    await identityCmd(["attach"]);

    expect(readFileSync(join(agentDir, ".env"), "utf8")).toBe(`BUZZ_NSEC=${nsec}\n`);
  });

  // Without these the surface has no post target, so a cross-post to Buzz has nowhere
  // to go however the tool policy is written.
  it("surface buzz records the channels it may listen and post in", async () => {
    writeFileSync(join(agentDir, ".env"), "BUZZ_NSEC=nsec1agentlocal\n");

    await surfaceCmd(
      ["buzz", "--relay", "wss://relay.example", "--channels", "hive,town", "--private-channels", "hive"],
    );

    const manifest = loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
    const buzz = manifest.surfaces.find((surface) => surface.kind === "buzz")!;
    // `town` was named but not asserted private and consent was never given, so it is not
    // listed at all — a channel the agent would hear in and never answer in.
    expect(buzz.channels).toEqual([{ id: "hive", reply: "private" }]);
    expect(manifest.guard.publicChannels).toEqual([]);
  });

  it("surface buzz grants a named public channel only with explicit consent", async () => {
    writeFileSync(join(agentDir, ".env"), "BUZZ_NSEC=nsec1agentlocal\n");

    await surfaceCmd(
      ["buzz", "--relay", "wss://relay.example", "--channels", "town", "--allow-public"],
    );

    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).guard.publicChannels)
      .toEqual(["buzz:town"]);
  });

  // `--channels --allow-public` reads the next option as the value, which would be
  // written as a channel id and then consented to as `buzz:--allow-public`.
  it.each([
    ["--channels"],
    ["--private-channels"],
  ])("surface buzz refuses %s when the next argument is another option", async (name) => {
    writeFileSync(join(agentDir, ".env"), "BUZZ_NSEC=nsec1agentlocal\n");

    await expect(
      surfaceCmd(["buzz", "--relay", "wss://relay.example", name, "--allow-public"]),
    ).rejects.toThrow(new RegExp(`${name} needs a comma-separated list`));
    expect(loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8")).surfaces)
      .toEqual([expect.objectContaining({ kind: "console" })]);
  });

  it("surface buzz refuses a private channel it was never told to listen in", async () => {
    writeFileSync(join(agentDir, ".env"), "BUZZ_NSEC=nsec1agentlocal\n");

    await expect(
      surfaceCmd(
        ["buzz", "--relay", "wss://relay.example", "--channels", "hive", "--private-channels", "ops"],
      ),
    ).rejects.toThrow(/--private-channels must also appear in --channels/);
  });

  it("enables cross-post when the second networked surface is added without replacing policy", async () => {
    writeFileSync(
      join(agentDir, ".env"),
      "BUZZ_NSEC=nsec1agentlocal\nSLACK_BOT_TOKEN=xoxb-agent-local\nSLACK_APP_TOKEN=xapp-agent-local\n",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["Bash(git status)"],
          deny: ["Read(./.env)"],
        },
        existingAgentData: { keep: true },
      }),
    );

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);
    await surfaceCmd(
      ["slack", "--channels", "GENG", "--private-channels", "GENG"],
    );

    const manifest = loadManifest(readFileSync(join(agentDir, "agent.yaml"), "utf8"));
    expect(manifest.surfaces.map((surface) => surface.kind)).toEqual(["console", "buzz", "slack"]);
    expect(manifest.limits.turnTimeoutMs).toBe(120000);

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(git status)", SURFACE_EGRESS_TOOL]);
    expect(settings.permissions.deny).toEqual(["Read(./.env)"]);
    expect(settings.existingAgentData).toEqual({ keep: true });
  });

  it("also enables cross-post when Buzz is the second networked surface", async () => {
    writeFileSync(
      join(agentDir, ".env"),
      "BUZZ_NSEC=nsec1agentlocal\nSLACK_BOT_TOKEN=xoxb-agent-local\nSLACK_APP_TOKEN=xapp-agent-local\n",
    );

    await surfaceCmd(
      ["slack", "--channels", "GENG", "--private-channels", "GENG"],
    );
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);

    await surfaceCmd(["buzz", "--relay", "wss://relay.example"]);

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain(SURFACE_EGRESS_TOOL);
  });
});

describe("addSlackSurface", () => {
  const base = AGENT_YAML("demo");

  it("adds token references and the reply each channel allows", () => {
    const manifest = loadManifest(
      addSlackSurface(base, [
        { id: "C123", reply: "public" },
        { id: "G456", reply: "private" },
      ]),
    );
    const slack = manifest.surfaces.find((surface) => surface.kind === "slack")!;
    expect(slack).toMatchObject({
      identity: "SLACK_BOT_TOKEN",
      appToken: "SLACK_APP_TOKEN",
      channels: [
        { id: "C123", reply: "public" },
        { id: "G456", reply: "private" },
      ],
    });
    expect(manifest.guard.publicChannels).toEqual(["slack:C123"]);
  });

  // No channel id names a DM — `message.im` is what opens that path — so a surface with
  // an empty list is a DM-only agent rather than one that was configured wrong.
  it("writes a channel-less surface, which is a DM-only agent", () => {
    const manifest = loadManifest(addSlackSurface(base, []));
    expect(manifest.surfaces.find((surface) => surface.kind === "slack")!.channels).toEqual([]);
  });

  it("refuses a duplicate surface", () => {
    const once = addSlackSurface(base, [{ id: "G456", reply: "private" }]);
    expect(() => addSlackSurface(once, [{ id: "G789", reply: "private" }])).toThrow(/already/i);
  });
});

describe("addOwnerId", () => {
  const owned = setRespondTo(AGENT_YAML("demo"), "owner-only").yaml;

  it("promotes a scalar owner to a list rather than replacing it", () => {
    const first = addOwnerId(owned, "npub1buzz").yaml;
    const { yaml, changed } = addOwnerId(first, "U08SLACK");

    expect(changed).toBe(true);
    // The npub survives: replacing it would lock the owner out of the surface they had.
    expect(readAuthorGate(yaml).owner).toEqual(["npub1buzz", "U08SLACK"]);
  });

  it("is idempotent, so re-running `surface slack` does not duplicate the id", () => {
    const once = addOwnerId(owned, "U08SLACK").yaml;
    const twice = addOwnerId(once, "U08SLACK");

    expect(twice.changed).toBe(false);
    expect(readAuthorGate(twice.yaml).owner).toEqual(["U08SLACK"]);
  });
});

describe("readAuthorGate", () => {
  it("reads a manifest that does not yet satisfy the schema", () => {
    // owner-only with no owner fails `loadManifest`, and is exactly the state the
    // command exists to repair — it has to be readable to be fixed.
    const broken = setRespondTo(AGENT_YAML("demo"), "owner-only").yaml;
    expect(() => loadManifest(broken)).toThrow();

    expect(readAuthorGate(broken)).toEqual({ respondTo: "owner-only", owner: [] });
  });
});

describe("settleChannelReplies", () => {
  const noFlags: string[] = [];
  const priv = { id: "G1", reply: "private" } as const;
  const open = { id: "C1", reply: "public" } as const;

  it("asks nothing when every channel is private", async () => {
    expect(await settleChannelReplies([priv], [], noFlags)).toEqual([priv]);
  });

  it("drops a public channel without --allow-public, so nothing is opened unasked", async () => {
    // No terminal under vitest, so this is the non-interactive path: declining is the
    // default, and the one that fails closed.
    expect(await settleChannelReplies([priv, open], [], noFlags)).toEqual([priv]);
  });

  it("keeps a public channel on --allow-public, and only the ones named", async () => {
    // Consent to this channel is not consent to every public destination the agent has:
    // what is written is the entry, and the guard reads exactly the entries.
    const settled = await settleChannelReplies([priv, open], [], ["--allow-public"]);
    expect(settled).toEqual([priv, open]);
  });

  it("treats an unclassified channel as one to consent to as well", async () => {
    expect(await settleChannelReplies([open], ["C1"], noFlags)).toEqual([]);
    expect(await settleChannelReplies([open], ["C1"], ["--allow-public"])).toEqual([open]);
  });
});

describe("reconcilePrivateChannels", () => {
  it("drops an assertion Slack contradicts, so declining consent actually refuses", () => {
    // The adapter seeds its private set from config and only ever adds to it, so a stale
    // `--private-channels C1` would make normalization call a public channel private and
    // the guard would never fire — bypassing the rule the operator just kept on.
    const result = reconcilePrivateChannels(["C1"], { confirmedPrivate: [], publicChannels: ["C1"] });

    expect(result.privateChannels).toEqual([]);
    expect(result.disputed).toEqual(["C1"]);
  });

  it("adds what Slack confirms private without the human having to assert it", () => {
    const result = reconcilePrivateChannels([], { confirmedPrivate: ["G1"], publicChannels: [] });
    expect(result.privateChannels).toEqual(["G1"]);
    expect(result.disputed).toEqual([]);
  });

  it("keeps an assertion Slack could not classify, which is what the flag is for", () => {
    // Not in publicChannels means Slack never said public — a missing scope, not a denial.
    const result = reconcilePrivateChannels(["G1"], { confirmedPrivate: [], publicChannels: [] });
    expect(result.privateChannels).toEqual(["G1"]);
    expect(result.disputed).toEqual([]);
  });

  it("does not duplicate a channel both asserted and confirmed", () => {
    const result = reconcilePrivateChannels(["G1"], { confirmedPrivate: ["G1"], publicChannels: [] });
    expect(result.privateChannels).toEqual(["G1"]);
  });
});

describe("hasSurface", () => {
  it("sees a slack surface before any credential is prompted for", () => {
    const base = AGENT_YAML("demo");
    expect(hasSurface(base, "slack")).toBe(false);
    expect(hasSurface(addSlackSurface(base, [{ id: "G1", reply: "private" }]), "slack")).toBe(true);
    // Reaching addSlackSurface's own duplicate check costs two token prompts and a
    // Slack API call first, so `surface slack` asks this before either.
    expect(hasSurface(base, "console")).toBe(true);
  });
});

describe("settleAuthorGate", () => {
  const owned = setRespondTo(AGENT_YAML("demo"), "owner-only").yaml;

  it("adds --owner-id without evicting the id another surface depends on", async () => {
    const withBuzz = addOwnerId(owned, "npub1buzz").yaml;
    const settled = await settleAuthorGate(withBuzz, ["--owner-id", "U08SLACK"], SLACK_AUTHOR_GATE);

    expect(readAuthorGate(settled).owner).toEqual(["npub1buzz", "U08SLACK"]);
  });

  it("leaves a gate that is not owner-only alone", async () => {
    const open = setRespondTo(AGENT_YAML("demo"), "anyone").yaml;
    expect(await settleAuthorGate(open, ["--owner-id", "U08SLACK"], SLACK_AUTHOR_GATE)).toBe(open);
  });

  it("does not re-ask once a Slack id is present", async () => {
    const settled = addOwnerId(owned, "U08SLACK").yaml;
    expect(await settleAuthorGate(settled, ["--owner-id", "U0OTHER"], SLACK_AUTHOR_GATE)).toBe(settled);
  });

  it("does not mistake an npub for a Slack id", async () => {
    // Both are opaque strings; only the Slack-shaped one satisfies this surface.
    const withBuzz = addOwnerId(owned, "npub1buzz").yaml;
    const settled = await settleAuthorGate(withBuzz, ["--owner-id", "U08SLACK"], SLACK_AUTHOR_GATE);
    expect(readAuthorGate(settled).owner).toContain("U08SLACK");
  });

  it("returns the config untouched when nobody answered", async () => {
    // No terminal and no flag: it reports rather than guessing an owner.
    expect(await settleAuthorGate(owned, [], SLACK_AUTHOR_GATE)).toBe(owned);
  });

  it("settles the Buzz gate on a Nostr id, and does not accept a Slack one for it", async () => {
    const withSlack = addOwnerId(owned, "U08SLACK").yaml;
    const settled = await settleAuthorGate(
      withSlack,
      ["--owner-id", "npub1buzz"],
      BUZZ_AUTHOR_GATE,
    );

    // The Slack id was already there and is kept; it just does not answer for Buzz.
    expect(readAuthorGate(settled).owner).toEqual(["U08SLACK", "npub1buzz"]);
    // Now that a Nostr id is present the Buzz gate is settled and stops asking.
    expect(await settleAuthorGate(settled, ["--owner-id", "npub1other"], BUZZ_AUTHOR_GATE))
      .toBe(settled);
  });

  // Same hole as the channel flags: `flag` reads whatever token follows, so this would
  // otherwise write "--allow-public" as the owner and match nobody.
  it("refuses --owner-id when the next argument is another option", async () => {
    await expect(
      settleAuthorGate(owned, ["--owner-id", "--allow-public"], BUZZ_AUTHOR_GATE),
    ).rejects.toThrow(/--owner-id needs a member id/);
  });

  it("accepts the hex spelling the manifest normalizes an npub to", async () => {
    const hex = "a".repeat(64);
    const withHex = addOwnerId(owned, hex).yaml;
    expect(await settleAuthorGate(withHex, ["--owner-id", "npub1other"], BUZZ_AUTHOR_GATE))
      .toBe(withHex);
  });
});

describe("channelsByNumber", () => {
  const offered = [
    { channel_id: "6f1c-aaa", name: "hive" },
    { channel_id: "6f1c-bbb", name: "town" },
    { channel_id: "6f1c-ccc", name: "general" },
  ];

  it("maps menu numbers to the channels behind them", () => {
    expect(channelsByNumber(offered, ["1", "3"]).map((c) => c.channel_id))
      .toEqual(["6f1c-aaa", "6f1c-ccc"]);
  });

  it("picks nothing when nothing was picked", () => {
    expect(channelsByNumber(offered, [])).toEqual([]);
  });

  it("collapses the same channel picked twice", () => {
    expect(channelsByNumber(offered, ["2", "2"]).map((c) => c.channel_id)).toEqual(["6f1c-bbb"]);
  });

  // Dropping the bad one would configure two of the three channels someone asked for,
  // which they would only notice as an agent ignoring one of them.
  it.each([["4"], ["0"], ["-1"], ["two"]])("refuses the whole selection over %s", (bad) => {
    expect(() => channelsByNumber(offered, ["1", bad])).toThrow(/no channel numbered/);
  });
});

describe("classifyChannels", () => {
  const api = (answers: Record<string, boolean | undefined | Error>) => ({
    channelIsPrivate: async (id: string) => {
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });

  it("sorts channels by what Slack says, not by what the id looks like", async () => {
    // C-prefixed ids are private channels too, which is why the prefix cannot be trusted.
    const result = await classifyChannels(api({ C1: true, C2: false }), ["C1", "C2"]);

    expect(result.confirmedPrivate).toEqual(["C1"]);
    expect(result.publicChannels).toEqual(["C2"]);
    expect(result.unknown).toEqual([]);
  });

  it("keeps `could not ask` apart from `Slack said public`", async () => {
    const result = await classifyChannels(
      api({ C1: undefined, C2: new Error("missing_scope") }),
      ["C1", "C2"],
    );

    expect(result.unknown).toEqual(["C1", "C2"]);
    expect(result.publicChannels).toEqual([]);
  });

  it("does not throw, so a bad channel id cannot lose the tokens already staged", async () => {
    await expect(classifyChannels(api({ C1: new Error("channel_not_found") }), ["C1"]))
      .resolves.toMatchObject({ unknown: ["C1"] });
  });
});
