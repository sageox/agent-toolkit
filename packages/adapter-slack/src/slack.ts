import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type {
  ChannelDecl,
  ChannelRef,
  EventRef,
  GuardedMessage,
  InboundEvent,
  ReactionResult,
  SurfaceAdapter,
  ThreadReply,
} from "@sageox/agent-toolkit-core";
import {
  SLACK_SURFACE,
  isDirectSlackChannel,
  parseSlackEventId,
  slackEventId,
  slackMentionedMembers,
  toSlackInboundEvent,
  type SlackMessage,
} from "./normalize.ts";

export interface SlackSocketClient {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off?(event: string, listener: (payload: unknown) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackHistoryPage {
  messages?: SlackMessage[];
  nextCursor?: string;
}

export interface SlackDirectPage {
  ids?: string[];
  nextCursor?: string;
}

/** Narrow API seam: production wraps WebClient and tests never touch the network. */
export interface SlackApiClient {
  authTest(): Promise<{ userId?: string; botId?: string }>;
  channelIsPrivate(channel: string): Promise<boolean | undefined>;
  /**
   * One page of the DM conversations this bot has open — the ids no configuration names.
   * Paged like `history` and `replies`, so the walk stays on the tested side of this seam.
   */
  openDirectChannels(cursor?: string): Promise<SlackDirectPage>;
  history(args: { channel: string; oldest: string; cursor?: string }): Promise<SlackHistoryPage>;
  replies(args: {
    channel: string;
    ts: string;
    oldest: string;
    cursor?: string;
  }): Promise<SlackHistoryPage>;
  /** The name a person reads for a member id, or `undefined` when Slack will not say. */
  userName(id: string): Promise<string | undefined>;
  /** Answers with the posted message's `ts`, when Slack reports one. */
  postMessage(args: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<string | undefined>;
  addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>;
  removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void>;
}

export interface SlackAdapterOptions {
  /** xoxb token: Web API only, held by the gateway. */
  botToken: string;
  /** xapp token with connections:write: Socket Mode only, held by the gateway. */
  appToken: string;
  /**
   * The channels this agent serves, each carrying whether its replies are public. That
   * assertion is what stands in when `conversations.info` is unavailable.
   *
   * DMs are admitted without being listed: their IDs do not exist until the conversation
   * does, so the app's `message.im` subscription is what opens or closes that path. An
   * empty list is therefore a working DM-only agent, not a misconfiguration.
   */
  channels: readonly ChannelDecl[];
  /** Resume point persisted by the CLI; Slack timestamps are Unix seconds. */
  since?: number;
  api?: SlackApiClient;
  socket?: SlackSocketClient;
}

interface SocketEnvelope {
  type?: string;
  body?: { event?: SlackMessage };
  ack?: () => Promise<unknown>;
}

/** Where a reply goes: the message that prompted it, and the thread it sits in. */
interface SlackInboundContext {
  eventTs: string;
  threadTs?: string;
}

/**
 * A reaction reference: the emoji name, then the message it sits on.
 *
 * Slack has no id for a reaction, so this is minted rather than reported — it carries the
 * three things `reactions.remove` asks for. The name goes first and the separator is `@`,
 * because a message reference is `channel:ts` and `parseSlackEventId` splits on the first
 * colon: appending the name would have been read as part of the timestamp. A Slack emoji
 * name cannot contain `@` — see `SLACK_EMOJI_NAME`.
 */
const slackReactionId = (channel: string, ts: string, name: string) =>
  `${name}@${slackEventId(channel, ts)}`;

function parseSlackReactionId(nativeId: string): { name: string; message: string } {
  const at = nativeId.indexOf("@");
  if (at <= 0 || at === nativeId.length - 1) {
    throw new Error(`invalid Slack reaction reference: ${nativeId}`);
  }
  return { name: nativeId.slice(0, at), message: nativeId.slice(at + 1) };
}

/** A dedup key only has to outlive Slack's retries and the backfill/live overlap. */
const SEEN_LIMIT = 2_048;

/** Reads a reply target straight off the event, which is where it was all along. */
function contextOf(event: InboundEvent): SlackInboundContext {
  return {
    eventTs: parseSlackEventId(event.id.nativeId).ts,
    threadTs: event.threadRoot ? parseSlackEventId(event.threadRoot.nativeId).ts : undefined,
  };
}

export class SlackAdapter implements SurfaceAdapter {
  readonly kind = SLACK_SURFACE;

  private readonly api: SlackApiClient;
  private readonly socket: SlackSocketClient;
  private readonly allowedChannels: Set<string>;
  private readonly privateChannels: Set<string>;
  /** Display names as configured, so a cross-post can be asked for by the name people say. */
  private readonly channelNames: Map<string, string>;
  /** Channels Slack answered `is_private: false` for. Outranks the ID-prefix guess. */
  private readonly publicChannels = new Set<string>();
  /** DMs heard from since start, so a reply may go back where the question came from. */
  private readonly dmChannels = new Set<string>();
  /** One entry per channel, for a reply with no triggering event to thread onto. */
  private readonly lastByChannel = new Map<string, SlackInboundContext>();
  private readonly seen = new Set<string>();
  /**
   * Member id to name, filled as messages mention people and never expired.
   *
   * A miss costs one `users.info`; a rename goes unnoticed until restart. Both are the
   * right trade for a directory that only decides how a mention reads — the alternative,
   * pulling `users.list` at boot, spends a large workspace's whole member table to answer
   * about the handful of people who actually speak.
   */
  private readonly memberNames = new Map<string, string>();
  /** Ids Slack would not name, so a second message does not ask about them again. */
  private readonly unnamed = new Set<string>();
  /**
   * Normalization runs one message at a time per conversation, in arrival order.
   *
   * Resolving a name is a network call, so `accept` has to be able to wait — and two
   * messages waiting concurrently would be delivered in whichever order Slack answered
   * about their mentions. `ChannelQueue` preserves the order it is submitted in, so that
   * scrambling would reach the brain: the agent answers the second question first, and a
   * reply with no inbound context threads onto the wrong message.
   *
   * Per conversation and not one chain for the adapter, because that is the whole of what
   * ordering means here — `ChannelQueue` serializes a channel and runs channels in
   * parallel, so a single chain would impose a stricter order than anything downstream
   * asks for and let one message's lookups delay every other conversation. A chain is
   * dropped once it drains, so this holds an entry per conversation in flight rather than
   * one per conversation ever seen.
   */
  private readonly chains = new Map<string, Promise<void>>();
  /**
   * Which run of this adapter queued work belongs to.
   *
   * `stop()` bumps it, so a message still waiting on a lookup is discarded rather than
   * finishing into a later `start()` — delivering an event the previous session heard to
   * the callback the new one installed, and dragging its reply target along with it.
   */
  private generation = 0;
  private botUserId?: string;
  private botId?: string;
  private onEvent?: (event: InboundEvent) => void;
  private since?: number;
  /** Authenticated and channel visibility resolved — everything egress checks depend on. */
  private started = false;
  /** Socket Mode is connected. Only true when someone asked to be told about events. */
  private listening = false;

  constructor(opts: SlackAdapterOptions) {
    this.allowedChannels = new Set(opts.channels.map((channel) => channel.id));
    this.privateChannels = new Set(
      opts.channels.filter((channel) => channel.reply === "private").map((channel) => channel.id),
    );
    this.channelNames = new Map(
      opts.channels.flatMap((channel) => (channel.name ? [[channel.id, channel.name]] : [])),
    );
    this.since = opts.since;
    this.api = opts.api ?? new WebSlackApi(opts.botToken);
    this.socket = opts.socket ?? new SocketModeClient({ appToken: opts.appToken });
  }

  cursor(): number | undefined {
    return this.since;
  }

  async start(onEvent?: (event: InboundEvent) => void): Promise<void> {
    if (this.started) throw new Error("SlackAdapter is already started");

    const identity = await this.api.authTest();
    if (!identity.userId) throw new Error("Slack auth.test did not return the bot user id");
    this.botUserId = identity.userId;
    this.botId = identity.botId;
    this.onEvent = onEvent;

    // Slack Connect and shared channels do not always follow an ID-prefix privacy rule.
    // A failed lookup is not trusted as private: the configured assertion remains, and
    // everything else stays public so the egress guard fails closed.
    await Promise.all(
      [...this.allowedChannels].map(async (channel) => {
        try {
          const isPrivate = await this.api.channelIsPrivate(channel);
          if (isPrivate) this.privateChannels.add(channel);
          // Recorded, not merely "not added": normalization otherwise falls back to the
          // ID prefix and calls a public G-prefixed channel private, which is the one
          // case where the guard would let workspace-visible output through.
          //
          // The configured assertion is dropped in the same step, because Slack answering
          // "public" outranks it. Leaving it in place kept `postTargets` reporting the
          // channel private off the configured entries alone, so the guard never saw a
          // public channel to refuse and a cross-surface post reached the whole workspace.
          else if (isPrivate === false) {
            this.publicChannels.add(channel);
            this.privateChannels.delete(channel);
          }
        } catch {
          // Missing channels:read/groups:read must not widen egress.
        }
      }),
    );

    // Everything `post` and the egress guard rely on is now in place. Saying so before the
    // socket is what lets a caller with nothing to listen for stop here — and it is why an
    // inbound outage can no longer be the reason a deliverable status post never went out.
    this.started = true;
    if (!onEvent) return;

    const resumeFrom = this.since;
    // The run every message from here belongs to. The listener is registered before the
    // connection is up, so an event can already be queued when the start below fails.
    const session = this.generation;
    this.socket.on("slack_event", this.handleEnvelope);
    try {
      await this.socket.start();
      this.listening = true;
      // Socket Mode has no replay. Connect first, then fill the earlier gap; deduplication
      // makes overlap safe and avoids a new gap between the history call and the socket.
      if (resumeFrom !== undefined) await this.backfill(resumeFrom, session);
    } catch (error) {
      this.started = false;
      this.socket.off?.("slack_event", this.handleEnvelope);
      this.onEvent = undefined;
      // As on `stop`: a start that failed leaves no run for queued work to belong to, and
      // without this it would belong to whichever run starts next.
      this.invalidate();
      await this.socket.disconnect().catch(() => {});
      throw error;
    }
  }

  async send(channel: ChannelRef, msg: GuardedMessage, inReplyTo?: InboundEvent): Promise<void> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before send()");
    this.assertChannel(channel);
    // The triggering event already carries everything a reply needs — its own id is the
    // channel and timestamp, and `threadRoot` is the thread it belongs to. Reading them
    // off the event rather than a cache means a turn can take as long as the gateway
    // lets it: there is no retention window to outlive, so nothing to get wrong.
    const target = inReplyTo ? contextOf(inReplyTo) : this.lastByChannel.get(channel.id);
    if (!target) throw new Error(`no inbound context for Slack channel ${channel.id}`);

    const text = this.outboundText(msg);

    // In a channel, threading the answer onto the question is what keeps the channel
    // readable. A 1:1 DM has nothing to keep tidy, and a threaded answer there hides
    // behind a "1 reply" link — so a top-level DM gets a top-level answer, while a
    // question asked inside a thread is still answered in that thread.
    const threadTs =
      target.threadTs ?? (this.dmChannels.has(channel.id) ? undefined : target.eventTs);
    await this.api.postMessage({ channel: channel.id, text, threadTs });
  }

  postTargets(): ChannelRef[] {
    return [...this.allowedChannels].map((id) => ({
      surface: SLACK_SURFACE,
      id,
      isPublic: !this.privateChannels.has(id),
      name: this.channelNames.get(id),
    }));
  }

  async post(
    channel: ChannelRef,
    msg: GuardedMessage,
    threadRoot?: EventRef,
    mentions: readonly string[] = [],
  ): Promise<EventRef | undefined> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before post()");
    this.assertChannel(channel);
    const text = this.outboundText(msg);

    // A Slack `ts` is unique only within a conversation, so an anchor from a different
    // channel names a real message somewhere else — and `thread_ts` pointing at one starts
    // a thread nobody will find. Refuse rather than post it into the void.
    const root = threadRoot ? this.locate(threadRoot) : undefined;
    if (threadRoot && root?.channel !== channel.id) {
      throw new Error(`a Slack thread root must be a message in ${channel.id}`);
    }

    const ts = await this.api.postMessage({
      channel: channel.id,
      text: address(mentions) + text,
      threadTs: root?.ts,
    });
    return ts ? { surface: SLACK_SURFACE, nativeId: slackEventId(channel.id, ts) } : undefined;
  }

  /**
   * Replies beneath a thread root this adapter posted — one `conversations.replies` walk.
   *
   * Every way this can fail throws, and none of them answers `[]`. A probe mints a verdict
   * from what comes back, so "nobody replied" has to stay distinguishable from "this read
   * did not happen" — see {@link SurfaceAdapter.readThread}.
   *
   * `oldest: "0"` because a thread read is not a backfill: the caller wants everything
   * under the root, not what arrived after some cursor. Slack returns the parent whatever
   * `oldest` says, and the parent is not in its own thread — dropped by `ts` rather than by
   * position, since a page boundary promises nothing about which message comes first.
   *
   * Normalized through `toSlackInboundEvent`, so a join notice or a hidden message is no
   * more a reply here than it is a turn. One answer to "what counts as a message" rather
   * than a second one that drifts.
   */
  async readThread(root: EventRef, limit?: number): Promise<readonly ThreadReply[]> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before readThread()");
    if (root.surface !== SLACK_SURFACE) {
      throw new Error(`a ${root.surface} thread root names no Slack thread`);
    }
    const at = this.locate(root);
    if (!at) {
      throw new Error(
        "a Slack thread root must name a message in a conversation this agent serves",
      );
    }

    const messages = await this.collect((cursor) =>
      this.api.replies({ channel: at.channel, ts: at.ts, oldest: "0", cursor }),
    );

    // Sorted on the Slack `ts` rather than the ISO string it becomes: `ts` carries
    // microseconds and the ISO form is truncated to milliseconds, so two replies inside one
    // millisecond would tie and come back in whatever order the pages happened to arrive.
    const ordered = messages
      .filter((message) => message.ts !== at.ts)
      .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    // The same directory the inbound path fills, filled the same way before rendering.
    // Sharing the map without sharing the lookup is what makes one mention read two ways
    // depending on which door it came through — and a probe tallying replies is exactly
    // the caller that would then disagree with the channel it is reading.
    for (const message of ordered) await this.learnNames(message.text ?? "");

    const replies = ordered
      .flatMap((message) => {
        const event = toSlackInboundEvent(
          { ...message, type: message.type ?? "message", channel: at.channel },
          this.normalizeOptions(),
        );
        return event ? [{ author: event.author, text: event.text, ts: event.ts }] : [];
      });
    return limit === undefined ? replies : replies.slice(0, limit);
  }

