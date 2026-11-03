/**
 * What counts as a reply that says nothing — the one definition the brain and the tick
 * path share, so "an empty reply posts nothing" means the same thing on both.
 *
 * A model asked to reply with nothing rarely emits zero bytes. It invents a token for
 * silence instead: an HTML comment, a zero-width character, `(no reply)`. `trim()` saw none
 * of those as empty, so buzz-ashby's five-minute screening tick posted one blank-looking or
 * placeholder line to its channel every tick (toolkit v0.10.0, 2026-11-02).
 */

/**
 * Code points that render as nothing: zero-width space/joiner/non-joiner, word joiner, the
 * BOM (which is also the zero-width no-break space when it lands mid-text), the soft hyphen
 * and the Mongolian vowel separator. Only the BOM is in `\s`; `trim()` keeps the rest.
 */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]/g;

/** `<!-- … -->`, across lines; `[^]` because `.` stops at a newline. */
const HTML_COMMENT = /<!--[^]*?-->/g;

/**
 * Tokens a model reaches for when told to say nothing on a tick. Dropped only for a
 * scheduled turn: a tick has no human waiting on an answer, so a dropped placeholder costs
 * nothing, while a person who asked a question and got `ok` back is owed that `ok`.
 * Matched whole, case-insensitively, with surrounding brackets and punctuation removed
 * (`(no reply)`, `No reply.`, `[none]`); a sentence that merely contains one still posts.
 */
const TICK_PLACEHOLDERS = new Set([
  "no reply",
  "nothing",
  "nothing to say",
  "nothing to post",
  "none",
  "n/a",
  "ok",
  "done",
]);

/** Brackets, quotes, emphasis markers and sentence punctuation at either end of a token. */
const WRAPPING = /^[\s()[\]{}<>"'`*_~.,:;!?-]+|[\s()[\]{}<>"'`*_~.,:;!?-]+$/g;

export type SilentReason = "empty" | "invisible" | "placeholder";

/**
 * Why `text` is silence, or `undefined` when it has something to post.
 *
 * - `empty` — nothing but whitespace, the silence `trim()` always recognised.
 * - `invisible` — nothing once HTML comments and invisible code points are removed.
 * - `placeholder` — one of {@link TICK_PLACEHOLDERS}; only with `scheduled`.
 */
export function whySilent(text: string, opts: { scheduled?: boolean } = {}): SilentReason | undefined {
  if (!text.trim()) return "empty";
  const visible = text.replace(HTML_COMMENT, "").replace(INVISIBLE, "").trim();
  if (!visible) return "invisible";
  if (opts.scheduled && TICK_PLACEHOLDERS.has(visible.replace(WRAPPING, "").toLowerCase())) {
    return "placeholder";
  }
  return undefined;
}

/** `true` when posting `text` would say nothing — see {@link whySilent}. */
export function isSilentReply(text: string, opts: { scheduled?: boolean } = {}): boolean {
  return whySilent(text, opts) !== undefined;
}
