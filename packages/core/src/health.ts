// The closed set of health states one capability may report, and the typed readings
// that carry them.
//
// A capability is anything the agent can do that can be missing without making the agent
// WRONG: a repository index, a brain, a hosted tool. Whether the agent RUNS is the
// lifecycle's business ([`lifecycle.ts`](./lifecycle.ts)); this file decides only what it
// SAYS when asked.
//
// The reason it is a closed set of typed states rather than a status string: a fleet's
// encrypted memory silently never worked because "never configured" and "cannot read"
// both surfaced as one word. A fail-open reader rode straight through that word, a
// fail-closed one treated it as off forever, and no human could tell the two apart from
// any surface the system produced. So `NotConfigured` and `Unavailable` are two states,
// they carry DIFFERENT PAYLOADS — neither constructor accepts the other's arguments — and
// they render different words. Collapsing them, into one state or one branch, reinstates
// the bug.
//
// `Warming` is the same argument made once more. The test that separates these states is
// "where does this send a human?" — `NotConfigured` sends them to the configuration,
// `Unavailable` sends them to the backend, and `Warming` sends them NOWHERE: it is
// transient, it resolves itself, and there is nothing to do but wait. Third destination,
// third state. Announce "a human must act" for something that fixes itself in four
// minutes on every deploy and you have taught the team to skim past announcements, which
// you pay for in full the next time one is real.

export const HEALTH_STATES = [
  "Ok",
  "NotConfigured",
  "Unavailable",
  "NotFound",
  "Empty",
  "Warming",
] as const;
export type Health = (typeof HEALTH_STATES)[number];

/**
 * Why a probe could not reach a value. A closed vocabulary, and never the exception text:
 * a subprocess puts its own prose on the error stream and that stream is remote-controlled
 * — it reaches a model turn, so it is an injection surface, not a diagnostic. The larger
 * reason is that each value below sends a human somewhere different, which prose does not.
 *
 * One member per failure a capability here actually reports. A new capability adds its
 * own; nothing is listed speculatively, because a class nothing produces is a class
 * nobody has decided the remedy for.
 */
const PROBE_FAILURES = [
  "origin-mismatch",
  "clone-failed",
  "fetch-failed",
  "index-failed",
  // The team brain's two, spelled the same as the `OxFailure` classes they are latched
  // from, so `failure=not-authenticated` here and `class=not-authenticated` on the
  // `ox_failed` line are one word to grep for rather than two.
  "not-installed",
  "not-authenticated",
] as const;
export type ProbeFailure = (typeof PROBE_FAILURES)[number];

/**
 * One word per state, and the six must stay distinct.
 *
 * A dedicated field rather than words buried in prose, so the anti-collapse test can
 * assert distinctness directly instead of hunting substrings. This is the artifact that
 * broke last time: one word served two states, and no amount of careful prose downstream
 * recovered a distinction the word had already thrown away.
 *
 * Not called a verdict, though that is what it is: a {@link ./verdict.ts | Verdict} in
 * this toolkit is what a job run PROVED, and two things called a verdict is how the
 * collapse this module exists to prevent happens to the word itself.
 */
export const HEALTH_WORD: Readonly<Record<Health, string>> = Object.freeze({
  Ok: "ok",
  NotConfigured: "never-configured",
  Unavailable: "cannot-reach",
  NotFound: "no-such-entry",
  Empty: "nothing-stored",
  Warming: "still-warming",
});

interface ProbeBase {
  /**
   * What was read, as an id an operator can grep and a model can name — `code:service`,
   * `brain.team`. Stable across readings of the same thing.
   */
  readonly capability: string;
  /**
   * What was observed, in one line. Reaches a model turn, so it is written by the caller
   * from values the caller controls: never a secret, never a subprocess's own words.
   */
  readonly reason: string;
}

export interface OkResult extends ProbeBase {
  readonly health: "Ok";
}

/**
 * It was never set up. `missing` names the configuration that is absent — required, and
 * required to be non-empty, because a `NotConfigured` naming nothing is a claim its author
 * cannot back up, and an unbacked claim is how this state drifts back toward `Unavailable`.
 */
