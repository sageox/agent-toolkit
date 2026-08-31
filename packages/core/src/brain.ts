import type { InboundEvent, GuardedMessage } from "./events.ts";
import type { ProbeResult } from "./health.ts";

export interface BrainContext {
  agentName: string;
  /** The operator's steering: who this agent is and how it should sound. */
  persona?: string;
  /** Which brains are wired up, so the turn explains the ones it actually has. */
  memory?: { vault?: boolean; private?: boolean; team?: boolean };
  /** A gateway-hosted, explicitly allowlisted cross-surface post tool is available. */
  postMessage?: boolean;
  /** A gateway-hosted, explicitly allowlisted reaction tool is available. */
  react?: boolean;
  /**
   * How every capability the agent has is doing, right now. Trusted runtime data, not chat
   * content: each reading is built from a closed vocabulary by whoever probed it.
   *
   * A snapshot taken for this turn and never for the next one. Warmup clears itself, so
   * the disclosure has to clear with it.
   */
  capabilities?: readonly ProbeResult[];
}

/** The brain returns intent. It holds no transport credential and cannot send. */
export type BrainStep = { type: "reply"; msg: GuardedMessage };

/** What the gateway hands back when the guard refuses a step. */
export interface GuardFeedback {
  blocked: true;
  rule: string;
  reason: string;
}

/**
 * The guard is a feedback loop, not a wall: a refused step is returned to the brain as
 * the result of the `yield` that requested it, so the brain can adapt within the same
 * turn. `undefined` means the step was allowed and sent.
 */
export interface Brain {
  runTurn(
    event: InboundEvent,
    ctx: BrainContext,
  ): AsyncGenerator<BrainStep, void, GuardFeedback | undefined>;
}

export class MockBrain implements Brain {
  async *runTurn(event: InboundEvent): AsyncGenerator<BrainStep, void, GuardFeedback | undefined> {
    yield { type: "reply", msg: { text: `echo: ${event.text}` } };
  }
}