  async react(target: InboundEvent, emoji: string): Promise<ReactionResult | undefined> {
    if (!this.started) return undefined;
    const at = this.locate(target.id);
    if (!at) return undefined;
    const name = slackReactionName(emoji);
    // Refused here rather than sent for Slack to answer `invalid_name`, which tells a
    // caller nothing it can act on.
    if (!SLACK_EMOJI_NAME.test(name)) {
      throw new Error(
        `Slack has no name for ${emoji} here — react with the Slack emoji name instead, ` +
          'such as "thumbsup"',
      );
    }
    const ref = { surface: SLACK_SURFACE, nativeId: slackReactionId(at.channel, at.ts, name) };
    try {
      // Awaited before the ref exists, which is what serializes a withdrawal behind the
      // addition it withdraws: a caller cannot name a reaction that has not been made yet.
      // The gateway's signals are fire-and-forget, so nothing else was holding that order.
      await this.api.addReaction({ channel: at.channel, timestamp: at.ts, name });
    } catch (error) {
      // Slack reports the state we wanted as a failure. The reaction this call asked for
      // is on the message — so the ref comes back and says it is that one reaction rather
      // than a new one or an error.
      //
      // `placed: false`, though, and the distinction is the whole point: `already_reacted`
      // says a reaction under this identity exists. It does not say this call made it, or
      // that this turn did. A caller that withdrew on it would take back a reaction placed
      // before the turn began.
      if (!isAlreadyReacted(error)) throw error;
      return { ref, placed: false };
    }
    return { ref, placed: true };
  }

