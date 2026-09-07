import { describe, it, expect } from "vitest";
import {
  verdictFromGate,
  combineVerdicts,
  describeVerdict,
  isProven,
  type Verdict,
} from "../src/verdict.ts";

const pass = (gate: string) => verdictFromGate({ gate, executed: true, exitCode: 0 });
const fail = (gate: string) => verdictFromGate({ gate, executed: true, exitCode: 1 });
const unproven = (gate: string) => verdictFromGate({ gate, executed: false, exitCode: null });

describe("verdictFromGate", () => {
  it("returns UNKNOWN, never PASS, for a gate that did NOT execute", () => {
    const v = unproven("existing-suite");
    expect(v.status).toBe("UNKNOWN");
    expect(isProven(v)).toBe(false);
  });
  it("returns UNKNOWN for an executed gate with no exit code (killed/timed out)", () => {
    const v = verdictFromGate({ gate: "ci", executed: true, exitCode: null });
    expect(v.status).toBe("UNKNOWN");
    expect(isProven(v)).toBe(false);
  });
  it("returns PASS only for an executed, exit-0 gate", () => {
    const v = pass("existing-suite");
    expect(v.status).toBe("PASS");
    expect(isProven(v)).toBe(true);
  });
  it("returns FAIL for an executed non-zero gate", () => {
    const v = fail("adversarial-tests");
    expect(v.status).toBe("FAIL");
    expect(isProven(v)).toBe(false);
  });
});

describe("combineVerdicts", () => {
  it("is UNKNOWN on empty input — no gates ran is never success", () => {
    expect(combineVerdicts([]).status).toBe("UNKNOWN");
  });
  it("is PASS only when every gate is PASS", () => {
    expect(combineVerdicts([pass("a"), pass("b")]).status).toBe("PASS");
  });
  it("lets any FAIL dominate", () => {
    expect(combineVerdicts([pass("a"), fail("b")]).status).toBe("FAIL");
  });
  it("never swallows an UNKNOWN into PASS", () => {
    expect(combineVerdicts([pass("a"), unproven("b")]).status).toBe("UNKNOWN");
  });
  it("still refuses PASS when an UNKNOWN and a FAIL are both present", () => {
    expect(combineVerdicts([pass("a"), unproven("b"), fail("c")]).status).toBe("FAIL");
  });
});

// These assertions are the contract, not a description of today's wording: a rewording
// that puts a success word back into UNKNOWN or FAIL must fail here.
describe("describeVerdict", () => {
  it("never renders UNKNOWN as clean/green/ok, and never opens with PROVEN", () => {
    const text = describeVerdict(unproven("ci"));
    expect(text).toMatch(/NOT PROVEN/);
    expect(text.startsWith("PROVEN")).toBe(false);
    expect(text).not.toMatch(/\b(clean|green|ok)\b/i);
  });
  it("never renders FAIL as clean/green", () => {
    const text = describeVerdict(fail("ci"));
    expect(text.startsWith("FAILED")).toBe(true);
    expect(text).not.toMatch(/\b(clean|green)\b/i);
  });
  it("reads as proven only for PASS", () => {
    expect(describeVerdict(pass("ci")).startsWith("PROVEN")).toBe(true);
  });
});

// `JobConfig.report`'s contract: the shape is the toolkit's, the words are the agent's.
// A body that writes a sentence about a gate gets that sentence in the status post.
describe("a gate's own detail", () => {
  const said = (gate: string, exitCode: number | null, detail: string) =>
    verdictFromGate({ gate, executed: true, exitCode, detail });

  it("replaces the machine phrasing, verbatim and unescaped", () => {
    // The shape a fleet's channel lines are written in: a short linked reference, so the
    // reader does not pay a round trip for a bare number. Nothing here may rewrite it.
    const line = "filed [#537](https://example.test/i/537), declined 2 as already open";
    expect(describeVerdict(said("triage", 0, line))).toBe(`PROVEN: ${line}`);
  });

  it("leaves a gate that said nothing exactly as it reads today", () => {
    expect(describeVerdict(pass("ci"))).toBe("PROVEN: ci passed (gate ci exited 0).");
    expect(describeVerdict(fail("ci"))).toBe("FAILED: ci did not pass (gate ci exited 1).");
    expect(describeVerdict(unproven("ci"))).toBe(
      "NOT PROVEN: gate ci did not execute. No verdict — treat as unsafe until a gate runs.",
    );
  });

  it("keeps the status word in front of it, so a body cannot phrase its own pass", () => {
    expect(describeVerdict(said("ci", 1, "everything looks clean"))).toBe(
      "FAILED: everything looks clean",
    );
    // The UNKNOWN warning still lands, as its own sentence: a body's line that ends
    // without a full stop must not run into the toolkit's words.
    expect(describeVerdict(said("ci", null, "everything looks clean"))).toBe(
      "NOT PROVEN: everything looks clean. No verdict — treat as unsafe until a gate runs.",
    );
    expect(describeVerdict(said("ci", null, "nothing came back?"))).toBe(
      "NOT PROVEN: nothing came back? No verdict — treat as unsafe until a gate runs.",
    );
  });

  it("is dropped by combineVerdicts, so the run's own verdict stays host-phrased", () => {
    const combined = combineVerdicts([said("ci", 1, "shipped it")]);
    expect(combined.detail).toBeUndefined();
    expect(describeVerdict(combined)).toBe("FAILED: combined did not pass (ci: gate ci exited 1).");
  });
});

