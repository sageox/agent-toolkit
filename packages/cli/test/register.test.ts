import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, toHexPubkey } from "@sageox/agent-toolkit-adapter-buzz";
import { loadManifest } from "@sageox/agent-toolkit-core";
import {
  addBotToChannel,
  buzzCli,
  allowlistDrift,
  directoryFor,
  sameRelay,
  type BuzzSurfaceChannels,
  canonicalPng,
  isRelayMembershipError,
  prepareAvatarForUpload,
  relayMembershipHandoff,
  toHttpBase,
  registerAgent,
  listChannels,
  type BuzzCli,
} from "../src/register.ts";

import { CLI, run } from "./cli-harness.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** Records what the buzz CLI was asked to do, and what env it was given. */
function fakeCli(responses: Record<string, string> = {}) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const cli: BuzzCli = async (args, env) => {
    calls.push({ args, env });
    const key = `${args[0]} ${args[1]}`;
    return responses[key] ?? JSON.stringify({ accepted: true, event_id: "e1", message: "" });
  };
  return { cli, calls };
}

describe("toHttpBase", () => {
  it("derives the CLI's base URL from the relay websocket URL", () => {
    expect(toHttpBase("wss://buzz.example.ai")).toBe("https://buzz.example.ai");
    expect(toHttpBase("ws://localhost:3000")).toBe("http://localhost:3000");
  });
  it("leaves an http base alone", () => {
    expect(toHttpBase("https://buzz.example.ai")).toBe("https://buzz.example.ai");
  });
});

describe("isRelayMembershipError", () => {
  it("recognizes the relay's NIP-43 denial", () => {
    expect(isRelayMembershipError(new Error("restricted: not a relay member"))).toBe(true);
    expect(isRelayMembershipError(new Error("You must be a relay member to access this relay"))).toBe(true);
  });

  // The spelling the relay actually sends, forwarded by the `buzz` client verbatim. It was
  // missed by a regex written for the prose form, and `create` looped on the question.
  it("recognizes the relay's own 403 code", () => {
    expect(
      isRelayMembershipError(
        new Error(
          'buzz channels list failed: {"error":"auth_error","message":"relay error 403: ' +
            'relay_membership_required","retryable":false}',
        ),
      ),
    ).toBe(true);
  });

  it("does not hide channel-level or unrelated registration failures", () => {
    expect(isRelayMembershipError(new Error("channel is invite-only"))).toBe(false);
    expect(isRelayMembershipError(new Error("relay unreachable"))).toBe(false);
  });

  it("lets identity setup continue after a membership-gated relay refuses the key", async () => {
    const root = mkdtempSync(join(tmpdir(), "buzz-register-membership-"));
    const agent = join(root, "demo");
    const bin = join(root, "bin");
    mkdirSync(agent);
    mkdirSync(bin);
    const key = generateKeypair();
    writeFileSync(join(agent, ".env"), `BUZZ_NSEC=${key.nsec}\n`);
    writeFileSync(join(agent, "profile.json"), '{"display_name":"demo"}\n');
    writeFileSync(
      join(bin, "buzz"),
      '#!/bin/sh\nprintf \'%s\\n\' \'{"error":"auth","message":"restricted: not a relay member"}\' >&2\nexit 3\n',
      { mode: 0o755 },
    );

    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_TOOLKIT_HOME: root,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      };
      delete env.BUZZ_NSEC;
      const { stdout } = await run(
        CLI,
        ["identity", "register", "buzz", "--agent", "demo", "--relay", "wss://closed.example", "--channel", "town"],
        { env },
      );

      expect(stdout).toContain("relay membership required");
      expect(stdout).toContain(key.npub);
      expect(stdout).toContain("The rest of setup can continue");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relayMembershipHandoff", () => {
  const key = generateKeypair();
  const hex = toHexPubkey(key.npub);

  it("names both grants, in the spelling each command takes", () => {
    const text = relayMembershipHandoff({
      relayUrl: "wss://closed.example",
      nsec: key.nsec,
      channel: "9a3b-town",
    });
    // `buzz-admin` takes either spelling; `buzz channels add-member` matches on hex, so an
    // npub there is a command that runs and grants nothing.
    expect(text).toContain(`buzz-admin add-member --pubkey ${key.npub}`);
    // The relay and the key are global `buzz` options that this subcommand does not carry,
    // and an omitted --relay is localhost — a command that grants a role somewhere else.
    expect(text).toContain("BUZZ_PRIVATE_KEY=<channel owner or admin nsec>");
    expect(text).toContain("buzz --relay https://closed.example channels add-member");
    expect(text).toContain(`--channel 9a3b-town --pubkey ${hex} --role bot`);
  });

  // The handoff reports a *relay* failure. A key that will not decode is a second problem,
  // and throwing on it here would replace the two commands with a bech32 error.
  it("falls back to placeholders rather than throwing on a key that will not decode", () => {
    const text = relayMembershipHandoff({
      relayUrl: "wss://closed.example",
      nsec: "nsec1doctor",
      channel: "9a3b-town",
    });
    expect(text).toContain("buzz-admin add-member --pubkey <the agent npub>");
    expect(text).toContain("--pubkey <the agent pubkey, hex> --role bot");
  });

  it("leaves the channel a placeholder when the relay never listed one", () => {
    const text = relayMembershipHandoff({ relayUrl: "wss://closed.example", nsec: key.nsec });
    expect(text).toContain("--channel <channel-uuid>");
  });
});

describe("registerAgent", () => {
  const key = generateKeypair();
  const opts = {
    relayUrl: "wss://buzz.example.ai",
    nsec: key.nsec,
    name: "harry",
  };

  it("sets the profile without attempting human-owned channel membership", async () => {
    const f = fakeCli();
    await registerAgent(opts, f.cli);

    expect(f.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["users set-profile"]);
    expect(f.calls[0].args).toContain("harry");
  });

  it("signs with the agent's own key — no admin credential", async () => {
    const f = fakeCli();
    await registerAgent(opts, f.cli);
    for (const call of f.calls) {
      expect(call.env.BUZZ_PRIVATE_KEY).toBe(key.nsec);
      expect(call.env.BUZZ_RELAY_URL).toBe("https://buzz.example.ai");
    }
  });

  it("stops if the relay rejects the profile", async () => {
    const f = fakeCli({
      "users set-profile": JSON.stringify({ accepted: false, message: "not permitted" }),
    });
    await expect(registerAgent(opts, f.cli)).rejects.toThrow(/not permitted/);
    expect(f.calls).toHaveLength(1); // never attempted the membership
  });

  it("passes an about line through when given", async () => {
    const f = fakeCli();
    await registerAgent({ ...opts, about: "a test agent" }, f.cli);
    expect(f.calls[0].args).toContain("--about");
    expect(f.calls[0].args).toContain("a test agent");
  });

  it("uploads the avatar, then republishes every profile field before joining", async () => {
    const f = fakeCli({
      "upload file": "uploaded https://media.example.ai/harry.png\n",
    });
    await registerAgent(
      {
        ...opts,
        about: "the camp guide",
        nip05: "harry@example.ai",
        avatar: "/tmp/avatar.png",
      },
      f.cli,
    );

    expect(f.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "upload file",
      "users set-profile",
    ]);
    expect(f.calls[0].args).toEqual(["upload", "file", "--file", "/tmp/avatar.png"]);
    expect(f.calls[1].args).toEqual([
      "users", "set-profile",
      "--name", "harry",
      "--about", "the camp guide",
      "--nip05", "harry@example.ai",
      "--avatar", "https://media.example.ai/harry.png",
    ]);
  });

  it("stops when an avatar upload returns no URL", async () => {
    const f = fakeCli({ "upload file": "uploaded, but the relay returned no location" });
    await expect(registerAgent({ ...opts, avatar: "/tmp/avatar.png" }, f.cli)).rejects.toThrow(
      /no URL/,
    );
    expect(f.calls).toHaveLength(1);
  });
});

