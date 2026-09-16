/**
 * What is left of the turn in flight.
 *
 * A `tools/call` carries nothing about the turn that produced it, and the gateway holds
 * both halves of the number a call has to fit inside: when the turn started, and how long
 * it gets. `Gateway.runTurn` is where `withTimeout` applies that bound, so it is where the
 * deadline is registered, and `job_run` reads it from here rather than weighing a job
 * against `limits.turnTimeoutMs`.
 *
 * Those are two different numbers and the difference is the whole reason this exists. The
 * manifest's is a turn's *whole* budget; a tool call always starts partway into it, and a
 * scheduled turn that declared `budget.wallClockMs` was never given the manifest's number
 * at all. Deciding to wait against a number that does not apply is what issue #44 was.
 *
 * Constructed by the caller and handed to both sides, because the gateway is built after
 * the servers that read it.
 */
export class TurnClock {
  /** A box per turn, so two that share a millisecond stay two entries. */
  private live = new Set<{ at: number }>();

  /**
   * Registers one turn's deadline. The returned closer must run on every exit path — a
   * deadline that outlives its turn is a bound the next call would be measured against.
   */
  open(at: number): () => void {
    const turn = { at };
    this.live.add(turn);
    return () => {
      this.live.delete(turn);
    };
  }

  /**
   * How long the one turn in flight will still listen — `null` when there is none, or when
   * there is more than one.
   *
   * The ambiguity rule `SurfaceEgress.liveTurn` already states, about the same ambiguity: a
   * channel runs its turns one at a time, two channels run concurrently, and a tool call
   * names neither. `null` rather than a guess, and a caller reads it as "no bound known"
   * and falls back to what it knew before.
   *
   * Negative once a turn has overrun. That is a true answer and the useful one: nothing can
   * still be waited for inside it.
   */
  remaining(now = Date.now()): number | null {
    if (this.live.size !== 1) return null;
    const [turn] = this.live;
    return turn!.at - now;
  }
}
