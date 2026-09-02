import type { InboundEvent } from "@sageox/agent-toolkit-core";

export const SLACK_SURFACE = "slack";

/** The small, stable subset shared by Events API messages and history results. */
export interface SlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  /** Set on a thread parent in history results, so a backfill knows the thread moved. */
  latest_reply?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface SlackNormalizeOptions {
  botUserId: string;
  botId?: string;
  /** Channels asserted private by configuration or a successful conversations.info call. */
  privateChannels?: ReadonlySet<string>;
  /**
   * Channels Slack reported public, which outranks every heuristic below.
   *
   * Only an explicit `is_private: false` belongs here. An ID prefix is a guess — Slack
   * Connect and shared channels do not follow one — so a guess must never survive an
   * answer, or the egress guard is deciding on the wrong fact.
   */
  publicChannels?: ReadonlySet<string>;
  /**
   * Member id to the name a person reads, for rendering the mentions in a message.
   *
   * Passed in rather than looked up, so this stays a pure function: resolving a name is a
   * network call, and the adapter is what owns the cache and the ordering. An id missing
   * from the map renders as itself, which is what every mention did before there was a map.
   */
  memberNames?: ReadonlyMap<string, string>;
}

/**
 * A member mention, as Slack writes it in message text: `<@U0ALICE>`, or `<@U0ALICE|alice>`
 * where an older client supplied the label. Also matches the bot's own id, which
 * {@link normalizeSlackText} strips before this runs.
 */
export const SLACK_MENTION = /<@([UWB][A-Z0-9]+)(?:\|([^>]*))?>/g;

/** Every member a message mentions, which is what the adapter has to resolve names for. */
export function slackMentionedMembers(text: string): string[] {
  return [...text.matchAll(SLACK_MENTION)].map((match) => match[1]);
}

const MESSAGE_SUBTYPES = new Set([undefined, "bot_message", "file_share", "me_message", "thread_broadcast"]);

/**
 * Maps a native Slack event to the transport-neutral event model.
 *
 * Edits, deletes, joins, and other message-shaped notices are deliberately ignored. Feeding
 * their synthesized text to a brain would make metadata look like a user request.
 */
export function toSlackInboundEvent(
  message: SlackMessage,
  opts: SlackNormalizeOptions,
): InboundEvent | undefined {
  if (message.type !== "message" && message.type !== "app_mention") return undefined;
  if (!MESSAGE_SUBTYPES.has(message.subtype) || message.hidden) return undefined;
  if (!message.channel || !message.ts || typeof message.text !== "string") return undefined;

  const authorId = message.user ?? message.bot_id;
  if (!authorId) return undefined;

  const direct = isDirectSlackChannel(message);
  const mention = new RegExp(`<@${escapeRegExp(opts.botUserId)}(?:\\|[^>]+)?>`).test(message.text);
  // A DM is structurally private, so nothing outranks it. Everything after is inference —
  // channel_type, the ID prefix, a configured assertion — and Slack saying "public" beats
  // all of it. Without this, a public G-prefixed channel is normalized private and
  // the guard never sees a public channel to refuse.
  const confirmedPublic = opts.publicChannels?.has(message.channel) === true;
  const privateChannel =
    direct ||
    (!confirmedPublic &&
      (message.channel_type === "group" ||
        message.channel_type === "mpim" ||
        message.channel.startsWith("G") ||
        opts.privateChannels?.has(message.channel) === true));
  const root = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined;
  let timestamp: string;
  try {
    timestamp = slackTimestampToIso(message.ts);
  } catch {
    return undefined;
  }

  return {
    // Slack timestamps are unique only within a conversation. Qualifying them here keeps
    // EventRef opaque and globally unambiguous within the Slack surface.
    id: { surface: SLACK_SURFACE, nativeId: slackEventId(message.channel, message.ts) },
    surface: SLACK_SURFACE,
    channel: {
      surface: SLACK_SURFACE,
      id: message.channel,
      // Unknown Slack channels fail closed as public. A C-prefixed private Slack Connect
      // channel is private only after conversations.info or explicit configuration says so.
      isPublic: !privateChannel,
    },
    author: {
      surface: SLACK_SURFACE,
      id: authorId,
      isSelf: authorId === opts.botUserId || (!!opts.botId && message.bot_id === opts.botId),
      isAgent: !!message.bot_id || authorId === opts.botUserId,
    },
    text: normalizeSlackText(message.text, opts.botUserId, opts.memberNames),
    // A DM is itself a direct address; requiring an @mention inside it makes normal DMs deaf.
    mentionsMe: direct || mention || message.type === "app_mention",
    ...(root
      ? { threadRoot: { surface: SLACK_SURFACE, nativeId: slackEventId(message.channel, root) } }
      : {}),
    ts: timestamp,
    raw: message,
  };
}

/**
 * A 1:1 DM. Decides both privacy and whether a mention is needed, and the adapter admits
 * DMs on it too — so it lives here once rather than being restated per call site.
 * `channel_type` is set on socket events; the ID prefix covers history results.
 */
export function isDirectSlackChannel(message: SlackMessage): boolean {
  return message.channel_type === "im" || !!message.channel?.startsWith("D");
}

export function slackEventId(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

export function parseSlackEventId(nativeId: string): { channel: string; ts: string } {
  const separator = nativeId.indexOf(":");
  if (separator <= 0 || separator === nativeId.length - 1) {
    throw new Error(`invalid Slack event reference: ${nativeId}`);
  }
  return { channel: nativeId.slice(0, separator), ts: nativeId.slice(separator + 1) };
}

/** Slack's three XML entities are the only ones its message text escapes. */
function normalizeSlackText(
  text: string,
  botUserId: string,
  memberNames?: ReadonlyMap<string, string>,
): string {
  const withoutMention = text.replace(
    new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]+)?>`, "g"),
    "",
  );
  // Everyone else stays, named: `<@U0ALICE>` tells a brain somebody was addressed and not
  // who. The directory outranks the label, which is whatever the sending client embedded
  // and disagrees after a rename; the label beats a bare id, and a bare id still reads as
  // a mention rather than vanishing. `@name` is text, not markup, so quoting it addresses
  // nobody — the property `outboundText` keeps by escaping.
  const named = withoutMention.replace(
    SLACK_MENTION,
    (_whole, id: string, label?: string) => `@${memberNames?.get(id) || label || id}`,
  );
  return named
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
}

function slackTimestampToIso(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) throw new Error(`invalid Slack timestamp: ${ts}`);
  return new Date(seconds * 1000).toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
