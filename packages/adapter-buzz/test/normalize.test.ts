import { describe, it, expect } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { toInboundEvent, toReplyTemplate, BUZZ_DEFAULTS } from "../src/normalize.ts";

const authorSk = generateSecretKey();
const authorPk = getPublicKey(authorSk);
const mePk = getPublicKey(generateSecretKey());

function chatEvent(opts: { text?: string; channel?: string; mentions?: string[] } = {}) {
  const tags: string[][] = [["h", opts.channel ?? "hive"]];
  for (const p of opts.mentions ?? [mePk]) tags.push(["p", p]);
  return finalizeEvent(
    {
      kind: BUZZ_DEFAULTS.kind,
      created_at: 1786000000,
      tags,
      content: opts.text ?? "hello agent",
    },
    authorSk,
  );
}

describe("toInboundEvent", () => {
  it("normalizes a chat event into the cross-surface shape", () => {
    const raw = chatEvent();
    const e = toInboundEvent(raw, { pubkey: mePk });
    expect(e.surface).toBe("buzz");
    expect(e.text).toBe("hello agent");
    expect(e.channel.id).toBe("hive");
    expect(e.author.id).toBe(authorPk);
    expect(e.id).toEqual({ surface: "buzz", nativeId: raw.id });
    expect(e.ts).toBe(new Date(1786000000 * 1000).toISOString());
  });

  it("sets mentionsMe only when a p tag matches our pubkey", () => {
    expect(toInboundEvent(chatEvent(), { pubkey: mePk }).mentionsMe).toBe(true);
    expect(toInboundEvent(chatEvent({ mentions: [authorPk] }), { pubkey: mePk }).mentionsMe).toBe(
      false,
    );
  });

  it("treats a message from our own key as an agent message", () => {
    const own = finalizeEvent(
      { kind: BUZZ_DEFAULTS.kind, created_at: 1, tags: [["h", "hive"]], content: "status" },
      authorSk,
    );
    expect(toInboundEvent(own, { pubkey: authorPk }).author.isAgent).toBe(true);
    expect(toInboundEvent(own, { pubkey: mePk }).author.isAgent).toBe(false);
  });

  it("recognises a pubkey the relay's directory lists as another agent", () => {
    const listed = toInboundEvent(chatEvent(), { pubkey: mePk, agents: new Map([[authorPk, "ida"]]) });
    expect(listed.author.isAgent).toBe(true);
    expect(listed.author.isSelf).toBe(false);
    const unlisted = toInboundEvent(chatEvent(), { pubkey: mePk, agents: new Map() });
    expect(unlisted.author.isAgent).toBe(false);
  });

  it("marks a channel public unless it is one the config called private", () => {
    const opts = { pubkey: mePk, privateChannels: new Set(["hive"]) };
    expect(toInboundEvent(chatEvent({ channel: "hive" }), opts).channel.isPublic).toBe(false);
    expect(toInboundEvent(chatEvent({ channel: "town-square" }), opts).channel.isPublic).toBe(true);
  });

  it("defaults an untagged channel rather than throwing", () => {
    const e = finalizeEvent(
      { kind: BUZZ_DEFAULTS.kind, created_at: 1, tags: [["p", mePk]], content: "hi" },
      authorSk,
    );
    expect(toInboundEvent(e, { pubkey: mePk }).channel.id).toBe(BUZZ_DEFAULTS.unknownChannel);
  });
});

describe("toReplyTemplate", () => {
  it("threads the reply to the origin event and its author", () => {
    const inbound = toInboundEvent(chatEvent(), { pubkey: mePk });
    const t = toReplyTemplate({ text: "on it" }, inbound);

    expect(t.kind).toBe(BUZZ_DEFAULTS.kind);
    expect(t.content).toBe("on it");
    expect(t.tags).toContainEqual(["e", inbound.id.nativeId, "", "reply"]);
    expect(t.tags).toContainEqual(["p", inbound.author.id]);
    expect(t.tags).toContainEqual(["h", "hive"]);
  });

  it("never emits a broadcast or bulk-mention tag", () => {
    const inbound = toInboundEvent(chatEvent(), { pubkey: mePk });
    const t = toReplyTemplate({ text: "@everyone hi" }, inbound);
    const tagNames = t.tags.map((x) => x[0]);
    // content may contain the words; the ESCALATION is a tag, and we emit none
    expect(tagNames).not.toContain("broadcast");
    expect(tagNames.filter((n) => n === "p")).toHaveLength(1);
  });
});

describe("NIP-10 thread ancestry", () => {
  const ROOT = "1111111111111111111111111111111111111111111111111111111111111111";
  const PARENT = "2222222222222222222222222222222222222222222222222222222222222222";

  function threadedEvent(tags: string[][]) {
    return finalizeEvent(
      { kind: BUZZ_DEFAULTS.kind, created_at: 1786000000, tags: [["h", "hive"], ...tags], content: "x" },
      authorSk,
    );
  }

  it("reads the root marker as the thread root", () => {
    const e = toInboundEvent(threadedEvent([["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]]), {
      pubkey: mePk,
    });
    expect(e.threadRoot?.nativeId).toBe(ROOT);
  });

  it("treats a lone reply marker as the root, as the relay does", () => {
    const e = toInboundEvent(threadedEvent([["e", ROOT, "", "reply"]]), { pubkey: mePk });
    expect(e.threadRoot?.nativeId).toBe(ROOT);
  });

  it("has no thread root for a top-level message", () => {
    expect(toInboundEvent(chatEvent(), { pubkey: mePk }).threadRoot).toBeUndefined();
  });

  it("replies to the thread ROOT, keeping threads flat rather than nesting", () => {
    const inbound = toInboundEvent(
      threadedEvent([["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]]),
      { pubkey: mePk },
    );
    const eTags = toReplyTemplate({ text: "ok" }, inbound).tags.filter((t) => t[0] === "e");

    expect(eTags).toEqual([["e", ROOT, "", "reply"]]);
    expect(eTags).not.toContainEqual(["e", inbound.id.nativeId, "", "reply"]);
  });

  it("replying to a top-level message sends only the reply tag", () => {
    const inbound = toInboundEvent(chatEvent(), { pubkey: mePk });
    const eTags = toReplyTemplate({ text: "ok" }, inbound).tags.filter((t) => t[0] === "e");

    expect(eTags).toEqual([["e", inbound.id.nativeId, "", "reply"]]);
  });

  it("emits exactly one e tag, so root and parent can never disagree", () => {
    const inbound = toInboundEvent(threadedEvent([["e", ROOT, "", "reply"]]), { pubkey: mePk });
    const eTags = toReplyTemplate({ text: "ok" }, inbound).tags.filter((x) => x[0] === "e");
    expect(eTags).toEqual([["e", ROOT, "", "reply"]]);
  });
});
