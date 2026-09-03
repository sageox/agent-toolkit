import type { AgentManifest } from "./manifest.ts";
import type { SurfaceAdapter } from "./adapter.ts";
import type { Brain, BrainContext, GuardFeedback } from "./brain.ts";
import type { InboundEvent } from "./events.ts";
import type { ProbeResult } from "./health.ts";
import { evaluateEgress } from "./guard.ts";
import { SurfaceEgress, type LiveTurnHandle } from "./surface-egress.ts";
import { TurnPolicy } from "./policy.ts";
import { ChannelQueue } from "./queue.ts";

export interface GatewayOpts {
  manifest: AgentManifest;
  adapters: SurfaceAdapter[];
  brain: Brain;
  /** Called when a turn fails. Defaults to logging; a failed turn never kills the gateway. */
  onError?: (error: unknown, event: InboundEvent) => void;
  /** Override for tests that need a controllable clock. */
  policy?: TurnPolicy;
  /** Contents of the manifest's `persona` file, if one is configured. */
  persona?: string;
  /** Which brains the agent has, so the turn explains the ones it actually has. */
  memory?: BrainContext["memory"];
  /**
   * The one guarded send path. Shared with the hosted post tool when that
   * capability is enabled; built here for a caller that has no reason to hold one.
   */
  egress?: SurfaceEgress;
  /** Whether the brain actually received the top-level post tool. */
  postMessage?: boolean;
  /** Whether the brain actually received the reaction tool. */
  react?: boolean;
  /**
   * How every capability is doing, re-read at turn time and never captured.
   *
   * This is the re-probe path, and it is a function for one reason: warmup is transient,
   * and a transient state read once and cached is a permanent one. A background index
   * becomes ready while the agent runs, and the turn after it does must stop saying it
   * has not.
   */
  capabilities?: () => readonly ProbeResult[];
}

/**
 * The only component that sends. It owns the transport connections, the guard, and
 * the credentials; the brain reaches a surface only by asking through this loop.
 */
export class Gateway {
  private byKind = new Map<string, SurfaceAdapter>();
  private policy: TurnPolicy;
  private queue: ChannelQueue;
  private egress: SurfaceEgress;
  private stoppedReason?: string;

  constructor(private opts: GatewayOpts) {
    for (const a of opts.adapters) this.byKind.set(a.kind, a);
    const limits = opts.manifest.limits;
    this.policy = opts.policy ?? new TurnPolicy(limits);
    this.egress =
      opts.egress ?? new SurfaceEgress({ manifest: opts.manifest, adapters: opts.adapters });
    this.queue = new ChannelQueue({
      maxConcurrentChannels: limits.maxConcurrentChannels,
      channelQueueLimit: limits.channelQueueLimit,
      onShed: (channel, count) =>
        console.warn(`turns_shed channel=${channel} count=${count} reason=queue_full`),
      onError: (error, channel) => this.report(error, channel),
    });
  }

  async start(): Promise<void> {
    for (const a of this.opts.adapters) await a.start((e) => this.onEvent(e));
  }

  async stop(): Promise<void> {
    for (const a of this.opts.adapters) await a.stop();
  }

  /**
   * The kill switch. Only ever called programmatically by an operator — no code path
   * reaches it from anything read in a channel, and nothing calls `resumeServing`, so
   * coming back ON stays a human act (§7.8). A wrong OFF costs idle time; a wrong ON
   * puts an unsupervised agent back to work.
   */
  stopServing(reason: string): void {
    this.stoppedReason = reason;
  }

  resumeServing(): void {
    this.stoppedReason = undefined;
  }

  get serving(): boolean {
    return this.stoppedReason === undefined;
  }

  /** Waits for in-flight turns to finish — for tests and graceful shutdown. */
  async drain(): Promise<void> {
    await this.queue.drain();
  }

  private authorAllowed(e: InboundEvent): boolean {
    const m = this.opts.manifest;
    switch (m.respondTo) {
      case "nobody":
        return false;
      case "anyone":
        return true;
      case "owner-only":
        // The owner is one person holding one ID per surface, and an ID is only ever
        // compared against the surface it came from — no two namespaces overlap here.
        return !!m.owner?.includes(e.author.id);
      case "allowlist":
        return (m.allowlist ?? []).includes(e.author.id);
      default:
        return false; // unreachable, but an unknown mode admits nobody
    }
  }

