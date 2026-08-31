import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { encrypt, getConversationKey } from "nostr-tools/nip44";

import {
  CORE_SLUG,
  deriveEngramAddress,
  EngramStore,
  normalizeEngramPrefix,
  normalizeEngramSlug,
  NIP44_PLAINTEXT_MAX,
} from "../src/engram.ts";
import { resolveBuzzSigner } from "../src/identity.ts";
import { privateBrainHandler, PRIVATE_BRAIN_TOOLS } from "../src/private-brain.ts";
import { FakeRelay } from "./fake-relay.ts";

const stores: EngramStore[] = [];
const relays: FakeRelay[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const relay of relays.splice(0)) await relay.stop();
});

async function setup(relayOpts: { withholdEose?: boolean } = {}) {
  const relay = await FakeRelay.start({ requireAuth: true, ...relayOpts });
  relays.push(relay);
  const secret = generateSecretKey();
  const signer = await resolveBuzzSigner("TEST_NSEC", {
    env: { TEST_NSEC: nip19.nsecEncode(secret) },
  });
  const ownerSecret = generateSecretKey();
  const owner = getPublicKey(ownerSecret);
  // Short, so a deliberately silent relay does not cost the suite the production deadline.
  const store = new EngramStore({ relayUrl: relay.url, owner, signer, queryTimeoutMs: 400 });
  stores.push(store);
  return { relay, signer, secret, owner, ownerSecret, store };
}

describe("NIP-AE primitives", () => {
  it("matches the published d-tag reference vector", () => {
    const agentSecret = new Uint8Array(32);
    agentSecret[31] = 1;
    const ownerSecret = new Uint8Array(32);
    ownerSecret[31] = 2;
    const key = getConversationKey(agentSecret, getPublicKey(ownerSecret));
    expect(deriveEngramAddress(key, "mem/example")).toBe(
      "72d4f9629106451505d7d341ea85bb3ebad4f654fcfd2aad100d5a35f8a85cba",
    );
  });

  it("normalizes shorthand while refusing slugs that leak arbitrary text into tags", () => {
    expect(normalizeEngramSlug("preferences")).toBe("mem/preferences");
    expect(normalizeEngramSlug(CORE_SLUG)).toBe(CORE_SLUG);
    expect(() => normalizeEngramSlug("mem/Upper Case")).toThrow(/invalid engram slug/);
    expect(() => normalizeEngramSlug("mem/../escape")).toThrow(/invalid engram slug/);
  });

  it("reads the three spellings of one write-scope prefix as the same grant", () => {
    expect(normalizeEngramPrefix("mem/skills/")).toBe("mem/skills");
    expect(normalizeEngramPrefix("mem/skills")).toBe("mem/skills");
    expect(normalizeEngramPrefix("skills")).toBe("mem/skills");
    expect(() => normalizeEngramPrefix("mem/Skills")).toThrow(/invalid engram slug/);
  });
});

