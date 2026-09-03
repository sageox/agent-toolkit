import type {
  ActorRef,
  InboundEvent,
  GuardedMessage,
  ChannelRef,
  EventRef,
  ThreadReply,
} from "./events.ts";

/** What one `react` call found or did. */
export interface ReactionResult {
  /** The reaction. Present whether this call made it or found it already there. */
  ref: EventRef;
  /**
   * Whether **this call** put it there, which is the only case a caller may withdraw it.
   *
   * An agent's identity on a surface is one identity, and a reaction under it may predate
   * this turn: Slack answers a repeat with `already_reacted`, which says the reaction
   * exists and says nothing about who made it or when. Withdrawing on that basis takes
   * back a reaction the gateway never made.
   *
   * Buzz reports `true` whenever it published, which is what it can honestly know: the
   * event is ours by authorship, and a reaction placed under this identity by some other
   * process is, on Nostr, not distinguishable from one placed by this one — a relay says
   * nothing back about whether it already held the event.
   */
  placed: boolean;
}

export interface SurfaceAdapter {
  readonly kind: string;
  /**
   * Connect. With `onEvent`, also listen and deliver inbound messages to it.
   *
   * **Omit it only if you genuinely never want to hear anything.** An agent is what it
   * hears, and one that came up without a listener is deaf while looking healthy — the
   * failure this repo has paid for before. The only caller that legitimately omits it is a
   * `job run`, a process that posts one status and exits; passing a no-op handler instead
   * would open a subscription nobody reads and, on Slack, make an inbound outage the reason
   * a perfectly deliverable status post never went out.
   */
  start(onEvent?: (e: InboundEvent) => void): Promise<void>;
  /**
   * Send an already-guarded message. `inReplyTo` is adapter context, never authority:
   * it keeps concurrent inbound messages from racing a reply onto the wrong thread.
   */
  send(channel: ChannelRef, msg: GuardedMessage, inReplyTo?: InboundEvent): Promise<void>;
  /**
   * Configured channels this adapter may receive a new top-level post in.
   *
   * Optional because some surfaces, such as the local console, only make sense as a
   * reply destination. The returned refs are trusted adapter configuration, never ids
   * supplied by the brain.
   */
  postTargets?(): readonly ChannelRef[];

  /**
   * Who this surface can vouch for as addressable, by id, with the name people use.
   *
   * Optional, and only a surface that holds a roster answers: Buzz reads the relay's
   * directory records, which is what makes a pubkey mentionable there at all. It is the
   * surface's knowledge and never the manifest's — the principals an operator named live
   * in `owner` and `allowlist`, and `SurfaceEgress.address` reads both sources.
   */
  principals?(): ReadonlyMap<string, string | undefined>;

  /**
   * The name people use for an id this surface has seen, or nothing.
   *
   * Presentation only — it labels a line brought home from this surface, and is never an
   * identity check. Slack answers from the member names it has resolved, Buzz from the
   * directory; an id neither knows is shown as itself.
   */
  displayName?(id: string): string | undefined;

  /**
   * Publish a message with no inbound context: a new top-level post, or — given a
   * `threadRoot` this adapter handed back earlier — a reply beneath one of its own.
   *
   * The ref comes back so a caller can thread under what it just posted. That is a job's
   * need and never a chat turn's: a reply to the message that woke the agent already has a
   * thread, which is why `GuardedMessage` stays as narrow as it is. `undefined` when the
   * surface reports no id — a caller reads that as "no thread root" and posts the next line
   * at top level rather than dropping it.
   *
   * `mentions` addresses the post to a named set, rendered as whatever this surface's
   * addressing primitive is — a `p` tag on Buzz, `<@id>` on Slack. A channel post is
   * otherwise addressed to a channel and nobody in it wakes, which is right for a status
   * line and is the whole failure mode of a probe: a roll call nobody was addressed by
   * reads back as an empty thread and reports every agent silent. Only the per-run job
   * channel passes it, and only for a `report.probe` job; a status post never does.
   *
   * **Ids the surface resolves, never display names.** A name renders and wakes no one, so
   * an adapter validates the shape it was handed and refuses rather than posting a message
   * that looks addressed and is not. An adapter on a surface with **no** addressing
   * primitive must throw on a non-empty list for the same reason {@link readThread} is
   * absent rather than answering `[]` — silence a caller cannot distinguish from an answer
   * is the bug both rules exist to prevent.
   */
  post?(
    channel: ChannelRef,
    msg: GuardedMessage,
    threadRoot?: EventRef,
    mentions?: readonly string[],
  ): Promise<EventRef | undefined>;

  /**
   * Replies beneath a thread root this adapter handed back from {@link post}.
   *
   * The other half of `post`'s verb. `post` exists so a caller can thread under what it
   * just published — a job's need and never a chat turn's — and this is how that same
   * caller finds out what came back. A job that *probes* is written from the pair: it
   * posts one message, waits, reads the answers, and mints a verdict from what it read.
   *
   * Optional, and a surface with no thread model omits it. Omitting is not the same
   * answer as an empty array and callers must not let the two collapse: "nobody answered"
   * and "this surface cannot tell you" are the difference between a roll call that found
   * silence and one that found nothing out.
   *
   * `limit` is a ceiling on how many replies come back, oldest first when the surface
   * orders them; unset means whatever the surface gives. Nothing here promises the whole
   * thread — a relay answers from what it still stores.
   *
   * **The root is not authority and this is not a way to read a channel.** A caller may
   * only pass a root it holds because this adapter returned it, the way `react` may only
   * mark the message the turn is answering; nothing in an adapter can check that, so the
   * caller that hands a root over is the one that has to have issued it. The toolkit's
   * only caller is the per-run job channel, which refuses a root that run did not post.
   */
  readThread?(root: EventRef, limit?: number): Promise<readonly ThreadReply[]>;