  /**
   * The admission path. Every check here happens *before* a turn is queued, so a refused
   * event costs nothing — and the decision never depends on what the message says.
   */
  private onEvent(e: InboundEvent): void {
    // An answer to something this agent asked on a conversation's behalf comes home instead
    // of becoming a turn: it goes out as this agent's own message through the guarded path a
    // reply takes, and that is the whole of what happens to it. Admitting it as well would
    // have the agent answer, on the far door, a line that was addressed to the person who
    // asked — and keep an exchange between two agents going there. Only while serving: the
    // kill switch means silence, and an answer relayed under it is the agent still speaking.
    if (this.serving) {
      const link = this.egress.claimLink(e);
      if (link) {
        void this.egress.relayHome(link, e);
        return;
      }
    }

    // "Arrived but ignored" and "never arrived" look identical from outside, and they
    // have completely different causes — so say which, every time.
    const skip = this.skipReason(e);
    if (skip) {
      console.info(
        `event_skipped surface=${e.surface} channel=${e.channel.id} event=${e.id.nativeId} reason=${skip}`,
      );
      return;
    }

    const adapter = this.byKind.get(e.surface);
    if (!adapter) return;

    this.queue.submit(`${e.surface}:${e.channel.id}`, async () => {
      // A run that did nothing must be distinguishable from one that never ran, so log
      // both ends of every turn — ids and counts only, never the message text.
      const started = Date.now();
      console.info(`turn_start surface=${e.surface} channel=${e.channel.id} event=${e.id.nativeId}`);
      // The brain's reaction tool marks "the message you are answering", and this is where
      // the gateway says which message that is. Registered for exactly the turn's lifetime,
      // so a tool call arriving late has nothing stale to land on — and read back by the
      // acknowledgement, which must not withdraw a glyph the brain asked for.
      const turn = this.egress.answers(e);
      const stopSignalling = this.signalWorking(e, adapter, turn);
      try {
        const sent = await this.runTurn(e, adapter);
        console.info(
          `turn_done surface=${e.surface} channel=${e.channel.id} event=${e.id.nativeId} ` +
            `sent=${sent} ms=${Date.now() - started}`,
        );
      } catch (error) {
        console.warn(
          `turn_failed surface=${e.surface} channel=${e.channel.id} event=${e.id.nativeId} ` +
            `ms=${Date.now() - started}`,
        );
        this.report(error, `${e.surface}:${e.channel.id}`, e);
      } finally {
        // Signalling first: it reads what the turn claimed, so the turn must still be there.
        stopSignalling();
        turn.close();
      }
    });
  }

  /**
   * Tells the channel the agent has picked the message up and is working.
   *
   * Both signals are best-effort and never awaited into the turn: a failed emoji must
   * not cost a real answer. The typing indicator is ephemeral, so it is refreshed until
   * the turn ends — and the returned stopper must run on every exit path, or the channel
   * shows the agent typing forever.
   */
  private signalWorking(e: InboundEvent, adapter: SurfaceAdapter, turn: LiveTurnHandle): () => void {
    const ack = this.opts.manifest.ack;
    // A courtesy signal is still egress: never react in a channel the guard would not
    // let the agent speak in.
    const allowed = evaluateEgress({ text: "" }, e.channel, this.opts.manifest.guard).ok;
    if (!allowed) return () => {};

    // Held rather than discarded, because the ref it resolves to is the only thing that
    // names *this* reaction. Still never awaited into the turn — a failed emoji must not
    // cost a real answer — so the failure is absorbed into an undefined ref.
    const acknowledged =
      ack.emoji && adapter.react
        ? adapter.react(e, ack.emoji).catch(() => undefined)
        : undefined;

    // The acknowledgement and nothing else. It means "working" and stops being true when
    // the turn ends, while whatever the brain was asked to signal during the turn is meant
    // to stand — including when the brain chose the same emoji, which is why this names the
    // reaction rather than the message or the message and the glyph.
    //
    // Chaining off `acknowledged` also orders the two: a turn that finishes before the
    // reaction lands cannot issue the withdrawal first and leave a late 👀 behind.
    const withdraw = () => {
      if (!acknowledged || !adapter.unreact) return;
      // Waits out any reaction the brain asked for that could be this one, then decides on
      // what it turned out to be. Waiting rather than assuming: a request that answers is
      // settled precisely by ref, and one that fails claims nothing so the acknowledgement
      // comes off as usual.
      //
      // Only requests that could be this reaction are waited on. A hung request for some
      // other glyph could never have claimed this one, and is no reason to leave a channel
      // showing "working" forever.
      void turn
        .settled(adapter.reactionKey?.(ack.emoji) ?? ack.emoji)
        .then(() => acknowledged)
        .then((reaction) => {
          // Only what this acknowledgement actually placed. A reaction that was already
          // there belongs to whatever put it there — an earlier turn, or another process
          // under this agent's identity — and taking it back is not this turn's to do.
          if (!reaction?.placed) return;
          // The brain was asked for this very reaction and asked for it here — on both
          // surfaces that is the same reaction rather than a second one, so withdrawing
          // "the acknowledgement" would take back what the brain was asked to leave.
          // Compared by ref, so a surface's own spellings of one emoji cannot disagree.
          if (turn.claimed.has(reaction.ref.nativeId)) return;
          return adapter.unreact?.(reaction.ref);
        })
        .catch(() => {});
    };

    if (!ack.typing || !adapter.setTyping) return withdraw;

    // Pass a thread root only when there is one: a top-level message gets a
    // channel-level indicator, which is what shows at the bottom of the channel.
    const beat = () => void adapter.setTyping?.(e.channel, e.threadRoot).catch(() => {});
    beat();
    const timer = setInterval(beat, TYPING_REFRESH_MS);
    return () => {
      clearInterval(timer);
      withdraw();
    };
  }

