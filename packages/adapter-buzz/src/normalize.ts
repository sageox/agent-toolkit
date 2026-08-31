import type { Event, EventTemplate } from "nostr-tools/pure";
import type {
  ActorRef,
  InboundEvent,
  GuardedMessage,
  ThreadReply,
} from "@sageox/agent-toolkit-core";

/**
 * The relay conventions this adapter implements, pinned in one place.
 *
 * Standard NIPs are stable but relay *extensions* drift, so these are options with
 * documented defaults rather than constants scattered through the code — a convention
 * change is a config change, not a rewrite.
 */
export const BUZZ_DEFAULTS = {
  kind: 9,
  channelTag: "h",
  mentionTag: "p",
  replyTag: "e",
  unknownChannel: "unknown",
  /** NIP-25 reaction. */
  reactionKind: 7,
  /** Buzz's ephemeral typing indicator, as built by buzz-acp. */
  typingKind: 20002,
  /** NIP-09 deletion. */
  deletionKind: 5,
} as const;

/** A NIP-25 reaction on the triggering message. */
export function toReactionTemplate(target: InboundEvent, emoji: string): EventTemplate {
  return {
    kind: BUZZ_DEFAULTS.reactionKind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      [BUZZ_DEFAULTS.channelTag, target.channel.id],
      [BUZZ_DEFAULTS.replyTag, target.id.nativeId],
      [BUZZ_DEFAULTS.mentionTag, target.author.id],
    ],
    content: emoji,
  };
}

/** NIP-09 deletion of our own reaction — how a 👀 is taken back once the reply lands. */
export function toReactionRemovalTemplate(reactionEventId: string): EventTemplate {
  return {
    kind: BUZZ_DEFAULTS.deletionKind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [[BUZZ_DEFAULTS.replyTag, reactionEventId]],
    content: "",
  };
}

/**
 * The ephemeral "working on it" indicator.
 *
 * Kind 20002 is in Nostr's ephemeral range, so relays do not store it — which is why it
 * has to be refreshed while a turn runs rather than sent once.
 */
export function toTypingTemplate(channelId: string, replyTo?: string): EventTemplate {
  // Thread-scope it only when the triggering message was itself in a thread. A
  // top-level post gets a channel-only indicator — that is what renders at the bottom of
  // the channel rather than inside a thread nobody has open.
  const tags: string[][] = [[BUZZ_DEFAULTS.channelTag, channelId]];
  if (replyTo) tags.push([BUZZ_DEFAULTS.replyTag, replyTo, "", "reply"]);
  return { kind: BUZZ_DEFAULTS.typingKind, created_at: Math.floor(Date.now() / 1000), tags, content: "" };
}

export const SURFACE = "buzz";

export interface NormalizeOptions {
  /** The agent's own pubkey — the mention target and the self-authorship check. */
  pubkey: string;
  /** Channels listed `reply: private`. Anything else is public, so the guard fails closed. */
  privateChannels?: ReadonlySet<string>;
}