  /** Both spellings of one Slack reaction key alike; `slackReactionName` is the rule. */
  reactionKey(emoji: string): string {
    return slackReactionName(emoji);
  }

  async unreact(reaction: EventRef): Promise<void> {
    if (!this.started || reaction.surface !== SLACK_SURFACE) return;
    const { name, message } = parseSlackReactionId(reaction.nativeId);
    // Through `locate`, so removing a reaction is held to the same "a channel this adapter
    // serves" rule that making one is. A ref is minted here and never asserted by a brain,
    // but the check costs a line and the rule should not have two answers.
    const at = this.locate({ surface: SLACK_SURFACE, nativeId: message });
    if (!at) return;
    await this.api.removeReaction({ channel: at.channel, timestamp: at.ts, name });
  }

  /**
   * Resolves an event reference back to the message it names.
   *
   * The reference is self-describing, so this is parsing rather than recall — but the
   * channel is still checked, because reacting is egress too and must stay inside the
   * conversations this adapter serves.
   */
  private locate(target: EventRef): { channel: string; ts: string } | undefined {
    if (target.surface !== SLACK_SURFACE) return undefined;
    let parsed: { channel: string; ts: string };
    try {
      parsed = parseSlackEventId(target.nativeId);
    } catch {
      return undefined;
    }
    const known = this.allowedChannels.has(parsed.channel) || this.dmChannels.has(parsed.channel);
    return known ? parsed : undefined;
  }

