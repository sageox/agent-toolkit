import { z } from "zod";
import type { ChannelHistory } from "./events.ts";
import type { SealedTick } from "./gateway.ts";
import { JOB_OUTPUT_LIMIT_BYTES } from "./job-output.ts";
import type { JobSource } from "./manifest.ts";
import { channelLine } from "./surface-read.ts";

/**
 * The answer a prompt job with a `source` owes: items about the messages the host read, each
 * citing the messages it is about.
 *
 * The toolkit owns this shape because it is what lets the host check an answer against the
 * read before anything is posted — which messages exist, who wrote them, which links they
 * carry. How the post reads is the job's: `source.title`, `source.line` and `source.quiet`
 * lay it out, and the host only fills in what it checked.
 */

const MAX_ITEMS = 50;
// An item can be an author's whole window, links included: fifteen GitHub pull requests
// written as Markdown links come to about 900 characters.
const MAX_ITEM_CHARS = 1000;

/** How a job lays out its digest — see `source` in `manifest.ts`. */
export interface DigestFormat {
  title?: string;
  line: string;
  quiet?: string;
  byAuthor?: boolean;
}

/** What each format may name. `{author}` needs `byAuthor`, where an item is one author's. */
const FIELDS = { title: [], line: ["text", "authors", "author"], quiet: ["authors"] } as const;
const FIELD = /\{(\w*)\}/g;

/**
 * What is wrong with a job's layout, by field. The manifest refuses these at load: a field
 * the host does not fill would otherwise post as nothing, unnoticed until the digest goes out.
 */
export function formatProblems(format: DigestFormat): [field: string, problem: string][] {
  const problems: [string, string][] = [];
  for (const field of ["title", "line", "quiet"] as const) {
    const takes: readonly string[] = FIELDS[field];
    for (const [, name] of (format[field] ?? "").matchAll(FIELD)) {
      if (field === "line" && name === "author" && !format.byAuthor) {
        const why = "without it an item can cite several authors, which is what `{authors}` is for";
        problems.push([field, `\`{author}\` needs \`byAuthor: true\`: ${why}`]);
      } else if (!takes.includes(name!)) {
        const named = takes.length ? takes.map((f) => `{${f}}`).join(", ") : "nothing";
        problems.push([field, `\`{${name}}\` is not filled in here; ${field} takes ${named}`]);
      }
    }
  }
  return problems;
}

/** One pass, so a value is never read as a format: an item's own `{authors}` stays text. */
function fill(format: string, values: Record<string, string>): string {
  return format.replace(FIELD, (_, name: string) => values[name] ?? "");
}

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
      "one, so there is no line about someone who posted nothing. A link may appear only if a " +
      "message the line cites contains it.",
    ...(source.byAuthor
      ? ["Each line is one author's: its `refs` are all by one author, and no author gets two."]
      : []),
    ...(source.quiet
      ? [
          "Give a line to every author whose messages carry a link." +
            (history.more ? "" : " The host names the authors you give no line as quiet."),
        ]
      : []),
    ...(/\{authors?\}/.test(source.line)
      ? ["The host adds the authors of the messages a line cites, so leave them out of `text`."]
      : []),
    "Use no tools. The answer is checked against these messages before anything is posted, " +
      "and one that does not fit posts nothing.",
  ].join("\n");
}

/**
 * A reply as the post it becomes, or why it is not a digest of this read.
 *
 * Everything is checked against the read, never against what the reply says about itself.
 * Reasons name positions and fields, never content: they are logged and replayed to the brain
 * as the guard's are. The credits, the quiet authors and the partial notice are the host's,
 * because they are claims about the read; every other word of the post is the job's.
 */
export function acceptDigest(
  text: string,
  history: ChannelHistory,
  format: DigestFormat,
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

  const lines = format.title ? [format.title] : [];
  // Every author a line credits, with the first line that does, so a second can name it.
  const lineOf = new Map<string, number>();
  for (const [index, item] of digest.data.items.entries()) {
    const missing = item.refs.find((ref) => !history.messages[ref - 1]);
    if (missing !== undefined) {
      const returned = history.messages.length;
      return refuse(`item ${index + 1} cites ref ${missing}, and the read returned ${returned}`);
    }
    const cited = [...new Set(item.refs)].map((ref) => history.messages[ref - 1]!);
    const authors = [...new Set(cited.map((message) => channelLine(message).from))];
    // Checked rather than asked for, because the job's words are what change: a brief that
    // asked for an item per pull request posted a flat list of every pull request. Before
    // links, because a line grouped by topic usually misses a link too, and the repair it
    // needs is the grouping.
    if (format.byAuthor) {
      if (authors.length > 1) {
        const cites = `item ${index + 1} cites ${authors.length} authors`;
        return refuse(`${cites}, and a line is one author's`);
      }
      const earlier = lineOf.get(authors[0]!);
      if (earlier !== undefined) {
        const both = `items ${earlier} and ${index + 1}`;
        return refuse(`${both} are one author's: give each author one line`);
      }
    }
    // Whole links, never substrings: a prefix of a posted link is a link nobody posted.
    const posted = new Set(cited.flatMap((message) => links(message.text)));
    if (links(item.text).some((link) => !posted.has(link))) {
      return refuse(`item ${index + 1} has a link none of the messages it cites contains`);
    }
    for (const author of authors) if (!lineOf.has(author)) lineOf.set(author, index + 1);
    const credits = { authors: authors.join(", "), author: authors[0]! };
    lines.push(fill(format.line, { text: item.text, ...credits }));
  }

  if (format.quiet) {
    // An author whose message carries a link did something a reader can open, so leaving
    // them out would have the quiet line name them. Named by the first such ref, a position,
    // so the repair needs no content in the reason.
    const unlined = new Map<string, number>();
    for (const [index, message] of history.messages.entries()) {
      const author = channelLine(message).from;
      if (!lineOf.has(author) && !unlined.has(author) && links(message.text).length) {
        unlined.set(author, index + 1);
      }
    }
    if (unlined.size) {
      const refs = [...unlined.values()].join(", ");
      return refuse(`the authors of refs ${refs} posted links and have no line`);
    }
  }
  if (history.more) {
    const read = history.messages.length;
    lines.push(`(Partial: this covers only the ${read} most recent messages in the window.)`);
  } else if (format.quiet) {
    // Only a whole window can say who had nothing worth a line; after a partial read the
    // notice above stands in for this.
    const authors = new Set(history.messages.map((message) => channelLine(message).from));
    const quiet = [...authors].filter((author) => !lineOf.has(author));
    if (quiet.length) lines.push(fill(format.quiet, { authors: quiet.join(", ") }));
  }
  return { ok: true, msg: { text: lines.join("\n") } };
}
