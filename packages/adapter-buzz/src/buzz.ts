import type { Relay } from "nostr-tools/relay";
import { connectAuthenticated } from "./connect.ts";
import type { Signer } from "nostr-tools/signer";
import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import type {
  SurfaceAdapter,
  InboundEvent,
  GuardedMessage,
  ChannelDecl,
  ChannelRef,
  EventRef,
  ReactionResult,
  ThreadReply,
} from "@sageox/agent-toolkit-core";
import { toHexPubkey } from "./identity.ts";
import { DIRECTORY_KIND } from "./profile.ts";
import {
  toInboundEvent,
  toChannelPostTemplate,
  toReplyTemplate,
  toReactionTemplate,
  toReactionRemovalTemplate,
  toTypingTemplate,
  toThreadReply,
  BUZZ_DEFAULTS,
  SURFACE,
} from "./normalize.ts";

/**
 * How far back a listener with no cursor still hears, in seconds.
 *
 * `created_at` is the author's clock, not ours. A message published a moment ago can
 * carry a timestamp a little behind our own second, and a floor set at exactly now
 * excludes it from the REQ — so it is never delivered, the cursor never advances past
 * it, and every later start excludes it again. A minute absorbs that skew and relay
 * delivery delay while still being now to anyone reading the channel.
 */
const FRESH_START_LOOKBACK = 60;

/**
 * How long {@link BuzzAdapter.readThread} waits for the relay to finish answering.
 *
 * EOSE is what makes a read an answer rather than a guess: it says the relay accepted the
 * REQ and has sent everything it stores for it, so an empty result means nobody replied.
 * Without it there is no way to tell that from a relay that took the query and went quiet
 * — which is why the wait ends in a throw rather than in whatever arrived first. A probe
 * reading a thread it just rooted is asking a question it will act on.
 */
const THREAD_READ_TIMEOUT_MS = 5000;

export interface BuzzAdapterOptions {
  relayUrl: string;
  /**
   * `PlainKeySigner` (file nsec) by default; `BunkerSigner` (NIP-46) is a drop-in for
   * the hardened tier, because nostr-tools types both as `Signer`.
   */
  signer: Signer;
  /**
   * The channels this agent serves, each carrying whether its replies are public.
   *
   * This relay streams events for channel (`#h`) subscriptions but **not** for mention
   * (`#p`) subscriptions: a `#p` filter returns stored events on REQ and then never
   * pushes, so an agent subscribed that way only ever sees a message when it restarts.
   * Subscribing per channel and deciding `mentionsMe` locally is what makes a live tag
   * arrive at all. Falls back to a mention filter when no channels are configured.
   *
   * Per channel means one REQ each, not one REQ naming them all: an agent that opened a
   * single REQ naming two channels answered its boot batch and then never received another
   * live event, while a one-channel agent on the same relay and channel kept receiving.
   * One channel is the case where the two shapes are the same REQ, which is why the first
   * migrated agents did not show it.
   */
  channels?: readonly ChannelDecl[];
  /**
   * Resume point from a previous run — the gap a restart would otherwise lose. Absent
   * means there is no previous run to resume, and `start` bounds the first REQ at
   * {@link FRESH_START_LOOKBACK} rather than asking for the channel's whole stored history.
   */
  since?: number;
}

export class BuzzAdapter implements SurfaceAdapter {
  readonly kind = SURFACE;

  private relay?: Relay;
  private pubkey?: string;
  private since?: number;
  /** Held so a reconnect can re-open the subscriptions `start` opened. */
  private onEvent?: (e: InboundEvent) => void;
  /**
   * The last inbound event per channel. Replies thread onto it, and a channel we have
   * never received from is one we refuse to publish into.
   */
  private lastByChannel = new Map<string, InboundEvent>();
  /** The ids the relay can never vouch for privacy on, so normalization does not re-derive it. */
  private readonly privateChannels: ReadonlySet<string>;
  /**
   * Pubkeys the relay's directory lists, with the name each record carries, so a sibling's
   * message carries `isAgent` and the chain-depth cap applies to it, and so a person can
   * ask for it by name. Learned from the relay rather than declared: the toolkit owns no
   * roster, and a directory record is what makes a pubkey mentionable at all. Never pruned
   * — a record that disappears does not make its author a person.
   */
  private agents = new Map<string, string | undefined>();

