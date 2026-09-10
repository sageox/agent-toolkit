import type { JobConfig } from "./manifest.ts";

/**
 * Where a switch reading came from — the distinction this module exists to preserve.
 *
 * A fail-closed job once sat unset for four days with work waiting behind it, because
 * "nobody ever set this" and "a human turned it off" both printed a bare `off`: a config
 * gap nobody had closed was indistinguishable from a state somebody had chosen, and it
 * surfaced only because a person happened to ask. Separately, a memory-owner
 * misconfiguration made every read fail at once, so no fail-closed job could be armed at
 * all — and that hid for weeks behind a status that read normal.
 *
 * `set` is the only one of the three that is evidence of intent.
 */
export type SwitchOrigin = "set" | "never-set" | "unreadable";

/**
 * Why a read did not reach a value. A closed vocabulary, never the exception text: the
 * raw message carries the backend's own stderr onto whatever surface renders it, and each
 * class sends a human somewhere different — `backend-missing` is a broken deployment,
 * `auth-failed` is an unseeded key, `unreachable` is an outage to wait out.
 */
export type SwitchFailure =
  | "no-signing-key"
  | "no-owner"
  | "backend-missing"
  | "timeout"
  | "unreachable"
  | "auth-failed"
  | "backend-error";

export type SwitchState = "on" | "off";

/**
 * What a retrieved value was recognized as, decided while the raw text is still in hand.
 *
 * Every value that does not arm parks, so `state` alone cannot say whether a human chose
 * `off` or fat-fingered `onn`. A monitor watching for a job that is never admitted has to
 * tell those apart: the first is somebody's decision and must not page anyone, the second
 * is a job nobody meant to stop. Classified here rather than downstream because the raw
 * text stops here — it is the operator's, and no record this produces carries it.
 */
export type SwitchValueClass = "arming" | "parking" | "unrecognized";

/**
 * What the backend said, before any job's fail-direction interprets it.
 *
 * Separate from {@link SwitchReading} because the two answer different questions: this one
 * is a fact about the key, and the reading is what that fact means for one job. Two jobs
 * of opposite fail-direction turn the same lookup into opposite readings.
 */
export type SwitchLookup =
  | { origin: "set"; state: SwitchState; value?: SwitchValueClass }
  | { origin: "never-set" }
  | { origin: "unreadable"; failure: SwitchFailure };

/** One job's interpretation of one lookup. What the run record keeps. */
export interface SwitchReading {
  state: SwitchState;
  origin: SwitchOrigin;
  /**
   * Only ever set when `origin` is `set` — the other two origins never reached a value.
   * Absent from a source written before this existed, which is why nothing may read a bare
   * `origin: "set"` as evidence that somebody deliberately parked the job.
   */
  value?: SwitchValueClass;
  /**
   * Only ever set when `origin` is `unreadable` — a never-set reading is a fact about the
   * key, and hanging a "why it failed" off it would invent one.
   */
  failure?: SwitchFailure;
}

/**
 * One attempt to read one key, bound to whichever brain holds the agent's memory.
 *
 * A transport that fails classifies its own failure rather than throwing, because only it
 * knows its error vocabulary. An exception that escapes anyway is caught by
 * {@link admitJob} and treated as `backend-error` — unrecognized never means "no value".
 */
export type SwitchSource = (key: string) => Promise<SwitchLookup>;

/** How the run was started. Stamped by the host from the entry point, never passed in. */
export type JobTriggerKind = "schedule" | "on-request" | "webhook";

/** Who asked, resolved from the inbound author. Never self-reported by the job body. */
export interface JobRequester {
  kind: "human" | "agent" | "system";
  id: string;
}

export interface JobRequest {
  trigger: JobTriggerKind;
  /** Absent for a clock tick, which nobody asked for. */
  requestedBy?: JobRequester | null;
}

export interface JobAdmission {
  admitted: boolean;
  /** Why not, in the run record's vocabulary. Absent when admitted. */
  outcome?: "denied-suspend" | "denied-switch";
  /** True when a human ran this job while it was parked. Recorded, and greppable at 3am. */
  bypassedSwitch: boolean;
  /** The switch as this job read it, or null when the job declares none. */
  switch: SwitchReading | null;
  /** One line for the run record and the log. Never carries a backend's error text. */
  reason: string;
}

/**
 * The values that arm a job. Everything else parks it.
 *
 * Deliberately not symmetric with a list of off-spellings: a value nobody can interpret is
 * treated as `off` whatever the job's fail-direction, because the only value that may
 * start unattended work is one that unambiguously says so. A typo in the arming direction
 * costs idle time somebody notices; a typo in the parking direction leaves automation
 * running that somebody was trying to stop.
 */
const ARMING_VALUES = new Set(["on", "true", "yes", "1", "enabled", "armed"]);

/**
 * The values that are recognized as somebody having parked the job on purpose.
 *
 * It changes no outcome — everything outside {@link ARMING_VALUES} parks either way — so it
 * is safe for it to be a closed list where the arming one has to be. What it decides is
 * whether a denial is worth telling anyone about, and only an exact spelling settles that:
 * an annotated `off — back Monday` is a sentence, and admitting sentences here would make
 * `on — back Monday` (which parks, and which nobody intended to) look deliberate too.
 * `sageox-agent job park` writes a bare `off` for exactly this reason.
 */