// `report.proven: verbatim` — presentation, and only over PASS. These assertions are the
// contract: a rewording that lets `verbatim` reach FAIL or UNKNOWN must fail here.
describe("a proven line rendered verbatim", () => {
  const said = (gate: string, exitCode: number | null, detail: string) =>
    verdictFromGate({ gate, executed: true, exitCode, detail });
  const shift = "The bench is full, so I tended [#3961](https://example.test/p/3961) instead.";

  it("renders a passing body's own sentence as written", () => {
    expect(describeVerdict(said("shift", 0, shift), "verbatim")).toBe(shift);
  });

  it("still labels a passing gate that said nothing — that sentence is the host's", () => {
    expect(describeVerdict(pass("ci"), "verbatim")).toBe("PROVEN: ci passed (gate ci exited 0).");
  });

  it("cannot take the label off a FAIL or an UNKNOWN", () => {
    expect(describeVerdict(said("ci", 1, "everything looks clean"), "verbatim")).toBe(
      "FAILED: everything looks clean",
    );
    expect(describeVerdict(said("ci", null, "everything looks clean"), "verbatim")).toBe(
      "NOT PROVEN: everything looks clean. No verdict — treat as unsafe until a gate runs.",
    );
  });

  it("keeps the label on an empty sentence, so no setting can post a blank line", () => {
    // `GateResultSchema` bounds `detail` with `string().optional()` and no `min(1)`, so a
    // body may write an empty one — and `??` keeps it rather than composing the fallback.
    // Truthiness is the whole of what stands between that and a channel line with nothing
    // in it, and it is one keystroke from a change that reads like a tidy-up.
    expect(describeVerdict(said("shift", 0, ""), "verbatim")).toBe("PROVEN: ");
    expect(describeVerdict(said("shift", 0, ""))).toBe("PROVEN: ");
  });

  it("changes nothing when it is not asked for", () => {
    expect(describeVerdict(said("shift", 0, shift))).toBe(`PROVEN: ${shift}`);
    expect(describeVerdict(said("shift", 0, shift), "labelled")).toBe(`PROVEN: ${shift}`);
  });
});

// The `@ts-expect-error` cases are checked by `pnpm typecheck`, which fails if any of
// them stops erroring — that is the regression worth catching.
describe("a verdict cannot be forged", () => {
  it("refuses a hand-written PASS", () => {
    // @ts-expect-error - a plain object is not a Verdict.
    const composed: Verdict = { status: "PASS", gate: "fabricated", reason: "never ran" };
    expect(composed.status).toBe("PASS"); // the type is the fence; a cast still lies
  });

  it("refuses a spread that swaps the status of a minted verdict", () => {
    // @ts-expect-error - the copy is a plain object, so it is not a Verdict either.
    const laundered: Verdict = { ...unproven("ci"), status: "PASS" };
    expect(laundered.status).toBe("PASS");
  });

  it("throws instead of letting a minted UNKNOWN be edited into a PASS", () => {
    const v = unproven("ci");
    expect(() => {
      // @ts-expect-error - `status` is readonly.
      v.status = "PASS";
    }).toThrow(TypeError);
    expect(v.status).toBe("UNKNOWN");
    expect(describeVerdict(v)).toMatch(/NOT PROVEN/);
  });

  it("throws on a redefined property, which is how a freeze gets worked around", () => {
    const v = fail("ci");
    expect(() => Object.defineProperty(v, "status", { value: "PASS" })).toThrow(TypeError);
    expect(isProven(v)).toBe(false);
  });
});
