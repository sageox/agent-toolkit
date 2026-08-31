import { createHmac } from "node:crypto";
import { decrypt, encrypt } from "nostr-tools/nip44";
import type { Event } from "nostr-tools/pure";
import { verifyEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import type { Relay, Subscription } from "nostr-tools/relay";

import { connectAuthenticated } from "./connect.ts";
import type { EngramSigner } from "./identity.ts";

/** NIP-AE's addressable event kind. */
const ENGRAM_KIND = 30_174;
export const CORE_SLUG = "core";
export const NIP44_PLAINTEXT_MAX = 65_535;
const D_TAG_DOMAIN = "agent-memory/v1/d-tag";
const CLOCK_POISON_SECONDS = 5 * 60;
/**
 * How long one relay query may run before silence is reported as silence.
 *
 * Without it, nostr-tools synthesises an EOSE of its own after ~4.4s and the query
 * *resolves empty* — a relay that accepted the REQ and then said nothing reads back as
 * "there is no such record", and the next write publishes over whatever it actually
 * holds. Rejecting is the only answer a silent relay may give.
 */
const QUERY_TIMEOUT_MS = 10_000;

export type EngramBody =
  | { slug: "core"; profile: string }
  | { slug: string; value: string | null };

export interface EngramEntry {
  slug: string;
  value: string;
  eventId: string;
  createdAt: number;
}

export interface EngramListing {
  slug: string;
  eventId: string;
  createdAt: number;
}

/**
 * One event the relay returned that this agent provably signed at this address.
 *
 * `body` is absent when the record is authentic but unreadable — a broken envelope,
 * content this key cannot decrypt, or a body that does not match its own address. Such a
 * record is deliberately kept as a candidate rather than dropped: it is still the value
 * at that address, and skipping it would let an older readable event pass for the head.
 */
interface Candidate {
  event: Event;
  body?: EngramBody;
}

interface Decoded {
  event: Event;
  body: EngramBody;
}

/** Accepts `core`, a full `mem/…` slug, or the CLI-compatible shorthand without `mem/`. */
export function normalizeEngramSlug(raw: string): string {
  const slug = raw === CORE_SLUG || raw.startsWith("mem/") ? raw : `mem/${raw}`;
  validateEngramSlug(slug);
  return slug;
}

/**
 * Canonicalizes one write-scope prefix.
 *
 * `mem/skills/`, `mem/skills`, and `skills` are the same grant, because those are the
 * three ways an operator writes it — the first is how the allowlist this replaces spelled
 * it, and the third is the shorthand every other slug argument already accepts.
 */
export function normalizeEngramPrefix(raw: string): string {
  return normalizeEngramSlug(raw.endsWith("/") ? raw.slice(0, -1) : raw);
}

/**
 * Whether `slug` falls inside one of these prefixes.
 *
 * Compared at segment boundaries, never as a raw string prefix: `mem/skills` admits
 * `mem/skills` and `mem/skills/rust` and refuses `mem/skills-notes`. A bare `startsWith`
 * would have taken that last one, and a mid-token match is how a scoped grant quietly
 * becomes a wider one than anybody approved.
 */
export function withinEngramScope(slug: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => slug === prefix || slug.startsWith(`${prefix}/`));
}

function validateEngramSlug(slug: string): void {
  if (slug === CORE_SLUG) return;
  if (Buffer.byteLength(slug) > 255) throw new Error("engram slug exceeds 255 bytes");
  if (!/^mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*$/.test(slug)) {
    throw new Error(
      `invalid engram slug ${JSON.stringify(slug)} (expected core or mem/<lowercase-key>)`,
    );
  }
}

/** The public address leaks neither the slug nor its contents. */
export function deriveEngramAddress(conversationKey: Uint8Array, slug: string): string {
  validateEngramSlug(slug);
  return createHmac("sha256", conversationKey)
    .update(D_TAG_DOMAIN)
    .update(Buffer.from([0]))
    .update(slug)
    .digest("hex");
}

/**
 * Newest timestamp wins; NIP-01 resolves a same-second tie to the lowest event id.
 *
 * Deliberately chosen over *every* candidate, readable or not, so that an unreadable
 * record cannot be filtered out of the running and let a stale one win.
 */