  constructor(private opts: BuzzAdapterOptions) {
    this.since = opts.since;
    this.privateChannels = new Set(
      (opts.channels ?? []).filter((c) => c.reply === "private").map((c) => c.id),
    );
  }

  /** The resume point to hand back on the next start. */
  cursor(): number | undefined {
    return this.since;
  }

  async start(onEvent?: (e: InboundEvent) => void): Promise<void> {
    this.pubkey = await this.opts.signer.getPublicKey();

    // Authentication must complete before the first REQ: an auth-required relay rejects
    // a subscription that arrives first, leaving the agent connected and deaf.
    const { relay, authRefusal } = await connectAuthenticated(
      this.opts.relayUrl,
      this.opts.signer,
      { enableReconnect: true, onReauthenticated: () => this.subscribeAll() },
    );

    // A refusal is terminal for this agent, so it is raised here rather than carried: the
    // relay verified the signature and still will not serve the key, so every REQ opened
    // on this socket comes back `auth-required` and the agent runs on looking healthy and
    // hearing nothing. Closing first stops the reconnect loop `enableReconnect` started.
    // `authenticated: false` on its own is not this — a relay that never challenges
    // reports it too, and serves the agent perfectly well.
    if (authRefusal) {
      relay.close();
      throw new Error(`relay ${this.opts.relayUrl} refused this agent's key: ${authRefusal}`);
    }
    this.relay = relay;

    // Connected is all a caller with nothing to deliver to needs — `post` works off the
    // relay, and a REQ whose events go nowhere is a subscription the agent pays to ignore.
    if (!onEvent) return;

    // A REQ with no `since` matches every event the relay still stores for these channels,
    // and each one is delivered here as though it had just arrived. An agent that came up
    // on fresh storage answered threads four, six and eight days old — eight replies in 65
    // seconds. Nothing was missed while this process was not running, so with no cursor the
    // floor is the last minute rather than the last week; a restart that kept its cursor is
    // unaffected and still recovers the gap it was down for.
    this.since ??= Math.floor(Date.now() / 1000) - FRESH_START_LOOKBACK;

    this.onEvent = onEvent;
    this.subscribeAll();
  }

  /**
   * Opens one REQ per filter on the current socket.
   *
   * Run on start and again after every reconnect. The reconnect case is not redundant:
   * nostr-tools re-fires the previous REQs itself, but from `ws.onopen` — ahead of the
   * reconnect's AUTH challenge — so an auth-required relay refuses them and CLOSED
   * evicts them, leaving an authenticated agent with no subscription and no error. See
   * {@link connectAuthenticated}.
   *
   * Resuming rather than replaying is free here: `since` has advanced with every event
   * received, so the new REQ asks only for the gap.
   */
  private subscribeAll(): void {
    const relay = this.relay;
    const onEvent = this.onEvent;
    if (!relay || !onEvent) return;

    // The directory before the channels: on a relay that answers REQs in the order they
    // arrived, a sibling's message replayed from the backlog is normalized after the record
    // that names it. Kind 10100 is replaceable, so this is one record per author however
    // long the relay has held it, and a `since` would hide every agent registered before
    // this process started.
    relay.subscribe([{ kinds: [DIRECTORY_KIND] }], {
      onevent: (event: Event) => this.agents.set(event.pubkey, directoryName(event)),
    });

    for (const filter of this.filters()) {
      relay.subscribe([filter], {
        onevent: (event: Event) => {
          // Advance the cursor on everything received, not just what we act on: a
          // filtered-out event still proves the relay had nothing older left to send.
          this.since = Math.max(this.since ?? 0, event.created_at);
          const inbound = toInboundEvent(event, {
            pubkey: this.pubkey!,
            privateChannels: this.privateChannels,
            agents: this.agents,
          });
          // An event tagged with two of our channels matches two REQs, and normalization
          // gives it one channel. Only that channel's REQ delivers it, or the brain
          // answers the same message once per REQ it arrived on.
          const subscribed = filter[`#${BUZZ_DEFAULTS.channelTag}`]?.[0];
          if (subscribed !== undefined && inbound.channel.id !== subscribed) return;
          this.lastByChannel.set(inbound.channel.id, inbound);
          onEvent(inbound);
        },
      });
    }
  }

