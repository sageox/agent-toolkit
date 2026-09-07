// "Run the tool. Never compose the verdict."
//
// A gate that did NOT execute is UNKNOWN, never PASS: an unrun test and a passing
// test read identically in prose, which is how an agent ends up reporting all-clear
// for a check it never ran.
//
// A GateResult is an observation, reported by whoever tried to run the gate. This
// module turns one into a verdict and does nothing else — it spawns nothing (the
// first consumer's main gate is a CI result read over an API) and cannot know
// whether a caller claiming `executed: true` ran anything.

export type VerdictStatus = "PASS" | "FAIL" | "UNKNOWN";

/**
 * The result of trying to run one gate.
 *
 * The two fields are orthogonal on purpose: `executed` answers *did it start*, `exitCode`
 * answers *what did it say*. A gate killed or timed out mid-run started and never got to
 * speak, so it is `{executed: true, exitCode: null}`.
 *
 * This matters more than it reads. A job body serializes a `GateResult` to JSON for the
 * job host to read back, so a producer who took `executed` to mean "ran to completion"
 * would encode that killed gate as `false` while one reading the rules would encode it as
 * `true`. Both still yield UNKNOWN — no verdict is ever wrong — but two encodings of one
 * state is a defect in a cross-process contract.
 */
export interface GateResult {
  gate: string;
  /** Did the gate process START? Nothing about how it ended — see `exitCode`. */
  executed: boolean;
  /** What it said on the way out. `null` when it never said anything. */
  exitCode: number | null;
  /**
   * The body's own sentence about this gate. Never used to decide; it replaces the
   * machine-phrased reason in the threaded status line — see `describeVerdict`.
   */
  detail?: string;
}

/**
 * A class, not an interface, so a verdict cannot be composed (`{ status: "PASS" }`)
 * or laundered (`{ ...v, status: "PASS" }`): `#minted` makes the type nominal and
 * both of those produce plain objects. A symbol brand does NOT work — TypeScript
 * carries a symbol-keyed property through a spread. The freeze closes editing, since
 * `readonly` is erased. Exported as a type only, so `new` is unreachable outside.
 */
class MintedVerdict {
  // @ts-expect-error -- TS6133: never read on purpose; its presence is what brands the type.
  readonly #minted = true;

  constructor(
    readonly status: VerdictStatus,
    readonly gate: string,
    readonly reason: string,
    /** The body's own sentence about this gate, when it wrote one. Never decides anything. */
    readonly detail?: string,
  ) {
    Object.freeze(this);
  }
}

export type Verdict = MintedVerdict;

/** The only constructor of a PASS, and only for a gate that executed and exited 0. */
export function verdictFromGate(result: GateResult): Verdict {
  const { gate, executed, exitCode, detail } = result;

  if (!executed) return new MintedVerdict("UNKNOWN", gate, `gate ${gate} did not execute`, detail);

  // Killed or timed out mid-run: we only know it passed if it says so with a 0.
  if (exitCode === null)
    return new MintedVerdict(
      "UNKNOWN",
      gate,
      `gate ${gate} executed but returned no exit code`,
      detail,
    );

  if (exitCode === 0) return new MintedVerdict("PASS", gate, `gate ${gate} exited 0`, detail);

  return new MintedVerdict("FAIL", gate, `gate ${gate} exited ${exitCode}`, detail);
}

/**
 * FAIL dominates, then UNKNOWN. Empty input is UNKNOWN — "no gates ran" is not
 * success. If any leg is unproven, the whole thing is unproven.
 *
 * The combination carries no `detail`. It is what the headline is rendered from, and a
 * body that could phrase the run's one-line verdict could phrase its own PASS.
 */
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) {
    return new MintedVerdict("UNKNOWN", "combined", "no gates ran");
  }
  const fail = verdicts.find((v) => v.status === "FAIL");
  if (fail) {
    return new MintedVerdict("FAIL", "combined", `${fail.gate}: ${fail.reason}`);
  }
  const unknown = verdicts.find((v) => v.status === "UNKNOWN");
  if (unknown) {
    return new MintedVerdict("UNKNOWN", "combined", `${unknown.gate}: ${unknown.reason}`);
  }
  return new MintedVerdict("PASS", "combined", `all ${verdicts.length} gates exited 0`);
}

/**
 * How a passing line is rendered — the only presentation choice a job gets, and it reaches
 * PASS alone.
 *
 * `labelled` is the default and the shape every job has had: `PROVEN:` in front of the
 * sentence. `verbatim` drops that word for the sentences a *body* wrote — a passing gate
 * carrying a `detail` renders as that detail and nothing else — so a job whose gates are a
 * shift report reads as one. A passing gate with no `detail` is unmoved by it: the sentence
 * there is the host's machine phrasing, and unlabelled machine phrasing is not prose.
 *
 * FAIL and UNKNOWN are unmoved by either value. Their label is the whole of what stops a
 * body's reassuring sentence from reading as a pass, and no setting may take it away.
 */
export type ProvenVoice = "labelled" | "verbatim";

/**
 * UNKNOWN and FAIL must not contain a word a skimming reader could mistake for
 * success. `verdict.test.ts` asserts it.
 *
 * A gate's `detail` replaces the machine phrasing of the reason and nothing else: the
 * status word in front of it is still this module's, so a body that writes "all clear"
 * on a gate that exited 1 gets "FAILED: all clear" rather than a line that reads as a
 * pass. `combineVerdicts` never copies a detail forward, so the run's own verdict — the
 * one `jobStatus` puts in the headline — stays entirely host-phrased, under either
 * {@link ProvenVoice}: there is no detail on a combined verdict for `verbatim` to render.
 */
export function describeVerdict(v: Verdict, proven: ProvenVoice = "labelled"): string {
  switch (v.status) {
    case "PASS": {
      // Tested against `v.detail` rather than against `said`: the label comes off the
      // body's own sentence, never off the fallback composed on the line above. Truthiness
      // rather than `!== undefined` — `detail: ""` is admissible and reaches `said` intact,
      // so the stricter test that would look like it matched the `??` renders a line with
      // nothing in it.
      const said = v.detail ?? `${v.gate} passed (${v.reason}).`;
      return proven === "verbatim" && v.detail ? said : `PROVEN: ${said}`;
    }
    case "FAIL":
      return `FAILED: ${v.detail ?? `${v.gate} did not pass (${v.reason}).`}`;
    case "UNKNOWN": {
      // A second sentence follows here and nowhere else, so this is the one branch where a
      // body's line, if it ended without a full stop, would run into the toolkit's words.
      let said = v.detail ?? `${v.reason}.`;
      if (!/[.!?]$/.test(said)) said += ".";
      return `NOT PROVEN: ${said} No verdict — treat as unsafe until a gate runs.`;
    }
  }
}

export function isProven(v: Verdict): boolean {
  return v.status === "PASS";
}