function firstTag(event: Event, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** Who signed an event, as core names an actor. */
function toActorRef(event: Event, pubkey: string): ActorRef {
  return {
    surface: SURFACE,
    id: event.pubkey,
    isSelf: event.pubkey === pubkey,
    // Recognising *other* agents needs a roster the relay can give us; until then this
    // is only ever true for ourselves, so the chain-depth cap protects against a
    // self-loop but not yet against an agent-to-agent one (§8 rule 4).
    isAgent: event.pubkey === pubkey,
  };
}

/**
 * One reply read back from a thread, carrying who spoke, what they said, and when.
 *
 * Not an `InboundEvent`, and the missing fields are the reason: a reply found by asking
 * for it was not delivered to a subscription, did not wake anything, and has no honest
 * `mentionsMe` — the reader went looking. See {@link ThreadReply}, and note that `text`
 * is untrusted channel content.
 */
export function toThreadReply(event: Event, opts: NormalizeOptions): ThreadReply {
  return {
    author: toActorRef(event, opts.pubkey),
    text: event.content,
    ts: new Date(event.created_at * 1000).toISOString(),
  };
}

export function toInboundEvent(event: Event, opts: NormalizeOptions): InboundEvent {
  const channelId = firstTag(event, BUZZ_DEFAULTS.channelTag) ?? BUZZ_DEFAULTS.unknownChannel;
  const mentions = event.tags.filter((t) => t[0] === BUZZ_DEFAULTS.mentionTag).map((t) => t[1]);

  return {
    id: { surface: SURFACE, nativeId: event.id },
    surface: SURFACE,
    channel: {
      surface: SURFACE,
      id: channelId,
      // Unknown means public: the guard must fail closed on a channel we cannot vouch for.
      isPublic: opts.privateChannels?.has(channelId) !== true,
    },
    author: toActorRef(event, opts.pubkey),
    text: event.content,
    mentionsMe: mentions.includes(opts.pubkey),
    threadRoot: threadRootOf(event),
    ts: new Date(event.created_at * 1000).toISOString(),
    raw: event,
  };
}

/**
 * The root of the thread this event sits in, or undefined when it is top-level.
 *
 * Mirrors the relay's own ancestry rule: an explicit `root` marker wins, otherwise a
 * `reply` marker is treated as the root — that is what a first-level reply looks like.
 * Getting this wrong is not cosmetic: a reply whose root tag disagrees with the thread's
 * real ancestry is refused with "root tag does not match thread ancestry".
 */
function threadRootOf(event: Event): InboundEvent["threadRoot"] {
  const marked = (marker: string) =>
    event.tags.find((t) => t[0] === BUZZ_DEFAULTS.replyTag && t[3] === marker)?.[1];
  const root = marked("root") ?? marked("reply");
  return root ? { surface: SURFACE, nativeId: root } : undefined;
}

/**
 * Builds the unsigned reply. It carries exactly the tags a threaded reply needs — the
 * escalation vectors this surface has (broadcast, bulk mention, attachment) are tags,
 * and none of them are representable here.
 */
export function toReplyTemplate(msg: GuardedMessage, inReplyTo: InboundEvent): EventTemplate {
  // Where a reply lands is the harness's decision, not the brain's: the thread's root
  // when the message is already threaded, otherwise the triggering message itself. This
  // is upstream's `resolve_reply_anchor`, and it keeps threads FLAT — anchoring to the
  // parent instead nests a new sub-thread under every answer.
  const anchor = inReplyTo.threadRoot?.nativeId ?? inReplyTo.id.nativeId;

  return {
    kind: BUZZ_DEFAULTS.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      [BUZZ_DEFAULTS.channelTag, inReplyTo.channel.id],
      // The anchor is the root of its own thread, so root and parent coincide: a single
      // marked tag is both correct and what the relay's ancestry check expects.
      [BUZZ_DEFAULTS.replyTag, anchor, "", "reply"],
      [BUZZ_DEFAULTS.mentionTag, inReplyTo.author.id],
    ],
    content: msg.text,
  };
}

/**
 * A new channel post, carrying no invented reply context and no mention the caller did not
 * ask for.
 *
 * `threadRoot` is context this adapter handed back from a post of its own — never an id
 * read off an inbound message, which is what `toReplyTemplate` is for. A headline and the
 * detail beneath it are addressed to a channel and get no `p` tag, which is why a status
 * post pings nobody.
 *
 * `mentions` is the exception, and it is the only way a post wakes anyone: a `p` tag is the
 * wake trigger this relay convention has (`toInboundEvent` reads `mentionsMe` off exactly
 * these), so a probe that must be answered addresses its roster and a status line still
 * does not. The pubkeys are hex, already normalised by the caller — `p` on a name is a tag
 * no agent matches itself against.
 */
export function toChannelPostTemplate(
  msg: GuardedMessage,
  channelId: string,
  threadRoot?: string,
  mentions: readonly string[] = [],
): EventTemplate {
  const tags: string[][] = [[BUZZ_DEFAULTS.channelTag, channelId]];
  // The root of its own thread, so root and parent coincide — the same single marked tag
  // `toReplyTemplate` uses, and the same flatness: detail sits one level under the
  // headline rather than nesting beneath whichever detail line came before it.
  if (threadRoot) tags.push([BUZZ_DEFAULTS.replyTag, threadRoot, "", "reply"]);
  for (const pubkey of mentions) tags.push([BUZZ_DEFAULTS.mentionTag, pubkey]);

  return {
    kind: BUZZ_DEFAULTS.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: msg.text,
  };
}
