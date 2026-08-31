// What "the agent is up" means, and — the load-bearing half — what is allowed to decide
// it is not.
//
// The doctrine, and everything below follows from it:
//
//   An agent is UP and able to answer immediately. Secondary warmup work never blocks
//   startup, and while it runs the agent must be able to say it is not ready yet.
//
// This exists because of a measured outage. A chat agent's container gated its own startup
// on building a code index. The build took seven minutes, during which no agent process
// existed at all: the connection was not idle, it was absent, so a mention arriving in the
// window was dropped and never replayed. A human asked a question and got silence — no
// acknowledgement, no error, nothing distinguishable from the agent thinking. Across a
// fleet of eight at roughly thirty rollouts a day, that came to about 4.7 agent-hours
// daily in which a mention was a black hole.
//
// The gate's stated reason was sound and is preserved here: an agent answering from an
// empty index gives a CONFIDENT WRONG ANSWER, not an error, so it must not answer from
// one. The defect was the leap from there to "so it must not exist." Not answering *from
// the index* is a correctness requirement. Not being *reachable* was a convenience, bought
// because a container runtime hands you "run this to completion first" for free and nobody
// priced what it cost.
//
// Two layers, and conflating them is the bug:
//
//   1. LIFECYCLE (this file) — one per agent. Decides whether the agent runs at all.
//   2. CAPABILITY HEALTH ([`health.ts`](./health.ts)) — N per agent, one per thing the
//      agent can do. Decides what the agent SAYS when asked.
//
// The rule that joins them is one sentence, and it is the whole point:
//
//   ONLY A PRECONDITION GATES STARTUP. NO CAPABILITY HEALTH, IN ANY COMBINATION, EVER
//   DOES.
//
// `lifecycle.test.ts` asserts that over every state in the health enum, so the doctrine is
// executable rather than aspirational. If you are here to add "…unless the index is still
// building", that test is the argument you have to beat.

import {
  HEALTH_WORD,
  type ProbeResult,
  isActionable,
  isDegrading,
  isTransient,
  needsHuman,
} from "./health.ts";

/**
 * The two outcomes of deciding whether to start.
 *
 * There is deliberately no phase machine here — no `Draining`, no `Stopped`, no transition
 * table. The {@link ./gateway.ts | Gateway} already owns the running agent's shape
 * (`start`, `drain`, `stop`), and a second unenforced model of the same thing is exactly
 * the drift this toolkit refuses everywhere else.
 *
 * `Ready` does NOT mean "fully capable". It means connected, listening, and able to answer
 * — including able to answer "that part of me is still warming up". An agent with every
 * brain unavailable is still `Ready`; it just discloses a lot. That is not a weakened
 * definition, it is the correct one: a readiness signal that waits for full capability is
 * a readiness signal that produces silence, and silence is the failure mode with no
 * observability at all.
 */
export type AgentPhase = "Ready" | "Failed";

const PHASE_MEANING: Readonly<Record<AgentPhase, string>> = Object.freeze({
  Ready: "connected and answering — capabilities may still be warming or degraded",
  Failed: "a precondition cannot be satisfied; refusing to run",
});

/**
 * A precondition is a thing that makes the agent WRONG OR UNPOLICED if absent — never
 * merely less informed.
 *
 * The distinction is the entire fatal/degraded line, and it is narrow on purpose. An agent
 * with no identity has no accountable voice. One whose tool allowlist is unenforced has a
 * reach nobody approved. One with no model credential answers nothing at all. Those
 * processes are WRONG, and a wrong agent running is worse than no agent.
 *
 * An agent whose search index is still building is none of those things. It is less
 * informed, temporarily, and it can say so. That is a capability, and capabilities do not
 * belong here.
 */
export interface Precondition {
  readonly id: string;
  readonly satisfied: boolean;
  /** What was observed, one line. Never a secret. */
  readonly reason: string;
  /** What a human must do. Required — a precondition is by definition not self-healing. */
  readonly remedy: string;
}

export function precondition(
  id: string,
  satisfied: boolean,
  reason: string,
  remedy: string,
): Precondition {
  if (remedy.trim() === "") {
    throw new TypeError(
      `precondition(${id}) needs a remedy — if no human action can satisfy it, it is not a ` +
        `precondition, it is a capability, and capabilities never gate startup`,
    );
  }
  return { id, satisfied, reason, remedy };
}