function selectEngramHead<T extends { event: Event }>(entries: T[]): T | undefined {
  return entries.reduce<T | undefined>((best, entry) => {
    if (!best || entry.event.created_at > best.event.created_at) return entry;
    if (entry.event.created_at === best.event.created_at && entry.event.id < best.event.id) {
      return entry;
    }
    return best;
  }, undefined);
}

/**
 * Relay-backed NIP-AE storage for one `(agent, owner)` pair.
 *
 * It stays in the gateway zone because it holds the agent signer. The MCP-facing brain
 * receives values and opaque event ids, never the key that signs or decrypts them.
 */
export class EngramStore {
  private relay?: Relay;
  private connecting?: Promise<Relay>;
  private conversationKey?: Promise<Uint8Array>;
  private agentPubkey?: Promise<string>;

  constructor(
    private opts: {
      relayUrl: string;
      owner: string;
      signer: EngramSigner;
      /** Overrides {@link QUERY_TIMEOUT_MS} where relay latency genuinely needs longer. */
      queryTimeoutMs?: number;
    },
  ) {
    if (!/^[0-9a-f]{64}$/.test(opts.owner)) {
      throw new Error("private memory owner must be a lowercase 64-character hex pubkey");
    }
  }

  async list(): Promise<EngramListing[]> {
    const events = await this.query({
      kinds: [ENGRAM_KIND],
      authors: [await this.agent()],
      "#p": [this.opts.owner],
      limit: 5000,
    });

    const groups = new Map<string, Candidate[]>();
    for (const candidate of await this.candidatesOf(events)) {
      const d = tagValue(candidate.event, "d");
      if (!d) continue;
      const members = groups.get(d) ?? [];
      members.push(candidate);
      groups.set(d, members);
    }

    const listings: EngramListing[] = [];
    for (const [d, members] of groups) {
      const head = selectEngramHead(members)!;
      // Omitting a key whose current value cannot be read would report it as deleted,
      // which is the same lie as reading a stale one. Say so instead.
      if (!head.body) {
        throw new Error(
          `private-memory address ${d} has a current record (event ${head.event.id}) that is not valid or decryptable`,
        );
      }
      if (head.body.slug === CORE_SLUG || bodyValue(head.body) === null) continue;
      listings.push({
        slug: head.body.slug,
        eventId: head.event.id,
        createdAt: head.event.created_at,
      });
    }
    return listings.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async read(rawSlug: string): Promise<EngramEntry | undefined> {
    const slug = normalizeEngramSlug(rawSlug);
    const head = await this.fetchHead(slug);
    if (!head) return undefined;
    const value = bodyValue(head.body);
    if (value === null) return undefined;
    return {
      slug,
      value,
      eventId: head.event.id,
      createdAt: head.event.created_at,
    };
  }

  async write(rawSlug: string, value: string): Promise<EngramEntry> {
    const slug = normalizeEngramSlug(rawSlug);
    const body: EngramBody = slug === CORE_SLUG
      ? { slug: CORE_SLUG, profile: value }
      : { slug, value };
    return this.publishBody(body);
  }

  async remove(rawSlug: string): Promise<{ slug: string; eventId: string; createdAt: number }> {
    const slug = normalizeEngramSlug(rawSlug);
    if (slug === CORE_SLUG) {
      throw new Error("core private memory cannot be deleted; replace its profile instead");
    }
    const written = await this.publishBody({ slug, value: null });
    return { slug, eventId: written.eventId, createdAt: written.createdAt };
  }

  close(): void {
    this.relay?.close();
    this.relay = undefined;
    this.connecting = undefined;
  }

  private async publishBody(body: EngramBody): Promise<EngramEntry> {
    const encoded = JSON.stringify(body);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > NIP44_PLAINTEXT_MAX) {
      throw new Error(
        `private-memory body exceeds ${NIP44_PLAINTEXT_MAX}-byte NIP-44 limit (${bytes} bytes)`,
      );
    }

    const head = await this.fetchHead(body.slug);
    const now = Math.floor(Date.now() / 1000);
    if (head && head.event.created_at > now + CLOCK_POISON_SECONDS) {
      throw new Error(
        `private-memory head is ${head.event.created_at - now}s ahead of this clock; refusing a clock-poisoned write`,
      );
    }
    const createdAt = Math.max(now, (head?.event.created_at ?? 0) + 1);
    const key = await this.key();
    const d = deriveEngramAddress(key, body.slug);
    const signed = await this.opts.signer.signEvent({
      kind: ENGRAM_KIND,
      created_at: createdAt,
      tags: [
        ["d", d],
        ["p", this.opts.owner],
        ["alt", "encrypted agent memory record"],
      ],
      content: encrypt(encoded, key),
    });

    const reason = await (await this.connection()).publish(signed);
    if (/^(duplicate:|duplicate$)/i.test(reason.trim())) {
      throw new Error("private-memory write conflict: relay already has a newer head");
    }

    // Do not report success merely because one relay acknowledged a packet. Re-read the
    // authoritative head; a concurrent writer may already have won.
    let verified: Decoded | undefined;
    for (const delayMs of [0, 100, 250]) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      verified = await this.fetchHead(body.slug);
      if (verified?.event.id === signed.id) break;
    }
    if (verified?.event.id !== signed.id) {
      throw new Error("private-memory write conflict: the published event is not the head");
    }
    const value = bodyValue(body);
    return {
      slug: body.slug,
      value: value ?? "",
      eventId: signed.id,
      createdAt,
    };
  }

  private async fetchHead(slug: string): Promise<Decoded | undefined> {
    const d = deriveEngramAddress(await this.key(), slug);
    const events = await this.query({
      kinds: [ENGRAM_KIND],
      authors: [await this.agent()],
      "#d": [d],
      "#p": [this.opts.owner],
      limit: 16,
    });
    const candidates = (await this.candidatesOf(events)).filter((candidate) =>
      candidate.event.tags.some((tag) => tag[0] === "d" && tag[1] === d),
    );
    const head = selectEngramHead(candidates);
    if (head && !head.body) {
      // Unreadable is not absent, and it is not stale either. Dropping this record and
      // handing back an older readable one would report a value that is no longer
      // current, and let the next write replace a record this agent could not read.
      throw new Error(
        `private-memory record ${slug} has a current event (${head.event.id}) that is not valid or decryptable`,
      );
    }
    return head?.body ? { event: head.event, body: head.body } : undefined;
  }

  /**
   * The relay's answer, reduced to records this agent provably wrote.
   *
   * The signature check is what makes failing closed on an unreadable head safe: a relay
   * cannot brick private memory by serving junk at an address, because an event this
   * agent did not sign was never its memory in the first place. Everything that survives
   * that gate is a real record, so an unreadable one is kept as a candidate.
   */
  private async candidatesOf(events: Event[]): Promise<Candidate[]> {
    const agent = await this.agent();
    const out: Candidate[] = [];
    for (const event of events) {
      if (event.kind !== ENGRAM_KIND || event.pubkey !== agent) continue;
      if (!verifyEvent(event)) continue;
      out.push({ event, body: await this.readBody(event).catch(() => undefined) });
    }
    return out;
  }

  private async readBody(event: Event): Promise<EngramBody> {
    const dTags = event.tags.filter((tag) => tag[0] === "d");
    const pTags = event.tags.filter((tag) => tag[0] === "p");
    if (
      dTags.length !== 1 ||
      pTags.length !== 1 ||
      dTags[0].length < 2 ||
      pTags[0].length < 2 ||
      pTags[0][1] !== this.opts.owner
    ) {
      throw new Error("invalid engram envelope");
    }

    const plaintext = decrypt(event.content, await this.key());
    const body = parseEngramBody(plaintext);
    if (deriveEngramAddress(await this.key(), body.slug) !== dTags[0][1]) {
      throw new Error("engram body does not match its private address");
    }
    return body;
  }

  private key(): Promise<Uint8Array> {
    return (this.conversationKey ??= this.opts.signer.conversationKey(this.opts.owner));
  }

  private agent(): Promise<string> {
    return (this.agentPubkey ??= this.opts.signer.getPublicKey());
  }

  /**
   * One relay connection, replaced only when the last one is beyond reviving.
   *
   * A dropped connection is reconnecting on its own, but it cannot carry a REQ in the
   * meantime, so a tool call arriving inside that backoff has to open a new one. The old
   * one is closed first: left alone it reconnects anyway, holds its ping interval, and is
   * no longer reachable from `close()` — one leaked socket per drop the agent writes
   * through, in a gateway that runs for weeks.
   */
  private async connection(): Promise<Relay> {
    if (this.relay?.connected) return this.relay;
    return (this.connecting ??= connectAuthenticated(this.opts.relayUrl, this.opts.signer, {
      enableReconnect: true,
    })
      .then(({ relay }) => {
        this.relay?.close();
        return (this.relay = relay);
      })
      .finally(() => {
        this.connecting = undefined;
      }));
  }

  private async query(filter: Filter): Promise<Event[]> {
    const relay = await this.connection();
    return new Promise<Event[]>((resolve, reject) => {
      const events: Event[] = [];
      let settled = false;
      let sub: Subscription | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = this.opts.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        sub?.close();
        if (error) reject(error);
        else resolve(events);
      };

      deadline = setTimeout(
        () => finish(new Error(`private-memory query timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      try {
        sub = relay.subscribe([filter], {
          // Past our own deadline on purpose. nostr-tools otherwise invents an EOSE after
          // ~4.4s and this query resolves *empty*, which a caller cannot tell from a relay
          // that genuinely holds nothing — the one answer silence must never produce.
          eoseTimeout: timeoutMs * 2,
          onevent: (event) => events.push(event),
          oneose: () => finish(),
          onclose: (reason) => finish(new Error(`private-memory query closed: ${reason}`)),
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

function tagValue(event: Event, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function bodyValue(body: EngramBody): string | null {
  return "profile" in body ? body.profile : body.value;
}

function parseEngramBody(plaintext: string): EngramBody {
  assertNoDuplicateJsonKeys(plaintext);
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new Error("engram content is not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("engram body must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.slug !== "string") throw new Error("engram body is missing a string slug");
  validateEngramSlug(obj.slug);
  if (obj.slug === CORE_SLUG) {
    if (typeof obj.profile !== "string") throw new Error("core engram needs a string profile");
    return { slug: CORE_SLUG, profile: obj.profile };
  }
  if (obj.value !== null && typeof obj.value !== "string") {
    throw new Error("memory engram needs a string or null value");
  }
  return { slug: obj.slug, value: obj.value as string | null };
}

/** A small JSON grammar walk used only to enforce NIP-AE's duplicate-key rejection rule. */
function assertNoDuplicateJsonKeys(text: string): void {
  let at = 0;
  const ws = () => {
    while (/\s/.test(text[at] ?? "")) at++;
  };
  const string = (): string => {
    ws();
    const start = at;
    if (text[at++] !== '"') throw new Error("invalid JSON string");
    let escaped = false;
    while (at < text.length) {
      const ch = text[at++];
      if (!escaped && ch === '"') return JSON.parse(text.slice(start, at)) as string;
      if (!escaped && ch === "\\") escaped = true;
      else escaped = false;
    }
    throw new Error("unterminated JSON string");
  };
  const value = (): void => {
    ws();
    if (text[at] === "{") {
      at++;
      ws();
      const keys = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      while (true) {
        const key = string();
        if (keys.has(key)) throw new Error(`duplicate JSON member ${key}`);
        keys.add(key);
        ws();
        if (text[at++] !== ":") throw new Error("invalid JSON object");
        value();
        ws();
        const next = text[at++];
        if (next === "}") return;
        if (next !== ",") throw new Error("invalid JSON object");
      }
    }
    if (text[at] === "[") {
      at++;
      ws();
      if (text[at] === "]") {
        at++;
        return;
      }
      while (true) {
        value();
        ws();
        const next = text[at++];
        if (next === "]") return;
        if (next !== ",") throw new Error("invalid JSON array");
      }
    }
    if (text[at] === '"') {
      string();
      return;
    }
    const start = at;
    while (at < text.length && !/[\s,\]}]/.test(text[at])) at++;
    if (start === at) throw new Error("invalid JSON value");
    JSON.parse(text.slice(start, at));
  };
  value();
  ws();
  if (at !== text.length) throw new Error("trailing data after JSON value");
}