describe("relay-backed private memory", () => {
  it("encrypts a write, verifies it as head, and reads it back", async () => {
    const { relay, owner, store } = await setup();
    const written = await store.write("preferences", "Prefers concise status updates.");

    expect(written.slug).toBe("mem/preferences");
    expect(relay.published).toHaveLength(1);
    const event = relay.published[0];
    expect(event.kind).toBe(30_174);
    expect(event.tags).toContainEqual(["p", owner]);
    expect(event.tags.find((tag) => tag[0] === "d")?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(event.content).not.toContain("concise");

    await expect(store.read("mem/preferences")).resolves.toMatchObject({
      value: "Prefers concise status updates.",
      eventId: event.id,
    });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ slug: "mem/preferences", eventId: event.id }),
    ]);
  });

  it("replaces an existing value and uses a strictly newer timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-15T00:00:00Z").getTime());
    const { store } = await setup();
    const first = await store.write("state", "one");
    const second = await store.write("state", "two");

    expect(second.createdAt).toBe(first.createdAt + 1);
    await expect(store.read("state")).resolves.toMatchObject({ value: "two" });
  });

  it("tombstones a value without pretending core can be deleted", async () => {
    const { store } = await setup();
    await store.write("state", "temporary");
    await store.remove("state");

    await expect(store.read("state")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    await expect(store.remove("core")).rejects.toThrow(/cannot be deleted/);
  });

  it("treats an undecryptable existing record as an error, not an empty memory", async () => {
    const { relay, signer, owner, store } = await setup();
    const slug = "mem/locked";
    const address = deriveEngramAddress(await signer.conversationKey(owner), slug);
    const wrongKey = await signer.conversationKey(getPublicKey(generateSecretKey()));
    const bad = await signer.signEvent({
      kind: 30_174,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", address], ["p", owner]],
      content: encrypt(JSON.stringify({ slug, value: "secret" }), wrongKey),
    });
    relay.backlog.push(bad);

    await expect(store.read(slug)).rejects.toThrow(/not valid or decryptable/);
    await expect(store.write(slug, "replacement")).rejects.toThrow(/not valid or decryptable/);
  });

  // A relay serving both copies must not let the readable one speak for the address: the
  // agent would act on a superseded value, and its next write would replace a record it
  // could not read.
  it("refuses a stale readable record when a newer one at the address is unreadable", async () => {
    const { relay, signer, owner, store } = await setup();
    const slug = "mem/masked";
    const key = await signer.conversationKey(owner);
    const address = deriveEngramAddress(key, slug);
    const wrongKey = await signer.conversationKey(getPublicKey(generateSecretKey()));
    const now = Math.floor(Date.now() / 1000);

    relay.backlog.push(
      await signer.signEvent({
        kind: 30_174,
        created_at: now - 100,
        tags: [["d", address], ["p", owner]],
        content: encrypt(JSON.stringify({ slug, value: "superseded" }), key),
      }),
      await signer.signEvent({
        kind: 30_174,
        created_at: now,
        tags: [["d", address], ["p", owner]],
        content: encrypt(JSON.stringify({ slug, value: "current" }), wrongKey),
      }),
    );

    await expect(store.read(slug)).rejects.toThrow(/not valid or decryptable/);
    await expect(store.list()).rejects.toThrow(/not valid or decryptable/);
    await expect(store.write(slug, "replacement")).rejects.toThrow(/not valid or decryptable/);
    expect(relay.published).toHaveLength(0);
  });

  // nostr-tools invents an EOSE of its own after ~4.4s, so silence would otherwise come
  // back as an empty result — indistinguishable from a relay that holds nothing.
  it("reports a relay that accepts a query and then says nothing, rather than reading it as empty", async () => {
    const { store } = await setup({ withholdEose: true });
    await expect(store.read("core")).rejects.toThrow(/timed out after 400ms/);
    await expect(store.list()).rejects.toThrow(/timed out after 400ms/);
    await expect(store.write("state", "value")).rejects.toThrow(/timed out after 400ms/);
  });

  it("rejects duplicate envelope tags and duplicate JSON members", async () => {
    const { relay, signer, owner, store } = await setup();
    const slug = "mem/malformed";
    const key = await signer.conversationKey(owner);
    const address = deriveEngramAddress(key, slug);
    const duplicateTag = await signer.signEvent({
      kind: 30_174,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", address], ["d", address], ["p", owner]],
      content: encrypt(JSON.stringify({ slug, value: "bad" }), key),
    });
    relay.backlog.push(duplicateTag);
    await expect(store.read(slug)).rejects.toThrow(/not valid or decryptable/);

    relay.backlog.splice(0);
    const duplicateJson = await signer.signEvent({
      kind: 30_174,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["d", address], ["p", owner]],
      content: encrypt(
        `{"slug":"${slug}","value":"bad","extra":{"same":1,"same":2}}`,
        key,
      ),
    });
    relay.backlog.push(duplicateJson);
    await expect(store.read(slug)).rejects.toThrow(/not valid or decryptable/);
  });

  it("refuses a value beyond NIP-44's plaintext cap", async () => {
    const { store } = await setup();
    await expect(store.write("large", "x".repeat(NIP44_PLAINTEXT_MAX))).rejects.toThrow(
      /NIP-44 limit/,
    );
  });
});

