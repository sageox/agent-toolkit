import { describe, it, expect } from "vitest";
import { TurnPolicy, type PolicyConfig } from "../src/policy.ts";
import type { InboundEvent } from "../src/events.ts";

let clock = 1_000_000;
const now = () => clock;

function ev(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    id: { surface: "buzz", nativeId: `e${Math.random()}` },
    surface: "buzz",
    channel: { surface: "buzz", id: "hive", isPublic: false },
    author: { surface: "buzz", id: "alice", isSelf: false, isAgent: false },
    text: "hi",
    mentionsMe: true,
    ts: "2026-08-13T00:00:00Z",
    raw: null,
    ...over,
  };
}

const DEFAULTS: PolicyConfig = {
  perAuthorPerMinute: 6,
  perChannelPerMinute: 20,
  maxTurnsPerThread: 8,
  maxAgentChainDepth: 2,
};

function policy(over: Partial<PolicyConfig> = {}) {
  clock = 1_000_000;
  return new TurnPolicy({ ...DEFAULTS, ...over }, now);
}

describe("TurnPolicy per-author rate", () => {
  it("admits traffic under the limit", () => {
    const p = policy({ perAuthorPerMinute: 3 });
    for (let i = 0; i < 3; i++) expect(p.admit(ev()).ok).toBe(true);
  });

  it("refuses the author over the limit, naming the rule", () => {
    const p = policy({ perAuthorPerMinute: 2 });
    p.admit(ev());
    p.admit(ev());
    const r = p.admit(ev());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("perAuthorPerMinute");
  });

  it("throttles one abuser without deafening everyone else", () => {
    const p = policy({ perAuthorPerMinute: 1, perChannelPerMinute: 100 });
    p.admit(ev({ author: { surface: "buzz", id: "abuser", isSelf: false, isAgent: false } }));
    expect(p.admit(ev({ author: { surface: "buzz", id: "abuser", isSelf: false, isAgent: false } })).ok).toBe(
      false,
    );
    expect(p.admit(ev({ author: { surface: "buzz", id: "bob", isSelf: false, isAgent: false } })).ok).toBe(true);
  });

  it("lets the window slide", () => {
    const p = policy({ perAuthorPerMinute: 1 });
    expect(p.admit(ev()).ok).toBe(true);
    expect(p.admit(ev()).ok).toBe(false);
    clock += 61_000;
    expect(p.admit(ev()).ok).toBe(true);
  });

  it("scopes counters per surface, so a Slack alice is not a Buzz alice", () => {
    const p = policy({ perAuthorPerMinute: 1 });
    p.admit(ev());
    const slackAlice = ev({
      surface: "slack",
      author: { surface: "slack", id: "alice", isSelf: false, isAgent: false },
      channel: { surface: "slack", id: "hive", isPublic: false },
    });
    expect(p.admit(slackAlice).ok).toBe(true);
  });
});

describe("TurnPolicy per-channel rate", () => {
  it("refuses a channel over the limit even from different authors", () => {
    const p = policy({ perChannelPerMinute: 2, perAuthorPerMinute: 100 });
    p.admit(ev({ author: { surface: "buzz", id: "a", isSelf: false, isAgent: false } }));
    p.admit(ev({ author: { surface: "buzz", id: "b", isSelf: false, isAgent: false } }));
    const r = p.admit(ev({ author: { surface: "buzz", id: "c", isSelf: false, isAgent: false } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("perChannelPerMinute");
  });
});

describe("TurnPolicy thread caps", () => {
  const thread = { surface: "buzz", nativeId: "root-1" };

  it("caps total turns in one thread", () => {
    const p = policy({ maxTurnsPerThread: 2, perAuthorPerMinute: 100 });
    expect(p.admit(ev({ threadRoot: thread })).ok).toBe(true);
    expect(p.admit(ev({ threadRoot: thread })).ok).toBe(true);
    const r = p.admit(ev({ threadRoot: thread }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("maxTurnsPerThread");
  });

  it("counts threads separately", () => {
    const p = policy({ maxTurnsPerThread: 1, perAuthorPerMinute: 100 });
    expect(p.admit(ev({ threadRoot: thread })).ok).toBe(true);
    expect(
      p.admit(ev({ threadRoot: { surface: "buzz", nativeId: "root-2" } })).ok,
    ).toBe(true);
  });
});

describe("TurnPolicy bookkeeping stays bounded", () => {
  it("forgets rate counters once their window has passed", () => {
    const p = policy({ perAuthorPerMinute: 100, perChannelPerMinute: 100 });
    for (let i = 0; i < 500; i++) {
      p.admit(ev({ author: { surface: "buzz", id: `user-${i}`, isSelf: false, isAgent: false } }));
    }
    expect(p.stats().rateKeys).toBeGreaterThan(100);

    clock += 61_000;
    p.admit(ev()); // one later turn triggers the sweep
    expect(p.stats().rateKeys).toBeLessThan(10);
  });

  it("forgets idle threads, so a long-running gateway does not grow forever", () => {
    const p = policy({ perAuthorPerMinute: 10_000, perChannelPerMinute: 10_000 });
    for (let i = 0; i < 500; i++) {
      p.admit(ev({ threadRoot: { surface: "buzz", nativeId: `thread-${i}` } }));
    }
    expect(p.stats().threads).toBe(500);

    clock += 2 * 60 * 60 * 1000; // two hours later
    p.admit(ev({ threadRoot: { surface: "buzz", nativeId: "fresh" } }));
    expect(p.stats().threads).toBe(1);
  });

  it("still caps an active thread while it stays active", () => {
    const p = policy({ maxTurnsPerThread: 2, perAuthorPerMinute: 100 });
    const t = { surface: "buzz", nativeId: "busy" };
    p.admit(ev({ threadRoot: t }));
    clock += 30_000;
    p.admit(ev({ threadRoot: t }));
    clock += 30_000;
    expect(p.admit(ev({ threadRoot: t })).ok).toBe(false);
  });
});

describe("TurnPolicy agent-chain depth (spec §8)", () => {
  const agent = { surface: "buzz", id: "other-agent", isSelf: false, isAgent: true };
  const thread = { surface: "buzz", nativeId: "root-1" };

  it("caps an agent-to-agent chain at the hard depth", () => {
    const p = policy({ maxAgentChainDepth: 2, perAuthorPerMinute: 100 });
    expect(p.admit(ev({ author: agent, threadRoot: thread })).ok).toBe(true);
    expect(p.admit(ev({ author: agent, threadRoot: thread })).ok).toBe(true);
    const r = p.admit(ev({ author: agent, threadRoot: thread }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe("maxAgentChainDepth");
  });

  it("caps agents harder than humans in the same thread", () => {
    const p = policy({ maxAgentChainDepth: 1, maxTurnsPerThread: 50, perAuthorPerMinute: 100 });
    p.admit(ev({ author: agent, threadRoot: thread }));
    expect(p.admit(ev({ author: agent, threadRoot: thread })).ok).toBe(false);
    // a human in the same thread is still served
    expect(p.admit(ev({ threadRoot: thread })).ok).toBe(true);
  });

  it("recognises another agent across surfaces, so a cross-surface chain is capped too", () => {
    const p = policy({ maxAgentChainDepth: 1, perAuthorPerMinute: 100 });
    p.admit(ev({ author: agent, threadRoot: thread }));
    const fromSlack = ev({
      surface: "slack",
      author: { surface: "slack", id: "other-agent", isSelf: false, isAgent: true },
      threadRoot: thread,
    });
    expect(p.admit(fromSlack).ok).toBe(false);
  });
});