  async stop(): Promise<void> {
    this.socket.off?.("slack_event", this.handleEnvelope);
    try {
      // `listening`, not `started`: disconnecting a socket that was never connected is
      // asking a client to undo something it never did.
      if (this.listening) await this.socket.disconnect();
    } finally {
      this.listening = false;
      this.started = false;
      this.onEvent = undefined;
      // Whatever is mid-lookup belongs to the run being stopped, and to nothing after it.
      this.invalidate();
    }
  }

  /**
   * Ends the run that queued work belongs to.
   *
   * Every asynchronous producer here — a live envelope waiting on a lookup, a replay still
   * paging history — stamps the run it started in, and `accept` drops anything stamped with
   * a run that has ended. Both ways a run ends go through this, because the stamp is only
   * worth anything if nothing can outlive it unstamped.
   */
  private invalidate(): void {
    this.generation++;
    this.chains.clear();
  }

  /**
   * Answers when this envelope has been delivered, which Socket Mode ignores and a caller
   * that needs to know an event has landed can await. The ack above is deliberately not
   * part of it — Slack retries an envelope that waits, so it goes first and alone.
   */
  private readonly handleEnvelope = async (payload: unknown): Promise<void> => {
    const envelope = payload as SocketEnvelope;
    // Acknowledge before normalization or user code. Slack retries envelopes that wait.
    if (envelope.ack) void envelope.ack().catch(() => {});
    if (envelope.type !== "events_api" || !envelope.body?.event) return;
    await this.enqueue(envelope.body.event);
  };

