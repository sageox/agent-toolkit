import { describe, expect, it } from "vitest";
import {
  HEALTH_STATES,
  type Health,
  type ProbeResult,
  probeEmpty,
  probeNotConfigured,
  probeNotFound,
  probeOk,
  probeUnavailable,
  probeWarming,
} from "../src/health.ts";
import {
  describeStartup,
  describeUnmet,
  evaluateStartup,
  precondition,
  preconditionFromProbe,
} from "../src/lifecycle.ts";
import { assembleTurnPrompt } from "../src/turn.ts";
import type { InboundEvent } from "../src/events.ts";

/** One reading per health state, so the sweeps below cover the whole enum. */
function sample(health: Health): ProbeResult {
  switch (health) {
    case "Ok":
      return probeOk("code:acme--service", "the code index is ready");
    case "NotConfigured":
      return probeNotConfigured("code:acme--private", ["GITHUB_TOKEN"], "mount it", "no token");
    case "Unavailable":
      return probeUnavailable("code:acme--docs", "clone-failed", "check the URL", "no clone");
    case "NotFound":
      return probeNotFound("brain.private", "mem/demo/core", "no entry at this key yet");
    case "Empty":
      return probeEmpty("code:acme--service", "re-run ox index code", "the index holds nothing");
    case "Warming":
      return probeWarming("code:acme--service", new Date("2026-08-19T06:35:21Z"), "building");
  }
}

const met = precondition("tools.policy", true, "a tool policy is loaded", "add tools: ./settings.json");

const event = (text: string): InboundEvent => ({
  id: { surface: "buzz", nativeId: "e1" },
  surface: "buzz",
  channel: { surface: "buzz", id: "hive", isPublic: false },
  author: { surface: "buzz", id: "npub1abc", isSelf: false, isAgent: false },
  text,
  mentionsMe: true,
  ts: "2026-08-19T06:35:21Z",
  raw: null,
});

it("a sample exists for every health state, so the sweeps below are exhaustive", () => {
  for (const state of HEALTH_STATES) expect(sample(state).health).toBe(state);
});

// --- THE DOCTRINE ------------------------------------------------------------
//
// An agent gating its own startup on a code index cost a fleet about 4.7 agent-hours a
// day of silence — not slow answers, no answers, because no process existed to receive
// the question. These two theorems are what stops that being re-added in good faith.

describe("THE THEOREM: no capability state, alone, can stop the agent reaching Ready", () => {
  it("holds for every state in the health enum, one at a time", () => {
    for (const state of HEALTH_STATES) {
      const verdict = evaluateStartup({ preconditions: [met], capabilities: [sample(state)] });
      expect(verdict.phase, `capability health ${state} must not gate startup`).toBe("Ready");
    }
  });

  it("holds for every state at once, which is the case a real fleet reaches", () => {
    const verdict = evaluateStartup({
      preconditions: [met],
      capabilities: HEALTH_STATES.map(sample),
    });
    expect(verdict.phase).toBe("Ready");
  });

  it("holds with no preconditions to satisfy and every capability broken", () => {
    const verdict = evaluateStartup({ capabilities: HEALTH_STATES.map(sample), preconditions: [] });
    expect(verdict.phase).toBe("Ready");
  });
});

// The second half of the same doctrine. Coming up Ready and then refusing the turn is the
// same silence reached one layer down: a disclosable gap converted back into nothing.
it("THE THEOREM at turn level: no capability state stops a turn being assembled", () => {
  for (const state of HEALTH_STATES) {
    const prompt = assembleTurnPrompt(event("still there?"), {
      agentName: "demo",
      capabilities: [sample(state)],
    });
    expect(prompt, `capability health ${state} must not block a turn`).toContain("still there?");
  }
});

it("an unsatisfied PRECONDITION is the only thing that produces Failed", () => {
  const verdict = evaluateStartup({
    preconditions: [precondition("tools.policy", false, "no policy staged", "add tools:")],
    capabilities: [sample("Ok")],
  });
  expect(verdict.phase).toBe("Failed");
  expect(verdict.unmet.map((p) => p.id)).toEqual(["tools.policy"]);
});

// --- the two axes, at startup ------------------------------------------------

it("discloses warming to the agent and announces it to nobody", () => {
  const verdict = evaluateStartup({
    preconditions: [met],
    capabilities: [sample("Warming"), sample("Unavailable")],
  });
  expect(verdict.disclosing.map((c) => c.health)).toEqual(["Warming", "Unavailable"]);
  expect(verdict.warming.map((c) => c.health)).toEqual(["Warming"]);
  expect(verdict.actionable.map((c) => c.health)).toEqual(["Unavailable"]);
});

it("discloses a healthy or merely absent capability to nobody", () => {
  const verdict = evaluateStartup({
    preconditions: [met],
    capabilities: [sample("Ok"), sample("NotFound")],
  });
  expect(verdict.disclosing).toEqual([]);
});

// --- the footgun guard -------------------------------------------------------

it("refuses to build a precondition from a Warming probe", () => {
  expect(() => preconditionFromProbe("code.index", sample("Warming"))).toThrow(
    /transient and self-healing/,
  );
});

it("refuses to build a precondition from a probe no human needs to act on", () => {
  for (const state of ["Ok", "NotFound"] as const) {
    expect(() => preconditionFromProbe("x", sample(state))).toThrow(/nothing to gate on/);
  }
});

it("carries the remedy through when the probe is actionable", () => {
  const gate = preconditionFromProbe("code.index", sample("NotConfigured"));
  expect(gate.satisfied).toBe(false);
  expect(gate.remedy).toBe("mount it");
});

it("refuses a precondition with no remedy — that shape is a capability", () => {
  expect(() => precondition("x", false, "observed", "   ")).toThrow(/it is a capability/);
});

// --- what an operator reads --------------------------------------------------

it("names the phase, the actionable set, and the warming set separately", () => {
  const line = describeStartup(
    evaluateStartup({
      preconditions: [met],
      capabilities: [sample("Warming"), sample("Unavailable")],
    }),
  );
  expect(line).toMatch(/phase=Ready/);
  expect(line).toMatch(/actionable=code:acme--docs:cannot-reach/);
  expect(line).toMatch(/warming=code:acme--service:still-warming/);
});

it("says nothing about capabilities on a failed startup — that is about preconditions", () => {
  const line = describeStartup(
    evaluateStartup({
      preconditions: [precondition("tools.policy", false, "no policy", "add it")],
      capabilities: [sample("Unavailable")],
    }),
  );
  expect(line).toMatch(/phase=Failed/);
  expect(line).toMatch(/unmet=tools\.policy/);
  expect(line).not.toContain("code:acme--docs");
});

// Fix one, restart into the next, fix that: a five-minute misconfiguration becomes an
// afternoon. Every unmet precondition names its own remedy in one message.
it("reports every unmet precondition with what to do about it", () => {
  const message = describeUnmet(
    evaluateStartup({
      preconditions: [
        precondition("tools.policy", false, "no policy staged", "add tools: ./settings.json"),
        precondition("identity", false, "no signing key", "run sageox-agent identity create"),
      ],
    }),
  );
  expect(message).toContain("tools.policy");
  expect(message).toContain("add tools: ./settings.json");
  expect(message).toContain("identity");
  expect(message).toContain("run sageox-agent identity create");
});
