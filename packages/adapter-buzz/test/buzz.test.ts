import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { PlainKeySigner } from "nostr-tools/signer";
import type { InboundEvent } from "@sageox/agent-toolkit-core";
import { BuzzAdapter } from "../src/buzz.ts";
import { BUZZ_DEFAULTS, toInboundEvent } from "../src/normalize.ts";
import { DIRECTORY_KIND } from "../src/profile.ts";
import { FakeRelay } from "./fake-relay.ts";

const agentSk = generateSecretKey();
const agentPk = getPublicKey(agentSk);
const userSk = generateSecretKey();

let relay: FakeRelay;
afterEach(async () => {
  await relay?.stop();
});

const now = Math.floor(Date.now() / 1000);

/**
 * Timestamped against the real clock, and a minute ahead of it by default: an adapter with
 * no cursor floors its filter at whatever `start` reads off the wall clock, and nostr-tools
 * drops what the filter excludes before the adapter ever sees it. A fixed date would be a
 * message every one of these tests silently stopped receiving.
 */
function mention(text: string, at = now + 60) {
  return finalizeEvent(
    {
      kind: BUZZ_DEFAULTS.kind,
      created_at: at,
      tags: [
        ["h", "hive"],
        ["p", agentPk],
      ],
      content: text,
    },
    userSk,
  );
}

/** Same clock rule as {@link mention} — a fixed past date is a message the filter drops. */
function inChannel(channel: string, text: string, at = now + 60) {
  return finalizeEvent(
    {
      kind: BUZZ_DEFAULTS.kind,
      created_at: at,
      tags: [
        ["h", channel],
        ["p", agentPk],
      ],
      content: text,
    },
    userSk,
  );
}

function newAdapter(extra: Record<string, unknown> = {}) {
  return new BuzzAdapter({
    relayUrl: relay.url,
    signer: new PlainKeySigner(agentSk),
    channels: [{ id: "hive", reply: "private" }],
    ...extra,
  });
}

async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

/** The REQs that listen for chat. The directory REQ `start` opens first is not one. */
function chatReqs() {
  return relay.reqs.filter((req) =>
    (req.filters[0].kinds as number[]).includes(BUZZ_DEFAULTS.kind),
  );
}

/** What a registered agent leaves on the relay — the record clients gate a mention on. */
function directoryRecord(sk: Uint8Array, name: string) {
  return finalizeEvent(
    {
      kind: DIRECTORY_KIND,
      created_at: now - 86400,
      tags: [],
      content: JSON.stringify({ name, channel_ids: ["hive"], respond_to: "anyone" }),
    },
    sk,
  );
}