  /**
   * Normalizes and delivers one message, behind everything already queued.
   *
   * The returned promise settles when *this* message has been delivered, which is what
   * lets a backfill wait for its own replay without a second ordering rule.
   */
  private enqueue(message: SlackMessage, session = this.generation): Promise<void> {
    const conversation = message.channel ?? "";
    const generation = session;
    // Errors are absorbed rather than left on the chain: one message nobody could
    // normalize must not stop every message behind it in the same conversation.
    const next = (this.chains.get(conversation) ?? Promise.resolve())
      .then(() => this.accept(message, generation))
      .catch(() => {});
    this.chains.set(conversation, next);
    // Only if nothing has queued behind it, or the entry dropped here is one another
    // message is already waiting on.
    void next.then(() => {
      if (this.chains.get(conversation) === next) this.chains.delete(conversation);
    });
    return next;
  }

  private async accept(message: SlackMessage, generation: number): Promise<void> {
    if (!message.channel) return;
    // A DM cannot be addressed to anyone but this bot, and its conversation ID does not
    // exist until someone opens it — so it can never be configured ahead of time. The
    // app's `message.im` subscription is the switch; the guard still sees a DM as private.
    const direct = isDirectSlackChannel(message);
    if (!direct && !this.allowedChannels.has(message.channel)) return;
    // Before normalizing, because the text is rendered there and a name that arrives after
    // is a name the brain never saw.
    await this.learnNames(message.text ?? "");
    // The lookup above is the one place this can lose the thread of its own lifecycle.
    // Checked after it and before anything is recorded or delivered.
    if (generation !== this.generation) return;
    const normalized = toSlackInboundEvent(message, this.normalizeOptions());
    if (!normalized) return;

    const key = normalized.id.nativeId;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);

