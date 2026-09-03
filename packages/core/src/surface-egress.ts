import { z } from "zod";
import type { SurfaceAdapter } from "./adapter.ts";
import type {
  ActorRef,
  ChannelRef,
  EventRef,
  GuardedMessage,
  InboundEvent,
  ThreadReply,
} from "./events.ts";
import type { AgentManifest } from "./manifest.ts";
import { evaluateEgress, type GuardVerdict } from "./guard.ts";
import { Links, type Link } from "./links.ts";
import {
  mcpToolServer,
  serveMcp,
  type HostedMcp,
  type McpHandler,
  type ServeOptions,
} from "./mcp-http.ts";
import { ToolRefused } from "./tool-audit.ts";
import { qualifyTool, type ToolPolicy } from "./tool-policy.ts";

export const SURFACE_EGRESS_SERVER = "surface-egress";
const POST_MESSAGE = "post_message";
const REACT = "react";
export const SURFACE_EGRESS_TOOL_NAMES = [POST_MESSAGE, REACT] as const;
/** The top-level post tool. Named for the server it came with, and kept that way. */
export const SURFACE_EGRESS_TOOL = qualifyTool(SURFACE_EGRESS_SERVER, POST_MESSAGE);
/** The reaction tool, on the same server and allowlisted separately. */
export const SURFACE_REACT_TOOL = qualifyTool(SURFACE_EGRESS_SERVER, REACT);

/**
 * Which of this server's two tools to serve, decided by the caller that knows.
 *
 * Both are optional capabilities and neither implies the other: an agent on one surface
 * with no channel to post into can still react, and a policy may allowlist either alone.
 * Passed in rather than re-derived here, so the tool the brain is offered and the tool the
 * gateway agreed to serve cannot come apart.
 */
export interface SurfaceEgressTools {
  postMessage: boolean;
  react: boolean;
}

/** One in-flight turn, as the reaction and addressing paths need it. */
interface LiveTurn {
  event: InboundEvent;
  /**
   * Whether this turn has already addressed someone. One admitted inbound message wakes
   * at most one principal, which is what bounds paging without a counter of its own.
   */
  addressed: boolean;
  /**
   * Reactions the brain put on the message, by the ref the surface answered with.
   *
   * Refs rather than emoji, because an emoji is not an identity: Slack names one where
   * Buzz carries the character, so `👀` and `eyes` are one reaction that only the adapter
   * can see are one. This holds exactly the reactions the gateway must not withdraw —
   * which includes the acknowledgement itself when the brain was asked for that same
   * reaction, and does not when the surface answered with a distinct one. On Buzz a
   * reaction re-signed a second later IS distinct, and the glyph survives the turn by the
   * other route: the acknowledgement is withdrawn and the brain's own is left standing.
   */
  claimed: Set<string>;
  /** Reaction requests this turn has issued that have not answered yet, by surface key. */
  reacting: Map<Promise<unknown>, string>;
}

/** What a turn hands the gateway: what the brain claimed, and the closer. */
export interface LiveTurnHandle {
  /** Native ids of the reactions the brain put on the message during the turn. */
  claimed: ReadonlySet<string>;
  /**
   * Resolves once every reaction this turn asked for **that could be `key`** has answered.
   *
   * An unanswered request for the same reaction is an unresolved claim: it may be for the
   * very one the acknowledgement is about to withdraw, and only what it returns can say.
   * Waiting turns that unknown into an answer.
   *
   * Keyed rather than waiting on all of them, because a request for a different reaction
   * can never claim this one — and a hung request that could not have claimed it is not a
   * reason to leave a "working" indicator on a channel forever. On a surface that spells
   * an emoji one way the key is exact; on one where it can be spelled two ways
   * `reactionKey` makes them agree.
   */
  settled(key: string): Promise<void>;
  close(): void;
}

export interface SurfaceEgressOptions {
  manifest: AgentManifest;
  adapters: SurfaceAdapter[];
}

/**
 * The one guarded path out of this agent onto a chat surface.
 *
 * Origin replies, explicit cross-surface posts and reactions all pass through this
 * object, so a new send path cannot accidentally skip the public-channel or allowlist
 * checks. A reaction belongs here for the reason `Gateway.signalWorking` already gives:
 * a courtesy signal is still egress, and must never appear in a channel the agent would
 * not be allowed to speak in.
 */
