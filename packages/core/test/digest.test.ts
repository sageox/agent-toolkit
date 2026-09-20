import { describe, expect, it } from "vitest";
import { acceptDigest } from "../src/digest.ts";
import type { ChannelHistory } from "../src/events.ts";
import { JOB_OUTPUT_LIMIT_BYTES } from "../src/job-output.ts";

const history: ChannelHistory = {
  messages: [
    {
      author: { surface: "buzz", id: "npub1abcdefghijklmnop", isSelf: false, isAgent: true },
      text: "opened https://example.test/pr/9 for review",
      ts: "2026-09-10T09:00:00.000Z",
    },
    {
      author: { surface: "slack", id: "U0BO", isSelf: false, isAgent: true, name: "bo" },
      text: "merged <https://example.test/pr/7|#7>",
      ts: "2026-09-10T10:00:00.000Z",
    },
  ],
  more: false,
};

describe("acceptDigest", () => {
  it("reads a fenced answer, and a link the way the cited message spells it", () => {
    const items = [
      { text: "merged #7 (https://example.test/pr/7), opened https://example.test/pr/9.", refs: [2, 1] },
    ];
    expect(acceptDigest("```json\n" + JSON.stringify({ items }) + "\n```", history)).toEqual({
      ok: true,
      // Credited in citation order, by name where the surface gave one and a compact id
      // where it did not — `read_channel`'s own `from`.
      msg: { text: `• ${items[0]!.text} — bo, npub1abcdefg…` },
    });
  });

  it("refuses an answer over the output limit before parsing it", () => {
    expect(acceptDigest(" ".repeat(JOB_OUTPUT_LIMIT_BYTES + 1), history)).toMatchObject({
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
      expect(acceptDigest(JSON.stringify({ items: [{ text, refs: [1] }] }), history), text)
        .toMatchObject({ ok: false, reason: expect.stringContaining("link") });
    }
  });

  it("refuses a line that is two lines, a line that cites nothing, and a digest of nothing", () => {
    for (const items of [[{ text: "one\ntwo", refs: [1] }], [{ text: "x", refs: [] }], []]) {
      expect(acceptDigest(JSON.stringify({ items }), history).ok, JSON.stringify(items)).toBe(false);
    }
  });
});
