import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type {
  ActorRef,
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

/** One page of `users.conversations`, as Slack spells a conversation object. */
export interface SlackConversationPage {
  channels?: {
    id?: string;
    name?: string;
    is_private?: boolean;
    is_im?: boolean;
    is_mpim?: boolean;
  }[];
  nextCursor?: string;
}

/** One page of `conversations.members`. */
export interface SlackMembersPage {
  ids?: string[];
  nextCursor?: string;
}

/** What `users.info` says about a member: the name to show, and whether it is a bot. */
export interface SlackUser {
  name?: string;
  isBot: boolean;
}

/** Narrow API seam: production wraps WebClient and tests never touch the network. */
export interface SlackApiClient {
  authTest(): Promise<{ userId?: string; botId?: string }>;
  channelIsPrivate(channel: string): Promise<boolean | undefined>;
  /**
   * One page of the conversations this bot is a member of, for the `types` asked for —
   * `im` for the DMs no configuration names, channels for what it was actually invited to.
   * Paged like `history` and `replies`, so the walk stays on the tested side of this seam.
   */
  memberConversations(args: { types: string; cursor?: string }): Promise<SlackConversationPage>;
  /** One page of a channel's member ids. */
  channelMembers(args: { channel: string; cursor?: string }): Promise<SlackMembersPage>;
  /**
   * `limit` is a page size, not a total: this endpoint answers newest first, so one page
   * of `n` is the most recent `n`. Unset takes Slack's own default.
   */
  history(args: {
    channel: string;
    oldest: string;
    cursor?: string;
    limit?: number;
  }): Promise<SlackHistoryPage>;
  replies(args: {
    channel: string;
    ts: string;
    oldest: string;
    cursor?: string;
  }): Promise<SlackHistoryPage>;
  /** Who a member id is, or `undefined` when Slack will not say. */
  user(id: string): Promise<SlackUser | undefined>;
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
  /** `reply: private` as configured — what a lookup that cannot answer falls back to. */
  private readonly configuredPrivate: ReadonlySet<string>;
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
   * Member id to name, filled as messages mention people and never expired. A rename goes
   * unnoticed until restart — the alternative, `users.list` at boot, spends a whole
   * workspace's member table to answer about the few people who speak.
   */
  private readonly memberNames = new Map<string, string>();
  /** Ids Slack would not name, so a second message does not ask about them again. */
  private readonly unnamed = new Set<string>();
  /**
   * One message at a time per conversation, in arrival order.
   *
   * Resolving a name is a network call, and `ChannelQueue` preserves the order it is
   * submitted in — so two messages racing on their lookups would have the agent answer the
   * second question first. Per conversation, not adapter-wide, because that queue
   * serializes a channel and runs channels in parallel. Dropped once drained.
   */
  private readonly chains = new Map<string, Promise<void>>();
  /**
   * Which run of this adapter queued work belongs to. Ending a run bumps it, so a message
   * still waiting on a lookup is discarded rather than delivered into a later `start()`.
   */
  private generation = 0;
  /**
   * Resolves once this run's socket has settled — connected, or failed to.
   *
   * The listener is registered before `socket.start()`, because Socket Mode delivers from
   * the moment it connects. Delivery still waits: a start that then fails throws out of
   * `start`, and a turn already spent answering would make that a lie. Held rather than
   * dropped — it is a real message either way.
   */
  private socketSettled: Promise<void> = Promise.resolve();
  private releaseSocket: () => void = () => {};
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
    this.configuredPrivate = new Set(
      opts.channels.filter((channel) => channel.reply === "private").map((channel) => channel.id),
    );
    this.privateChannels = new Set(this.configuredPrivate);
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
    // Before the first await, not after the last: a `stop` during either lookup below ends
    // this run, and capturing afterwards would read the replacement's stamp and pass every
    // ownership check downstream as though this were the live run.
    const session = this.generation;

    const identity = await this.api.authTest();
    if (!identity.userId) throw new Error("Slack auth.test did not return the bot user id");
    if (session !== this.generation) return;
    this.botUserId = identity.userId;
    this.botId = identity.botId;
    this.onEvent = onEvent;

    // Slack Connect and shared channels do not always follow an ID-prefix privacy rule.
    // A failed lookup is not trusted as private: the configured assertion remains, and
    // everything else stays public so the egress guard fails closed.
    const privacy = await Promise.all(
      [...this.allowedChannels].map(async (channel) => {
        try {
          return { channel, isPrivate: await this.api.channelIsPrivate(channel) };
        } catch {
          // Missing channels:read/groups:read must not widen egress.
          return { channel, isPrivate: undefined };
        }
      }),
    );
    if (session !== this.generation) return;
    // From configuration plus this run's answers, and nothing earlier. Both sets outlive a
    // `stop`, so a previous run's answer would decide a lookup that fails now — and in the
    // direction where it once said "private", the guard would allow a reply into a channel
    // configured public.
    this.privateChannels.clear();
    for (const channel of this.configuredPrivate) this.privateChannels.add(channel);
    this.publicChannels.clear();
    for (const { channel, isPrivate } of privacy) {
      if (isPrivate) this.privateChannels.add(channel);
      // Recorded, not merely "not added": normalization otherwise falls back to the ID
      // prefix and calls a public G-prefixed channel private, the one case where the guard
      // would let workspace-visible output through. The configured assertion is dropped in
      // the same step, because Slack answering "public" outranks it.
      else if (isPrivate === false) {
        this.publicChannels.add(channel);
        this.privateChannels.delete(channel);
      }
    }

    // Everything `post` and the egress guard rely on is now in place. Saying so before the
    // socket is what lets a caller with nothing to listen for stop here — and it is why an
    // inbound outage can no longer be the reason a deliverable status post never went out.
    this.started = true;
    if (!onEvent) return;

    const resumeFrom = this.since;
    // The listener goes on before the connection is up, so an envelope can already be
    // queued when the start below fails.
    this.socketSettled = new Promise((resolve) => {
      this.releaseSocket = resolve;
    });
    this.socket.on("slack_event", this.handleEnvelope);
    try {
      await this.socket.start();
      // A `stop` and a fresh `start` can both have happened while that was pending. The
      // gate, the listener and `onEvent` are single fields, so touching any of them now
      // would be reaching into a run this one does not own.
      if (session !== this.generation) return;
      this.listening = true;
      this.releaseSocket(); // before the backfill, which enqueues through the same gate
      // Socket Mode has no replay. Connect first, then fill the earlier gap; deduplication
      // makes overlap safe and avoids a new gap between the history call and the socket.
      if (resumeFrom !== undefined) await this.backfill(resumeFrom, session);
    } catch (error) {
      // Same rule on the way out: a late failure must not unsubscribe, disconnect or
      // invalidate a run that replaced this one. Still thrown — the caller asked this one.
      if (session === this.generation) {
        this.started = false;
        this.socket.off?.("slack_event", this.handleEnvelope);
        this.onEvent = undefined;
        this.invalidate();
        await this.socket.disconnect().catch(() => {});
      }
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

    const text = this.outboundText(msg, channel.id);

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

  /** A member's name as the inbound path resolved it — the same directory, read back. */
  displayName(id: string): string | undefined {
    return this.memberNames.get(id);
  }

  async post(
    channel: ChannelRef,
    msg: GuardedMessage,
    threadRoot?: EventRef,
    mentions: readonly string[] = [],
  ): Promise<EventRef | undefined> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before post()");
    this.assertChannel(channel);
    const text = this.outboundText(msg, channel.id);

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
   * Every failure throws and none answers `[]`, per {@link SurfaceAdapter.readThread}.
   * `oldest: "0"` because a thread read wants the whole thread, not what followed a cursor.
   * Slack returns the parent whatever `oldest` says and it is not in its own thread, so it
   * is dropped by `ts` — a page boundary promises nothing about order. Normalized through
   * `toSlackInboundEvent`, so a join notice is no more a reply here than it is a turn.
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

  /**
   * The channels Slack reports this bot as a member of — one `users.conversations` walk.
   *
   * Channels only, not `im`: the question this answers is whether anyone invited the bot
   * anywhere, and a DM somebody opened is not an invitation to a channel. Classified by
   * `privacyOf`, the same rule `conversations.info` answers are read with at startup, so a
   * channel listed here and the same channel in `postTargets` cannot disagree.
   */
  async listChannels(): Promise<readonly ChannelRef[]> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before listChannels()");
    const channels: ChannelRef[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.memberConversations({
        types: "public_channel,private_channel",
        cursor,
      });
      for (const channel of page.channels ?? []) {
        if (!channel.id) continue;
        // Unknown is public, as everywhere else here: the guard has to fail closed on a
        // channel nothing can vouch for.
        channels.push({
          surface: SLACK_SURFACE,
          id: channel.id,
          isPublic: privacyOf(channel) !== true,
          ...(channel.name ? { name: channel.name } : {}),
        });
      }
      cursor = page.nextCursor || undefined;
    } while (cursor);
    return channels;
  }

  /**
   * Who is in one channel this adapter serves — `conversations.members`, then one
   * `users.info` per member.
   *
   * A call per member is what Slack offers: the bulk alternative is `users.list`, which
   * spends the whole workspace's member table to name the few people in one channel — the
   * trade `memberNames` already refuses at startup. `learnName` caches both answers, so a
   * second read of the same roster costs nothing, and `limit` bounds the first one.
   *
   * A member Slack would not name is still in the channel, so they come back by id. What
   * that costs is `isAgent`, which is `false` for the same reason it is on an author with
   * no `bot_id` — the only honest default when nothing said otherwise.
   */
  async listMembers(channel: ChannelRef, limit?: number): Promise<readonly ActorRef[]> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before listMembers()");
    this.assertChannel(channel);

    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.api.channelMembers({ channel: channel.id, cursor });
      ids.push(...(page.ids ?? []));
      cursor = page.nextCursor || undefined;
    } while (cursor && (limit === undefined || ids.length < limit));

    const members: ActorRef[] = [];
    // Sequential, for `learnNames`' reason: `users.info` is rate-limited per workspace, and
    // a roster is exactly the burst that limit is aimed at.
    for (const id of limit === undefined ? ids : ids.slice(0, limit)) {
      members.push(this.actor(id, await this.learnName(id)));
    }
    return members;
  }

  /** One `users.info`. See {@link SurfaceAdapter.describeActor} for what `undefined` means. */
  async describeActor(id: string): Promise<ActorRef | undefined> {
    if (!this.started) {
      throw new Error("SlackAdapter.start() must be called before describeActor()");
    }
    let user: SlackUser | undefined;
    try {
      user = await this.api.user(id);
    } catch (error) {
      // `user_not_found` is the one failure that means what `undefined` means here. A
      // missing scope or a network fault is a lookup that did not happen, and answering
      // "nobody" on either would report a real member as a stranger.
      if (slackErrorCode(error) !== "user_not_found") throw error;
    }
    if (user?.name) this.memberNames.set(id, user.name);
    return user && this.actor(id, user);
  }

  /**
   * Recent messages in a channel this adapter serves — one page of `conversations.history`.
   *
   * One page and no cursor walk: the endpoint answers newest first, so the page *is* the
   * recent end of the channel, and paging on would walk back to the channel's first day to
   * answer a question about its last hour. `limit` is passed to Slack as that page's size.
   *
   * Thread replies are not in it — `conversations.history` returns parents only, the same
   * Slack fact `backfill` works around — and that is the right answer for a channel read.
   * {@link readThread} is how one thread is opened.
   */
  async readChannel(channel: ChannelRef, limit?: number): Promise<readonly ThreadReply[]> {
    if (!this.started) throw new Error("SlackAdapter.start() must be called before readChannel()");
    this.assertChannel(channel);

    const page = await this.api.history({ channel: channel.id, oldest: "0", limit });
    // Sorted on the Slack `ts` rather than the ISO string it becomes, per `readThread`.
    const ordered = [...(page.messages ?? [])].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
    for (const message of ordered) await this.learnNames(message.text ?? "");

    return ordered.flatMap((message) => {
      const event = toSlackInboundEvent(
        { ...message, type: message.type ?? "message", channel: channel.id },
        this.normalizeOptions(),
      );
      return event ? [{ author: event.author, text: event.text, ts: event.ts }] : [];
    });
  }

  /**
   * A member id as core names an actor.
   *
   * `is_bot` is `toSlackInboundEvent`'s `bot_id` seen from the other side: what makes an
   * author an agent there is that a bot posted the message, and what makes an id one here
   * is that Slack calls it a bot.
   */
  private actor(id: string, user?: SlackUser): ActorRef {
    const self = id === this.botUserId;
    return {
      surface: SLACK_SURFACE,
      id,
      isSelf: self,
      isAgent: self || user?.isBot === true,
      ...(user?.name ? { name: user.name } : {}),
    };
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
    this.releaseSocket(); // parked work wakes to a moved generation; without this it hangs
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
    await this.socketSettled; // see the field: a replay passes through, the socket is up
    // Checked before the lookup as well as after: a message already stale when its turn
    // comes must not spend a `users.info` that the run still serving this conversation
    // would wait behind.
    if (generation !== this.generation) return;
    // Before normalizing, because the text is rendered there and a name that arrives after
    // is a name the brain never saw.
    await this.learnNames(message.text ?? "");
    if (generation !== this.generation) return;
    const normalized = toSlackInboundEvent(message, this.normalizeOptions());
    if (!normalized) return;

    const key = normalized.id.nativeId;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);

    if (direct) this.dmChannels.add(message.channel);
    this.since = Math.max(this.since ?? 0, Number(message.ts));
    // The newest, not the most recently processed: `start` connects before it fills the
    // gap, so a replay lands among live messages older than it.
    const context = contextOf(normalized);
    const latest = this.lastByChannel.get(normalized.channel.id);
    if (!latest || Number(context.eventTs) > Number(latest.eventTs)) {
      this.lastByChannel.set(normalized.channel.id, context);
    }
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
   * Sequential, because Slack rate-limits `users.info` per workspace and a burst is what
   * that limit is aimed at. A refusal is remembered: an id Slack will not name would
   * otherwise cost a failed call per message forever.
   */
  private async learnNames(text: string): Promise<void> {
    for (const id of new Set(slackMentionedMembers(text))) {
      if (id === this.botUserId || this.memberNames.has(id) || this.unnamed.has(id)) continue;
      await this.learnName(id);
    }
  }

  /**
   * One `users.info`, with both answers remembered: the name in `memberNames`, a refusal
   * in `unnamed`. Shared with the roster read, which asks about members who have never
   * spoken and so are exactly the ids no cache holds.
   */
  private async learnName(id: string): Promise<SlackUser | undefined> {
    try {
      const user = await this.api.user(id);
      if (user?.name) this.memberNames.set(id, user.name);
      else this.unnamed.add(id);
      return user;
    } catch (error) {
      // Only a refusal that will not change on its own. `unnamed` is never cleared, so a
      // transient failure recorded here renders that member by id for the whole process.
      if (isPermanentNameFailure(error)) this.unnamed.add(id);
      return undefined;
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
    const live = () => session === this.generation;
    // Built before the walk it guards: enumerating DMs pages too, and a `stop` landing in
    // the middle of that is the same waste as one landing in the middle of a history page.
    for (const channel of [...this.allowedChannels, ...(await this.directChannels(live))]) {
      if (!live()) return;
      const parents = await this.collect(
        (cursor) => this.api.history({ channel, oldest: String(oldest), cursor }),
        live,
      );

      const missed = [...parents];
      for (const parent of parents) {
        if (!live()) return;
        if (!hasRepliesSince(parent, oldest)) continue;
        missed.push(
          ...(await this.collect(
            (cursor) => this.api.replies({ channel, ts: parent.ts!, oldest: String(oldest), cursor }),
            live,
          )),
        );
      }

      // `conversations.replies` can hand back the thread parent whatever `oldest` says, so
      // drop anything at or before the cursor rather than answering an old message twice.
      const replay = missed
        .filter((message) => Number(message.ts ?? 0) > oldest)
        .sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
      // One turn, not one await per message: each await was a point where a live message
      // could land in the middle of a sorted replay. The chain already orders them.
      await Promise.all(
        replay.map((message) =>
          this.enqueue({
            ...message,
            type: message.type ?? "message",
            channel,
            channel_type: this.privateChannels.has(channel) ? "group" : "channel",
          }, session),
        ),
      );
    }
  }

  /**
   * The DMs a backfill has to cover. `channels` never holds one — the id does not exist
   * until someone opens it — and `dmChannels` is empty until `accept` fills it, so without
   * this a DM sent while the agent was down is in neither set and is lost.
   *
   * **Read, never granted:** these ids are backfilled and nothing else. A DM still earns a
   * reply by having spoken. A failed lookup costs the backfill, not the launch.
   */
  private async directChannels(live: () => boolean): Promise<string[]> {
    const ids: string[] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await this.api.memberConversations({ types: "im", cursor });
        ids.push(...(page.channels ?? []).flatMap((channel) => (channel.id ? [channel.id] : [])));
        cursor = page.nextCursor || undefined;
      } while (cursor && live());
    } catch {
      // Whatever paged in before the failure is still worth refilling. Without `im:read`
      // that is nothing, which is the case this catch is really here for.
    }
    return ids;
  }

  /**
   * Drains one cursor-paged endpoint. Slack pages backwards in time; the caller sorts.
   *
   * `live` is asked between pages, so a walk whose run has ended stops. A backfill passes
   * it; a thread read does not, being a caller's request rather than background work.
   */
  private async collect(
    page: (cursor?: string) => Promise<SlackHistoryPage>,
    live: () => boolean = () => true,
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(cursor);
      messages.push(...(result.messages ?? []));
      cursor = result.nextCursor || undefined;
    } while (cursor && live());
    return messages;
  }

  /** The reach every channel-scoped call here has, sending and reading alike. */
  private assertChannel(channel: ChannelRef): void {
    if (channel.surface !== SLACK_SURFACE) {
      throw new Error(`a ${channel.surface} channel names no Slack conversation`);
    }
    // A DM earns its way in by having spoken first, which is the same reach the
    // configured list grants — never a channel this adapter has not heard from.
    if (!this.allowedChannels.has(channel.id) && !this.dmChannels.has(channel.id)) {
      throw new Error(`Slack channel ${channel.id} is not configured`);
    }
  }

  /**
   * The brain's text, written as Slack's encoding of those same characters. Both outbound
   * paths go through it, so neither can send without encoding.
   *
   * Escaping is the half of `normalizeSlackText` that was missing. That function un-escapes
   * `&lt;`, `&gt;` and `&amp;` on the way in, so the brain reads characters and never
   * Slack's encoding — but with no encoder on the way out the round trip is not symmetric,
   * and text that reached the brain carrying `<@U0ALICE>` went back out as live markup and
   * notified that member. Inbound no longer hands that form over — a mention arrives named,
   * as `@alice` — so what this still catches is a brain writing `<@…>` of its own, which
   * nothing upstream screens. Quoting the message that woke the agent is ordinary and must
   * not be an act of addressing. Addressing is `mentions`, whose ids {@link address}
   * validates and whose count the `post_message` audit line carries.
   *
   * A broadcast is escaped by those same replacements and logged rather than refused.
   * `&lt;!channel&gt;` renders as characters and notifies nobody, so the throw that stood
   * here bought no reach and cost the whole turn: `SurfaceEgress.reply` does not catch
   * around `send`, so it left `drive` and the channel saw the acknowledgement appear and
   * vanish with no answer. The brain also reads `<!channel>` from somebody who merely typed
   * those characters — `normalizeSlackText` un-escapes the `&lt;!channel&gt;` Slack sent —
   * so quoting either form is an answer and one `egress_escaped` line, not a dead turn.
   *
   * `&` is replaced first, or it escapes the ampersands the other two introduce.
   */
  private outboundText(msg: GuardedMessage, channel: string): string {
    if (/<!\s*(?:channel|here|everyone)(?:\^[^>]*)?>/i.test(msg.text)) {
      console.warn(
        `egress_escaped surface=${SLACK_SURFACE} channel=${channel} rule=slackBroadcast ` +
          `reason="the text carried a broadcast, escaped to characters that notify nobody"`,
      );
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

  /** `users.conversations` rather than `conversations.list`: the bot's own, not the workspace's. */
  async memberConversations(args: {
    types: string;
    cursor?: string;
  }): Promise<SlackConversationPage> {
    const response = await this.client.users.conversations({
      types: args.types,
      exclude_archived: true,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return {
      channels: response.channels as SlackConversationPage["channels"],
      nextCursor: response.response_metadata?.next_cursor,
    };
  }

  async channelMembers(args: { channel: string; cursor?: string }): Promise<SlackMembersPage> {
    const response = await this.client.conversations.members({
      channel: args.channel,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return { ids: response.members, nextCursor: response.response_metadata?.next_cursor };
  }

  async history(args: {
    channel: string;
    oldest: string;
    cursor?: string;
    limit?: number;
  }): Promise<SlackHistoryPage> {
    const response = await this.client.conversations.history({
      channel: args.channel,
      oldest: args.oldest,
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
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
  async user(id: string): Promise<SlackUser | undefined> {
    const user = (await this.client.users.info({ user: id })).user;
    if (!user) return undefined;
    return {
      name: user.profile?.display_name || user.profile?.real_name || user.name,
      isBot: Boolean(user.is_bot),
    };
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
 * the things it could then be, which `outboundText` escapes in `text`. This prefix is the
 * one part of an outbound message the adapter builds itself, so it is the one part that is
 * not escaped — which makes this check the only thing keeping a live broadcast off the
 * wire. The bound is generous; Slack ids are 9–11 characters.
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
 * `users.info` failures that outlast the request, so the id is worth not asking about again.
 *
 * Read off `data.error` like {@link isAlreadyReacted}, and deliberately a short list: the
 * default `WebClient` retries 429 itself, so what reaches this is usually a network fault,
 * which must stay retryable. Everything unrecognised is treated that way.
 */
const PERMANENT_NAME_FAILURES = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "user_not_found",
  "account_inactive",
]);

function isPermanentNameFailure(error: unknown): boolean {
  const code = slackErrorCode(error);
  return code !== undefined && PERMANENT_NAME_FAILURES.has(code);
}

/**
 * A platform error's own code, read off `data.error` rather than its message, which is
 * prose and localizable. Anything not of that shape is not a platform error.
 */
function slackErrorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof code === "string" ? code : undefined;
}

/** `already_reacted` — the one `reactions.add` failure that means the call succeeded. */
function isAlreadyReacted(error: unknown): boolean {
  return slackErrorCode(error) === "already_reacted";
}