  async send(channel: ChannelRef, msg: GuardedMessage, context?: InboundEvent): Promise<void> {
    if (!this.relay) throw new Error("BuzzAdapter.start() must be called before send()");
    const inReplyTo = context ?? this.lastByChannel.get(channel.id);
    if (!inReplyTo) {
      // Without an inbound event there is nothing to thread onto, and publishing into a
      // channel we have never heard from is exactly the reach the guard exists to deny.
      throw new Error(`no inbound context for channel ${channel.id}`);
    }
    const signed = await this.opts.signer.signEvent(toReplyTemplate(msg, inReplyTo));
    await this.relay.publish(signed);
  }

  /** The relay's directory, as {@link SurfaceAdapter.principals} — see `agents`. */
  principals(): ReadonlyMap<string, string | undefined> {
    return this.agents;
  }

  /** The directory's name for an agent; a person's pubkey has none here. */
  displayName(id: string): string | undefined {
    return this.agents.get(id);
  }

  postTargets(): ChannelRef[] {
    return (this.opts.channels ?? []).map((channel) => ({
      surface: SURFACE,
      id: channel.id,
      isPublic: channel.reply === "public",
      name: channel.name,
    }));
  }

  async post(
    channel: ChannelRef,
    msg: GuardedMessage,
    threadRoot?: EventRef,
    mentions: readonly string[] = [],
  ): Promise<EventRef | undefined> {
    if (!this.relay) throw new Error("BuzzAdapter.start() must be called before post()");
    const configured = this.postTargets().some((target) => target.id === channel.id);
    if (channel.surface !== SURFACE || !configured) {
      throw new Error(`Buzz channel ${channel.id} is not configured`);
    }
    // An `EventRef` is surface-qualified and never comparable across surfaces, so a root
    // from somewhere else is not a thread this adapter could anchor to — it is a 64-hex
    // string that happens to fit the tag.
    if (threadRoot && threadRoot.surface !== SURFACE) {
      throw new Error(`a ${threadRoot.surface} thread root cannot anchor a Buzz post`);
    }

    // `p` on anything but a pubkey is a tag no agent matches itself against, so a display
    // name would publish a post that looks addressed and wakes no one — the silent half of
    // this failure, which a caller cannot tell from a fleet that did not answer. `npub…` is
    // accepted and folded to hex because that is the spelling a roster is written in.
    const addressed = mentions.map((who) => {
      try {
        return toHexPubkey(who);
      } catch {
        throw new Error(
          "a Buzz post is addressed by pubkey (npub… or 64-char hex), and one recipient " +
            "is neither — a display name renders but wakes nobody",
        );
      }
    });

    const signed = await this.opts.signer.signEvent(
      toChannelPostTemplate(msg, channel.id, threadRoot?.nativeId, addressed),
    );
    await this.relay.publish(signed);
    // The id the signature already committed to, not something scraped back out of the
    // relay's answer. A signed Nostr event carries a `pubkey` that is 64 hex characters
    // too, so a caller left to recognize an id by its shape can thread a whole run's
    // detail onto the author instead — silently, and onto nothing.
    return { surface: SURFACE, nativeId: signed.id };
  }

  /**
   * Replies beneath a root this adapter posted — one REQ on the socket it already holds.
   *
   * Replies only: the root carries no `e` tag naming itself, so it is not in its own
   * thread. Ordered oldest first, because a caller tallying who answered reads a thread
   * the way a person does, and a relay's delivery order is not promised to be either.
   *
   * The `limit` goes into the filter as well as onto the result. A relay that honours it
   * sends fewer events, and one that does not is trimmed here — asking is what keeps a
   * thread nobody expected to be long from arriving in full.
   */
  async readThread(root: EventRef, limit?: number): Promise<readonly ThreadReply[]> {
    const relay = this.relay;
    if (!relay) throw new Error("BuzzAdapter.start() must be called before readThread()");
    // An `EventRef` is surface-qualified and never comparable across surfaces, so a root
    // from somewhere else names no thread here — it is a string of the right shape.
    if (root.surface !== SURFACE) {
      throw new Error(`a ${root.surface} thread root names no Buzz thread`);
    }

    const filter: Filter = {
      kinds: [BUZZ_DEFAULTS.kind],
      [`#${BUZZ_DEFAULTS.replyTag}`]: [root.nativeId],
      ...(limit !== undefined ? { limit } : {}),
    };

    const events: Event[] = [];
    await new Promise<void>((resolve, reject) => {
      // `sub.close()` fires `onclose` synchronously, so every path here settles first and
      // closes second — without the guard, finishing normally rejects on its own cleanup.
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          done(
            new Error(
              `the relay did not finish answering within ${THREAD_READ_TIMEOUT_MS}ms, so what ` +
                "came back is not the whole thread",
            ),
          ),
        THREAD_READ_TIMEOUT_MS,
      );
      const sub = relay.subscribe([filter], {
        // nostr-tools fires `oneose` on a timer of its own when the relay sends no EOSE
        // (`baseEoseTimeout`, 4.4s), which would hand back a silent relay's empty answer as
        // though the relay had said there was nothing. Pushed out past this read's own
        // clock so the only EOSE that resolves it is one the relay actually sent.
        eoseTimeout: THREAD_READ_TIMEOUT_MS * 2,
        onevent: (event: Event) => void events.push(event),
        oneose: () => done(),
        // The relay's own refusal — `auth-required` on a socket that lost its
        // authentication is the one that actually happens. Never a partial answer passed
        // off as a whole one.
        onclose: (reason: string) => done(new Error(`the relay closed the thread read: ${reason}`)),
      });
    });

