import type { Event, EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import type { Relay } from "nostr-tools/relay";
import { connectAuthenticated } from "./connect.ts";
import { resolveBuzzSigner } from "./identity.ts";

export interface AgentProfile {
  name: string;
  about?: string;
  picture?: string;
}

/**
 * The record a client reads to decide whether this agent may be `@`-mentioned at all.
 *
 * A kind-0 profile and channel membership are not enough. Clients gate their mention
 * picker on this record, and an agent without one has its mention *stripped at send*: the
 * message posts, carries no `p` tag, and the agent — connected, authenticated, and
 * subscribed — hears nothing. Every signal on both sides reports healthy, which is what
 * makes the failure expensive to diagnose.
 *
 * Nothing else publishes it for an agent hosted outside a desktop client, so the toolkit
 * does. This is the one leg of registration not delegated to the `buzz` CLI, because that
 * CLI has no command for it.
 */
export const DIRECTORY_KIND = 10100;

/** How long to wait for the relay's copy of the record before assuming there is none. */
const DIRECTORY_READ_MS = 4000;

/**
 * How long a publish waits for the socket before giving up.
 *
 * `run` reconciles the record at startup and warns on failure, which requires a failure to
 * arrive: an unbounded connect against a relay that accepts the TCP connection and never
 * upgrades would hang the launch instead. Generous, because the cost of being wrong here is
 * a record left stale for one restart, not a refused launch.
 */
const CONNECT_MS = 10_000;

export interface AgentDirectory {
  /** The handle a client matches when a human types `@name`. */
  name: string;
  displayName?: string;
  /** Channels the agent answers in — a client gates the mention on finding its own here. */
  channelIds: string[];
  /** Who may wake it, in the vocabulary clients read. */
  respondTo: "anyone" | "allowlist" | "nobody";
  respondToAllowlist?: string[];
}

/**
 * The keys this toolkit states outright, and therefore must not carry over from an earlier
 * record. `respond_to_allowlist` is the one that bites: an agent moved off `allowlist` emits
 * no such field, so preserving the old one leaves the record contradicting its own
 * `respond_to` and naming principals the config dropped.
 */
const OWNED_KEYS = ["name", "display_name", "channel_ids", "respond_to", "respond_to_allowlist"];

function toWire(
  directory: AgentDirectory,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  // The manifest has no field for a display name, so a publish that was not given one —
  // `run`'s reconcile — keeps the record's copy rather than rewriting a chosen name to the
  // lowercase slug on a deploy that was reconciling something else. Registration gives one,
  // from profile.json, and that replaces the copy.
  const carriedName = typeof existing.display_name === "string" ? existing.display_name : undefined;
  const wire: Record<string, unknown> = {
    name: directory.name,
    display_name: directory.displayName ?? carriedName ?? directory.name,
    channel_ids: directory.channelIds,
    respond_to: directory.respondTo,
  };
  if (directory.respondToAllowlist?.length) {
    wire.respond_to_allowlist = directory.respondToAllowlist;
  }
  return wire;
}

/**
 * Whether a publish would tell the relay anything its copy does not already say.
 *
 * Keys are sorted because their order in the relay's copy is not this toolkit's to control.
 * Array order is left alone: every array here was written by this same merge, so a
 * difference in one is a difference in the config that produced it.
 */
function sameContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const canonical = (record: Record<string, unknown>): string =>
    JSON.stringify(Object.entries(record).sort(([x], [y]) => (x < y ? -1 : 1)));
  return canonical(a) === canonical(b);
}

/**
 * What a publish writes: this toolkit's fields over whatever else the record carried.
 *
 * Split out from the publish so the one rule that is easy to get wrong can be tested
 * without a relay — an owned key must be replaced, never carried, or a record keeps
 * saying what the config no longer does.
 */
export function mergeDirectoryContent(
  existing: Record<string, unknown>,
  directory: AgentDirectory,
): { content: Record<string, unknown>; preserved: string[] } {
  const carried = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !OWNED_KEYS.includes(key)),
  );
  return {
    content: { ...carried, ...toWire(directory, existing) },
    preserved: Object.keys(carried),
  };
}

/** The agent's directory record as the relay currently holds it, or undefined if it has none. */
function fetchDirectory(relay: Relay, pubkey: string): Promise<Record<string, unknown> | undefined> {
  return fetchOwn(relay, pubkey, DIRECTORY_KIND);
}

/**
 * The newest readable event of one replaceable kind signed by `pubkey`, or undefined.
 *
 * Newest by `created_at` rather than last-delivered: a relay that has not yet pruned an
 * older copy of a replaceable event may send both, in either order.
 */
