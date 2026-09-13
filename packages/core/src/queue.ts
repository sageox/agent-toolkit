export type Turn = () => Promise<void>;

export interface QueueOptions {
  /** How many channels may be mid-turn at once. */
  maxConcurrentChannels: number;
  /** How many turns may wait behind the running one, per channel. */
  channelQueueLimit: number;
  /** Called when overflow drops turns — shedding is never silent. */
  onShed?: (channel: string, count: number) => void;
  onError?: (error: unknown, channel: string) => void;
}

/** One queued turn, and how to tell it that it will never run. */
interface Queued {
  turn: Turn;
  shed?: () => void;
}

interface ChannelState {
  pending: Queued[];
  running: boolean;
}

/**
 * Serialize per channel, bounded across channels.
 *
 * Both failure modes are real: global serialization lets one slow turn head-of-line
 * block every other surface, while unbounded concurrency races sessions and interleaves
 * egress. So a channel is strictly ordered, and channels run in parallel up to a cap.
 */
export class ChannelQueue {
  private channels = new Map<string, ChannelState>();
  private activeChannels = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private opts: QueueOptions) {}

  /**
   * `shed` is called when overflow drops this turn instead of running it.
   *
   * A chat turn needs none: the message is still in the channel, and the shedding is
   * already in the log. A caller that is owed an answer whatever happens — a clock tick,
   * which has a run record to write either way — passes one, because a dropped turn is
   * otherwise a promise that never settles.
   */
  submit(channel: string, turn: Turn, shed?: () => void): void {
    const state = this.channels.get(channel) ?? { pending: [], running: false };
    this.channels.set(channel, state);

    state.pending.push({ turn, shed });
    if (state.pending.length > this.opts.channelQueueLimit) {
      const count = state.pending.length - this.opts.channelQueueLimit;
      // shed oldest — the newest message is the live one
      for (const dropped of state.pending.splice(0, count)) dropped.shed?.();
      this.opts.onShed?.(channel, count);
    }
    this.pump();
  }

  /** Resolves once every queued turn has finished. */
  async drain(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.activeChannels === 0 && [...this.channels.values()].every((s) => !s.pending.length);
  }

  private pump(): void {
    for (const [channel, state] of this.channels) {
      if (this.activeChannels >= this.opts.maxConcurrentChannels) return;
      if (state.running || state.pending.length === 0) continue;
      void this.runChannel(channel, state);
    }
  }

  private async runChannel(channel: string, state: ChannelState): Promise<void> {
    state.running = true;
    this.activeChannels++;
    try {
      const queued = state.pending.shift();
      if (queued) await queued.turn();
    } catch (error) {
      // One bad turn must not wedge its channel forever.
      this.opts.onError?.(error, channel);
    } finally {
      state.running = false;
      this.activeChannels--;
      if (state.pending.length === 0) this.channels.delete(channel);
      this.pump();
      this.settleIdle();
    }
  }

  private settleIdle(): void {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