describe("BuzzAdapter", () => {
  beforeEach(async () => {
    relay = await FakeRelay.start();
  });

  it("subscribes for mentions of its own pubkey", async () => {
    const a = newAdapter({ channels: [] });
    await a.start(() => {});
    await settle();

    const filter = chatReqs()[0].filters[0];
    expect(filter.kinds).toEqual([BUZZ_DEFAULTS.kind]);
    expect(filter["#p"]).toEqual([agentPk]);
    await a.stop();
  });

  it("delivers a mention as a normalized InboundEvent", async () => {
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();

    relay.emit(mention("deploy status?"));
    await settle();

    expect(got).toHaveLength(1);
    expect(got[0].text).toBe("deploy status?");
    expect(got[0].surface).toBe("buzz");
    expect(got[0].mentionsMe).toBe(true);
    expect(got[0].channel.isPublic).toBe(false); // hive is listed reply: private
    await a.stop();
  });

  it("still delivers after a reconnect — the resubscribe has to follow the new AUTH", async () => {
    // requireAuth is the whole point: an auth-required relay refuses the REQ nostr-tools
    // re-fires from `ws.onopen`, before the reconnect's challenge can even arrive, and
    // answers CLOSED — which evicts the subscription from `openSubs` for good. The agent
    // re-authenticates and then hears nothing, looking healthy the entire time.
    relay = await FakeRelay.start({ requireAuth: true });
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();

    // nostr-tools waits 10s before its first reconnect, which no test can sit through.
    (a as unknown as { relay: { resubscribeBackoff: number[] } }).relay.resubscribeBackoff = [10];
    relay.dropConnections();
    await settle(500);

    expect(relay.authEvents.length).toBeGreaterThanOrEqual(2); // the socket did re-auth

    relay.emit(mention("still there?"));
    await settle();

    expect(got.map((e) => e.text)).toContain("still there?");
    await a.stop();
  });

  it("publishes a signed, threaded reply", async () => {
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("ping"));
    await settle();

    await a.send(got[0].channel, { text: "pong" });
    await settle();

    expect(relay.published).toHaveLength(1);
    const published = relay.published[0];
    expect(verifyEvent(published)).toBe(true);
    expect(published.pubkey).toBe(agentPk);
    expect(published.content).toBe("pong");
    expect(published.tags).toContainEqual(["e", got[0].id.nativeId, "", "reply"]);
    await a.stop();
  });

  it("refuses to send to a channel it has no inbound context for", async () => {
    const a = newAdapter();
    await a.start(() => {});
    await settle();

    await expect(
      a.send({ surface: "buzz", id: "never-seen", isPublic: false }, { text: "hi" }),
    ).rejects.toThrow();
    expect(relay.published).toHaveLength(0);
    await a.stop();
  });

  it("publishes a signed top-level post to a configured channel", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    const ref = await a.post({ surface: "buzz", id: "hive", isPublic: false }, { text: "shipped" });
    await settle();

    const published = relay.published[0];
    expect(verifyEvent(published)).toBe(true);
    expect(published.content).toBe("shipped");
    expect(published.tags).toContainEqual(["h", "hive"]);
    expect(published.tags.some((tag) => tag[0] === "e")).toBe(false);
    expect(published.tags.some((tag) => tag[0] === "p")).toBe(false);
    // The signature's own id, so threading needs nothing parsed back out of the relay.
    expect(ref).toEqual({ surface: "buzz", nativeId: published.id });
    await a.stop();
  });

  it("connects without subscribing when nobody asked to be told about events", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start();
    await settle();

    // A `job run` posts one status and exits. A REQ whose events go nowhere is a
    // subscription the agent pays to ignore, and the relay pays to serve.
    expect(relay.reqs).toHaveLength(0);
    await a.post({ surface: "buzz", id: "hive", isPublic: false }, { text: "shipped" });
    await settle();
    expect(relay.published).toHaveLength(1);
    await a.stop();
  });

  it("threads a post under one it published itself, and keeps the thread flat", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    const channel = { surface: "buzz", id: "hive", isPublic: false } as const;
    const root = await a.post(channel, { text: "job sweep completed — 2 of 5 gates did not pass" });
    const first = await a.post(channel, { text: "NOT PROVEN: jscpd did not execute" }, root);
    // The second detail anchors on the headline too, not on the detail before it: one
    // thread under the headline, never a chain of replies to replies.
    await a.post(channel, { text: "FAILED: unit-tests did not pass" }, root);
    await settle();

    for (const detail of relay.published.slice(1)) {
      expect(detail.tags).toContainEqual(["e", root!.nativeId, "", "reply"]);
      expect(detail.tags).toContainEqual(["h", "hive"]);
      // Nobody is being addressed — a headline and its detail are posted to a channel.
      expect(detail.tags.some((tag) => tag[0] === "p")).toBe(false);
    }
    expect(first!.nativeId).not.toBe(root!.nativeId);
    await a.stop();
  });

  it("wakes the recipients a post names, and nobody else in the channel", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});

    const channel = { surface: "buzz", id: "hive", isPublic: false } as const;
    const drone = getPublicKey(generateSecretKey());
    const forager = getPublicKey(generateSecretKey());
    // No `settle` on either side: `publish` resolves on the relay's OK, which the fake
    // sends after recording the event, so `published` is populated by the time this returns.
    await a.post(channel, { text: "roll call" }, undefined, [drone, nip19.npubEncode(forager)]);

    // A `p` tag is the wake trigger, and the whole of it: every agent subscribed to `hive`
    // is delivered this event, and only the two named here normalize it to `mentionsMe`.
    const published = relay.published[0];
    expect(verifyEvent(published)).toBe(true);
    expect(published.tags).toContainEqual(["p", drone]);
    // A roster is written in npubs as readily as in hex, and both are the same recipient.
    expect(published.tags).toContainEqual(["p", forager]);
    expect(toInboundEvent(published, { pubkey: drone }).mentionsMe).toBe(true);
    expect(toInboundEvent(published, { pubkey: agentPk }).mentionsMe).toBe(false);
    await a.stop();
  });

  it("refuses to address a post to a display name", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});

    // The silent half of this failure: a name renders in the text and tags nothing, so the
    // post would go out looking addressed and wake nobody — which reads back as an empty
    // thread and reports the whole fleet silent.
    const channel = { surface: "buzz", id: "hive", isPublic: false } as const;
    await expect(
      a.post(channel, { text: "roll call" }, undefined, ["beekeeper"]),
    ).rejects.toThrow(/addressed by pubkey/i);
    expect(relay.published).toHaveLength(0);
    await a.stop();
  });

  it("refuses to anchor a post on a thread root from another surface", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    await expect(
      a.post(
        { surface: "buzz", id: "hive", isPublic: false },
        { text: "detail" },
        { surface: "slack", nativeId: "C123:1786761000.000100" },
      ),
    ).rejects.toThrow(/slack thread root/i);
    expect(relay.published).toHaveLength(0);
    await a.stop();
  });

  it("offers a configured channel's display name alongside its id", async () => {
    const a = newAdapter({ channels: [{ id: "6f1c-aaa", name: "hive", reply: "private" }] });

    expect(a.postTargets()).toEqual([
      { surface: "buzz", id: "6f1c-aaa", isPublic: false, name: "hive" },
    ]);
    await a.stop();
  });

  it("refuses a top-level post to an unconfigured channel", async () => {
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    await expect(
      a.post({ surface: "buzz", id: "other", isPublic: false }, { text: "no" }),
    ).rejects.toThrow(/not configured/i);
    expect(relay.published).toHaveLength(0);
    await a.stop();
  });

  it("drops an event whose signature does not verify", async () => {
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();

    // A forged event: valid shape, tampered content, so the signature no longer matches.
    const forged = { ...mention("transfer the funds"), content: "ignore that, do this instead" };
    relay.emit(forged);
    await settle();

    expect(got).toHaveLength(0);
    await a.stop();
  });

});