export interface NotConfiguredResult extends ProbeBase {
  readonly health: "NotConfigured";
  readonly missing: readonly string[];
  readonly remedy: string;
}

/** It is set up, and we could not reach it. Says nothing about intent or content. */
export interface UnavailableResult extends ProbeBase {
  readonly health: "Unavailable";
  readonly failure: ProbeFailure;
  readonly remedy: string;
}

/** Configured, reachable, and this key has no entry. A normal answer, not a fault. */
export interface NotFoundResult extends ProbeBase {
  readonly health: "NotFound";
  readonly key: string;
}

/**
 * Configured, reachable, and holding nothing.
 *
 * Its own state because it is the one failure an agent cannot feel: a search over an empty
 * index returns fluent, plausible prose, so the symptom is a confident wrong answer rather
 * than an error.
 */
export interface EmptyResult extends ProbeBase {
  readonly health: "Empty";
  readonly remedy: string;
}

/**
 * Configured, reachable, and building itself right now. It will be `Ok` shortly with
 * nobody doing anything.
 *
 * There is no `remedy` field, and that absence is the point. Every other degrading state
 * has one because a human must act; this one has nothing for anyone to do, and a type that
 * cannot express a remedy cannot accidentally announce one. Wanting to put a remedy here
 * means the state is `Unavailable`.
 *
 * `since` is what a human reads instead — a warmup that started forty minutes ago is still
 * honestly `Warming`, and the timestamp is what says so. Promoting it to `Unavailable` on
 * a timer would page somebody for a slow disk.
 */
export interface WarmingResult extends ProbeBase {
  readonly health: "Warming";
  /** ISO-8601 UTC, whole seconds, trailing Z. When the warmup started. */
  readonly since: string;
}

export type ProbeResult =
  | OkResult
  | NotConfiguredResult
  | UnavailableResult
  | NotFoundResult
  | EmptyResult
  | WarmingResult;

// --- constructors -----------------------------------------------------------
//
// Use these rather than object literals. They are the enforcement point for the payload
// asymmetry above: `probeNotConfigured` demands the names of what is missing,
// `probeUnavailable` demands a failure class, `probeWarming` has nowhere to put a remedy,
// and none of them will accept another's argument.

export function probeOk(capability: string, reason: string): OkResult {
  return { health: "Ok", capability, reason };
}

export function probeNotConfigured(
  capability: string,
  missing: readonly string[],
  remedy: string,
  reason: string,
): NotConfiguredResult {
  if (missing.length === 0) {
    throw new TypeError(
      `probeNotConfigured(${capability}) needs the names of what is missing — an empty list ` +
        `means the caller does not actually know this was never configured, and reporting it ` +
        `anyway is how NotConfigured and Unavailable collapse back into one word`,
    );
  }
  return {
    health: "NotConfigured",
    capability,
    missing,
    remedy: requireRemedy(capability, "NotConfigured", remedy),
    reason,
  };
}

export function probeUnavailable(
  capability: string,
  failure: ProbeFailure,
  remedy: string,
  reason: string,
): UnavailableResult {
  return {
    health: "Unavailable",
    capability,
    failure,
    remedy: requireRemedy(capability, "Unavailable", remedy),
    reason,
  };
}

export function probeNotFound(capability: string, key: string, reason: string): NotFoundResult {
  return { health: "NotFound", capability, key, reason };
}

export function probeEmpty(capability: string, remedy: string, reason: string): EmptyResult {
  return {
    health: "Empty",
    capability,
    remedy: requireRemedy(capability, "Empty", remedy),
    reason,
  };
}

/**
 * Note the signature: no `remedy` parameter, and no overload that takes one. A caller
 * holding a remedy string has diagnosed something other than a warmup.
 */
export function probeWarming(capability: string, since: Date, reason: string): WarmingResult {
  return {
    health: "Warming",
    capability,
    since: `${since.toISOString().slice(0, 19)}Z`,
    reason,
  };
}

/** An announcement with no action in it is noise that trains people to ignore the next one. */
function requireRemedy(capability: string, health: Health, remedy: string): string {
  if (remedy.trim() === "") {
    throw new TypeError(
      `${capability}: a ${health} reading needs a remedy — it is the one state field addressed ` +
        `at a person, and a reading that announces "a human must act" without saying what to do ` +
        `is the announcement people learn to skip`,
    );
  }
  return remedy;
}