function fetchOwn(
  relay: Relay,
  pubkey: string,
  kind: number,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let found: Record<string, unknown> | undefined;
    let foundAt = -Infinity;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(finish, DIRECTORY_READ_MS);

    const sub = relay.subscribe([{ kinds: [kind], authors: [pubkey] }], {
      onevent: (event: Event) => {
        if (event.created_at < foundAt) return;
        try {
          const parsed: unknown = JSON.parse(event.content);
          if (parsed && typeof parsed === "object") {
            found = parsed as Record<string, unknown>;
            foundAt = event.created_at;
          }
        } catch {
          // Unreadable content counts as none: there is nothing in it worth preserving,
          // so a directory publish replaces it wholesale.
        }
      },
      oneose: () => {
        sub.close();
        finish();
      },
      onclose: finish,
    });
  });
}

/** Reads the agent's own directory record — what `doctor` checks without publishing. */
export async function readDirectory(opts: {
  relayUrl: string;
  identityRef: string;
  secretsDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown> | undefined> {
  const signer = await resolveBuzzSigner(opts.identityRef, { dir: opts.secretsDir, env: opts.env });
  const { relay } = await connectAuthenticated(opts.relayUrl, signer);
  try {
    return await fetchDirectory(relay, await signer.getPublicKey());
  } finally {
    relay.close();
  }
}

/**
 * Reads the agent's own kind-0 profile — the names clients resolve an `@…` mention against.
 *
 * `doctor` compares it with the directory record's `display_name`: the two are written by
 * different paths (the `buzz` CLI and this toolkit), so they can drift apart.
 */
export async function readProfile(opts: {
  relayUrl: string;
  identityRef: string;
  secretsDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown> | undefined> {
  const signer = await resolveBuzzSigner(opts.identityRef, { dir: opts.secretsDir, env: opts.env });
  const { relay } = await connectAuthenticated(opts.relayUrl, signer);
  try {
    return await fetchOwn(relay, await signer.getPublicKey(), 0);
  } finally {
    relay.close();
  }
}

/**
 * Publishes the agent's directory record, preserving only fields this toolkit does not own.
 *
 * The kind is plain-replaceable and shared with settings written by other tools, so a blind
 * write is a silent deletion — including of fields the relay itself requires to accept the
 * record. Hence read-merge. The merge drops `OWNED_KEYS` first, because carrying one of
 * those forward would preserve a value this publish is replacing.
 *
 * A record that already agrees is left alone, and `published` says so. Every `run` calls
 * this, so writing regardless would put one event per agent per restart on the relay and
 * move `created_at` — the only thing a reader has to tell "reconciled" from "changed".
 */
export async function publishDirectory(opts: {
  relayUrl: string;
  identityRef: string;
  secretsDir?: string;
  /** For a caller that already holds the key — `identity register` reads it from the bundle. */
  env?: NodeJS.ProcessEnv;
  directory: AgentDirectory;
}): Promise<{
  pubkey: string;
  /** Whether this call wrote. False when the relay's copy already said all of this. */
  published: boolean;
  eventId?: string;
  accepted?: string;
  preserved: string[];
}> {
  const signer = await resolveBuzzSigner(opts.identityRef, { dir: opts.secretsDir, env: opts.env });
  const pubkey = await signer.getPublicKey();
  const { relay } = await connectAuthenticated(opts.relayUrl, signer, {
    connectTimeoutMs: CONNECT_MS,
  });

  try {
    const existing = await fetchDirectory(relay, pubkey);
    const { content, preserved } = mergeDirectoryContent(existing ?? {}, opts.directory);
    if (existing && sameContent(existing, content)) {
      return { pubkey, published: false, preserved };
    }

    const template: EventTemplate = {
      kind: DIRECTORY_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(content),
    };
    const signed = (await signer.signEvent(template)) as VerifiedEvent;
    const accepted = await relay.publish(signed);
    return { pubkey, published: true, eventId: signed.id, accepted, preserved };
  } finally {
    relay.close();
  }
}

/**
 * Publishes the agent's kind-0 profile.
 *
 * Without one the agent is an unnamed pubkey, so nobody can find it to mention — and a
 * mention is the only thing that wakes it. Publishing is also the first write this key
 * has ever attempted, so it doubles as proof the relay accepts events from it.
 */
export async function publishProfile(opts: {
  relayUrl: string;
  identityRef: string;
  secretsDir?: string;
  profile: AgentProfile;
}): Promise<{ pubkey: string; eventId: string; accepted: string }> {
  const signer = await resolveBuzzSigner(opts.identityRef, { dir: opts.secretsDir });
  const pubkey = await signer.getPublicKey();
  const { relay } = await connectAuthenticated(opts.relayUrl, signer);

  const template: EventTemplate = {
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(opts.profile),
  };

  const signed = (await signer.signEvent(template)) as VerifiedEvent;
  try {
    const accepted = await relay.publish(signed);
    return { pubkey, eventId: signed.id, accepted };
  } finally {
    relay.close();
  }
}
