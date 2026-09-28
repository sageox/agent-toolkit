import { describe, it, expect, afterEach } from "vitest";
import type { Relay } from "nostr-tools/relay";
import { generateSecretKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { connectAuthenticated, ownerAuthTag } from "../src/connect.ts";
import { resolveBuzzSigner } from "../src/identity.ts";
import { FakeRelay } from "./fake-relay.ts";

let relay: FakeRelay;
const opened: Relay[] = [];

afterEach(async () => {
  for (const r of opened.splice(0)) r.close();
  await relay?.stop();
});

const signer = () =>
  resolveBuzzSigner("TEST_NSEC", {
    env: { TEST_NSEC: nip19.nsecEncode(generateSecretKey()) },
  });

async function connect(url: string, opts: { enableReconnect?: boolean } = {}) {
  const result = await connectAuthenticated(url, await signer(), opts);
  opened.push(result.relay);
  return result;
}

describe("connectAuthenticated", () => {
  it("survives a relay that refuses the AUTH it verified, and reports the reason", async () => {
    relay = await FakeRelay.start({ requireAuth: true, rejectAuth: true });

    // nostr-tools rethrows the refusal inside its own `.catch`, on a promise it never
    // returns. Node exits on that unless the toolkit answers the challenge itself; a
    // listener here would otherwise capture what used to kill the process.
    const unhandled: unknown[] = [];
    const capture = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", capture);

    try {
      const result = await connect(relay.url);

      expect(result.authenticated).toBe(false);
      expect(result.authRefusal).toMatch(/restricted/);
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("still reports a refusal the relay gave no reason for, rather than an empty one", async () => {
    relay = await FakeRelay.start({ requireAuth: true, rejectAuth: true, rejectAuthReason: "" });

    const result = await connect(relay.url);

    expect(result.authenticated).toBe(false);
    // Callers ask `if (authRefusal)`, so an empty reason would read as no refusal at all.
    expect(result.authRefusal).toBeTruthy();
  });

  it("reports the relay's acceptance, not merely that we signed something", async () => {
    relay = await FakeRelay.start({ requireAuth: true });

    const result = await connect(relay.url);

    expect(result.authenticated).toBe(true);
    expect(result.authRefusal).toBeUndefined();
    expect(relay.authEvent).toBeDefined();
  });

  it("answers the second challenge too — a reconnected socket is unauthenticated", async () => {
    relay = await FakeRelay.start({ requireAuth: true });

    const { relay: client } = await connect(relay.url, { enableReconnect: true });
    expect(relay.authEvents).toHaveLength(1);

    // nostr-tools waits 10s before its first reconnect, which no test can sit through.
    client.resubscribeBackoff = [10];
    relay.dropConnections();
    await new Promise((r) => setTimeout(r, 500));

    expect(relay.authEvents).toHaveLength(2);
  });

  it("returns without a challenge rather than waiting on a relay that never asks", async () => {
    relay = await FakeRelay.start();

    const result = await connect(relay.url);

    expect(result.authenticated).toBe(false);
    expect(result.authRefusal).toBeUndefined();
    expect(relay.authEvent).toBeUndefined();
  });
});

const VALID_TAG = ["auth", "a".repeat(64), "", "b".repeat(128)];

describe("ownerAuthTag", () => {
  it("parses a well-formed NIP-OA tag", () => {
    expect(ownerAuthTag(JSON.stringify(VALID_TAG))).toEqual(VALID_TAG);
  });
  it("returns undefined for empty, missing, or non-JSON", () => {
    expect(ownerAuthTag(undefined)).toBeUndefined();
    expect(ownerAuthTag("")).toBeUndefined();
    expect(ownerAuthTag("not json")).toBeUndefined();
  });
  it("rejects the wrong label, arity, hex widths, and non-string members", () => {
    expect(ownerAuthTag(JSON.stringify(["p", "a".repeat(64), "", "b".repeat(128)]))).toBeUndefined();
    expect(ownerAuthTag(JSON.stringify(["auth", "a".repeat(64), ""]))).toBeUndefined();
    expect(ownerAuthTag(JSON.stringify(["auth", "xyz", "", "b".repeat(128)]))).toBeUndefined();
    expect(ownerAuthTag(JSON.stringify(["auth", "a".repeat(64), "", "b".repeat(64)]))).toBeUndefined();
    expect(ownerAuthTag(JSON.stringify(["auth", "a".repeat(64), "", 5]))).toBeUndefined();
  });
});

describe("connectAuthenticated owner attestation", () => {
  it("appends BUZZ_AUTH_TAG to the signed AUTH event, and it still verifies", async () => {
    relay = await FakeRelay.start({ requireAuth: true });
    const prev = process.env.BUZZ_AUTH_TAG;
    process.env.BUZZ_AUTH_TAG = JSON.stringify(VALID_TAG);
    try {
      const result = await connect(relay.url);
      expect(result.authenticated).toBe(true);
      // The relay verifyEvent'd the AUTH signature already (it authed us). The tag rides
      // alongside the standard relay + challenge tags.
      expect(relay.authEvent?.tags).toContainEqual(VALID_TAG);
      expect(relay.authEvent?.tags.some((t) => t[0] === "relay")).toBe(true);
      expect(relay.authEvent?.tags.some((t) => t[0] === "challenge")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BUZZ_AUTH_TAG;
      else process.env.BUZZ_AUTH_TAG = prev;
    }
  });

  it("adds no auth tag when BUZZ_AUTH_TAG is unset", async () => {
    relay = await FakeRelay.start({ requireAuth: true });
    const prev = process.env.BUZZ_AUTH_TAG;
    delete process.env.BUZZ_AUTH_TAG;
    try {
      const result = await connect(relay.url);
      expect(result.authenticated).toBe(true);
      expect(relay.authEvent?.tags.some((t) => t[0] === "auth")).toBe(false);
    } finally {
      if (prev !== undefined) process.env.BUZZ_AUTH_TAG = prev;
    }
  });
});