describe("addBotToChannel", () => {
  it("uses the owner key once while adding the agent key with the bot role", async () => {
    const agent = generateKeypair();
    const owner = generateKeypair();
    const f = fakeCli();

    await addBotToChannel({
      relayUrl: "wss://buzz.example.ai",
      agentNsec: agent.nsec,
      channelOwnerNsec: owner.nsec,
      channel: "chan-uuid",
    }, f.cli);

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args).toEqual([
      "channels", "add-member",
      "--channel", "chan-uuid",
      "--pubkey", agent.hex,
      "--role", "bot",
    ]);
    // Strict: `toEqual` treats an `undefined` value as an absent key, which would let the
    // BUZZ_AUTH_TAG sentinel — the thing that unsets an inherited tag — go unasserted.
    expect(f.calls[0].env).toStrictEqual({
      BUZZ_RELAY_URL: "https://buzz.example.ai",
      BUZZ_PRIVATE_KEY: owner.nsec,
      BUZZ_AUTH_TAG: undefined,
    });
  });

  it("refuses to assign the role with the agent's own key", async () => {
    const agent = generateKeypair();
    const f = fakeCli();
    await expect(addBotToChannel({
      relayUrl: "wss://buzz.example.ai",
      agentNsec: agent.nsec,
      channelOwnerNsec: agent.nsec,
      channel: "chan-uuid",
    }, f.cli)).rejects.toThrow(/must be different/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("buzzCli", () => {
  it("unsets an inherited BUZZ_AUTH_TAG rather than passing an owner's tag through", async () => {
    const bin = mkdtempSync(join(tmpdir(), "buzz-cli-env-"));
    writeFileSync(join(bin, "buzz"), '#!/bin/sh\nprintf \'tag=%s\\n\' "${BUZZ_AUTH_TAG-unset}"\n', {
      mode: 0o755,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    process.env.BUZZ_AUTH_TAG = "inherited-tag";

    try {
      expect(await buzzCli(["channels", "add-member"], { BUZZ_AUTH_TAG: undefined })).toContain(
        "tag=unset",
      );
      // Without the sentinel the tag is inherited — so the assertion above is not vacuous.
      expect(await buzzCli(["channels", "add-member"], {})).toContain("tag=inherited-tag");
    } finally {
      process.env.PATH = previousPath;
      delete process.env.BUZZ_AUTH_TAG;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe("canonicalPng", () => {
  it("removes metadata while keeping the image chunks needed by the relay", () => {
    const iend = ONE_PIXEL_PNG.indexOf(Buffer.from("IEND")) - 4;
    const text = Buffer.concat([
      Buffer.from([0, 0, 0, 3]),
      Buffer.from("tEXt"),
      Buffer.from("key"),
      Buffer.alloc(4),
    ]);
    const withMetadata = Buffer.concat([
      ONE_PIXEL_PNG.subarray(0, iend),
      text,
      ONE_PIXEL_PNG.subarray(iend),
    ]);

    const clean = canonicalPng(withMetadata);

    expect(clean.includes(Buffer.from("tEXt"))).toBe(false);
    expect(clean.includes(Buffer.from("IHDR"))).toBe(true);
    expect(clean.includes(Buffer.from("IDAT"))).toBe(true);
    expect(clean.includes(Buffer.from("IEND"))).toBe(true);
  });

  it("refuses a file that is not a PNG", () => {
    expect(() => canonicalPng(Buffer.from("not an image"))).toThrow(/did not produce a PNG/);
  });

  it("reports a profile that points at missing artwork", async () => {
    await expect(prepareAvatarForUpload("/definitely/missing/avatar.svg")).rejects.toThrow(
      /avatar does not exist/,
    );
  });

  it("prepares a PNG in disposable storage and cleans it up", async () => {
    const root = mkdtempSync(join(tmpdir(), "buzz-avatar-test-"));
    const source = join(root, "source.png");
    writeFileSync(source, ONE_PIXEL_PNG);
    try {
      const prepared = await prepareAvatarForUpload(source);
      expect(readFileSync(prepared.path)).toEqual(ONE_PIXEL_PNG);
      prepared.cleanup();
      expect(existsSync(prepared.path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listChannels", () => {
  it("returns the relay's channels for the picker", async () => {
    const f = fakeCli({
      "channels list": JSON.stringify([
        { channel_id: "a", name: "hive" },
        { channel_id: "b", name: "general" },
      ]),
    });
    const channels = await listChannels("wss://buzz.example.ai", "nsec1x", f.cli);
    expect(channels.map((c) => c.name)).toEqual(["hive", "general"]);
  });
});

describe("directoryFor", () => {
  const base = `name: demo
brain:
  provider: mock
surfaces:
  - kind: console
`;

  /** The record for one named relay, the way `doctor` and registration each resolve it. */
  const directoryAt = (extra: string, relayUrl: string) => {
    const manifest = loadManifest(base + extra);
    const surface = manifest.surfaces.find(
      (s) => s.kind === "buzz" && (s as { relayUrl?: unknown }).relayUrl === relayUrl,
    );
    return directoryFor(manifest, surface as BuzzSurfaceChannels, "demo");
  };

  it("lists every channel the surface declares, public and private alike", () => {
    const directory = directoryAt(
      `  - kind: buzz
    relayUrl: wss://buzz.example.ai
    identity: BUZZ_NSEC
    channels:
      - { id: c1, reply: public }
      - { id: c2, reply: private }
respondTo: anyone
`,
      "wss://buzz.example.ai",
    );
    expect(directory.channelIds).toEqual(["c1", "c2"]);
    expect(directory.respondTo).toBe("anyone");
  });

  it("gives each Buzz surface its own channels, not the first one's", () => {
    // Every surface would otherwise be told the agent answers where the first one does,
    // which is a mention stripped on one relay and invited on another.
    const two = `  - kind: buzz
    relayUrl: wss://first.example.ai
    identity: BUZZ_NSEC
    channels: [{ id: first-only, reply: private }]
  - kind: buzz
    relayUrl: wss://second.example.ai
    identity: BUZZ_NSEC
    channels: [{ id: second-only, reply: private }]
respondTo: anyone
`;
    expect(directoryAt(two, "wss://first.example.ai").channelIds).toEqual(["first-only"]);
    expect(directoryAt(two, "wss://second.example.ai").channelIds).toEqual(["second-only"]);
  });

  it("publishes owner-only as the allowlist of owners it actually is", () => {
    // A mode clients do not recognise reads as "never mentionable", which would hide the
    // agent from the picker for the one person it answers.
    const owner = generateKeypair();
    const directory = directoryAt(
      `  - kind: buzz
    relayUrl: wss://buzz.example.ai
    identity: BUZZ_NSEC
    channels: [{ id: c1, reply: private }]
respondTo: owner-only
owner:
  - ${owner.npub}
  - U0BL3MJV49Y
`,
      "wss://buzz.example.ai",
    );
    expect(directory.respondTo).toBe("allowlist");
    // The npub is written as the hex a Buzz event carries — publishing the npub itself
    // would match nobody reading the record, and doctor loads the manifest through a
    // reader that normalizes, so the two spellings would never reconcile.
    expect(directory.respondToAllowlist).toEqual([toHexPubkey(owner.npub), "U0BL3MJV49Y"]);
  });

  it("leaves an already-normalized principal alone", () => {
    // doctor passes a manifest whose ids its reader has already rewritten, so this has to
    // be idempotent or the check would drift against its own publisher.
    const hex = toHexPubkey(generateKeypair().npub);
    const directory = directoryAt(
      `  - kind: buzz
    relayUrl: wss://buzz.example.ai
    identity: BUZZ_NSEC
    channels: [{ id: c1, reply: private }]
respondTo: allowlist
allowlist:
  - ${hex}
`,
      "wss://buzz.example.ai",
    );
    expect(directory.respondToAllowlist).toEqual([hex]);
  });

  it("takes an explicit allowlist from `allowlist`, not from `owner`", () => {
    const friend = generateKeypair();
    const directory = directoryAt(
      `  - kind: buzz
    relayUrl: wss://buzz.example.ai
    identity: BUZZ_NSEC
    channels: [{ id: c1, reply: private }]
respondTo: allowlist
allowlist:
  - ${friend.npub}
owner:
  - U0BL3MJV49Y
`,
      "wss://buzz.example.ai",
    );
    expect(directory.respondTo).toBe("allowlist");
    expect(directory.respondToAllowlist).toEqual([toHexPubkey(friend.npub)]);
  });
});

describe("allowlistDrift", () => {
  it("is silent when the published allowlist names the same principals", () => {
    // Order is not meaningful on the wire, so a reorder is not drift.
    expect(allowlistDrift(["b", "a"], ["a", "b"])).toBeUndefined();
    expect(allowlistDrift(undefined, undefined)).toBeUndefined();
    expect(allowlistDrift([], undefined)).toBeUndefined();
  });

  it("reports an owner the published record has not caught up with", () => {
    // The failure this exists for: respond_to still says `allowlist`, so the mode matches
    // and only the membership has moved — the new owner's mentions are gated on the old one.
    expect(allowlistDrift(["npub1old"], ["npub1old", "npub1new"])).toBe("omits npub1new");
  });

  it("reports a principal the config dropped but the record still authorizes", () => {
    expect(allowlistDrift(["npub1old", "npub1new"], ["npub1new"])).toBe(
      "still authorizes npub1old",
    );
  });

  it("reports both directions at once", () => {
    expect(allowlistDrift(["npub1old"], ["npub1new"])).toBe(
      "omits npub1new and still authorizes npub1old",
    );
  });

  it("treats a missing or malformed field as authorizing nobody", () => {
    expect(allowlistDrift(undefined, ["npub1new"])).toBe("omits npub1new");
    expect(allowlistDrift("npub1new", ["npub1new"])).toBe("omits npub1new");
  });
});

describe("sameRelay", () => {
  it("accepts the spellings a human types for one relay", () => {
    // Registration takes the relay from a flag or a prompt; the surface was written
    // separately. A trailing slash between the two skipped the surface and published nothing.
    expect(sameRelay("wss://relay.example", "wss://relay.example/")).toBe(true);
    expect(sameRelay("wss://Relay.Example", "wss://relay.example")).toBe(true);
    expect(sameRelay("wss://relay.example/", "wss://relay.example//")).toBe(true);
  });

  it("keeps genuinely different relays apart", () => {
    expect(sameRelay("wss://relay.example", "wss://other.example")).toBe(false);
    expect(sameRelay("wss://relay.example", "ws://relay.example")).toBe(false);
    expect(sameRelay("wss://relay.example:443", "wss://relay.example:8443")).toBe(false);
    // A path is case-sensitive even though the host is not.
    expect(sameRelay("wss://relay.example/Hive", "wss://relay.example/hive")).toBe(false);
  });

  it("falls back to a trimmed comparison for something that is not a URL", () => {
    expect(sameRelay("not a url", "not a url")).toBe(true);
    expect(sameRelay("not a url", "other")).toBe(false);
  });
});