    if (direct) this.dmChannels.add(message.channel);
    this.since = Math.max(this.since ?? 0, Number(message.ts));
    this.lastByChannel.set(normalized.channel.id, contextOf(normalized));
    this.onEvent?.(normalized);
  }

  /** What the privacy answers resolved at startup amount to. Only valid once `started`. */
  private normalizeOptions() {
    return {
      botUserId: this.botUserId!,
      botId: this.botId,
      privateChannels: this.privateChannels,
      publicChannels: this.publicChannels,
      memberNames: this.memberNames,
    };
  }

  /**
   * Names the members a message mentions, so normalization can render them.
   *
   * Sequential rather than concurrent: a message mentions a handful of people at most, and
   * every one after the first conversation is already cached. Slack rate-limits
   * `users.info` per workspace, and a burst is what that limit is aimed at.
   *
   * A refusal is remembered as a refusal. Without `unnamed`, an id Slack will not name —
   * no `users:read`, a deactivated account, someone in another Enterprise Grid workspace —
   * would cost one failed call per message forever, and a channel that talks about that
   * person often would spend the rate limit on an answer that never changes.
   */
  private async learnNames(text: string): Promise<void> {
    for (const id of new Set(slackMentionedMembers(text))) {
      if (id === this.botUserId || this.memberNames.has(id) || this.unnamed.has(id)) continue;
      try {
        const name = await this.api.userName(id);
        if (name) this.memberNames.set(id, name);
        else this.unnamed.add(id);
      } catch {
        this.unnamed.add(id);
      }
    }
  }

  /**
   * Refills the gap a disconnect left behind.
   *
   * Two Slack facts shape this. `conversations.history` returns thread parents but never
   * their replies, and this agent answers *in* threads — so a threaded mention is exactly
   * the kind most likely to be missed. And both endpoints page newest-first, so sorting a
   * single page restores nothing: the whole gap is collected before any of it is replayed.
   *
   * What remains missed is a reply under a parent older than the cursor. That parent is
   * outside the history window, and Slack offers no way to enumerate the threads that
   * moved in a period — only the replies of a thread you can already name.
   */
  private async backfill(oldest: number, session: number): Promise<void> {
    for (const channel of [...this.allowedChannels, ...(await this.directChannels())]) {
      // A replay outlives a `stop` that lands mid-page otherwise, and goes on spending
      // history calls on a run that has ended.
      if (session !== this.generation) return;
      const parents = await this.collect((cursor) =>
        this.api.history({ channel, oldest: String(oldest), cursor }),
      );

      const missed = [...parents];
      for (const parent of parents) {
        if (!hasRepliesSince(parent, oldest)) continue;
        missed.push(
          ...(await this.collect((cursor) =>
            this.api.replies({ channel, ts: parent.ts!, oldest: String(oldest), cursor }),
          )),
        );
      }

      // `conversations.replies` can hand back the thread parent whatever `oldest` says, so
      // drop anything at or before the cursor rather than answering an old message twice.
      const replay = missed
        .filter((message) => Number(message.ts ?? 0) > oldest)
        .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
      for (const message of replay) {
        await this.enqueue({
          ...message,
          type: message.type ?? "message",
          channel,
          channel_type: this.privateChannels.has(channel) ? "group" : "channel",
        }, session);
      }
    }
  }

  /**
   * The DMs a backfill has to cover, which no configuration could have named.
   *
   * `channels` never holds a DM — its conversation id does not exist until someone opens
   * it — and `dmChannels` is populated by `accept`, so at startup it is empty. Between
   * them that left a DM sent while the agent was down in neither set: nothing enumerated
   * it, nothing replayed it, and the cursor moved past it the moment any channel message
   * was accepted. The message was gone, and a person who had asked something in a DM got
   * silence back from an agent that looked healthy.
   *
   * **Read, never granted.** These ids are backfilled and nothing else. A DM still earns
   * the right to be answered by having spoken, which `accept` is what records — so a
   * conversation with nothing in the gap stays one this adapter may not post into, and
   * enumerating open DMs cannot become a way to open one.
   *
   * A failed lookup costs the backfill, not the launch. Without `im:read` there is nothing
   * to enumerate, and taking a working channel-only agent down over it would be refusing
   * the wrong thing.
   */
  private async directChannels(): Promise<string[]> {
    const ids: string[] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await this.api.openDirectChannels(cursor);
        ids.push(...(page.ids ?? []));
        cursor = page.nextCursor || undefined;
      } while (cursor);
    } catch {
      // Whatever paged in before the failure is still worth refilling. Without `im:read`
      // that is nothing, which is the case this catch is really here for.
    }
    return ids;
  }

  /** Drains one cursor-paged endpoint. Slack pages backwards in time; the caller sorts. */
  private async collect(page: (cursor?: string) => Promise<SlackHistoryPage>): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(cursor);
      messages.push(...(result.messages ?? []));
      cursor = result.nextCursor || undefined;
    } while (cursor);
    return messages;
  }

  private assertChannel(channel: ChannelRef): void {
    if (channel.surface !== SLACK_SURFACE) throw new Error("cannot send a Slack message to another surface");
    // A DM earns its way in by having spoken first, which is the same reach the
    // configured list grants — never a channel this adapter has not heard from.
    if (!this.allowedChannels.has(channel.id) && !this.dmChannels.has(channel.id)) {
      throw new Error(`Slack channel ${channel.id} is not configured`);
    }
  }

  /**
   * The brain's text, screened and then written as Slack's encoding of those same
   * characters. Both outbound paths go through it, so neither can screen without encoding.
   *
   * A broadcast is refused rather than encoded. `GuardedMessage` cannot represent one, and
   * `<!channel>` in text is the way back through that boundary; waking every member of the
   * channel is worth failing the turn over rather than delivering as literal text.
   *
   * The rest is escaped, which is the half of `normalizeSlackText` that was missing. That
   * function un-escapes `&lt;`, `&gt;` and `&amp;` on the way in, so the brain reads
   * characters and never Slack's encoding — but with no encoder on the way out the round
   * trip is not symmetric, and text that reached the brain carrying `<@U0ALICE>` went back
   * out as live markup and notified that member. Quoting the message that woke the agent is
   * ordinary and must not be an act of addressing. Addressing is `mentions`, whose ids
   * {@link address} validates and whose count the `post_message` audit line carries.
   *
   * `&` is replaced first, or it escapes the ampersands the other two introduce.
   */
  private outboundText(msg: GuardedMessage): string {
    if (/<!\s*(?:channel|here|everyone)(?:\^[^>]*)?>/i.test(msg.text)) {
      throw new Error("Slack bulk mentions are not supported");
    }
    return msg.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

}

