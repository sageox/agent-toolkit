import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { probeRelay } from "../src/probe.ts";
import { publishProfile } from "../src/profile.ts";
import { BUZZ_DEFAULTS } from "../src/normalize.ts";
import { FakeRelay } from "./fake-relay.ts";

const agentSk = generateSecretKey();
const agentPk = getPublicKey(agentSk);
const otherSk = generateSecretKey();

let relay: FakeRelay;
let dir: string;

afterEach(async () => {
  await relay?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function secretsDir(): string {
  dir = mkdtempSync(join(tmpdir(), "probe-"));
  writeFileSync(join(dir, "BUZZ_NSEC"), nip19.nsecEncode(agentSk));
  return dir;
}

function event(kind: number, tags: string[][]) {
  return finalizeEvent({ kind, created_at: 1786000000, tags, content: "hi" }, otherSk);
}

describe("probeRelay", () => {
  it("reports the kinds and tags a relay actually serves", async () => {
    relay = await FakeRelay.start({
      backlog: [
        event(BUZZ_DEFAULTS.kind, [["h", "hive"], ["p", agentPk]]),
        event(BUZZ_DEFAULTS.kind, [["h", "eng"]]),
        event(1, [["t", "note"]]),
      ],
    });

    const report = await probeRelay({
      relayUrl: relay.url,
      identityRef: "BUZZ_NSEC",
      secretsDir: secretsDir(),
      seconds: 1,
    });

    // three distinct events, even though several queries match the same ones
    expect(report.events).toBe(3);
    expect(report.kinds[BUZZ_DEFAULTS.kind]).toBe(2);
    expect(report.kinds[1]).toBe(1);
    expect(report.matchingPinnedKind).toBe(2);
    expect(report.tagNames.h).toBe(2);
    expect(report.channelsSeen.sort()).toEqual(["eng", "hive"]);
    expect(report.mentionsOfMe).toBe(1);
  });

  it("answers a NIP-42 challenge when the relay demands one", async () => {
    relay = await FakeRelay.start({ requireAuth: true });
    const report = await probeRelay({
      relayUrl: relay.url,
      identityRef: "BUZZ_NSEC",
      secretsDir: secretsDir(),
      seconds: 1,
    });
    expect(report.auth).toBe("authenticated");
  });

  it("shows zero matches when the relay uses different conventions", async () => {
    relay = await FakeRelay.start({
      backlog: [event(42, [["group", "hive"]]), event(42, [["group", "eng"]])],
    });

    const report = await probeRelay({
      relayUrl: relay.url,
      identityRef: "BUZZ_NSEC",
      secretsDir: secretsDir(),
      seconds: 1,
    });

    // This is the failure the probe exists to make visible before deployment.
    expect(report.matchingPinnedKind).toBe(0);
    expect(report.tagNames[BUZZ_DEFAULTS.channelTag]).toBeUndefined();
    expect(report.kinds[42]).toBe(2);
    expect(report.tagNames.group).toBe(2);
  });

  it("says auth was required when it had no identity, rather than 'not requested'", async () => {
    relay = await FakeRelay.start({ requireAuth: true });
    const report = await probeRelay({ relayUrl: relay.url, seconds: 1 });
    expect(report.auth).toBe("required-no-identity");
  });

  it("surfaces relay NOTICE lines", async () => {
    relay = await FakeRelay.start({ notice: "auth-required: authenticate before subscribing" });
    const report = await probeRelay({ relayUrl: relay.url, seconds: 1 });
    expect(report.notices.join(" ")).toMatch(/auth-required/);
    // a NOTICE alone is enough to diagnose it, even with no AUTH challenge
    expect(report.auth).toBe("required-no-identity");
  });

  it("never publishes — a probe is read-only", async () => {
    relay = await FakeRelay.start({ backlog: [event(BUZZ_DEFAULTS.kind, [["h", "hive"]])] });
    await probeRelay({
      relayUrl: relay.url,
      identityRef: "BUZZ_NSEC",
      secretsDir: secretsDir(),
      seconds: 1,
    });
    expect(relay.published).toHaveLength(0);
  });
});

describe("publishProfile", () => {
  it("authenticates, then publishes a signed kind-0 the relay accepts", async () => {
    relay = await FakeRelay.start({ requireAuth: true });
    const result = await publishProfile({
      relayUrl: relay.url,
      identityRef: "BUZZ_NSEC",
      secretsDir: secretsDir(),
      profile: { name: "harry", about: "a test agent" },
    });

    expect(relay.authEvent).toBeDefined(); // auth happened before the write
    expect(relay.published).toHaveLength(1);
    const published = relay.published[0];
    expect(published.kind).toBe(0);
    expect(published.pubkey).toBe(result.pubkey);
    expect(JSON.parse(published.content)).toMatchObject({ name: "harry" });
  });
});
