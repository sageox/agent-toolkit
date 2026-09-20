import { z } from "zod";
import type { ChannelHistory } from "./events.ts";
import type { SealedTick } from "./gateway.ts";
import { JOB_OUTPUT_LIMIT_BYTES } from "./job-output.ts";
import type { JobSource } from "./manifest.ts";
import { channelLine } from "./surface-read.ts";

/**
 * The answer a prompt job with a `source` owes: lines about the messages the host read,
 * each citing the messages it is about.
 *
 * The toolkit owns this shape because it is what lets the host check an answer against the
 * read before anything is posted — which messages exist, who wrote them, which links they
 * carry. The words in it are the job's.
 */

const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 500;

const Digest = z.strictObject({
  items: z
    .array(
      z.strictObject({
        text: z.string().trim().min(1).max(MAX_ITEM_CHARS).regex(/^[^\r\n]*$/),
        refs: z.array(z.number().int().min(1)).min(1),
      }),
    )
    .min(1)
    .max(MAX_ITEMS),
});

/** A URL with a scheme, a `mailto:` or a `www.` address, up to Slack's `<url|label>` marks. */
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>|]+/gi;

/** The links in `text`, less the punctuation a sentence puts after one. */
function links(text: string): string[] {
  return (text.match(LINK) ?? []).map((link) => link.replace(/[.,;:!?)\]}'"]+$/, ""));
}

/** The read as the brain is handed it: one JSON object per message, `ref` counting from 1. */
export function digestData(history: ChannelHistory, maxTextChars?: number): string {
  return history.messages
    .map((message, index) =>
      JSON.stringify({ ref: index + 1, ...channelLine(message, maxTextChars) }),
    )
    .join("\n");
}

/** The sealed turn's brief: the job's words, then the shape its answer is checked against. */
export function digestBrief(prompt: string, source: JobSource, history: ChannelHistory): string {
  return [
    prompt,
    "",
    `The fenced data below is the ${history.messages.length} messages read from ` +
      `${source.surface} channel ${source.channel} for the last ${source.withinHours} hours, ` +
      "oldest first, one JSON object per line.",
    ...(history.more
      ? [
          "The window held more messages than were read, and these are only the most recent. " +
            "Do not describe anyone as quiet or absent: the messages that would say otherwise " +
            "were not read.",
        ]
      : []),
    'Answer with one JSON object and nothing else: {"items": [{"text": "…", "refs": [1, 2]}]}.',
    `Each item becomes one line of the post. \`text\` is one line of at most ${MAX_ITEM_CHARS} ` +
      "characters, and `refs` lists the `ref` of every message the line is about — at least " +
      "one, so there is no line about someone who posted nothing. The line is credited to the " +
      "authors of the messages it cites, so leave their names out of `text`. A link may appear " +
      "only if a message the line cites contains it.",
    "Use no tools. The answer is checked against these messages before anything is posted, " +
      "and one that does not fit posts nothing.",
  ].join("\n");
}

/**
 * A reply as the post it becomes, or why it is not a digest of this read.
 *
 * Everything is checked against the read, never against what the reply says about itself.
 * Reasons name positions and fields, never content: they are logged and replayed to the brain
 * as the guard's are.
 */
export function acceptDigest(
  text: string,
  history: ChannelHistory,
): ReturnType<SealedTick["accept"]> {
  const refuse = (reason: string) => ({ ok: false as const, rule: "digest", reason });
  if (Buffer.byteLength(text) > JOB_OUTPUT_LIMIT_BYTES) {
    return refuse(`the answer is over ${JOB_OUTPUT_LIMIT_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    // A fenced code block is still the object inside it.
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"));
  } catch {
    return refuse("the answer is not JSON");
  }
  const digest = Digest.safeParse(parsed);
  if (!digest.success) {
    const at = digest.error.issues[0]?.path.join(".") || "the top level";
    return refuse(`the answer is not {"items": [{"text", "refs"}]}: ${at} does not fit`);
  }

  const lines: string[] = [];
  for (const [index, item] of digest.data.items.entries()) {
    const missing = item.refs.find((ref) => !history.messages[ref - 1]);
    if (missing !== undefined) {
      const returned = history.messages.length;
      return refuse(`item ${index + 1} cites ref ${missing}, and the read returned ${returned}`);
    }
    const cited = [...new Set(item.refs)].map((ref) => history.messages[ref - 1]!);
    // Whole links, never substrings: a prefix of a posted link is a link nobody posted.
    const posted = new Set(cited.flatMap((message) => links(message.text)));
    if (links(item.text).some((link) => !posted.has(link))) {
      return refuse(`item ${index + 1} has a link none of the messages it cites contains`);
    }
    const authors = new Set(cited.map((message) => channelLine(message).from));
    lines.push(`• ${item.text} — ${[...authors].join(", ")}`);
  }
  if (history.more) {
    const read = history.messages.length;
    lines.push(`(Partial: this covers only the ${read} most recent messages in the window.)`);
  }
  return { ok: true, msg: { text: lines.join("\n") } };
}