export class SurfaceEgress {
  private byKind = new Map<string, SurfaceAdapter>();
  /**
   * The message each channel is currently answering, and what the brain has put on it.
   *
   * This is what lets the reaction tool take an emoji and nothing else. The brain has no
   * id for the message it is replying to and should not be handed one — a message id it
   * could name is a message id it could get wrong, on someone else's post. What it does
   * know is that it is mid-turn, and the gateway knows which message that turn is for.
   */
  private answering = new Map<string, LiveTurn>();
  /** Posts made on a conversation's behalf, and where their answers go. See `links.ts`. */
  private links = new Links();

  constructor(private opts: SurfaceEgressOptions) {
    for (const adapter of opts.adapters) this.byKind.set(adapter.kind, adapter);
  }

  targets(): ChannelRef[] {
    return [...this.byKind.values()].flatMap((adapter) =>
      adapter.post && adapter.postTargets ? [...adapter.postTargets()] : [],
    );
  }

  /**
   * Whether a top-level post has anywhere to go: any configured channel at all.
   *
   * One surface is enough. This asked for two while the tool was thought of as
   * *cross*-posting, and that reading left a single-surface agent unable to post into its
   * own configured channel from a job — where there is no inbound turn to answer and so no
   * reply to do it instead. `post` never needed a second surface: `jobs[].report` has
   * always reached one through the same call, from an egress built on one adapter.
   */
  canPost(): boolean {
    return this.targets().length > 0;
  }

  /** Whether any surface here can carry a reaction at all. */
  canReact(): boolean {
    return [...this.byKind.values()].some((adapter) => adapter.react);
  }

  /**
   * The surfaces that answer at least one of the four reads.
   *
   * Any read, not all: a surface answers what it can, and a call to one it does not carry
   * is refused by name when it is made. Not derived from {@link targets}, which lists only
   * surfaces with a configured channel to post into — a DM-only Slack agent has none of
   * those and is a working agent, so naming it from there would tell the brain there was
   * nowhere to ask.
   */
  readableSurfaces(): string[] {
    return [...this.byKind.values()]
      .filter(
        (adapter) =>
          adapter.listChannels ||
          adapter.listMembers ||
          adapter.describeActor ||
          adapter.readChannel,
      )
      .map((adapter) => adapter.kind);
  }

  /** Whether hosting the read server is worth it at all. */
  canRead(): boolean {
    return this.readableSurfaces().length > 0;
  }

  /**
   * Records the message a turn is answering, and hands back what the turn needs of it.
   *
   * `close` must run on every exit path: an entry that outlives its turn is a stale target
   * the next `react` would land on. It removes only its own turn, so one that has already
   * been superseded in its channel cannot delete the live one.
   */
  answers(event: InboundEvent): LiveTurnHandle {
    const key = `${event.surface}:${event.channel.id}`;
    const turn: LiveTurn = { event, addressed: false, claimed: new Set(), reacting: new Map() };
    this.answering.set(key, turn);
    return {
      claimed: turn.claimed,
      // Snapshotted on call: a turn is over before anything waits on this, so nothing new
      // can join, and a rejected request is an answer like any other.
      settled: (wanted: string) =>
        Promise.allSettled(
          [...turn.reacting].filter(([, k]) => k === wanted).map(([call]) => call),
        ).then(() => {}),
      close: () => {
        if (this.answering.get(key) === turn) this.answering.delete(key);
      },
    };
  }

  /**
   * Who sent the message this agent is answering, when exactly one turn is live.
   *
   * The registry {@link react} reads, and the same ambiguity rule: a channel runs its turns
   * one at a time, so one live turn names its author exactly and two at once name nobody.
   * `null` rather than a guess — the job door reads it as automation, which is the safe
   * direction there.
   *
   * The author is the surface's, from an event this gateway received. Nothing the brain
   * says during the turn reaches it.
   */
  asking(): ActorRef | null {
    return this.answeringEvent()?.author ?? null;
  }

