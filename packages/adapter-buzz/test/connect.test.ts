import { describe, it, expect, afterEach } from "vitest";
import type { Relay } from "nostr-tools/relay";
import { generateSecretKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { connectAuthenticated } from "../src/connect.ts";
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