const PARKING_VALUES = new Set(["off", "false", "no", "0", "disabled", "parked"]);

/**
 * What one stored value means. The vocabulary is the switch's, not any transport's.
 *
 * Always `set` — a value in hand is evidence of intent, whatever it says. The other two
 * origins are facts about a read that did not reach one, which is why the transport builds
 * them and this never does.
 */
export function interpretSwitchValue(
  raw: string,
): { origin: "set"; state: SwitchState; value: SwitchValueClass } {
  const value = raw.trim().toLowerCase();
  if (ARMING_VALUES.has(value)) return { origin: "set", state: "on", value: "arming" };
  return {
    origin: "set",
    state: "off",
    value: PARKING_VALUES.has(value) ? "parking" : "unrecognized",
  };
}

/**
 * Admission for one job run: both switches, the human bypass, and the fail-direction.
 *
 * The switch parks **automation**, not the job. A pass somebody asked for is not
 * automation — a coworker is on the other end, they get the answer, and they can stop it —
 * so a human's on-request run happens even when the job is parked. The alternative is
 * borrowing a posture switch as a one-off button: arm, run once, disarm, which is
 * precisely how a job ends up left armed by somebody who only wanted one run.
 *
 * `on-request` is a trigger, not an authorization: a sibling agent asking, or a webhook
 * firing, is automation and is subject to the switch exactly like a cron tick. The fleet
 * enforces that with steering because it has no mechanism; here the inbound author is
 * already classified, so it is a mechanism.
 *
 * The bypass answers *does it run at all*, never *what may it do* — every domain gate is
 * untouched — and it never writes: a parked job is still parked after a human's run.
 */
export async function admitJob(
  job: JobConfig,
  request: JobRequest,
  source?: SwitchSource | null,
): Promise<JobAdmission> {
  // Read even when `suspend` already settles the outcome, so `bypassedSwitch` is a fact
  // rather than an assumption and the record says which posture the run happened under.
  const reading = job.killSwitch
    ? resolveSwitchReading(await lookUp(source, job.killSwitch.key), job.killSwitch.failDirection)
    : null;
  const soft = reading ? `kill switch ${describeSwitch(reading)}` : "no kill switch declared";
  const parked = job.suspend || reading?.state === "off";
  const byHuman = request.trigger === "on-request" && request.requestedBy?.kind === "human";

  if (!parked) {
    return { admitted: true, bypassedSwitch: false, switch: reading, reason: soft };
  }
  const posture = job.suspend ? "suspend: true in the manifest" : soft;
  if (byHuman) {
    return {
      admitted: true,
      bypassedSwitch: true,
      switch: reading,
      reason:
        `ran while parked (${posture}) at the request of ` +
        `${request.requestedBy?.id ?? "a human"}; the posture is unchanged`,
    };
  }
  return {
    admitted: false,
    // `suspend` names the denial when both are parked: it is the one a flip of the other
    // would not clear, and the one that takes a reviewed diff to lift.
    outcome: job.suspend ? "denied-suspend" : "denied-switch",
    bypassedSwitch: false,
    switch: reading,
    reason: `${posture}; only a human's on-request run bypasses a parked job`,
  };
}

/**
 * The three origins rendered as three different sentences.
 *
 * The fleet's anti-fabrication incidents were rendering bugs at least as often as logic
 * ones, and this is the render half of the distinction {@link SwitchOrigin} draws: a
 * reading that collapses to a bare `off` here has thrown away everything the read learned.
 */
export function describeSwitch(reading: SwitchReading): string {
  if (reading.origin === "set") {
    return reading.state === "on"
      ? "is on — someone armed it"
      : "is off — the value at this key is not one that arms a job";
  }
  if (reading.origin === "never-set") {
    return reading.state === "on"
      ? "has never been set, and this job runs unless it is parked"
      : "has never been set, so this job has never been armed";
  }
  return reading.state === "on"
    ? `could not be read (${reading.failure}), and this job runs on a switch it cannot read`
    : `could not be read (${reading.failure}), and this job does not run on a switch it cannot read`;
}

/**
 * What a lookup means for one job.
 *
 * The fail-direction is applied here and nowhere else, per job, from the manifest — never
 * inherited and never a shared default. The fleet gets this right today by passing a
 * different argument to a function copied into five runners, which is exactly how a sixth
 * runner inherits the wrong one.
 */
function resolveSwitchReading(
  lookup: SwitchLookup,
  failDirection: "open" | "closed",
): SwitchReading {
  if (lookup.origin === "set") {
    // Omitted rather than guessed when the source did not classify: a reader that saw
    // `value: "parking"` here would be reading this line's default, not the stored value.
    return { state: lookup.state, origin: "set", ...(lookup.value ? { value: lookup.value } : {}) };
  }
  const state: SwitchState = failDirection === "open" ? "on" : "off";
  return lookup.origin === "never-set"
    ? { state, origin: "never-set" }
    : { state, origin: "unreadable", failure: lookup.failure };
}

/** A missing backend and a thrown transport are both "we could not look", never "unset". */
async function lookUp(source: SwitchSource | null | undefined, key: string): Promise<SwitchLookup> {
  if (!source) return { origin: "unreadable", failure: "backend-missing" };
  try {
    return await source(key);
  } catch {
    return { origin: "unreadable", failure: "backend-error" };
  }
}