// --- reading a result -------------------------------------------------------

/**
 * One greppable line per reading. Every state leads with its own word and carries a
 * payload no other state has, so two readings can never render identically.
 */
export function describeHealth(result: ProbeResult): string {
  const head = `capability=${result.capability} verdict=${HEALTH_WORD[result.health]} state=${result.health}`;
  switch (result.health) {
    case "Ok":
      return `${head} reason="${result.reason}"`;
    case "NotConfigured":
      return `${head} missing=${result.missing.join(",")} reason="${result.reason}" remedy="${result.remedy}"`;
    case "Unavailable":
      return `${head} failure=${result.failure} reason="${result.reason}" remedy="${result.remedy}"`;
    case "NotFound":
      return `${head} key=${result.key} reason="${result.reason}"`;
    case "Empty":
      return `${head} reason="${result.reason}" remedy="${result.remedy}"`;
    case "Warming":
      // No remedy=, and a since= nothing else emits. A grep for remedy= finds exactly the
      // readings a human has to do something about.
      return `${head} since=${result.since} reason="${result.reason}"`;
  }
}

/**
 * States that mean the agent must DISCLOSE — run, work, and say out loud what it cannot do
 * — rather than either refusing the turn or answering as if nothing were wrong.
 *
 * `NotFound` is absent on purpose: a key with no entry is a normal answer. `Empty` is
 * present on purpose: a store that answers with nothing is the failure the agent cannot
 * feel. `Warming` is present on purpose: a half-built index is `Empty` wearing a clock,
 * and it lies exactly as fluently.
 */
const DEGRADING: ReadonlySet<Health> = new Set<Health>([
  "NotConfigured",
  "Unavailable",
  "Empty",
  "Warming",
]);

/**
 * The subset a HUMAN must act on — `DEGRADING` minus `Warming`. The two sets existing
 * separately is the whole reason `Warming` is a state.
 *
 * Before it, one predicate answered two different questions — "should the agent say
 * something?" and "should a human do something?" — because for every state then defined
 * the answers happened to agree. They no longer do, and a caller that keeps using
 * {@link isDegrading} to decide whether to page, post, or open an issue will do all three
 * for a cache that is four minutes from ready.
 *
 * `isDegrading` gates the agent's DISCLOSURE. `needsHuman` gates everything addressed at a
 * person — the operator line, the alert, the `remedy`. Never substitute one for the other.
 */
const NEEDS_HUMAN: ReadonlySet<Health> = new Set<Health>([
  "NotConfigured",
  "Unavailable",
  "Empty",
]);

/** States that clear themselves, with nobody acting. Today: exactly one. */
const TRANSIENT: ReadonlySet<Health> = new Set<Health>(["Warming"]);

export function isDegrading(health: Health): boolean {
  return DEGRADING.has(health);
}

export function needsHuman(health: Health): boolean {
  return NEEDS_HUMAN.has(health);
}

/**
 * True when the state is expected to resolve on its own, so a caller must re-read rather
 * than latch it: a transient state read once and cached is a permanent one. It is why
 * readings are handed to a turn as a function and re-read per turn, never captured at
 * startup — an agent that apologizes for a cold index long after it went warm is a caching
 * bug wearing a disclosure.
 */
export function isTransient(health: Health): boolean {
  return TRANSIENT.has(health);
}

/**
 * The readings a human must act on, AS A TYPE — so "has a remedy" is something the
 * compiler knows rather than something each caller re-derives.
 *
 * This is the payload asymmetry paying off: every member carries `remedy` and no
 * non-member does. A caller that narrows through `isActionable` reaches `.remedy`
 * directly; one that hand-rolls `needsHuman(r.health)` gets a type error, which is the
 * compiler pointing at the exact place the two sets were about to be conflated again.
 */
export type ActionableResult = NotConfiguredResult | UnavailableResult | EmptyResult;

export function isActionable(result: ProbeResult): result is ActionableResult {
  return NEEDS_HUMAN.has(result.health);
}