  /**
   * The message this agent is answering, when exactly one turn is live — the same rule as
   * {@link asking}, for a caller that will answer it after the turn is over.
   */
  answeringEvent(): InboundEvent | null {
    return this.liveTurn()?.event ?? null;
  }

  /**
   * The one turn in flight, or `null` when there is none or more than one.
   *
   * A channel runs its turns one at a time, so a single live turn is exact; two at once
   * cannot say which one a tool call belongs to, and ambiguity is refused rather than
   * guessed at by every caller here.
   */
  private liveTurn(): LiveTurn | null {
    const live = [...this.answering.values()];
    return live.length === 1 ? live[0] : null;
  }

  /**
   * Everyone this agent may address by name on `surface`: the principals the manifest
   * names, and whoever the surface itself can vouch for.
   *
   * A manifest id carries no surface — `owner` is "one id per surface for the same
   * person" — so it is offered on every surface, and the adapter's own validation refuses
   * the shape that does not belong there. A surface's roster is that surface's alone.
   */
  principals(surface: string): Principal[] {
    const { owner = [], allowlist = [] } = this.opts.manifest;
    const named = [...owner, ...allowlist].map((id) => ({ surface, id }));
    const roster = this.byKind.get(surface)?.principals?.() ?? new Map();
    return [...named, ...[...roster].map(([id, name]) => ({ surface, id, name }))];
  }

  /**
   * A top-level post on behalf of the live turn, addressed to one principal so they wake.
   *
   * The brain supplies who and what; the same resolution rule as `post` applies to who —
   * an id the manifest or the surface already knows, or a name that maps to exactly one —
   * and the adapter renders the address as its own primitive. Bound to the live turn for
   * the termination proof: one admitted message can wake one principal, and a call with no
   * turn behind it (a prompt still running after its timeout) can wake nobody.
   */
  async address(
    surface: string,
    channelId: string,
    msg: GuardedMessage,
    wanted: string,
  ): Promise<EventRef | undefined> {
    const turn = this.liveTurn();
    if (!turn) {
      throw new Error(
        "there is no single conversation mid-turn to address someone on behalf of, so " +
          "nobody can be woken",
      );
    }
    if (turn.addressed) {
      throw new Error("this turn has already addressed someone; one message wakes one principal");
    }
    const principal = resolvePrincipal(this.principals(surface), wanted);
    if (!principal) {
      throw new Error(
        "the mention names nobody this agent may address on that surface — an owner, an " +
          "allowlisted id, or an agent the surface lists — or a name shared by more than one",
      );
    }

    // Everything that can refuse with nothing on the wire happens before the reservation,
    // so a refusal stays the feedback it is meant to be. Then reserved before the send is
    // awaited — the hosted server handles calls concurrently, and two that both passed the
    // checks would both wake someone — and kept whatever the send does: a rejection from a
    // surface can come after the message is out, and a second wake is worse than a lost
    // retry.
    const target = this.admit(surface, channelId, msg);
    turn.addressed = true;
    const ref = await this.publish(target, msg, undefined, [principal.id]);
    // The resolved id, on its own line: the tool audit records what the brain asked for,
    // which may be a name, and the post line records how many were addressed.
    console.info(`addressed surface=${surface} channel=${channelId} principal=${principal.id}`);
    // Whatever the principal answers under this post comes home to the turn that asked. A
    // surface that named no id has nothing a reply could be under, so nothing is opened.
    if (ref) this.links.open(ref, turn.event, principal.id);
    return ref;
  }

  /** The link an inbound event answers, if it is one — see {@link Links.claim}. */
  claimLink(event: InboundEvent): Link | undefined {
    return this.links.claim(event);
  }

