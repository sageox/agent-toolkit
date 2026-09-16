/**
 * What is left of the turns in flight.
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
   * How long the **soonest** turn in flight will still listen — `null` when none is.
   *
   * The soonest, rather than the one this call belongs to, because nothing can say which
   * that is: a `tools/call` names no turn, and a channel runs its turns one at a time while
   * two channels run at once. So the answer is the tightest bound any live turn has, which
   * is the only one every live turn satisfies.
   *
   * Answering `null` on that ambiguity was the first version, on the reasoning that a
   * caller should fall back to what it knew before. What it knew before is
   * `limits.turnTimeoutMs`, so under concurrency that reinstated #44 exactly: a job weighed
   * against a whole turn and waited for inside a shortened scheduled tick. The two wrong
   * answers here are not symmetric — guessing long loses a result and tells a channel
   * something false about it, while guessing short costs a job its inline verdict and sends
   * it to `report` instead — so this guesses short. That is a different question from the
   * one `SurfaceEgress.liveTurn` refuses to guess at, which is *who* is asking, and where a
   * wrong guess hands a sibling agent a person's authority.
   *
   * Negative once a turn has overrun. That is a true answer and the useful one: nothing can
   * still be waited for inside it.
   */
  remaining(now = Date.now()): number | null {
    let soonest: number | null = null;
    for (const { at } of this.live) if (soonest === null || at < soonest) soonest = at;
    return soonest === null ? null : soonest - now;
  }
}