    const replies = events
      .sort((a, b) => a.created_at - b.created_at)
      .map((event) => toThreadReply(event, { pubkey: this.pubkey!, agents: this.agents }));
    return limit === undefined ? replies : replies.slice(0, limit);
  }

  /**
   * NIP-25 reaction: the gateway's acknowledgement, or a glyph the brain asked for.
   *
   * The id comes back from the signature this just made rather than out of a map, which is
   * also why there is no map: NIP-09 deletes an event by id, and the id is the only thing
   * a withdrawal ever needed.
   */
  async react(target: InboundEvent, emoji: string): Promise<ReactionResult | undefined> {
    if (!this.relay) return undefined;
    const signed = await this.opts.signer.signEvent(toReactionTemplate(target, emoji));
    await this.relay.publish(signed);
    // Always `placed`: this call published the event, and a relay that already held it
    // says nothing back. See `ReactionResult.placed` for what that does and does not claim.
    return { ref: { surface: SURFACE, nativeId: signed.id }, placed: true };
  }

  /** Withdraws one reaction by NIP-09 — how a 👀 is taken back once the reply lands. */
  async unreact(reaction: EventRef): Promise<void> {
    // An `EventRef` is surface-qualified and never comparable across surfaces, so one from
    // somewhere else is not a reaction this adapter could have made.
    if (!this.relay || reaction.surface !== SURFACE) return;
    const signed = await this.opts.signer.signEvent(toReactionRemovalTemplate(reaction.nativeId));
    await this.relay.publish(signed);
  }

  /** Ephemeral "working on it". Refreshed by the caller while the turn runs. */
  async setTyping(channel: ChannelRef, threadRoot?: EventRef): Promise<void> {
    if (!this.relay) return;
    const signed = await this.opts.signer.signEvent(
      toTypingTemplate(channel.id, threadRoot?.nativeId),
    );
    await this.relay.publish(signed);
  }

  async stop(): Promise<void> {
    this.relay?.close();
    this.relay = undefined;
    this.onEvent = undefined;
  }

  /** One filter per REQ `start` opens — see {@link BuzzAdapterOptions.channels}. */
  private filters(): Filter[] {
    const base: Filter = { kinds: [BUZZ_DEFAULTS.kind] };
    if (this.since !== undefined) base.since = this.since;
    const channels = this.opts.channels ?? [];

    // No channels configured: ask for mentions and accept that some relays answer
    // this only on REQ rather than streaming it.
    if (channels.length === 0) {
      return [{ ...base, [`#${BUZZ_DEFAULTS.mentionTag}`]: [this.pubkey!] }];
    }

    return channels.map((channel) => ({
      ...base,
      [`#${BUZZ_DEFAULTS.channelTag}`]: [channel.id],
    }));
  }
}

/**
 * The name a directory record carries, as clients show it: `display_name` over `name`.
 * Unreadable content is a record without a name, not a record that does not exist.
 */
function directoryName(event: Event): string | undefined {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object") return undefined;
    const { display_name: display, name } = parsed as Record<string, unknown>;
    return typeof display === "string" ? display : typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