  /** Why an event will not become a turn, or undefined if it will. */
  private skipReason(e: InboundEvent): string | undefined {
    // Never answer yourself. Unconditional and first — independent of who the agent is
    // configured to serve, because a reply that mentions the message's author mentions
    // the agent itself when the agent wrote it, and that is a loop with no natural end.
    // The rate and depth caps stop it eventually; they should never be what stops it.
    if (e.author.isSelf) return "own_message";
    if (!e.mentionsMe) return "not_mentioned"; // the @mention is the only wake trigger (§8)
    if (!this.serving) return "kill_switch";
    if (!this.authorAllowed(e)) return `author_gate:${this.opts.manifest.respondTo}`;

    const admission = this.policy.admit(e);
    if (!admission.ok) return `limit:${admission.rule}`;
    return undefined;
  }

  private report(error: unknown, channel: string, event?: InboundEvent): void {
    // A failing turn degrades, it never kills: the brain, the transport, and the context
    // provider are all things that go down while the agent must stay up.
    if (this.opts.onError && event) {
      this.opts.onError(error, event);
      return;
    }
    // ids and counts only — the event text is attacker-reachable by design
    console.error(
      `turn_failed channel=${channel} error=${error instanceof Error ? error.message : "unknown"}`,
    );
  }

  private async runTurn(e: InboundEvent, adapter: SurfaceAdapter): Promise<number> {
    const turn = this.opts.brain.runTurn(e, {
      agentName: this.opts.manifest.name,
      persona: this.opts.persona,
      memory: this.opts.memory,
      postMessage: this.opts.postMessage,
      react: this.opts.react,
      capabilities: this.opts.capabilities?.(),
    });
    try {
      return await withTimeout(
        this.drive(turn, e, adapter),
        this.opts.manifest.limits.turnTimeoutMs,
        `turn timed out after ${this.opts.manifest.limits.turnTimeoutMs}ms`,
      );
    } finally {
      // An abandoned generator never runs its own `finally`, so the brain would never
      // close its ACP session on a failed send or a timeout. Returning it does.
      //
      // Deliberately not awaited: a generator suspended inside a hung `await` cannot be
      // resumed, so awaiting its return would hang exactly where the timeout was meant
      // to rescue us. Cleanup runs if it can; releasing the channel does not wait for it.
      void turn.return(undefined).catch(() => {});
    }
  }

  /**
   * The turn loop proper.
   *
   * On timeout this promise is left running — a race cannot cancel it — but the queue
   * slot is released, which is what stops one hung brain call from taking the whole
   * gateway down with it.
   */
  private async drive(
    turn: ReturnType<Brain["runTurn"]>,
    e: InboundEvent,
    adapter: SurfaceAdapter,
  ): Promise<number> {
    let sent = 0;
    // The guard is a feedback loop: a refused step is handed back to the brain as the
    // result of its own yield, so it can adapt without the turn ending. The loop is
    // bounded by the brain — the gateway never retries on its behalf.
    let feedback: GuardFeedback | undefined;
    while (true) {
      const next = await turn.next(feedback);
      if (next.done) break;
      feedback = undefined;

      const step = next.value;
      if (step.type !== "reply") continue;

      const verdict = await this.egress.reply(adapter, e, step.msg);
      if (!verdict.ok) {
        // The reason too, not just the rule: `leakPatterns` refuses over a list of pattern
        // names an operator has to see to act on, and a bare `rule=leakPatterns` says a
        // leak was caught without saying which. Safe to log for every rule by the same
        // invariant that lets it be replayed to the brain — a reason carries no message
        // text and no adapter-asserted field, and `guard.test.ts` holds that line.
        console.warn(
          `egress_blocked surface=${e.surface} channel=${e.channel.id} rule=${verdict.rule} ` +
            `reason="${verdict.reason}"`,
        );
        feedback = { blocked: true, rule: verdict.rule, reason: verdict.reason };
        continue;
      }
      sent++;
    }
    return sent;
  }
}

/** Buzz's typing indicator is ephemeral; upstream refreshes it on this cadence. */
const TYPING_REFRESH_MS = 3_000;

/** Rejects if `work` has not settled in time. `work` itself keeps running; only the wait ends. */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