  /**
   * Brings an answer home: the addressed principal's line, attributed, into the
   * conversation that asked for it.
   *
   * Deterministic — no brain reads it, and the text is the reply verbatim under a label the
   * gateway wrote. It leaves as this agent's own message through the same guarded path a
   * reply takes: public consent and the leak scan on the *home* channel, and the adapter's
   * own escaping, so a mention inside the relayed text addresses nobody. Being the agent's
   * own, it can never wake the agent. Never throws: a relay that fails is a log line, and
   * whatever turn the same event may start is not its business.
   */
  async relayHome(link: Link, event: InboundEvent): Promise<void> {
    const { home } = link;
    const from = `${event.surface}:${event.channel.id}`;
    const at = `${home.surface}:${home.channel.id}`;
    const source = this.byKind.get(event.surface);
    const who = source?.displayName?.(event.author.id) ?? event.author.id;
    const channel =
      source?.postTargets?.().find((target) => target.id === event.channel.id)?.name ??
      event.channel.id;
    const text = `${who} (${event.surface} · ${channel}): ${event.text}`;
    try {
      const verdict = await this.replyTo(home, { text });
      if (!verdict.ok) {
        console.warn(
          `relay from=${from} home=${at} result=refused rule=${verdict.rule} ` +
            `reason="${verdict.reason}"`,
        );
        return;
      }
      console.info(`relay from=${from} home=${at} result=sent`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown";
      console.warn(`relay from=${from} home=${at} result=failed reason="${reason}"`);
    }
  }

  /**
   * Puts the brain's chosen glyph on the message it is answering.
   *
   * Resolution, not trust — the same rule `resolveTarget` follows. The brain supplies the
   * emoji; every other part of the target comes from an event this gateway received.
   *
   * A channel runs its turns one at a time, so "the message being answered" is exact for
   * as long as only one channel is mid-turn. Two at once is ambiguous, and ambiguity is
   * refused rather than guessed at: the glyph is a convenience, and putting it on the
   * wrong person's message is worse than not putting it anywhere.
   */
  async react(emoji: string): Promise<InboundEvent> {
    const live = [...this.answering.values()];
    if (!live.length) {
      throw new Error(
        "there is no message to react to — this tool marks the one you are answering",
      );
    }
    if (live.length > 1) {
      throw new Error(
        "more than one conversation is mid-turn, so which message to mark is ambiguous: " +
          live.map(({ event }) => `${event.surface}:${event.channel.id}`).join(", "),
      );
    }

    const [turn] = live;
    const { event } = turn;
    const adapter = this.byKind.get(event.surface);
    if (!adapter?.react) throw new Error(`${event.surface} does not support reactions`);

    // A reaction gets exactly the reach a reply would: same destination, same rules, and
    // the emoji scanned as the text it is. The acknowledgement is checked on empty text
    // because the operator wrote that glyph into the manifest; this one is chosen inside a
    // turn that has read untrusted channel content, so it is caller-controlled text on the
    // way out of the agent — which is the whole thing `leakPatterns` exists to read. Sixty
    // four characters is plenty of room for a token, and "it is only an emoji" is a
    // property of a well-behaved brain rather than of this input.
    const verdict = this.evaluate({ text: emoji }, event.channel);
    if (!verdict.ok) {
      console.warn(
        `react surface=${event.surface} channel=${event.channel.id} result=refused ` +
          `rule=${verdict.rule} reason="${verdict.reason}"`,
      );
      throw new Error(`reaction refused by ${verdict.rule}: ${verdict.reason}`);
    }

    // Always published, never skipped on a belief that it is already there. What a repeat
    // means is the surface's to decide and differs between them — Slack has one reaction
    // per identity and answers `already_reacted`, while a Buzz reaction re-signed a second
    // later is a second event standing beside the first — so the honest way to find out
    // what is on the message is to ask for it and read what comes back.
    // Registered around the call, not after it. A turn can end while this is in flight, and
    // the gateway has to be able to tell "the brain claimed nothing" from "the brain asked
    // for something and the surface has not said what yet" — the second is worth waiting
    // out, because what comes back decides whether the acknowledgement may be withdrawn.
    const call = adapter.react(event, emoji);
    turn.reacting.set(call, adapter.reactionKey?.(emoji) ?? emoji);
    let reaction;
    try {
      reaction = await call;
    } finally {
      turn.reacting.delete(call);
    }
    // Nothing back means nothing is there: the surface is down, or this is not a message it
    // serves. Reporting a reaction here would have the brain tell the channel it signalled
    // something it did not. A reaction that was already there is a different answer and a
    // true one — the glyph the brain asked for is on the message.
    if (!reaction) {
      throw new Error(`${event.surface} did not accept the reaction`);
    }

    // Claimed by ref, which is what makes this hold across a surface's own spellings: the
    // acknowledgement's `👀` and a brain asking Slack for `eyes` are one reaction and come
    // back as one ref, so the turn's end leaves standing what the brain was asked to put
    // there rather than withdrawing "the acknowledgement" out from under it.
    turn.claimed.add(reaction.ref.nativeId);
    console.info(`react surface=${event.surface} channel=${event.channel.id} result=sent`);
    return event;
  }

  async reply(
    adapter: SurfaceAdapter,
    event: InboundEvent,
    msg: GuardedMessage,
  ): Promise<GuardVerdict> {
    const verdict = this.evaluate(msg, event.channel);
    if (!verdict.ok) return verdict;
    await adapter.send(event.channel, msg, event);
    return verdict;
  }

  /** {@link reply}, for a caller that holds the event and not the adapter it came through. */
  async replyTo(event: InboundEvent, msg: GuardedMessage): Promise<GuardVerdict> {
    const adapter = this.byKind.get(event.surface);
    if (!adapter) throw new Error(`no ${event.surface} surface to reply on`);
    return this.reply(adapter, event, msg);
  }

  /**
   * A message with no inbound context: the brain's explicit post, and a job's
   * status post. `threadRoot` threads the second kind under its own headline — the brain
   * has no way to name one, since the tool takes a surface, a channel, and text.
   *
   * `mentions` is the same shape of argument and reaches here from the same one caller: a
   * probing job's `post_message`, which is the only kind of post that has to wake somebody.
   * The brain's tool cannot reach it either — `PostArgs` has no such field.
   */
  async post(
    surface: string,
    channelId: string,
    msg: GuardedMessage,
    threadRoot?: EventRef,
    mentions?: readonly string[],
  ): Promise<EventRef | undefined> {
    return this.publish(this.admit(surface, channelId, msg), msg, threadRoot, mentions);
  }

  /**
   * Everything a post decides before anything is sent: the adapter, the configured channel
   * the request resolves to, and the guard's verdict on it. Throws with nothing on the wire.
   */
  private admit(surface: string, channelId: string, msg: GuardedMessage): PostTarget {
    const adapter = this.byKind.get(surface);
    if (!adapter?.post || !adapter.postTargets) {
      throw new Error("the target surface does not support top-level posts");
    }

    const channel = resolveTarget(adapter.postTargets(), surface, channelId);
    // Says both things it could mean, because the brain can act on the difference: an
    // unknown channel needs a different destination, an ambiguous name needs an id.
    if (!channel) {
      throw new Error(
        "the target channel is not configured as a post target, or its name belongs to " +
          "more than one — name it by id",
      );
    }

    const verdict = this.evaluate(msg, channel);
    if (!verdict.ok) {
      // A refusal is audited on the same line as a send, because this is the path that
      // reaches channels the agent was not invoked from — and a `leakPatterns` refusal the
      // operator never sees is a near-miss nobody learns from. The reason names the
      // patterns that fired and never what they matched.
      console.warn(
        `post_message surface=${surface} channel=${channel.id} result=refused ` +
          `rule=${verdict.rule} reason="${verdict.reason}"`,
      );
      throw new Error(`post refused by ${verdict.rule}: ${verdict.reason}`);
    }
    return { adapter, channel };
  }

  /**
   * The send itself, after {@link admit}. A rejection from here is ambiguous — the surface
   * may have taken the message before it failed — which is why nothing that reserves on a
   * post gives the reservation back on this path.
   */
  private async publish(
    { adapter, channel }: PostTarget,
    msg: GuardedMessage,
    threadRoot?: EventRef,
    mentions?: readonly string[],
  ): Promise<EventRef | undefined> {
    const ref = await adapter.post!(channel, msg, threadRoot, mentions);
    // The resolved id, not what was asked for: the audit line has to say where the
    // message went, and those are now two different strings. The recipient *count* and not
    // the ids: how many were addressed is what separates a roll call that found silence
    // from one that woke nobody, and a list would grow this line with the fleet.
    const addressed = mentions?.length ? ` mentions=${mentions.length}` : "";
    console.info(
      `post_message surface=${channel.surface} channel=${channel.id}${addressed} result=sent`,
    );
    return ref;
  }

  /**
   * Reads back the replies beneath a root one of these adapters posted.
   *
   * Inbound, on the outbound chokepoint, and here anyway: this object is what holds the
   * adapters and what both job doors already bind, so putting the read anywhere else means
   * a second place that owns a surface list. There is no guard call because there is
   * nothing outbound to rule on — the guard reads what this agent says, and this is what
   * somebody else said.
   *
   * The root's own `surface` picks the adapter, so a caller cannot read a Buzz thread by
   * naming Slack. **Whether the caller was entitled to that root is not decided here**;
   * see {@link SurfaceAdapter.readThread}.
   *
   * A surface with no thread model throws rather than answering `[]`. "Nobody replied" and
   * "this surface cannot tell you" are different findings, and a probe that could not tell
   * them apart would mint a verdict naming everyone silent.
   */
  async readThread(root: EventRef, limit?: number): Promise<readonly ThreadReply[]> {
    const adapter = this.byKind.get(root.surface);
    if (!adapter?.readThread) {
      throw new Error(
        `the ${root.surface} surface cannot read a thread back, so nothing here can say ` +
          "whether anyone replied",
      );
    }
    return adapter.readThread(root, limit);
  }

  /**
   * Channels the surface itself reports this agent as a member of.
   *
   * The one read that is not scoped to a configured channel, because the answer worth
   * having is where the two lists differ: a channel configured and never joined is an
   * agent nobody can reach, and no signal anywhere else says so.
   */
  async listChannels(surface: string): Promise<readonly ChannelRef[]> {
    const adapter = this.byKind.get(surface);
    if (!adapter?.listChannels) throw cannotRead(surface, "say which channels this agent is in");
    return adapter.listChannels();
  }

  /** Who is in one configured channel. See {@link SurfaceAdapter.listMembers}. */
  async listMembers(
    surface: string,
    channelId: string,
    limit?: number,
  ): Promise<readonly ActorRef[]> {
    const adapter = this.byKind.get(surface);
    if (!adapter?.listMembers) throw cannotRead(surface, "say who is in a channel");
    return adapter.listMembers(this.readTarget(adapter, surface, channelId), limit);
  }

  /** One actor by id. `undefined` is "not known here", never "cannot look anyone up". */
  async describeActor(surface: string, id: string): Promise<ActorRef | undefined> {
    const adapter = this.byKind.get(surface);
    if (!adapter?.describeActor) throw cannotRead(surface, "look an id up");
    return adapter.describeActor(id);
  }

  /** Recent messages in one configured channel. See {@link SurfaceAdapter.readChannel}. */
  async readChannel(
    surface: string,
    channelId: string,
    limit?: number,
  ): Promise<readonly ThreadReply[]> {
    const adapter = this.byKind.get(surface);
    if (!adapter?.readChannel) throw cannotRead(surface, "read a channel back");
    return adapter.readChannel(this.readTarget(adapter, surface, channelId), limit);
  }

  /**
   * The configured channel a read names — {@link admit}'s resolution without its guard.
   *
   * The guard rules on what this agent says, and a read says nothing. What survives is the
   * destination check: a channel read is bounded to the channels an operator configured,
   * so nothing the brain computes can point a read at a conversation the agent does not
   * serve. {@link listChannels} is deliberately outside that bound: what it is for is the
   * channel that is *not* configured, or configured and not joined.
   */
  private readTarget(adapter: SurfaceAdapter, surface: string, channelId: string): ChannelRef {
    const channel = resolveTarget(adapter.postTargets?.() ?? [], surface, channelId);
    if (!channel) {
      throw new Error(
        "that channel is not one this agent is configured for, or its name belongs to " +
          "more than one — name it by id",
      );
    }
    return channel;
  }

  private evaluate(msg: GuardedMessage, channel: ChannelRef): GuardVerdict {
    return evaluateEgress(msg, channel, this.opts.manifest.guard);
  }
}

/**
 * One refusal for every surface read, worded once.
 *
 * Never an empty answer, which is the rule {@link SurfaceAdapter.listChannels} states and
 * {@link SurfaceEgress.readThread} already keeps: a caller handed `[]` reports an empty
 * channel, and a caller told the surface cannot say reports that instead.
 */
function cannotRead(surface: string, question: string): Error {
  return new Error(`the ${surface} surface cannot ${question}, so nothing here can`);
}

/**
 * The configured channel a request names, by id or by display name.
 *
 * Resolution, not trust: whatever the brain passes is only ever used to *select* from
 * configured targets, and the `ChannelRef` that comes back is the adapter's own. Ids win
 * over names so a name that collides with some other channel's id cannot redirect a post,
 * and an ambiguous name resolves to nothing rather than to a guess — picking one of two
 * channels called "general" is exactly the mistake worth failing on.
 */
export function resolveTarget(
  targets: readonly ChannelRef[],
  surface: string,
  wanted: string,
): ChannelRef | undefined {
  const onSurface = targets.filter((target) => target.surface === surface);
  const byId = onSurface.find((target) => target.id === wanted);
  if (byId) return byId;

  const fold = (value: string) => value.trim().toLowerCase();
  const named = onSurface.filter((target) => target.name && fold(target.name) === fold(wanted));
  return named.length === 1 ? named[0] : undefined;
}

/** What {@link SurfaceEgress.admit} hands to the send: the adapter and its own channel ref. */
interface PostTarget {
  adapter: SurfaceAdapter;
  channel: ChannelRef;
}

/** Someone this agent may address: an id on a surface, and the name people use for it. */
export interface Principal {
  surface: string;
  id: string;
  name?: string;
}

/**
 * The principal a request names, by id or by display name — `resolveTarget`'s rule.
 *
 * Ids win over names so a name that collides with someone's id cannot redirect a page, and
 * an ambiguous name resolves to nothing: waking the wrong one of two agents called "ida"
 * is exactly the mistake worth failing on.
 */
export function resolvePrincipal(
  principals: readonly Principal[],
  wanted: string,
): Principal | undefined {
  const byId = principals.find((principal) => principal.id === wanted);
  if (byId) return byId;

  const fold = (value: string) => value.trim().toLowerCase();
  const named = principals.filter((p) => p.name && fold(p.name) === fold(wanted));
  return named.length === 1 ? named[0] : undefined;
}

const PostArgs = z.object({
  surface: z.string().min(1),
  channel: z.string().min(1),
  text: z.string().min(1),
  /**
   * One principal, never a list: a message wakes one person or agent (design spec §8, a
   * handoff names at most one downstream agent). A roll call that addresses a roster is a
   * job's capability, with its own bound, and stays `mentions` on the job channel.
   */
  mention: z.string().min(1).optional(),
});

/**
 * A glyph, and a bound that keeps it a glyph's worth of text.
 *
 * The bound is not what makes this safe — no length stops a token, and no character class
 * separates one from a Slack emoji name, which is ASCII either way. The guard is what
 * makes it safe, and `SurfaceEgress.react` runs it over this value. What the cap does is
 * keep a reaction from becoming a way to publish a paragraph into a channel, and keep one
 * audit line from carrying one.
 */
const ReactArgs = z.object({ emoji: z.string().min(1).max(64) });

function postTool(egress: SurfaceEgress) {
  // Named as `surface:id (name)` so a request phrased the way people actually phrase one
  // — "post that in hive" — has something here to match, without hiding the id the guard
  // and the audit log speak in.
  const targets = egress
    .targets()
    .map((target) => `${target.surface}:${target.id}${target.name ? ` (${target.name})` : ""}`)
    .join(", ");
  // Only the ones a surface can put a name to. A manifest id is listed by nobody here: the
  // brain reads it off the `from …` line of the message it is answering, which is the
  // case that matters — the person asking to be reached.
  const addressable = [...new Set(egress.targets().map((target) => target.surface))]
    .flatMap((surface) => egress.principals(surface))
    .filter((principal) => principal.name)
    .map((principal) => `${principal.surface}:${principal.id} (${principal.name})`)
    .join(", ");
  return {
    name: POST_MESSAGE,
    description:
      "Post a new top-level message into one of this agent's configured chat channels, " +
      "only when the user explicitly asks you to post or relay something there. Your normal " +
      "response is already sent back to the conversation that invoked you, so never use this " +
      "tool for an ordinary reply — including when the target is the channel you are already " +
      `answering in. Configured targets: ${targets || "none"}. ` +
      "A post wakes nobody unless `mention` names one person or agent; use it only when the " +
      "asker wants that principal reached. Besides the ids on the `from` line of messages " +
      `you answer, you may address: ${addressable || "no one by name"}.`,
    inputSchema: {
      type: "object",
      properties: {
        surface: { type: "string", description: "Target surface, for example buzz or slack" },
        channel: {
          type: "string",
          description: "Configured target channel — its id, or the name shown beside it",
        },
        text: { type: "string", description: "Exact message to post" },
        mention: {
          type: "string",
          description:
            "One principal to wake with this post — their id as it appears on a `from` " +
            "line, or a name listed above. Omit it for a post that wakes nobody.",
        },
      },
      required: ["surface", "channel", "text"],
    },
  };
}

const reactTool = {
  name: REACT,
  description:
    "Put one emoji on the message you are answering, when you are asked to signal " +
    "something with a reaction. It marks that one message and nothing else, it is never a " +
    "reply, and it never replaces one: answer in your normal response as well.",
  inputSchema: {
    type: "object",
    properties: {
      emoji: {
        type: "string",
        description:
          "The single emoji to put on the message — the character, or the name the " +
          "surface knows it by",
      },
    },
    required: ["emoji"],
  },
};

/** This server's JSON-RPC handler. Exported so the behaviour is testable. */
export function surfaceEgressHandler(
  egress: SurfaceEgress,
  policy: ToolPolicy,
  serve: SurfaceEgressTools,
): McpHandler {
  return mcpToolServer({
    name: SURFACE_EGRESS_SERVER,
    tools: () => [
      ...(serve.postMessage ? [postTool(egress)] : []),
      ...(serve.react ? [reactTool] : []),
    ],
    // Where it posted, never what it said: the destination is the accountability question
    // and `text` is a message the guard has already ruled on. See `tool-audit.ts`.
    //
    // `mention` is undeclared for the reason `emoji` is below: it is a string the brain
    // chose, and a refused call is audited as readily as an allowed one, so declaring it
    // would put whatever a turn was talked into passing on this line. Whom a post actually
    // woke is the resolved id on the `addressed …` line, which only an allowed call writes.
    //
    // `emoji` is undeclared for the same reason `text` is. It reads like a glyph and is
    // typed as free text the brain chose, so declaring it would put whatever a turn was
    // talked into sending on this line — on the way to refusing it, too, since a refused
    // call is audited as readily as an allowed one. Which reaction went where is on the
    // `react surface=… channel=…` line, and in the channel.
    audit: { [POST_MESSAGE]: ["surface", "channel"] },
    call: async (tool, args) => {
      if (tool === REACT) {
        const allowed = policy.allowsTool(SURFACE_REACT_TOOL);
        if (!allowed.ok) throw new ToolRefused(`reaction tool refused: ${allowed.reason}`);
        const { emoji } = ReactArgs.parse(args);
        const event = await egress.react(emoji);
        const where = `${event.surface}:${event.channel.id}`;
        return `Reacted ${emoji} on the message you are answering in ${where}.`;
      }
      if (tool !== POST_MESSAGE) throw new Error(`unknown tool ${tool}`);
      const allowed = policy.allowsTool(SURFACE_EGRESS_TOOL);
      if (!allowed.ok) throw new ToolRefused(`post tool refused: ${allowed.reason}`);
      const post = PostArgs.parse(args);
      if (post.mention === undefined) {
        await egress.post(post.surface, post.channel, { text: post.text });
        return `Posted to ${post.surface}:${post.channel}.`;
      }
      await egress.address(post.surface, post.channel, { text: post.text }, post.mention);
      return `Posted to ${post.surface}:${post.channel}, addressed to ${post.mention}.`;
    },
  });
}

export function serveSurfaceEgress(
  egress: SurfaceEgress,
  policy: ToolPolicy,
  serve: SurfaceEgressTools,
  opts: ServeOptions = {},
): Promise<HostedMcp> {
  return serveMcp(surfaceEgressHandler(egress, policy, serve), opts);
}
