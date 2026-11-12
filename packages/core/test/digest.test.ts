import { describe, expect, it } from "vitest";
import { acceptDigest } from "../src/digest.ts";
import type { ChannelHistory } from "../src/events.ts";
import { JOB_OUTPUT_LIMIT_BYTES } from "../src/job-output.ts";

const bo = { surface: "slack", id: "U0BO", isSelf: false, isAgent: true, name: "bo" } as const;
const history: ChannelHistory = {
  messages: [
    {
      author: { surface: "buzz", id: "npub1abcdefghijklmnop", isSelf: false, isAgent: true },
      text: "opened https://example.test/pr/9 for review",
      ts: "2026-09-10T09:00:00.000Z",
    },
    { author: bo, text: "merged <https://example.test/pr/7|#7>", ts: "2026-09-10T10:00:00.000Z" },
    { author: bo, text: "merged <https://example.test/pr/8|#8>", ts: "2026-09-10T11:00:00.000Z" },
    {
      author: { surface: "slack", id: "U0CY", isSelf: false, isAgent: true, name: "cy" },
      text: "on shift, nothing in flight",
      ts: "2026-09-10T12:00:00.000Z",
    },
  ],
  more: false,
};
const digest = (...items: { text: string; refs: number[] }[]) => JSON.stringify({ items });
const plain = { line: "• {text} — {authors}" };
const byAuthor = {
  title: "**Daily digest**",
  line: "• **{author}** — {text}",
  quiet: "• **Quiet** — {authors}",
  byAuthor: true,
};

describe("acceptDigest", () => {
  it("posts the job's own layout: its title, a line per author, and the quiet authors", () => {
    const answer = digest(
      { text: "merged [#7](https://example.test/pr/7) and [#8](https://example.test/pr/8)", refs: [2, 3] },
      { text: "opened https://example.test/pr/9.", refs: [1] },
    );
    const lines = [
      "**Daily digest**",
      // By name where the surface gave one and a compact id where it did not — `read_channel`'s
      // own `from`; and a link counts however the cited message spells it.
      "• **bo** — merged [#7](https://example.test/pr/7) and [#8](https://example.test/pr/8)",
      "• **npub1abcdefg…** — opened https://example.test/pr/9.",
    ];
    expect(acceptDigest("```json\n" + answer + "\n```", history, byAuthor)).toEqual({
      ok: true,
      msg: { text: [...lines, "• **Quiet** — cy"].join("\n") },
    });
    // Older messages went unread, so nobody can be called quiet.
    expect(acceptDigest(answer, { ...history, more: true }, byAuthor)).toEqual({
      ok: true,
      msg: {
        text: [...lines, "(Partial: this covers only the 4 most recent messages in the window.)"]
          .join("\n"),
      },
    });
  });

  it("holds a byAuthor job to one line per author: no line per pull request, none for two", () => {
    const perPullRequest = digest(
      { text: "merged [#7](https://example.test/pr/7)", refs: [2] },
      { text: "merged [#8](https://example.test/pr/8)", refs: [3] },
    );
    expect(acceptDigest(perPullRequest, history, byAuthor)).toMatchObject({
      ok: false,
      reason: "items 1 and 2 are one author's: give each author one line",
    });
    expect(acceptDigest(digest({ text: "busy day", refs: [2, 4] }), history, byAuthor)).toMatchObject({
      ok: false,
      reason: "item 1 cites 2 authors, and a line is one author's",
    });
    // Two authors who share a name are still two authors.
    const namesake = { author: { ...bo, id: "U0BO2" }, text: "merged", ts: "2026-09-10T13:00:00.000Z" };
    const twoBos = { ...history, messages: [...history.messages, namesake] };
    expect(acceptDigest(digest({ text: "merged", refs: [2, 5] }), twoBos, byAuthor)).toMatchObject({
      ok: false,
      reason: "item 1 cites 2 authors, and a line is one author's",
    });
  });

  it("can give every author a line in the busiest read there is", () => {
    const busy: ChannelHistory = {
      messages: Array.from({ length: 200 }, (_, i) => ({
        author: { surface: "slack", id: `U${i}`, isSelf: false, isAgent: true, name: `a${i}` },
        text: `merged https://example.test/pr/${i}`,
        ts: "2026-09-10T09:00:00.000Z",
      })),
      more: false,
    };
    const items = busy.messages.map((message, i) => ({ text: message.text, refs: [i + 1] }));
    expect(acceptDigest(JSON.stringify({ items }), busy, byAuthor).ok).toBe(true);
  });

  it("refuses to call an author quiet who posted a link", () => {
    // Accepted, the quiet line would name bo, who merged two pull requests.
    const answer = digest({ text: "opened https://example.test/pr/9.", refs: [1] });
    expect(acceptDigest(answer, history, byAuthor)).toMatchObject({
      ok: false,
      reason: "the authors of refs 2 posted links and have no line",
    });
  });

  it("refuses an answer over the output limit before parsing it", () => {
    expect(acceptDigest(" ".repeat(JOB_OUTPUT_LIMIT_BYTES + 1), history, plain)).toMatchObject({
      ok: false,
      reason: `the answer is over ${JOB_OUTPUT_LIMIT_BYTES} bytes`,
    });
  });

  it("refuses a link the cited messages do not carry whole, in each form a surface links", () => {
    for (const text of [
      "opened https://example.test/pr/90", // a link nobody posted
      "opened https://example.test/pr", // a prefix of one that was posted
      "ask mailto:ops@example.test", // a mailto the messages do not carry
      "see www.example.test/login", // and a bare www address
    ]) {
      expect(acceptDigest(JSON.stringify({ items: [{ text, refs: [1] }] }), history, plain), text)
        .toMatchObject({ ok: false, reason: "item 1 has a link none of the messages it cites contains" });
    }
  });

  it("refuses a line that is two lines, a line that cites nothing, and a digest of nothing", () => {
    for (const items of [[{ text: "one\ntwo", refs: [1] }], [{ text: "x", refs: [] }], []]) {
      expect(acceptDigest(JSON.stringify({ items }), history, plain).ok, JSON.stringify(items))
        .toBe(false);
    }
  });
});
