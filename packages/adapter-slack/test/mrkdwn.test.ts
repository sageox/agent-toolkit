import { describe, expect, it } from "vitest";
import { toMrkdwn } from "../src/mrkdwn.ts";

describe("Markdown to mrkdwn", () => {
  it("writes the emphasis, headings, lists and links a brain wrote as Slack spells them", () => {
    expect(toMrkdwn("**bold** and __bold__ and *italic* and _italic_ and ~~struck~~")).toBe(
      "*bold* and *bold* and _italic_ and _italic_ and ~struck~",
    );
    expect(toMrkdwn("# Deploy report")).toBe("*Deploy report*");
    // A heading is bold, and one written bold is not bold twice. mrkdwn has no bold inside
    // bold, so a heading that emphasizes only part of itself keeps that rather than being
    // wrapped in a span the inner `*` would leave unbalanced.
    expect(toMrkdwn("### **Summary**")).toBe("*Summary*");
    expect(toMrkdwn("## **Summary** today")).toBe("*Summary* today");
    expect(toMrkdwn("- one\n* two\n  - nested")).toBe("• one\n• two\n  • nested");
    expect(toMrkdwn("([#305](https://github.test/org/repo/pull/305)) landed")).toBe(
      "(<https://github.test/org/repo/pull/305|#305>) landed",
    );
    // The link inside is translated, not swallowed by the emphasis around it.
    expect(toMrkdwn("**[#305](https://github.test/a)**")).toBe("*<https://github.test/a|#305>*");
  });

  it("leaves alone the punctuation that is not markup", () => {
    // Slack links a bare URL itself, so wrapping one would only add markup to remove later.
    expect(toMrkdwn("see https://x.test/a?b=1 for the run")).toBe("see https://x.test/a?b=1 for the run");
    // Emphasis flanks a word, so a glob, an arithmetic line and a rule are none of it.
    expect(toMrkdwn("run *.ts and *.js")).toBe("run *.ts and *.js");
    expect(toMrkdwn("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(toMrkdwn("---")).toBe("---");
    // A list marker needs the space that follows it, which a dash mid-line does not have.
    expect(toMrkdwn("`--flag` - what it does")).toBe("`--flag` - what it does");
  });

  it("translates nothing inside a code span or a fenced block", () => {
    expect(toMrkdwn("`**kwargs` beside **bold**")).toBe("`**kwargs` beside *bold*");
    expect(toMrkdwn("```ts\nconst x = **a**;\n- not a bullet\n```\nthen **bold**")).toBe(
      "```ts\nconst x = **a**;\n- not a bullet\n```\nthen *bold*",
    );
    // A span closes on a run as long as the one that opened it, or the two backticks a
    // brain used to quote a backtick would read as one empty span and expose what follows.
    expect(toMrkdwn("``**a**`` beside **bold**")).toBe("``**a**`` beside *bold*");
    // The same rule for a block: `~~~` fences, and a ```` block quoting ``` stays open.
    expect(toMrkdwn("~~~\n**a**\n- not a bullet\n~~~\nthen **bold**")).toBe(
      "~~~\n**a**\n- not a bullet\n~~~\nthen *bold*",
    );
    expect(toMrkdwn("````\n```\n**a**\n```\n````\nthen **bold**")).toBe(
      "````\n```\n**a**\n```\n````\nthen *bold*",
    );
  });

  it("builds a link only around a URL, so escaped markup cannot become live again", () => {
    // The escape runs first, so a broadcast reaches this as characters — and stays them.
    expect(toMrkdwn("&lt;!channel&gt; deploy now")).toBe("&lt;!channel&gt; deploy now");
    // The one rule that emits `<` needs an http(s) or mailto URL, which these are not.
    expect(toMrkdwn("[boom](!channel)")).toBe("[boom](!channel)");
    expect(toMrkdwn("[boom](javascript:alert(1))")).toBe("[boom](javascript:alert(1))");
    // A label is markup to nobody: it arrives escaped and is copied, never translated.
    expect(toMrkdwn("[&lt;!channel&gt;](https://x.test/a)")).toBe(
      "<https://x.test/a|&lt;!channel&gt;>",
    );
    // `|` is what separates the two halves, so a URL carrying one is left as it was written.
    expect(toMrkdwn("[a](https://x.test/a|https://evil.test)")).toBe(
      "[a](https://x.test/a|https://evil.test)",
    );
  });
});