  /**
   * Channels this agent is a member of, as the surface itself reports membership.
   *
   * Not {@link postTargets}, which is what an operator configured. Slack lists a channel
   * there that nobody invited the bot to, and the gap between the two lists is the
   * bring-up failure that has no error anywhere: an agent that joined nothing connects,
   * authenticates, and is simply never spoken to.
   *
   * Optional, and a surface with no join to report omits it rather than answering `[]` —
   * the {@link readThread} rule, and it bites harder here, because an empty roster is
   * also what a real answer looks like.
   */
  listChannels?(): Promise<readonly ChannelRef[]>;

  /**
   * Who is in one channel this adapter serves, in no promised order.
   *
   * Bounded like {@link readThread}: `limit` is a ceiling on how many come back, and a
   * surface that cannot answer omits the method. The refs carry a `name` wherever the
   * surface can put one to the id — a roster of bare ids does not answer the question
   * anyone asks a membership read.
   */
  listMembers?(channel: ChannelRef, limit?: number): Promise<readonly ActorRef[]>;

  /**
   * One actor by the id this surface uses, or `undefined` when the surface has never
   * heard of it.
   *
   * The lookup behind {@link displayName}, which answers only from what the inbound path
   * already resolved — so a member who has not spoken has no cached name, and that is
   * exactly the id somebody asks about. `undefined` is "not known here" and never "this
   * surface cannot look anyone up"; a surface that cannot look anyone up omits the method.
   */
  describeActor?(id: string): Promise<ActorRef | undefined>;

  /**
   * Recent messages in a channel this adapter serves, oldest first.
   *
   * Distinct from {@link readThread}, which is scoped to one rooted thread this adapter
   * published: this is the channel, and nothing in it was addressed to the agent. `limit`
   * keeps the most recent that many, because what a reader of a channel wants is the end
   * of it. The text is untrusted for the same reason and to the same degree.
   */
  readChannel?(channel: ChannelRef, limit?: number): Promise<readonly ThreadReply[]>;

  /**
   * The resume cursor to persist, for surfaces that replay history from one. The CLI
   * saves it across restarts so the agent never reopens a deaf window.
   */
  cursor?(): number | undefined;
  stop(): Promise<void>;

  /**
   * Put an emoji on a message: the gateway's own acknowledgement that it has picked one
   * up, and the glyph a brain chooses for the message it is answering.
   *
   * Optional: a surface without reactions simply omits it. Both this and `setTyping`
   * are courtesy signals — they must never fail a turn, because a turn that produced a
   * real answer should not be lost to a missing emoji.
   *
   * The whole event rather than its ref, because a reaction is addressed to a message's
   * channel and author as much as to its id, and an adapter that had to look those up
   * could only look them up among the messages it still remembers. A channel busy enough
   * to evict that memory is the one an agent is most likely to be answering slowly in.
   *
   * **The ref identifies the reaction as the surface understands it**, so a caller can
   * tell "the thing I made" from "the thing something else made" without knowing how a
   * surface spells an emoji — Slack names one where Buzz carries the character, and `👀`
   * and `eyes` are one reaction that only the adapter can see are one.
   *
   * What that does *not* promise is one ref per message and emoji forever. Slack has one
   * reaction per identity, so its refs are stable. A Buzz reaction is content-addressed
   * over fields that include `created_at`, at one-second resolution — so asking twice
   * inside a second answers alike, and asking a second later is a genuinely different
   * event. Callers must hold both: a repeat is sometimes the same reaction and sometimes
   * another one standing beside it, and neither is an error.
   *
   * `undefined` means nothing is there — the surface is not connected, or the message is
   * not one it serves. A caller must not report a reaction on that.
   */
  react?(target: InboundEvent, emoji: string): Promise<ReactionResult | undefined>;

  /**
   * Withdraws one reaction this adapter made, named by the ref `react` handed back.
   *
   * The reaction rather than the message it sits on, because several can sit on one at
   * once and only some are ever taken back: the gateway withdraws its acknowledgement
   * when the turn ends, while whatever the brain was asked to signal is meant to stand.
   * Naming the message cannot tell those apart, and naming the message and the emoji
   * cannot either — the acknowledgement and a brain-chosen glyph may be the same emoji,
   * at which point the withdrawal takes back whichever was recorded last.
   *
   * A ref is exact and needs no bookkeeping to interpret, which is the other half: an
   * adapter that remembered every reaction in order to withdraw one would grow a map
   * entry per reaction it never withdraws.
   */
  unreact?(reaction: EventRef): Promise<void>;

  /**
   * How this surface spells an emoji, so two spellings of one reaction compare equal
   * without either being made. Pure: no I/O, no clock, no network.
   *
   * Slack names an emoji where Buzz carries the character, so `👀` and `eyes` are one
   * reaction and must key alike. Omitting this means the emoji is its own key, which is
   * right for a surface that carries the character it was given.
   *
   * This is a *conservative* comparison and never a decision: equal keys mean two requests
   * might turn out to be one reaction, and only the refs they come back with can say
   * whether they are. It exists so a caller can tell which outstanding requests are worth
   * waiting on, not which reaction to withdraw.
   */
  reactionKey?(emoji: string): string;

  /**
   * Show that the agent is working. Ephemeral, and refreshed while the turn runs.
   *
   * `threadRoot` is undefined for a top-level message, which scopes the indicator to the
   * channel — where a reader actually looks for it.
   */
  setTyping?(channel: ChannelRef, threadRoot?: EventRef): Promise<void>;
}
