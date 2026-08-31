import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Socket } from "node:net";
import { nip19 } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { DIRECTORY_KIND, mergeDirectoryContent, publishDirectory } from "../src/profile.ts";
import { FakeRelay } from "./fake-relay.ts";

const anyone = { name: "demo", channelIds: ["c1"], respondTo: "anyone" as const };

describe("mergeDirectoryContent", () => {
  it("keeps settings written by other tools", () => {
    // The reason publication read-merges at all: the relay requires some of these to
    // accept the record, and a blind write would delete them.
    const { content, preserved } = mergeDirectoryContent(
      { channel_add_policy: "owner", status: "online", agent_type: "claude-agent-acp" },
      anyone,
    );
    expect(content.channel_add_policy).toBe("owner");
    expect(content.status).toBe("online");
    expect(preserved).toEqual(["channel_add_policy", "status", "agent_type"]);
  });

  it("drops an allowlist the agent has moved off", () => {
    // Carrying it forward leaves the record contradicting its own respond_to and naming
    // principals the config dropped — and doctor then failing a config that is correct.
    const { content } = mergeDirectoryContent(
      { respond_to: "allowlist", respond_to_allowlist: ["npub1old"], channel_add_policy: "owner" },
      anyone,
    );
    expect(content.respond_to).toBe("anyone");
    expect(content).not.toHaveProperty("respond_to_allowlist");
    expect(content.channel_add_policy).toBe("owner");
  });

  it("replaces every field it owns rather than merging into it", () => {
    const { content, preserved } = mergeDirectoryContent(
      { name: "old", display_name: "Old", channel_ids: ["gone"], respond_to: "nobody" },
      { name: "demo", displayName: "Demo", channelIds: ["c1", "c2"], respondTo: "allowlist",
        respondToAllowlist: ["npub1new"] },
    );
    expect(content).toEqual({
      name: "demo",
      display_name: "Demo",
      channel_ids: ["c1", "c2"],
      respond_to: "allowlist",
      respond_to_allowlist: ["npub1new"],
    });
    expect(preserved).toEqual([]);
  });

  it("defaults the display name to the handle when none is given", () => {
    expect(mergeDirectoryContent({}, anyone).content.display_name).toBe("demo");
  });

  it("keeps a display name the record already carries", () => {
    // `directoryFor` never sets one — nothing in the manifest says it — so a publish that
    // defaulted to the handle would rewrite the name somebody chose in a client to the
    // lowercase slug, on the deploy that was reconciling an allowlist.
    const { content } = mergeDirectoryContent({ display_name: "Demo Agent" }, anyone);
    expect(content.display_name).toBe("Demo Agent");
  });
});

const agentSk = generateSecretKey();
const nsec = nip19.nsecEncode(agentSk);

/** The relay's copy of the record, signed by the agent whose record it is. */
const held = (content: Record<string, unknown>) =>
  finalizeEvent(
    { kind: DIRECTORY_KIND, created_at: 1786000000, tags: [], content: JSON.stringify(content) },
    agentSk,
  );

let relay: FakeRelay;
afterEach(async () => {
  await relay?.stop();
});

const publish = (directory: Parameters<typeof mergeDirectoryContent>[1]) =>
  publishDirectory({
    relayUrl: relay.url,
    identityRef: "BUZZ_NSEC",
    env: { BUZZ_NSEC: nsec },
    directory,
  });

const written = () => relay.published.filter((event) => event.kind === DIRECTORY_KIND);

describe("publishDirectory", () => {
  it("writes nothing when the relay's copy already says all of this", async () => {
    relay = await FakeRelay.start({
      requireAuth: true,
      backlog: [
        held({
          name: "demo",
          display_name: "Demo",
          channel_ids: ["c1"],
          respond_to: "anyone",
          status: "online",
        }),
      ],
    });

    const result = await publish({ name: "demo", channelIds: ["c1"], respondTo: "anyone" });

    expect(result.published).toBe(false);
    expect(written()).toEqual([]);
  });

  it("republishes when the config names a principal the record omits", async () => {
    // The drift that shipped: a manifest gained a third principal, the record kept two, and
    // the two whose mentions still landed made the agent look healthy.
    relay = await FakeRelay.start({
      requireAuth: true,
      backlog: [
        held({
          name: "demo",
          display_name: "Demo Agent",
          channel_ids: ["c1"],
          respond_to: "allowlist",
          respond_to_allowlist: ["principal-a", "principal-b"],
          agent_type: "claude-agent-acp",
          channel_add_policy: "owner",
        }),
      ],
    });

    const result = await publish({
      name: "demo",
      channelIds: ["c1"],
      respondTo: "allowlist",
      respondToAllowlist: ["principal-a", "principal-b", "principal-c"],
    });

    expect(result.published).toBe(true);
    expect(written()).toHaveLength(1);
    expect(JSON.parse(written()[0].content)).toEqual({
      name: "demo",
      display_name: "Demo Agent",
      channel_ids: ["c1"],
      respond_to: "allowlist",
      respond_to_allowlist: ["principal-a", "principal-b", "principal-c"],
      agent_type: "claude-agent-acp",
      channel_add_policy: "owner",
    });
  });

  it("fails rather than hanging when a relay takes the socket and never speaks", async () => {
    // nostr-tools arms a connection timeout only when one is passed, so an unbounded
    // `connect()` against a socket that is accepted and never upgraded stays pending for
    // good. `run` reconciles before it starts listening and warns on failure — with no
    // failure to warn about, the launch hangs instead of continuing without the record.
    const accepted: Socket[] = [];
    const mute = createServer((socket) => accepted.push(socket));
    await new Promise<void>((ready) => mute.listen(0, "127.0.0.1", ready));
    const { port } = mute.address() as { port: number };

    try {
      await expect(
        publishDirectory({
          relayUrl: `ws://127.0.0.1:${port}`,
          identityRef: "BUZZ_NSEC",
          env: { BUZZ_NSEC: nsec },
          directory: { name: "demo", channelIds: ["c1"], respondTo: "anyone" },
        }),
      ).rejects.toBeTruthy();
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((closed) => mute.close(() => closed()));
    }
  }, 20_000);
});
