/**
 * A brain's Markdown, written as Slack's mrkdwn.
 *
 * A brain writes Markdown whatever surface it is on — its reply contract is one prompt for
 * all of them — and Slack renders mrkdwn, so `**bold**` and `[#305](url)` arrive with their
 * punctuation showing. Steering a persona per surface does not fix that: the dialect is a
 * fact about the transport, and this adapter is the only thing that knows the surface is
 * Slack.
 *
 * Runs after the escape in `SlackAdapter.outboundText`, which is what makes the link rule
 * safe. By then the brain's own `<`, `>` and `&` are entities, so the `<url|text>` built
 * here is the only live markup that reaches the wire — and it is built only around an
 * `http(s):` or `mailto:` URL, so `[boom](!channel)` stays text and cannot become a
 * broadcast.
 *
 * A bare URL is left alone; Slack links it without help.
 */
export function toMrkdwn(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      const heading = HEADING.exec(line);
      if (heading) {
        const title = inline(heading[1]).trimEnd();
        // `## **Summary**` is bold already; wrapping it again leaves a stray `*` each side.
        return title.startsWith("*") && title.endsWith("*") ? title : `*${title}*`;
      }
      return inline(line.replace(BULLET, "$1• "));
    })
    .join("\n");
}

/** A fence line — the same pattern opens a block and closes it. Slack renders the block. */
const FENCE = /^[ \t]*```/;

/** Kept whole by the `split` in {@link inline}, so no rule reaches inside a code span either. */
const CODE_SPAN = /(`[^`]*`)/;

/** mrkdwn has no heading, so bold is the nearest thing a brain that asked for one gets. */
const HEADING = /^#{1,6}[ \t]+(.+)$/;

/** The space is required: `---` stays a rule and `**bold**` at a line start stays bold. */
const BULLET = /^([ \t]*)[-*][ \t]+/;

/** The rules, applied to the parts of a line that are not a code span. */
function inline(line: string): string {
  return line
    .split(CODE_SPAN)
    .map((part, index) => (index % 2 ? part : translate(part)))
    .join("");
}

/**
 * Emphasized text is translated in turn, or `**[#305](url)**` would consume the link and
 * send its brackets. That terminates: a delimiter pair is dropped on the way in. A link's
 * label is the exception — it is the one place a nested rule would put a second `<…>`
 * inside the one being built.
 */
function translate(text: string): string {
  /**
   * Every inline rule in one alternation, so no rule reads another's output — applied in
   * sequence, `**a**` becomes `*a*` and the next rule turns that into `_a_`. Declared here
   * rather than beside the rules above because the replacer re-enters this function, and a
   * `lastIndex` shared across those calls is a thing nobody should have to reason about.
   *
   * Both bold spellings are one alternative closed by a backreference, so `**a__` is not
   * one. Markdown and mrkdwn spell italic `_text_` alike, so that needs no rule; the
   * `*text*` spelling does, and its flanks exclude whitespace so `run *.ts` and `2 * 3`
   * are not read as emphasis.
   */
  const inlineRules =
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s<>|()]+)\)|(\*\*|__)(.+?)\3|~~(.+?)~~|\*([^*\s][^*]*[^*\s]|[^*\s])\*/g;

  return text.replace(
    inlineRules,
    (
      _whole: string,
      label: string,
      url: string,
      _delimiter: string,
      bold: string,
      strike: string,
      italic: string,
    ) => {
      if (url) return `<${url}|${label}>`;
      if (bold) return `*${translate(bold)}*`;
      if (strike) return `~${translate(strike)}~`;
      return `_${translate(italic)}_`;
    },
  );
}
