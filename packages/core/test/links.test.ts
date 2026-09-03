import { describe, expect, it } from "vitest";
import type { EventRef, InboundEvent } from "../src/events.ts";
import { Links, LINK_TTL_MS, MAX_RELAYED } from "../src/links.ts";

const IDA = "c".repeat(64);
const ROOT: EventRef = { surface: "buzz", nativeId: "root1" };

/** The Slack message that asked. */
function home(): InboundEvent {
  return {
    id: { surface: "slack", nativeId: "C0123:1.0" },
    surface: "slack",
    channel: { surface: "slack", id: "C0123", isPublic: false },
    author: { surface: "slack", id: "U08MADHUR", isSelf: false, isAgent: false },
    text: "@harry ask ida whether the sweep passed",
    mentionsMe: true,
    ts: "2026-09-02T00:00:00Z",
    raw: null,
  };
}

/** A Buzz line, threaded under `root` unless told otherwise. */
function line(
  author: string,
  opts: { root?: EventRef | null; isSelf?: boolean } = {},
): InboundEvent {
  const root = opts.root === undefined ? ROOT : opts.root;
  return {
    id: { surface: "buzz", nativeId: `e-${Math.random()}` },
    surface: "buzz",
    channel: { surface: "buzz", id: "hive", isPublic: false },
    author: { surface: "buzz", id: author, isSelf: opts.isSelf ?? false, isAgent: true },
    text: "passed",
    mentionsMe: false,
    ...(root ? { threadRoot: root } : {}),
    ts: "2026-09-02T00:01:00Z",
    raw: null,
  };
}

describe("Links", () => {
  it("answers only with the addressed principal's replies under the root that was posted", () => {
    const links = new Links();
    links.open(ROOT, home(), IDA);

    expect(links.claim(line(IDA))?.home.channel.id).toBe("C0123");
    expect(links.claim(line("someone-else"))).toBeUndefined();
    expect(links.claim(line(IDA, { root: { surface: "buzz", nativeId: "other" } }))).toBeUndefined();
    expect(links.claim(line(IDA, { root: null }))).toBeUndefined(); // top level is not under it
    // A relayed line is this agent's own message; one that came home again would loop.
    expect(links.claim(line(IDA, { isSelf: true }))).toBeUndefined();
  });

  it("keeps a root on one surface from being answered on another", () => {
    const links = new Links();
    links.open(ROOT, home(), IDA);
    const elsewhere = line(IDA, { root: { surface: "slack", nativeId: "root1" } });
    expect(links.claim(elsewhere)).toBeUndefined();
  });

  it("closes after its count, so a conversation never becomes a feed", () => {
    const links = new Links();
    links.open(ROOT, home(), IDA);
    for (let i = 0; i < MAX_RELAYED; i++) expect(links.claim(line(IDA))).toBeDefined();
    expect(links.claim(line(IDA))).toBeUndefined();
    expect(links.size()).toBe(0);
  });

  it("closes on the clock, whatever is left of its count", () => {
    let now = 1_000;
    const links = new Links(() => now);
    links.open(ROOT, home(), IDA);
    now += LINK_TTL_MS - 1;
    expect(links.claim(line(IDA))).toBeDefined();
    now += 1;
    expect(links.claim(line(IDA))).toBeUndefined();
    expect(links.size()).toBe(0);
  });
});
