import type { InboundEvent } from "./events.ts";
import type { LimitsConfig } from "./manifest.ts";

/** The caps this policy enforces — a slice of the manifest's `limits:`, one source of truth. */
export type PolicyConfig = Pick<
  LimitsConfig,
  "perAuthorPerMinute" | "perChannelPerMinute" | "maxTurnsPerThread" | "maxAgentChainDepth"
>;

export type Admission = { ok: true } | { ok: false; rule: string; reason: string };

const WINDOW_MS = 60_000;

/**
 * How long a thread's turn count is remembered after its last message. Runaway loops —
 * the thing the cap exists to stop — happen in seconds, so an hour of inactivity is a
 * safe point to forget a thread and let a revived conversation start fresh.
 */
const THREAD_TTL_MS = 60 * 60 * 1000;

interface ThreadState {
  turns: number;
  agentTurns: number;
  last: number;
}

/**
 * The decision made before a turn starts.
 *
 * Counters are **per author**, not just global, because the shared spend cap is the last
 * backstop and not the first: tripping it deafens every legitimate user, so one abuser
 * must be throttleable on their own.
 *
 * All bookkeeping is evicted on a timer. A gateway runs for months; anything keyed by
 * author, channel, or thread would otherwise be an unbounded map.
 */
export class TurnPolicy {
  private hits = new Map<string, number[]>();
  private threads = new Map<string, ThreadState>();
  private lastSweep = 0;

  constructor(
    private cfg: PolicyConfig,
    private now: () => number = Date.now,
  ) {}

  /** Bookkeeping sizes, so tests can prove eviction works. */
  stats(): { rateKeys: number; threads: number } {
    return { rateKeys: this.hits.size, threads: this.threads.size };
  }

  admit(event: InboundEvent): Admission {
    this.sweep();

    // Ids are surface-qualified so a Slack "alice" can never spend a Buzz "alice"'s budget.
    const author = `author:${event.author.surface}:${event.author.id}`;
    const channel = `channel:${event.channel.surface}:${event.channel.id}`;

    if (this.rateExceeded(author, this.cfg.perAuthorPerMinute))
      return refuse("perAuthorPerMinute", "author is over the per-minute turn limit");

    if (this.rateExceeded(channel, this.cfg.perChannelPerMinute))
      return refuse("perChannelPerMinute", "channel is over the per-minute turn limit");

    const threadId = event.threadRoot?.nativeId;
    const thread = threadId !== undefined ? this.threads.get(threadId) : undefined;
    if (thread) {
      if (thread.turns >= this.cfg.maxTurnsPerThread)
        return refuse("maxTurnsPerThread", "thread has reached its turn cap");

      // Another agent is recognised by identity regardless of the surface it arrived on,
      // so a Slack→Buzz chain is capped exactly like a same-surface one.
      if (event.author.isAgent && thread.agentTurns >= this.cfg.maxAgentChainDepth)
        return refuse("maxAgentChainDepth", "agent-to-agent chain has reached its depth cap");
    }

    this.record(author);
    this.record(channel);
    if (threadId !== undefined) {
      const state = thread ?? { turns: 0, agentTurns: 0, last: 0 };
      state.turns++;
      if (event.author.isAgent) state.agentTurns++;
      state.last = this.now();
      this.threads.set(threadId, state);
    }
    return { ok: true };
  }

  /** Drops expired rate keys and idle threads. Cheap, and amortised to once a window. */
  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < WINDOW_MS) return;
    this.lastSweep = now;

    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= now - WINDOW_MS)) this.hits.delete(key);
    }
    for (const [id, state] of this.threads) {
      if (state.last <= now - THREAD_TTL_MS) this.threads.delete(id);
    }
  }

  private recent(key: string): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    this.hits.set(key, kept);
    return kept;
  }

  private rateExceeded(key: string, limit: number): boolean {
    return this.recent(key).length >= limit;
  }

  private record(key: string): void {
    this.recent(key).push(this.now());
  }
}

function refuse(rule: string, reason: string): Admission {
  return { ok: false, rule, reason };
}
