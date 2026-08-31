import { describe, expect, it } from "vitest";
import {
  HEALTH_STATES,
  HEALTH_WORD,
  describeHealth,
  isActionable,
  isDegrading,
  isTransient,
  needsHuman,
  probeEmpty,
  probeNotConfigured,
  probeNotFound,
  probeOk,
  probeUnavailable,
  probeWarming,
} from "../src/health.ts";

describe("the anti-collapse invariant", () => {
  // The bug this file exists for: one word served two states, and every surface
  // downstream inherited a distinction that had already been thrown away.
  it("gives all six states distinct words", () => {
    const words = HEALTH_STATES.map((state) => HEALTH_WORD[state]);
    expect(new Set(words).size).toBe(HEALTH_STATES.length);
  });

  it("will not build a NotConfigured that cannot name what is missing", () => {
    expect(() => probeNotConfigured("brain.team", [], "set the token", "unset")).toThrow(
      /collapse back into one word/,
    );
  });

  // Two states, two payloads, and neither constructor takes the other's argument. This is
  // the type-level half of the same invariant: the collapse is unwritable, not merely
  // discouraged.
  it("renders NotConfigured and Unavailable with payloads no other state has", () => {
    const never = describeHealth(
      probeNotConfigured("brain.team", ["SAGEOX_TOKEN"], "mount the token", "never set up"),
    );
    const cannot = describeHealth(
      probeUnavailable("brain.team", "index-failed", "check ox", "the index would not build"),
    );
    expect(never).toContain("verdict=never-configured");
    expect(never).toContain("missing=SAGEOX_TOKEN");
    expect(cannot).toContain("verdict=cannot-reach");
    expect(cannot).toContain("failure=index-failed");
  });
});

describe("Warming is disclosed to the agent and announced to nobody", () => {
  const cold = probeWarming("code:acme--service", new Date("2026-08-19T06:35:21Z"), "building");

  it("is degrading and is not something a human must act on", () => {
    expect(isDegrading("Warming")).toBe(true);
    expect(needsHuman("Warming")).toBe(false);
    expect(isActionable(cold)).toBe(false);
  });

  // `remedy` is what says "a human must act". A grep for it must find exactly the readings
  // that mean it, or the announcement stops being worth reading.
  it("carries a timestamp instead of a remedy", () => {
    const line = describeHealth(cold);
    expect(line).toContain("since=2026-08-19T06:35:21Z");
    expect(line).not.toContain("remedy=");
  });

  it("is the only state a caller must re-read rather than latch", () => {
    const transient = HEALTH_STATES.filter(isTransient);
    expect(transient).toEqual(["Warming"]);
  });
});

describe("the two axes", () => {
  // `isDegrading` gates what the agent says. `needsHuman` gates what a person is told.
  // They agreed for every state that existed before Warming, which is exactly why one
  // predicate was doing both jobs and why substituting them still type-checks.
  it("disclose and announce differ on exactly one state", () => {
    const disclose = HEALTH_STATES.filter(isDegrading);
    const announce = HEALTH_STATES.filter(needsHuman);
    expect(disclose).toEqual(["NotConfigured", "Unavailable", "Empty", "Warming"]);
    expect(announce).toEqual(["NotConfigured", "Unavailable", "Empty"]);
  });

  // A store that answers with nothing is the one failure an agent cannot feel: the search
  // returns fluent prose either way. A key with no entry is a normal answer.
  it("discloses an empty store and says nothing about a missing key", () => {
    expect(isDegrading("Empty")).toBe(true);
    expect(isDegrading("NotFound")).toBe(false);
    expect(isDegrading("Ok")).toBe(false);
  });

  it("narrows an actionable reading to one that has a remedy", () => {
    const reading = probeEmpty("code:acme--service", "re-run ox index code", "holds nothing");
    expect(isActionable(reading)).toBe(true);
    // The point of the type guard: `.remedy` without a cast, because every member has one.
    if (isActionable(reading)) expect(reading.remedy).toBe("re-run ox index code");
  });

  it("refuses an actionable reading with no action in it", () => {
    expect(() => probeUnavailable("code:x", "clone-failed", "  ", "it did not clone")).toThrow(
      /the announcement people learn to skip/,
    );
  });
});

describe("describeHealth", () => {
  it("writes one greppable line per state, and no two the same", () => {
    const lines = [
      probeOk("a", "answered"),
      probeNotConfigured("b", ["TOKEN"], "mount it", "never set up"),
      probeUnavailable("c", "fetch-failed", "fix the checkout", "could not fast-forward"),
      probeNotFound("d", "mem/demo/core", "no entry"),
      probeEmpty("e", "reindex", "holds nothing"),
      probeWarming("f", new Date("2026-08-19T06:35:21Z"), "building"),
    ].map(describeHealth);
    expect(new Set(lines).size).toBe(lines.length);
    for (const line of lines) expect(line).toMatch(/^capability=\S+ verdict=\S+ state=\S+ /);
  });
});