/**
 * Reads privacy off a `conversations.info` channel object.
 *
 * `undefined` means Slack did not answer; it must never mean "answered public". The
 * difference decides whether callers keep a private assertion or drop it, so a naive
 * `is_private || is_im || is_mpim` is wrong: a public channel comes back with
 * `is_private: false` and the IM flags absent, and that chain yields `undefined` — an
 * explicit public answer laundered into "unknown", which every caller then fails closed
 * on in the wrong direction and treats as private.
 */
export function privacyOf(
  channel: { is_private?: boolean; is_im?: boolean; is_mpim?: boolean } | undefined,
): boolean | undefined {
  if (!channel) return undefined;
  return Boolean(channel.is_private || channel.is_im || channel.is_mpim);
}

/**
 * Exported so `sageox-agent surface slack` classifies channels with the same
 * `conversations.info` call the adapter makes at startup. A second copy of "what counts
 * as private" in the CLI would be one that drifts, and the two answers disagreeing means
 * setup promising a reply the guard then refuses.
 */
export class WebSlackApi implements SlackApiClient {
  private readonly client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken);
  }

  async authTest(): Promise<{ userId?: string; botId?: string }> {
    const response = await this.client.auth.test();
    return { userId: response.user_id, botId: response.bot_id };
  }

  async channelIsPrivate(channel: string): Promise<boolean | undefined> {
    return privacyOf((await this.client.conversations.info({ channel })).channel);
  }

  /** `users.conversations` rather than `conversations.list`: the bot's own DMs, not the workspace's. */
  async openDirectChannels(cursor?: string): Promise<SlackDirectPage> {
    const response = await this.client.users.conversations({
      types: "im",
      exclude_archived: true,
      ...(cursor ? { cursor } : {}),
    });
    return {
      ids: response.channels?.flatMap((channel) => (channel.id ? [channel.id] : [])),
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async history(args: { channel: string; oldest: string; cursor?: string }): Promise<SlackHistoryPage> {
    const response = await this.client.conversations.history({
      channel: args.channel,
      oldest: args.oldest,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return {
      messages: response.messages as SlackMessage[] | undefined,
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async replies(args: {
    channel: string;
    ts: string;
    oldest: string;
    cursor?: string;
  }): Promise<SlackHistoryPage> {
    const response = await this.client.conversations.replies({
      channel: args.channel,
      ts: args.ts,
      oldest: args.oldest,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return {
      messages: response.messages as SlackMessage[] | undefined,
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async postMessage(args: {
    channel: string;
    text: string;
    threadTs?: string;
  }): Promise<string | undefined> {
    const response = await this.client.chat.postMessage({
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    return response.ts;
  }

  /** `display_name` is what the workspace shows; the rest are Slack's own fallbacks. */
  async userName(id: string): Promise<string | undefined> {
    const user = (await this.client.users.info({ user: id })).user;
    return user?.profile?.display_name || user?.profile?.real_name || user?.name;
  }

  async addReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.client.reactions.add(args);
  }

  async removeReaction(args: { channel: string; timestamp: string; name: string }): Promise<void> {
    await this.client.reactions.remove(args);
  }
}

/** `latest_reply` is present only on thread parents, and only once a reply exists. */
function hasRepliesSince(message: SlackMessage, oldest: number): boolean {
  const latest = Number(message.latest_reply ?? 0);
  return !!message.ts && Number.isFinite(latest) && latest > oldest;
}

/**
 * What Slack's `reactions.add` takes, from what a caller has.
 *
 * Slack names an emoji, every other surface here carries the character, and there is no
 * general way to turn one into the other without shipping the whole Unicode-to-shortname
 * table. So both spellings are accepted — `:thumbsup:`, `thumbsup`, or a character this
 * map happens to know — and a character it does not know is refused by name rather than
 * sent for Slack to reject as `invalid_name`, which says nothing a caller can act on.
 *
 * The map is a convenience for the few characters a default configuration produces, not a
 * vocabulary: nothing in this toolkit decides which emoji an agent may use.
 */
function slackReactionName(emoji: string): string {
  const aliases: Record<string, string> = {
    "👀": "eyes",
    "✅": "white_check_mark",
    "👍": "+1",
    "👎": "-1",
  };
  return aliases[emoji] ?? emoji.replace(/^:|:$/g, "");
}

/** Slack emoji names are lowercase and punctuation-poor; a character never matches one. */
const SLACK_EMOJI_NAME = /^[a-z0-9_+'-]+$/;

/**
 * A Slack member id: `U…` for a person, `W…` on an Enterprise Grid, `B…` for a bot.
 *
 * Anchored and closed over the alphabet Slack actually issues, which is what makes the
 * mention below safe to build by concatenation: a value carrying `>` would otherwise close
 * the `<@…>` it was put inside and let the rest of it read as markup — `<!channel>` among
 * the things it could then be, which is the broadcast `outboundText` refuses in `text` and
 * which must not have a second way in. This prefix is the one part of an outbound message
 * the adapter builds itself, so it is the one part that is not escaped. The bound is
 * generous; Slack ids are 9–11 characters.
 */
const SLACK_MEMBER_ID = /^[UWB][A-Z0-9]{1,31}$/;

/**
 * The recipients, as the prefix that wakes them — Slack's addressing primitive is in the
 * text, so this is the whole of it.
 *
 * Every id is checked rather than the ones that look suspect: a mention list reaches here
 * from a job body, and "a display name renders and pings nobody" is exactly the silent
 * failure the caller is trying to avoid. Empty is the ordinary case and adds nothing —
 * a status post is addressed to the channel.
 */
function address(mentions: readonly string[]): string {
  if (!mentions.length) return "";
  for (const id of mentions) {
    if (!SLACK_MEMBER_ID.test(id)) {
      throw new Error(
        "a Slack post is addressed by member id (U…, W… or B…), and one recipient is " +
          "neither — a display name renders but wakes nobody",
      );
    }
  }
  return `${mentions.map((id) => `<@${id}>`).join(" ")} `;
}

/**
 * `already_reacted` — the one `reactions.add` failure that means the call succeeded.
 *
 * Read off the platform error's `data.error` rather than its message, which is prose and
 * localizable. Anything that is not this shape is not this error.
 */
function isAlreadyReacted(error: unknown): boolean {
  return (error as { data?: { error?: unknown } } | null)?.data?.error === "already_reacted";
}
