import { describe, it, expect } from "vitest";
import { isSilentReply, whySilent } from "../src/silent-reply.ts";

// Escapes rather than the characters themselves, so a reader can see what each case holds.
const ZERO_WIDTH_RUN = "\u200B\u200B\u200C\u200D";
const BOM = "\uFEFF";
const OTHER_INVISIBLES = "\u2060 \u00AD \u180E";

describe("whySilent", () => {
  it("sees whitespace, invisible code points and HTML comments as silence", () => {
    expect(whySilent("")).toBe("empty");
    expect(whySilent(" \n\t ")).toBe("empty");
    expect(whySilent("<!-- nothing to report -->")).toBe("invisible");
    expect(whySilent("<!--\nmulti\nline\n-->\n")).toBe("invisible");
    expect(whySilent(ZERO_WIDTH_RUN)).toBe("invisible");
    // `trim()` already strips the BOM, so alone it is plain emptiness; between comments it is not.
    expect(whySilent(BOM)).toBe("empty");
    expect(whySilent(`<!-- x -->${BOM}<!-- y -->`)).toBe("invisible");
    expect(whySilent(OTHER_INVISIBLES)).toBe("invisible");
    expect(whySilent("<!-- a -->\u200B <!-- b -->")).toBe("invisible");
  });

  it("drops a placeholder only on a scheduled turn", () => {
    const placeholders = [
      "(no reply)",
      "No reply.",
      "OK",
      "ok",
      "[none]",
      "N/A",
      "Nothing to post.",
      "*done*",
      "Nothing to say",
    ];
    for (const text of placeholders) {
      expect(whySilent(text, { scheduled: true }), text).toBe("placeholder");
      expect(whySilent(text), text).toBeUndefined();
    }
  });

  it("posts a real one-word reply, and a sentence that merely contains a placeholder", () => {
    expect(whySilent("Approved", { scheduled: true })).toBeUndefined();
    expect(whySilent("OK, two candidates moved to screening.", { scheduled: true })).toBeUndefined();
    expect(whySilent("Nothing to post about A, but B needs a call.", { scheduled: true })).toBeUndefined();
    // A comment inside a reply hides nothing the reply says.
    expect(whySilent("<!-- draft --> Approved", { scheduled: true })).toBeUndefined();
  });

  it("isSilentReply is whySilent as a verdict", () => {
    expect(isSilentReply("(no reply)", { scheduled: true })).toBe(true);
    expect(isSilentReply("(no reply)")).toBe(false);
    expect(isSilentReply("Approved")).toBe(false);
  });
});