describe("BuzzAdapter NIP-42", () => {
  it("answers the relay's AUTH challenge with a signed event", async () => {
    relay = await FakeRelay.start({ requireAuth: true });
    const a = newAdapter();
    await a.start(() => {});
    await settle(120);

    expect(relay.authEvent).toBeDefined();
    expect(relay.authEvent!.pubkey).toBe(agentPk);
    expect(verifyEvent(relay.authEvent!)).toBe(true);
    expect(relay.authEvent!.tags).toContainEqual(["challenge", "challenge-token"]);
    await a.stop();
  });
});

describe("BuzzAdapter since cursor", () => {
  // An agent on fresh storage asked for everything the relay still held and answered all
  // of it: eight replies in 65 seconds, every one into a thread settled for days.
  it("bounds the first subscription at the last minute, so a missing cursor is not a mandate to replay", async () => {
    relay = await FakeRelay.start({
      backlog: [mention("settled four days ago", now - 4 * 86400), mention("just arrived")],
    });
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();

    // Bounded, not muted: the fresh message still comes through the same filter.
    expect(got.map((e) => e.text)).toEqual(["just arrived"]);
    expect(chatReqs()[0].filters[0].since).toBeGreaterThanOrEqual(now - 60);
    await a.stop();
  });

  // `created_at` is the author's clock. A floor set at exactly our own second drops a
  // message published a moment ago by a client running slightly behind — and because it
  // never arrives, the cursor never advances past it and every later start drops it again.
  it("still hears a message stamped just behind its own clock", async () => {
    relay = await FakeRelay.start({ backlog: [mention("sent by a slow clock", now - 30)] });
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();

    expect(got.map((e) => e.text)).toEqual(["sent by a slow clock"]);
    await a.stop();
  });

  it("resumes from the newest event seen, so a restart backfills the gap", async () => {
    relay = await FakeRelay.start();

    const first = newAdapter();
    await first.start(() => {});
    await settle();
    relay.emit(mention("seen live", now + 100));
    await settle();
    const cursor = first.cursor();
    await first.stop();

    expect(cursor).toBe(now + 100);

    // While we are down, one mention arrives that we never saw, and one older message
    // is still sitting in the relay's store. Both are inside the fresh-start bound, so
    // only the cursor can be what holds the second one back.
    relay.backlog.push(mention("sent while we were down", now + 500));
    relay.backlog.push(mention("older, already handled", now + 50));

    const second = newAdapter({ since: cursor });
    const afterRestart: InboundEvent[] = [];
    await second.start((e) => afterRestart.push(e));
    await settle();

    const texts = afterRestart.map((e) => e.text);
    expect(relay.reqs.at(-1)!.filters[0].since).toBe(now + 100);
    expect(texts).toContain("sent while we were down"); // the gap is recovered
    expect(texts).not.toContain("older, already handled"); // and nothing is re-delivered
    await second.stop();
  });
});