describe("private-brain MCP", () => {
  it("advertises key-value tools and round-trips them", async () => {
    const { store } = await setup();
    const listed = await privateBrainHandler(store)({ id: 1, method: "tools/list" });
    expect((listed?.tools as typeof PRIVATE_BRAIN_TOOLS).map((tool) => tool.name)).toEqual([
      "brain_list",
      "brain_read",
      "brain_write",
      "brain_delete",
    ]);

    const write = await privateBrainHandler(store)({
      id: 2,
      method: "tools/call",
      params: { name: "brain_write", arguments: { slug: "handoff", value: "Ready." } },
    });
    expect(JSON.stringify(write)).toContain("wrote mem/handoff");

    const read = await privateBrainHandler(store)({
      id: 3,
      method: "tools/call",
      params: { name: "brain_read", arguments: { slug: "handoff" } },
    });
    expect(JSON.stringify(read)).toContain("Ready.");
  });

  describe("what the audit records about a refused private-memory write", () => {
    it("records both gates as refusals, and never the value", async () => {
      const { store } = await setup();
      const handler = privateBrainHandler(store, {
        writeScope: ["mem/skills/"],
        killSwitches: ["mem/jobs/shift"],
      });
      const lines: string[] = [];
      const collect = (line: unknown) => void lines.push(String(line));
      const info = vi.spyOn(console, "info").mockImplementation(collect);
      const warn = vi.spyOn(console, "warn").mockImplementation(collect);
      try {
        // `on` is what actually arms; a value that does not arm parks the job and is
        // deliberately never gated, so it would record `ok` and prove nothing here.
        const attempts = [
          { slug: "mem/jobs/shift", value: "on" },
          { slug: "mem/handoff", value: "note SECRET-VALUE" },
        ];
        for (const args of attempts) {
          await handler({
            id: 1,
            method: "tools/call",
            params: { name: "brain_write", arguments: args },
          }).catch(() => undefined);
        }
      } finally {
        info.mockRestore();
        warn.mockRestore();
      }

      const audited = lines.filter((line) => line.startsWith("tool_call "));
      expect(audited).toHaveLength(2);
      // A gate stopped both before they ran. "Something tried to arm a job through a turn"
      // is the line an operator goes looking for; `outcome=failed` would bury it among
      // tools that merely broke.
      expect(audited[0]).toContain('tool_call tool="mcp__private-brain__brain_write" outcome=refused');
      expect(audited[0]).toContain("is a job kill switch");
      expect(audited[1]).toContain("outcome=refused");
      expect(audited[1]).toContain("outside this agent's write scope");
      // The slug is declared and the value never is: memory content stays out of the log.
      expect(audited[0]).toContain('"slug":"mem/jobs/shift"');
      expect(audited.join("\n")).not.toContain("SECRET-VALUE");
    });
  });

  describe("write scope", () => {
    const call = (handler: ReturnType<typeof privateBrainHandler>, name: string, args: unknown) =>
      handler({ id: 1, method: "tools/call", params: { name, arguments: args } });

    it("confines writes and deletes to the scope while leaving reads whole", async () => {
      const { store } = await setup();
      const handler = privateBrainHandler(store, { writeScope: ["mem/skills/"] });

      await expect(call(handler, "brain_write", { slug: "mem/skills/rust", value: "x" })).resolves
        .toBeDefined();
      await expect(call(handler, "brain_write", { slug: "mem/skills", value: "x" })).resolves
        .toBeDefined();

      await expect(call(handler, "brain_write", { slug: "mem/handoff", value: "x" })).rejects
        .toThrow(/write refused: mem\/handoff is outside this agent's write scope \(mem\/skills\)/);
      await expect(call(handler, "brain_delete", { slug: "mem/handoff" })).rejects.toThrow(
        /delete refused: mem\/handoff is outside/,
      );
      await expect(call(handler, "brain_write", { slug: CORE_SLUG, value: "x" })).rejects.toThrow(
        /outside this agent's write scope/,
      );

      // The bound is on changing memory, not on seeing it: a scoped agent still reads the
      // core profile it is no longer allowed to rewrite.
      await store.write(CORE_SLUG, "I am the agent.");
      await expect(call(handler, "brain_read", { slug: CORE_SLUG })).resolves.toBeDefined();
      await expect(call(handler, "brain_list", {})).resolves.toBeDefined();
    });

    it("refuses a mid-token near-miss and the shorthand spelling of one", async () => {
      const { store } = await setup();
      const handler = privateBrainHandler(store, { writeScope: ["mem/skills"] });

      // `startsWith("mem/skills")` would have taken both of these.
      await expect(call(handler, "brain_write", { slug: "mem/skills-notes", value: "x" })).rejects
        .toThrow(/outside this agent's write scope/);
      await expect(call(handler, "brain_write", { slug: "skills-notes", value: "x" })).rejects
        .toThrow(/mem\/skills-notes is outside/);
      // …and the shorthand of an in-scope key is still in scope, because the check runs on
      // the normalized slug rather than on whatever the model typed.
      await expect(call(handler, "brain_write", { slug: "skills/rust", value: "x" })).resolves
        .toBeDefined();
    });

    // The shape a self-editing agent actually needs: rewrite my own profile, curate one
    // subtree, touch nothing else — including a key some other process owns.
    it("admits core alongside a subtree, and still refuses deleting core", async () => {
      const { store } = await setup();
      const handler = privateBrainHandler(store, { writeScope: [CORE_SLUG, "mem/skills/"] });

      await expect(call(handler, "brain_write", { slug: CORE_SLUG, value: "x" })).resolves
        .toBeDefined();
      await expect(call(handler, "brain_write", { slug: "mem/skills/rust", value: "x" })).resolves
        .toBeDefined();
      await expect(call(handler, "brain_delete", { slug: "mem/skills/rust" })).resolves.toBeDefined();

      await expect(call(handler, "brain_write", { slug: "mem/state/peaks", value: "x" })).rejects
        .toThrow(/outside this agent's write scope/);
      // In scope to write, and still undeletable: the store refuses core tombstones
      // outright, so a scope naming core cannot widen deletion by including it.
      await expect(call(handler, "brain_delete", { slug: CORE_SLUG })).rejects.toThrow(
        /core private memory cannot be deleted/,
      );
    });

    it("states the scope in the descriptions of the two tools it constrains", async () => {
      const { store } = await setup();
      const listed = await privateBrainHandler(store, { writeScope: ["mem/skills/"] })({
        id: 1,
        method: "tools/list",
      });
      const tools = listed?.tools as Array<{ name: string; description: string }>;
      const scoped = tools.filter((tool) => /only keys under mem\/skills/.test(tool.description));
      expect(scoped.map((tool) => tool.name)).toEqual(["brain_write", "brain_delete"]);
    });

    it("rejects a malformed prefix when the brain is built, not on the first write", async () => {
      const { store } = await setup();
      expect(() => privateBrainHandler(store, { writeScope: ["mem/Skills"] })).toThrow(/invalid engram slug/);
    });

    // Unreachable through the compiler and deliberately guarded anyway: a bare array has no
    // `writeScope` property, so reading one quietly would turn a confinement somebody
    // configured into no confinement at all. Of the two ways to get that wrong, only this
    // one is silent, so it is the one that gets a check.
    it("refuses a bare scope array at construction rather than reading it as an empty scope", async () => {
      const { store } = await setup();
      expect(() => privateBrainHandler(store, ["mem/skills"] as never)).toThrow(
        /not a scope array/,
      );
    });
  });

  /**
   * The write side of the kill switch, through the surface that actually mediates the key.
   *
   * This brain is where §6.3 rule 4 stops being steering: `brain_write` treated the switch
   * key like any other note, so an arming write was admitted for exactly the same authors as
   * a parking one. Nothing arriving here is ever a human — a hosted MCP server is
   * process-level and carries no per-request author — so nothing arriving here may arm.
   */
  describe("job kill switches", () => {
    const call = (handler: ReturnType<typeof privateBrainHandler>, name: string, args: unknown) =>
      handler({ id: 1, method: "tools/call", params: { name, arguments: args } });

    const brain = (store: EngramStore) =>
      privateBrainHandler(store, { killSwitches: ["mem/shift/enabled"] });

    it("refuses arming and admits parking, at the same key", async () => {
      const { store } = await setup();
      const handler = brain(store);

      await expect(call(handler, "brain_write", { slug: "mem/shift/enabled", value: "on" }))
        .rejects.toThrow(
          /private-memory write refused: mem\/shift\/enabled is a job kill switch, and only a human may arm a job/,
        );
      // Parking is never gated: a refusal to park is a kill switch that failed.
      await expect(call(handler, "brain_write", { slug: "mem/shift/enabled", value: "off" }))
        .resolves.toBeDefined();
      // …and the delete is refused, because an unset key arms a job that fails open.
      await expect(call(handler, "brain_delete", { slug: "mem/shift/enabled" })).rejects.toThrow(
        /private-memory delete refused: mem\/shift\/enabled is a job kill switch/,
      );
    });

    it("splits arming from parking on the same vocabulary the reader uses", async () => {
      // Not a second list of on-spellings: `interpretSwitchValue` is what the job host
      // reads the key with, so a writer and a reader disagreeing is not expressible.
      const { store } = await setup();
      const handler = brain(store);
      for (const value of ["ON", " true ", "yes", "1", "enabled", "armed"]) {
        await expect(call(handler, "brain_write", { slug: "mem/shift/enabled", value })).rejects
          .toThrow(/only a human may arm a job/);
      }
      for (const value of ["off", "false", "", "paused until Monday", "onn"]) {
        await expect(call(handler, "brain_write", { slug: "mem/shift/enabled", value })).resolves
          .toBeDefined();
      }
    });

    it("refuses the shorthand spelling of the key too", async () => {
      // The check runs on the normalized slug, so the switch is not one `mem/` away from
      // being armed by a model that typed the short form.
      const { store } = await setup();
      await expect(call(brain(store), "brain_write", { slug: "shift/enabled", value: "yes" }))
        .rejects.toThrow(/mem\/shift\/enabled is a job kill switch/);
    });

    it("leaves every other key alone, including a near-miss", async () => {
      // A note that happens to look like a switch is a note. Only the keys this deployment
      // declares are gated.
      const { store } = await setup();
      const handler = brain(store);
      for (const slug of ["mem/shift/enable", "mem/other/enabled", "mem/shift"]) {
        await expect(call(handler, "brain_write", { slug, value: "on" })).resolves.toBeDefined();
      }
    });

    // The two gates meet here, and the order decides which one wins. A scope is a grant an
    // operator narrowed on purpose; taking "parking is never gated" away from the agent as a
    // side effect of a decision about its skills subtree is not what they narrowed.
    it("lets a scoped agent park a switch its scope does not cover, and still not arm it", async () => {
      const { store } = await setup();
      const handler = privateBrainHandler(store, {
        writeScope: ["mem/skills"],
        killSwitches: ["mem/shift/enabled"],
      });

      await expect(call(handler, "brain_write", { slug: "mem/shift/enabled", value: "off" }))
        .resolves.toBeDefined();
      // Safe in exactly one direction: past the scope to park, never past it to arm.
      await expect(call(handler, "brain_write", { slug: "mem/shift/enabled", value: "on" }))
        .rejects.toThrow(/is a job kill switch, and only a human may arm a job/);
      await expect(call(handler, "brain_delete", { slug: "mem/shift/enabled" })).rejects.toThrow(
        /is a job kill switch/,
      );
      // …and the scope is untouched for every key that is not a declared switch.
      await expect(call(handler, "brain_write", { slug: "mem/handoff", value: "x" })).rejects
        .toThrow(/outside this agent's write scope/);
    });

    it("states the rule in the descriptions of the two tools it constrains", async () => {
      // A bound the model cannot see is a bound it spends turns rediscovering — here, by
      // retrying an arming write it will never be allowed to make.
      const { store } = await setup();
      const listed = await brain(store)({ id: 1, method: "tools/list" });
      const tools = listed?.tools as Array<{ name: string; description: string }>;
      const bounded = tools.filter((tool) => /never armed or deleted/.test(tool.description));
      expect(bounded.map((tool) => tool.name)).toEqual(["brain_write", "brain_delete"]);
      expect(bounded[0].description).toContain("mem/shift/enabled");
    });
  });
});