/**
 * The footgun guard, and the reason this is a function rather than a comment.
 *
 * The tempting mistake is one line long: probe a capability, find it not `Ok`, and promote
 * that reading to a startup gate. Do it with a `Warming` reading and you have rebuilt the
 * original outage exactly — a self-healing condition holding the process hostage — except
 * now it is spelled in the new vocabulary and looks principled.
 *
 * So this refuses `Warming` outright, and it refuses `Ok` and `NotFound` too: a satisfied
 * precondition built from a healthy probe is a gate that exists only to fail later.
 */
export function preconditionFromProbe(id: string, result: ProbeResult): Precondition {
  if (isTransient(result.health)) {
    throw new TypeError(
      `${id}: refusing to build a precondition from a ${result.health} probe — it is transient ` +
        `and self-healing, and gating startup on it is the exact defect this doctrine exists to ` +
        `prevent; report it as a capability and come up Ready`,
    );
  }
  if (!isActionable(result)) {
    throw new TypeError(
      `${id}: refusing to build a precondition from a ${result.health} probe — nothing here ` +
        `needs a human, so there is nothing to gate on`,
    );
  }
  // `isActionable` narrowed the union, so `.remedy` is reachable without a cast: every
  // actionable reading has one, and that is a fact the compiler holds.
  return precondition(id, false, result.reason, result.remedy);
}

export interface StartupVerdict {
  readonly phase: AgentPhase;
  /** Unsatisfied preconditions. Non-empty exactly when `phase` is `Failed`. */
  readonly unmet: readonly Precondition[];
  /** Capabilities the agent must disclose while running. Never affects `phase`. */
  readonly disclosing: readonly ProbeResult[];
  /** The subset of `disclosing` that clears itself. Never announced to a human. */
  readonly warming: readonly ProbeResult[];
  /** The subset of `disclosing` a human must act on. This is what gets announced. */
  readonly actionable: readonly ProbeResult[];
}

/**
 * Decide whether to start.
 *
 * Read the body: `capabilities` populates the disclosure lists and is never consulted for
 * `phase`. That is not an implementation detail to be tidied later — it IS the doctrine,
 * and `lifecycle.test.ts` proves it holds across every state in the health enum, including
 * states added after this was written.
 *
 * The readings passed here are a snapshot for the startup line only. Nothing may keep
 * them: a `Warming` reading is true for about four minutes, and a caller that caches one
 * has turned a transient state into a permanent one. Re-read from the source instead —
 * see {@link isTransient}.
 */
export function evaluateStartup(input: {
  readonly preconditions: readonly Precondition[];
  readonly capabilities?: readonly ProbeResult[];
}): StartupVerdict {
  const unmet = input.preconditions.filter((p) => !p.satisfied);
  const disclosing = (input.capabilities ?? []).filter((c) => isDegrading(c.health));

  return {
    phase: unmet.length > 0 ? "Failed" : "Ready",
    unmet,
    disclosing,
    warming: disclosing.filter((c) => isTransient(c.health)),
    actionable: disclosing.filter((c) => needsHuman(c.health)),
  };
}

/**
 * One greppable line. `phase=Ready actionable=- warming=code:service:still-warming` is
 * what an operator should be able to find in a log without knowing this file exists.
 */
export function describeStartup(verdict: StartupVerdict): string {
  const head = `phase=${verdict.phase} meaning="${PHASE_MEANING[verdict.phase]}"`;
  if (verdict.phase === "Failed") {
    return `${head} unmet=${verdict.unmet.map((p) => p.id).join(",")}`;
  }
  const caps = (list: readonly ProbeResult[]) =>
    list.map((c) => `${c.capability}:${HEALTH_WORD[c.health]}`).join(",") || "-";
  return `${head} actionable=${caps(verdict.actionable)} warming=${caps(verdict.warming)}`;
}

/**
 * Why the agent is refusing to run, with every unmet precondition and what to do about
 * each. All of them at once: fixing one and restarting into the next is how a five-minute
 * misconfiguration becomes an afternoon.
 */
export function describeUnmet(verdict: StartupVerdict): string {
  const list = verdict.unmet
    .map((p) => `  ${p.id} — ${p.reason}\n      ${p.remedy}`)
    .join("\n\n");
  return `${verdict.unmet.length} precondition(s) are unsatisfied, so this agent would run wrong:\n\n${list}`;
}