describe("BuzzAdapter against an auth-required relay", () => {
  it("receives mentions — it must authenticate before subscribing", async () => {
    relay = await FakeRelay.start({ requireAuth: true, backlog: [mention("hello agent")] });
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle(400);

    expect(relay.authEvent).toBeDefined();
    expect(got.map((e) => e.text)).toContain("hello agent");
    await a.stop();
  });

  it("refuses to start when the relay will not have this key, rather than subscribing deaf", async () => {
    relay = await FakeRelay.start({ requireAuth: true, rejectAuth: true });
    const a = newAdapter();

    await expect(a.start(() => {})).rejects.toThrow(/refused this agent's key/);
    await settle(200);

    // No REQ was installed, so nothing is left looking like a working subscription.
    expect(relay.reqs).toHaveLength(0);
  });

  it("treats a refusal with no reason as a refusal — `OK false \"\"` is protocol-legal", async () => {
    relay = await FakeRelay.start({ requireAuth: true, rejectAuth: true, rejectAuthReason: "" });
    const a = newAdapter();

    await expect(a.start(() => {})).rejects.toThrow(/refused this agent's key/);
    await settle(200);

    expect(relay.reqs).toHaveLength(0);
  });
});

describe("BuzzAdapter subscription shape", () => {
  it("subscribes by channel when channels are configured — the only filter this relay streams", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    const filter = chatReqs()[0].filters[0];
    expect(filter["#h"]).toEqual(["hive"]);
    expect(filter["#p"]).toBeUndefined();
    await a.stop();
  });

  it("asks the relay for its whole directory before any channel", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter();
    await a.start(() => {});
    await settle();

    const filter = relay.reqs[0].filters[0];
    expect(filter.kinds).toEqual([DIRECTORY_KIND]);
    expect(filter.since).toBeUndefined(); // a record predates this process by design
    expect(filter.authors).toBeUndefined(); // every agent's, not only our own
    await a.stop();
  });

  // Every reply `p`-tags the author it answers, so two agents that allowlist each other
  // answer one another until `maxTurnsPerThread` unless the gateway can see they are agents.
  it("recognises a sibling by its directory record, whether stored or published later", async () => {
    const storedSk = generateSecretKey();
    const laterSk = generateSecretKey();
    relay = await FakeRelay.start({ backlog: [directoryRecord(storedSk, "ida")] });
    const got: InboundEvent[] = [];
    const a = newAdapter();
    await a.start((e) => got.push(e));
    await settle();

    const from = (sk: Uint8Array, text: string, at: number) =>
      finalizeEvent(
        { kind: BUZZ_DEFAULTS.kind, created_at: at, tags: [["h", "hive"], ["p", agentPk]], content: text },
        sk,
      );
    relay.emit(from(storedSk, "ack from a registered agent", now + 61));
    relay.emit(mention("a person asking", now + 62));
    relay.emit(from(laterSk, "not yet registered", now + 63));
    relay.emit(directoryRecord(laterSk, "juno"));
    relay.emit(from(laterSk, "registered now", now + 64));
    await settle();

    expect(got.map((e) => [e.text, e.author.isAgent])).toEqual([
      ["ack from a registered agent", true],
      ["a person asking", false],
      ["not yet registered", false],
      ["registered now", true],
    ]);
    // The same roster is what a person addresses by name — the record's own name.
    expect(a.principals().get(getPublicKey(storedSk))).toBe("ida");
    expect(a.principals().get(getPublicKey(laterSk))).toBe("juno");
    expect(a.principals().has(getPublicKey(userSk))).toBe(false);
    await a.stop();
  });

  // A single REQ naming both channels is what made a two-channel agent answer its boot
  // batch and then go deaf, with every health signal still green: the relay served that
  // filter from its store and never pushed to it again.
  it("opens one REQ per channel, never one filter naming several", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter({
      channels: [
        { id: "hive", reply: "private" },
        { id: "eng", reply: "private" },
      ],
    });
    await a.start(() => {});
    await settle();

    expect(chatReqs()).toHaveLength(2);
    expect(chatReqs().map((req) => req.filters.length)).toEqual([1, 1]);
    expect(chatReqs().map((req) => req.filters[0]["#h"])).toEqual([["hive"], ["eng"]]);
    await a.stop();
  });

  it("hears a live mention in every channel it serves, not just the first", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({
      channels: [
        { id: "hive", reply: "private" },
        { id: "eng", reply: "private" },
      ],
    });
    await a.start((e) => got.push(e));
    await settle();

    relay.emit(mention("in hive", now + 100));
    relay.emit(inChannel("eng", "in eng", now + 200));
    await settle();

    expect(got.map((e) => [e.channel.id, e.text])).toEqual([
      ["hive", "in hive"],
      ["eng", "in eng"],
    ]);
    expect(got.every((e) => e.mentionsMe)).toBe(true);
    await a.stop();
  });

  // One REQ per channel means a message tagged with two of them matches two of them.
  // Normalization gives it one channel, and only that channel's REQ may deliver it —
  // otherwise the brain answers the same message once per REQ it arrived on.
  it("delivers a message cross-posted to two of its channels exactly once", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({
      channels: [
        { id: "hive", reply: "private" },
        { id: "eng", reply: "private" },
      ],
    });
    await a.start((e) => got.push(e));
    await settle();

    relay.emit(
      finalizeEvent(
        {
          kind: BUZZ_DEFAULTS.kind,
          created_at: now + 300,
          tags: [
            ["h", "hive"],
            ["h", "eng"],
            ["p", agentPk],
          ],
          content: "all hands",
        },
        userSk,
      ),
    );
    await settle();

    expect(got.map((e) => e.text)).toEqual(["all hands"]);
    expect(got[0].channel.id).toBe("hive");
    await a.stop();
  });

  it("still decides mentionsMe locally, so channel chatter does not wake it", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();

    relay.emit(mention("hey @harry"));
    relay.emit(
      finalizeEvent(
        { kind: BUZZ_DEFAULTS.kind, created_at: now + 61, tags: [["h", "hive"]], content: "chatter" },
        userSk,
      ),
    );
    await settle();

    expect(got.map((e) => e.mentionsMe)).toEqual([true, false]);
    await a.stop();
  });

  it("falls back to a mention filter when no channels are configured", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter({ channels: [] });
    await a.start(() => {});
    await settle();

    expect(chatReqs()[0].filters[0]["#p"]).toEqual([agentPk]);
    await a.stop();
  });
});

