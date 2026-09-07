import type { Relay } from "nostr-tools/relay";
import { connectAuthenticated } from "./connect.ts";
import type { Signer } from "nostr-tools/signer";
import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import type {
  ActorRef,
  ChannelHistory,
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
 * How long any of this adapter's reads waits for the relay to finish answering.
 *
 * EOSE is what makes a read an answer rather than a guess: it says the relay accepted the
 * REQ and has sent everything it stores for it, so an empty result means nobody replied,
 * and an empty roster means nobody is in the channel. Without it there is no way to tell
 * either from a relay that took the query and went quiet — which is why the wait ends in a
 * throw rather than in whatever arrived first. A probe reading a thread it just rooted is
 * asking a question it will act on.
 */
const READ_TIMEOUT_MS = 5000;

/**
 * How long the directory subscription waits for the relay's EOSE before the channels are
 * released anyway.
 *
 * nostr-tools fires `oneose` from a timer of its own when a relay sends no EOSE, and its
 * default is tuned for a browser client: 4.4 seconds is short enough to go off on a busy
 * relay that is still sending records, which would release the channels ahead of the
 * roster — the very order this subscription exists to keep. Long enough that only a relay
 * that will never answer reaches it, and short enough that such a relay does not keep the
 * agent deaf: the same trade `readThread` makes with its own clock.
 */
const DIRECTORY_EOSE_TIMEOUT_MS = 30_000;

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
  /**
   * Which record each entry in `agents` came from, so a later one can be judged against it.
   *
   * Beside the names rather than inside them: `agents` is handed to normalization for every
   * event on the wire as a `ReadonlyMap<string, string | undefined>`, so widening its value
   * would cost a projection per message to answer a question only this subscription asks.
   * Written once per directory record and never read on the message path.
   */
  private agentRecords = new Map<string, Stamped>();

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
      { enableReconnect: true, onReauthenticated: () => void this.subscribeAll() },
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
   *
   * A channel event is delivered only once the directory has answered **on this socket**.
   * A REQ is a subscription of its own and a relay may interleave two, so a sibling's
   * message replayed from the backlog could otherwise be normalized before the record that
   * names it and be admitted past the chain-depth cap as a person's. The gate is the
   * directory subscription's own `eosed` flag rather than anything kept here, because
   * nostr-tools resets that flag on every reconnect before re-firing the REQs — including
   * the reconnects this adapter never hears about, on a relay that issues no AUTH
   * challenge — so it says exactly what a replayed message has to wait for. Events that
   * arrive early are held and released in order when the directory answers. Kind 10100 is
   * replaceable, so that REQ is one record per author however long the relay has held it,
   * and a `since` on it would hide every agent registered before this process started.
   */
  private subscribeAll(): void {
    const relay = this.relay;
    const onEvent = this.onEvent;
    if (!relay || !onEvent) return;

    // A relay that refuses the directory REQ closes it, and nothing re-fires a closed
    // subscription: there is no directory here, and holding on for one would be deafness.
    let refused = false;
    const held: Array<() => void> = [];
    const release = () => {
      for (const deliver of held.splice(0)) deliver();
    };
    const directory = relay.subscribe([{ kinds: [DIRECTORY_KIND] }], {
      eoseTimeout: DIRECTORY_EOSE_TIMEOUT_MS,
      onevent: (event: Event) => this.vouch(event),
      oneose: release,
      onclose: () => {
        refused = true;
        release();
      },
    });

    for (const filter of this.filters()) {
      relay.subscribe([filter], {
        onevent: (event: Event) => {
          const deliver = () => {
            // Advance the cursor on everything delivered, not just what we act on: a
            // filtered-out event still proves the relay had nothing older left to send.
            // On delivery rather than receipt, so a held event a restart loses is one the
            // cursor still asks for.
            this.since = Math.max(this.since ?? 0, event.created_at);
            const inbound = toInboundEvent(event, {
              pubkey: this.pubkey!,
              privateChannels: this.privateChannels,
              agents: this.agents,
            });
            // An event tagged with two of our channels matches two REQs, and
            // normalization gives it one channel. Only that channel's REQ delivers it, or
            // the brain answers the same message once per REQ it arrived on.
            const subscribed = filter[`#${BUZZ_DEFAULTS.channelTag}`]?.[0];
            if (subscribed !== undefined && inbound.channel.id !== subscribed) return;
            this.lastByChannel.set(inbound.channel.id, inbound);
            onEvent(inbound);
          };
          if (directory.eosed || refused) deliver();
          else held.push(deliver);
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
    this.assertConfigured(channel);
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

    const events = await this.query(relay, {
      kinds: [BUZZ_DEFAULTS.kind],
      [`#${BUZZ_DEFAULTS.replyTag}`]: [root.nativeId],
      ...(limit !== undefined ? { limit } : {}),
    });
    const replies = this.ordered(events);
    return limit === undefined ? replies : replies.slice(0, limit);
  }

  /**
   * The channels this agent is in, which on Buzz takes both halves being true.
   *
   * It hears a channel because `start` opened a REQ for a configured one, and it can be
   * addressed in a channel because its directory record lists that channel — a client gates
   * its mention picker on finding it there, and strips the mention at send when it does not
   * (see `profile.ts`). A channel with only one half is where an agent connects, subscribes,
   * authenticates and is never spoken to, with every signal on both sides reporting healthy.
   * So this returns the overlap, and an operator reading it against `postTargets` sees which
   * configured channel the record does not cover.
   */
  async listChannels(): Promise<readonly ChannelRef[]> {
    const relay = this.relay;
    if (!relay) throw new Error("BuzzAdapter.start() must be called before listChannels()");
    const [record] = newestPerAuthor(
      await this.query(relay, { kinds: [DIRECTORY_KIND], authors: [this.pubkey!] }),
    );
    const listed = new Set(record ? directoryRecord(record).channels : []);
    return this.postTargets().filter((target) => listed.has(target.id));
  }

  /**
   * Who the relay says is in one configured channel — its channel-membership event.
   *
   * The relay's roster, which is the question `SlackAdapter.listMembers` answers from
   * `conversations.members`. Not the directory: a record naming this channel is its
   * author's claim about itself, so a key that was never granted membership can publish
   * one, and a caller diagnosing the failure {@link listChannels} describes would be told
   * membership was confirmed on the agent's own say-so. What the directory does answer is
   * `mentionable`, read below off the same records that put names to the roster.
   *
   * Its own REQ rather than the directory subscription `start` opens, because that one is
   * opened only for a caller that passed a listener: a `job run` starts this adapter to
   * post one line, and would otherwise read an empty roster and report a channel nobody is
   * in.
   *
   * The membership kind is addressable, so the newest event at the channel's address is the
   * current roster — newest across publishers rather than per publisher, which leaves the
   * relay's write policy deciding who may say who is in a channel. Nothing here can check
   * that: an `authors` filter would need a per-channel owner, and no manifest carries one.
   *
   * A relay holding no roster cannot answer, and this throws rather than returning `[]`: an
   * empty roster is a real finding — the channel nobody joined — and must not also be what a
   * relay that keeps no rosters looks like.
   */
  async listMembers(channel: ChannelRef, limit?: number): Promise<readonly ActorRef[]> {
    const relay = this.relay;
    if (!relay) throw new Error("BuzzAdapter.start() must be called before listMembers()");
    this.assertConfigured(channel);

    const roster = newest(
      await this.query(relay, {
        kinds: [BUZZ_DEFAULTS.membershipKind],
        // NIP-01's identifier tag, which on this kind is the channel the roster is for.
        "#d": [channel.id],
      }),
    );
    if (!roster) {
      throw new Error(
        `the relay holds no membership record for Buzz channel ${channel.id}, so who is ` +
          "in it cannot be read",
      );
    }

    // `limit` bounds the members and never the wire, unlike `readThread` and `readChannel`:
    // the roster is one event, so a relay-side limit would trim how many rosters came back
    // and not how many people are named in the one that did.
    //
    // Normalized and deduplicated before `limit`, because both decide who fits under it: one
    // pubkey tagged twice, or tagged once in hex and once as an npub, would take two of the
    // slots and come back twice. A tag that is no pubkey at all names nobody here —
    // `describeActor`'s finding for the same value — and dropping it keeps it out of the
    // `authors` filter below, which one unusable entry can cost its whole answer.
    //
    // `"p"` rather than `BUZZ_DEFAULTS.mentionTag`: on this kind the tag names a member, and
    // the two would drift apart the moment a relay spelled either differently.
    const pubkeys = [
      ...new Set(
        roster.tags.flatMap((tag) => {
          if (tag[0] !== "p" || !tag[1]) return [];
          try {
            return [toHexPubkey(tag[1])];
          } catch {
            return [];
          }
        }),
      ),
    ];
    const members = limit === undefined ? pubkeys : pubkeys.slice(0, limit);
    if (members.length === 0) return [];

    // One REQ for the whole roster, over the two kinds `describeActor` reads for one id: an
    // agent publishes a directory record, a person only the NIP-01 profile.
    const records = newestPerAuthor(
      await this.query(relay, {
        kinds: [DIRECTORY_KIND, BUZZ_DEFAULTS.profileKind],
        authors: members,
      }),
    );

    return members.map((pubkey) => {
      const own = records.filter((event) => event.pubkey === pubkey);
      const directory = own.find((event) => event.kind === DIRECTORY_KIND);
      if (!directory) {
        // Nothing here answers `mentionable` for a pubkey with no directory record, so it
        // is left unset rather than false: what makes a person mentionable on this relay is
        // not something the directory says.
        const profile = own[0];
        return this.actor(pubkey, profile ? directoryRecord(profile).name : undefined, false);
      }
      const record = directoryRecord(directory);
      return {
        ...this.actor(pubkey, record.name, true),
        mentionable: record.channels.includes(channel.id),
      };
    });
  }

  /**
   * A pubkey's own claim about itself: the directory record that makes it addressable, or
   * the NIP-01 profile a person publishes. Both carry the handle under the same two keys.
   *
   * `undefined` when the relay holds neither, which is the whole of what "never heard of"
   * can mean here — a pubkey is a well-formed string anyone holding the key can mint, so
   * there is nothing else about it to be absent.
   */
  async describeActor(id: string): Promise<ActorRef | undefined> {
    const relay = this.relay;
    if (!relay) throw new Error("BuzzAdapter.start() must be called before describeActor()");
    let pubkey: string;
    try {
      pubkey = toHexPubkey(id);
    } catch {
      // Not a pubkey, so it names nobody on this surface — the same finding as a pubkey
      // the relay holds nothing for, and reported the same way.
      return undefined;
    }

    const records = newestPerAuthor(
      await this.query(relay, {
        kinds: [DIRECTORY_KIND, BUZZ_DEFAULTS.profileKind],
        authors: [pubkey],
      }),
    );
    const directory = records.find((event) => event.kind === DIRECTORY_KIND);
    const record = directory ?? records.find((event) => event.kind === BUZZ_DEFAULTS.profileKind);
    if (!record) return undefined;
    return this.actor(pubkey, directoryRecord(record).name, directory !== undefined);
  }

  /**
   * Recent messages in a configured channel — one REQ on the channel tag.
   *
   * Not {@link readThread}'s bound, because nothing here was published by this agent and
   * nothing in it was addressed to it. What bounds it instead is the channel list an
   * operator configured, so no id a caller computes reaches a channel this agent does not
   * serve. A Nostr `limit` takes the newest that many, which is the end of the channel a
   * reader wants; they are then ordered oldest first, the way a person reads it.
   */
  async readChannel(channel: ChannelRef, limit?: number): Promise<ChannelHistory> {
    const relay = this.relay;
    if (!relay) throw new Error("BuzzAdapter.start() must be called before readChannel()");
    this.assertConfigured(channel);

    const events = await this.query(relay, {
      kinds: [BUZZ_DEFAULTS.kind],
      [`#${BUZZ_DEFAULTS.channelTag}`]: [channel.id],
      ...(limit !== undefined ? { limit } : {}),
    });
    const replies = this.ordered(events);
    return {
      // From the end, not `slice(-limit)`: a caller that asked for none would get every
      // line back, because `-0` is not a negative index.
      messages:
        limit === undefined ? replies : replies.slice(Math.max(0, replies.length - limit)),
      // Never `more`: one REQ ends on the relay's EOSE, which says it has sent everything
      // it stores for the filter, so a short answer here is the relay's whole answer. There
      // is no cursor to stop early on and no page bound to run into.
      more: false,
    };
  }

  /**
   * Records one directory entry, keeping the record NIP-01 says is current.
   *
   * Last-write-wins was what this did, and delivery order is not an order: a relay replaying
   * a backlog may send an author's superseded record after its current one, and the name
   * that survived was whichever arrived last. A live update still wins, because it genuinely
   * is later — {@link supersedes} is the same rule the explicit reads apply, and one concept
   * with two rules in one file is the thing worth avoiding here.
   *
   * Only the name is at stake, and it is presentation. `isAgent` reads membership of
   * `agents` rather than its value, so a record that ties or loses still vouches for its
   * author.
   */
  private vouch(event: Event): void {
    const held = this.agentRecords.get(event.pubkey);
    if (held && !supersedes(event, held)) return;
    this.agentRecords.set(event.pubkey, { created_at: event.created_at, id: event.id });
    this.agents.set(event.pubkey, directoryRecord(event).name);
  }

  /** Oldest first, named as core names a line read back off a channel. */
  private ordered(events: Event[]): ThreadReply[] {
    return events
      .sort((a, b) => a.created_at - b.created_at)
      .map((event) => toThreadReply(event, { pubkey: this.pubkey!, agents: this.agents }));
  }

  /** A pubkey as core names an actor. Ourselves is always an agent, per `toActorRef`. */
  private actor(pubkey: string, name: string | undefined, isAgent: boolean): ActorRef {
    const self = pubkey === this.pubkey;
    return {
      surface: SURFACE,
      id: pubkey,
      isSelf: self,
      isAgent: isAgent || self,
      ...(name ? { name } : {}),
    };
  }

  /** The reach every channel-scoped call here has: the channels an operator declared. */
  private assertConfigured(channel: ChannelRef): void {
    const configured = this.postTargets().some((target) => target.id === channel.id);
    if (channel.surface !== SURFACE || !configured) {
      throw new Error(`Buzz channel ${channel.id} is not configured`);
    }
  }

  /**
   * One REQ on the socket this adapter already holds, ended by the relay's own EOSE.
   *
   * EOSE is what makes every read here an answer rather than a guess — see
   * {@link READ_TIMEOUT_MS}. Written once because a second copy would be a second place
   * for a silent relay to be mistaken for an empty channel.
   */
  private query(relay: Relay, filter: Filter): Promise<Event[]> {
    const events: Event[] = [];
    return new Promise<Event[]>((resolve, reject) => {
      // `sub.close()` fires `onclose` synchronously, so every path here settles first and
      // closes second — without the guard, finishing normally rejects on its own cleanup.
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        if (error) reject(error);
        else resolve(events);
      };
      const timer = setTimeout(
        () =>
          done(
            new Error(
              `the relay did not finish answering within ${READ_TIMEOUT_MS}ms, so what came ` +
                "back is not the whole answer",
            ),
          ),
        READ_TIMEOUT_MS,
      );
      const sub = relay.subscribe([filter], {
        // nostr-tools fires `oneose` on a timer of its own when the relay sends no EOSE
        // (`baseEoseTimeout`, 4.4s), which would hand back a silent relay's empty answer as
        // though the relay had said there was nothing. Pushed out past this read's own
        // clock so the only EOSE that resolves it is one the relay actually sent.
        eoseTimeout: READ_TIMEOUT_MS * 2,
        onevent: (event: Event) => void events.push(event),
        oneose: () => done(),
        // The relay's own refusal — `auth-required` on a socket that lost its
        // authentication is the one that actually happens. Never a partial answer passed
        // off as a whole one.
        onclose: (reason: string) => done(new Error(`the relay closed the read: ${reason}`)),
      });
    });
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
 * What a directory name has to look like to be vouched for: a handle, not a sentence.
 *
 * The record is signed by the key it describes and by nobody else, so its name is that
 * key's own claim — and it goes two places a claim must not be free-form: the tool
 * description the brain reads, and the label on a line brought home for a person to read.
 * A name that could carry an instruction, a second label, or a line break is not a name
 * this adapter will put there. Letters and digits in any script, then up to thirty-one of
 * those, spaces, and the punctuation a handle has.
 */
const DIRECTORY_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,31}$/u;

/**
 * The newest record per author and kind — what a replaceable kind is supposed to mean.
 *
 * NIP-01 says a relay keeps one kind-0 and one 10100 per author and serves that one, so
 * every read here could take whatever arrived first. It does not, because the cost of a
 * relay that serves two is silent and specific: an obsolete record names a channel the
 * agent has since left, and these reads exist to be trusted about exactly that. Keyed on
 * the kind as well as the author, or `describeActor` — which asks for both kinds at once —
 * would keep one record and drop the other.
 *
 * `created_at` is seconds, so two records from one author can tie, and a tie broken by
 * arrival order is not a decision — it is whichever the relay happened to send first, which
 * is the nondeterminism this function exists to remove. NIP-01 settles it: on equal
 * timestamps the **lowest id in lexical order** is the one retained.
 */
function newestPerAuthor(events: Event[]): Event[] {
  const current = new Map<string, Event>();
  for (const event of events) {
    const key = `${event.pubkey}:${event.kind}`;
    const held = current.get(key);
    if (!held || supersedes(event, held)) current.set(key, event);
  }
  return [...current.values()];
}

/** The current event among several at one address, by {@link supersedes}. */
function newest(events: Event[]): Event | undefined {
  return events.reduce<Event | undefined>(
    (held, event) => (!held || supersedes(event, held) ? event : held),
    undefined,
  );
}

/**
 * NIP-01's replaceable-event rule: later wins, and on a tie the lower id does.
 *
 * Takes the two fields the rule is about rather than whole events, so the directory
 * subscription — which keeps only those two per author — can apply it without inventing an
 * event to compare against.
 */
type Stamped = Pick<Event, "created_at" | "id">;

function supersedes(event: Stamped, held: Stamped): boolean {
  if (event.created_at !== held.created_at) return held.created_at < event.created_at;
  return event.id < held.id;
}

/**
 * What a record says about its author: the name clients show — `display_name` over `name`,
 * and only one that is a handle — and the channels it answers in.
 *
 * Both keys are read the same way out of a kind-10100 directory record and a NIP-01
 * kind-0 profile, which is why {@link BuzzAdapter.describeActor} can fall back to the
 * second for a person, who publishes no first. Only a directory record carries
 * `channel_ids`; unreadable content is a record that says nothing, not one that is absent.
 */
function directoryRecord(event: Event): { name?: string; channels: readonly string[] } {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (!parsed || typeof parsed !== "object") return { channels: [] };
    const record = parsed as Record<string, unknown>;
    const { display_name: display, name, channel_ids: channels } = record;
    return {
      name: [display, name].find(
        (value): value is string => typeof value === "string" && DIRECTORY_NAME.test(value),
      ),
      channels: Array.isArray(channels)
        ? channels.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { channels: [] };
  }
}