describe("BuzzAdapter working signals", () => {
  it("acknowledges the message it picked up with a NIP-25 reaction", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("hey"));
    await settle();

    await a.react!(got[0], "👀");
    await settle();

    const reaction = relay.published.find((e) => e.kind === BUZZ_DEFAULTS.reactionKind);
    expect(reaction).toBeDefined();
    expect(reaction!.content).toBe("👀");
    expect(reaction!.tags).toContainEqual(["e", got[0].id.nativeId]);
    expect(verifyEvent(reaction!)).toBe(true);
    await a.stop();
  });

  it("publishes an ephemeral typing indicator on the channel", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    await a.setTyping!({ surface: "buzz", id: "hive", isPublic: false });
    await settle();

    const typing = relay.published.find((e) => e.kind === BUZZ_DEFAULTS.typingKind);
    expect(typing).toBeDefined();
    expect(typing!.tags).toContainEqual(["h", "hive"]);
    expect(typing!.content).toBe("");
    await a.stop();
  });
});

describe("BuzzAdapter withdraws its acknowledgement", () => {
  it("deletes the reaction it published, by id", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("hey"));
    await settle();

    const made = await a.react!(got[0], "👀");
    await settle();
    await a.unreact!(made!.ref);
    await settle();

    // Both reads after both settles: what the relay has recorded is asserted once, at a
    // point where nothing is still in flight to it.
    const reaction = relay.published.find((e) => e.kind === BUZZ_DEFAULTS.reactionKind)!;
    const deletion = relay.published.find((e) => e.kind === BUZZ_DEFAULTS.deletionKind);
    expect(made).toEqual({ ref: { surface: "buzz", nativeId: reaction.id }, placed: true });
    expect(deletion).toBeDefined();
    expect(deletion!.tags).toContainEqual(["e", reaction.id]);
    await a.stop();
  });

  // The 👀 and a glyph the brain chose stand on one message together, and only the first
  // is ever withdrawn. The withdrawal names the reaction it was handed, so the other is
  // untouched however the two were made.
  it("withdraws the reaction it is handed and leaves the other standing", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("everyone check in"));
    await settle();

    const acknowledged = await a.react!(got[0], "👀");
    await a.react!(got[0], "👍");
    await settle();
    const [ack, glyph] = relay.published.filter((e) => e.kind === BUZZ_DEFAULTS.reactionKind);
    expect([ack.content, glyph.content]).toEqual(["👀", "👍"]);
    expect(acknowledged).toEqual({ ref: { surface: "buzz", nativeId: ack.id }, placed: true });

    await a.unreact!(acknowledged!.ref);
    await settle();

    const deletions = relay.published.filter((e) => e.kind === BUZZ_DEFAULTS.deletionKind);
    expect(deletions).toHaveLength(1);
    expect(deletions[0].tags).toContainEqual(["e", ack.id]);
    await a.stop();
  });

  // A NIP-25 event is content-addressed — but `created_at` is one of the fields hashed,
  // and it has one-second resolution. So "reacting twice yields one event" holds only
  // within a second, and the next test pins the other half. Both are load-bearing: they
  // are the two ways an acknowledgement and a brain asking for the same glyph can relate.
  it("re-signs the same id when asked again within the same second", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("everyone check in"));
    await settle();

    const first = await a.react!(got[0], "👀");
    const again = await a.react!(got[0], "👀");
    await settle();

    expect(again).toEqual(first);
    await a.stop();
  });

  // The other half, and the one that decides what a turn lasting longer than a second
  // does: a later reaction to the same message with the same emoji is a DIFFERENT event.
  // The glyph survives the turn either way — within a second because the withdrawal is
  // skipped as claimed, and after one because the brain's own reaction is still standing
  // when the acknowledgement's is deleted.
  it("signs a different id a second later, so both reactions exist", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("everyone check in"));
    await settle();

    const acknowledged = await a.react!(got[0], "👀");
    // A turn takes seconds, and `created_at` is one of the hashed fields.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);
    let later;
    try {
      later = await a.react!(got[0], "👀");
    } finally {
      vi.useRealTimers();
    }
    await settle();

    expect(later!.ref.nativeId).not.toBe(acknowledged!.ref.nativeId);

    // Withdrawing the acknowledgement leaves the later one on the message.
    await a.unreact!(acknowledged!.ref);
    await settle();
    const deletions = relay.published.filter((e) => e.kind === BUZZ_DEFAULTS.deletionKind);
    expect(deletions.map((d) => d.tags.find((t) => t[0] === "e")?.[1])).toEqual([
      acknowledged!.ref.nativeId,
    ]);
    await a.stop();
  });

  // A reaction is addressed to the message's channel and author as much as to its id, so
  // it takes the whole event. A busy channel moves on while a turn runs, and an adapter
  // that had to look its target up among what it still remembers would have lost it.
  it("reacts to the message it was given even once later ones have arrived", async () => {
    relay = await FakeRelay.start();
    const got: InboundEvent[] = [];
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start((e) => got.push(e));
    await settle();
    relay.emit(mention("everyone check in"));
    await settle();

    for (let i = 0; i < 20; i++) relay.emit(mention(`someone else replying ${i}`));
    await settle();

    await a.react!(got[0], "👍");
    await settle();

    const reaction = relay.published.find((e) => e.kind === BUZZ_DEFAULTS.reactionKind)!;
    expect(reaction.content).toBe("👍");
    expect(reaction.tags).toContainEqual(["e", got[0].id.nativeId]);
    await a.stop();
  });

  it("does nothing with a reaction reference from another surface", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    await a.unreact!({ surface: "slack", nativeId: "not-ours" });
    await settle();

    expect(relay.published.filter((e) => e.kind === BUZZ_DEFAULTS.deletionKind)).toHaveLength(0);
    await a.stop();
  });

  it("scopes typing to the channel for a top-level message", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter({ channels: [{ id: "hive", reply: "private" }] });
    await a.start(() => {});
    await settle();

    await a.setTyping!({ surface: "buzz", id: "hive", isPublic: false });
    await settle();

    const typing = relay.published.find((e) => e.kind === BUZZ_DEFAULTS.typingKind)!;
    expect(typing.tags).toEqual([["h", "hive"]]); // channel only — no thread tag
    await a.stop();
  });
});

describe("BuzzAdapter reads back a thread it rooted", () => {
  /** One reply beneath `root`, tagged the way this relay's clients tag one. */
  const replyTo = (root: string, text: string, sk: Uint8Array, at: number) =>
    finalizeEvent(
      {
        kind: BUZZ_DEFAULTS.kind,
        created_at: at,
        tags: [
          ["h", "hive"],
          [BUZZ_DEFAULTS.replyTag, root, "", "reply"],
        ],
        content: text,
      },
      sk,
    );

  it("answers with the replies beneath the root, oldest first", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter();
    await a.start();

    const root = (await a.post!({ surface: "buzz", id: "hive", isPublic: false }, {
      text: "roll call",
    }))!;
    // Out of order on the wire, because a relay promises nothing about delivery order and a
    // caller tallying who answered reads a thread the way a person does.
    relay.backlog.push(replyTo(root.nativeId, "second", userSk, now + 20));
    relay.backlog.push(replyTo(root.nativeId, "first", agentSk, now + 10));
    // A reply in the same channel that is not in this thread, and must not be counted.
    relay.backlog.push(inChannel("hive", "unrelated"));

    const replies = await a.readThread!(root);
    expect(replies.map((r) => r.text)).toEqual(["first", "second"]);
    expect(replies.map((r) => r.author.isSelf)).toEqual([true, false]);
    expect(replies[0].ts).toBe(new Date((now + 10) * 1000).toISOString());
    await a.stop();
  });

  it("holds the read to `limit`", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter();
    await a.start();

    const root = (await a.post!({ surface: "buzz", id: "hive", isPublic: false }, {
      text: "roll call",
    }))!;
    for (let i = 0; i < 3; i++) {
      relay.backlog.push(replyTo(root.nativeId, `r${i}`, userSk, now + i));
    }

    expect(await a.readThread!(root, 2)).toHaveLength(2);
    expect(relay.reqs.at(-1)!.filters[0].limit).toBe(2);
    await a.stop();
  });

  it("refuses a root from another surface", async () => {
    relay = await FakeRelay.start();
    const a = newAdapter();
    await a.start();

    // 64 hex characters from Slack is not a Buzz thread — it is a string of the right shape.
    await expect(a.readThread!({ surface: "slack", nativeId: "f".repeat(64) })).rejects.toThrow(
      /names no Buzz thread/,
    );
    await a.stop();
  });

  it("throws rather than calling a relay that never finished answering an empty thread", async () => {
    relay = await FakeRelay.start({ withholdEose: true });
    const a = newAdapter();
    await a.start();

    const root = (await a.post!({ surface: "buzz", id: "hive", isPublic: false }, {
      text: "roll call",
    }))!;
    // EOSE is what makes zero replies an answer. Without it, "nobody has replied yet" and
    // "the relay stopped talking to us" are the same silence, and a probe must not read one
    // as the other.
    await expect(a.readThread!(root)).rejects.toThrow(/not the whole thread/);
    await a.stop();
  }, 10_000);
});
