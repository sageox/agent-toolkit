import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BYPASS_CASES, NOT_ESTABLISHED, POLICY_CASES } from "./cases.ts";
import { classifyRefusal, FIXTURES, runPolicyCase, VERDICTS } from "./harness.ts";

describe("the adjudicated case table", () => {
  it.each(POLICY_CASES.map((c) => [c.id, c] as const))("%s", async (_id, policyCase) => {
    const outcome = await runPolicyCase(policyCase.fixture, policyCase.tool, policyCase.args);

    expect(outcome.verdict, `${policyCase.id}: ${outcome.detail ?? "no detail"}`).toBe(
      policyCase.expect,
    );

    // The verdict rule, asserted rather than trusted to the harness. `Allowed` needs
    // positive evidence that the call reached the server, and every refusal needs evidence
    // that it did not — a boundary that says no after relaying the call has not refused
    // anything.
    if (policyCase.expect === "Allowed") expect(outcome.requests.length).toBeGreaterThan(0);
    else expect(outcome.requests).toEqual([]);
  });
});

describe("the harness's own verdict rule", () => {
  it("gives each gate its own word", () => {
    expect(
      classifyRefusal(new Error("MCP call refused: tool mcp__github__pr_create is denied by policy")),
    ).toBe("Denied");
    expect(
      classifyRefusal(new Error("MCP call refused: tool mcp__github__pr_list is not allowlisted")),
    ).toBe("Unlisted");
    expect(
      classifyRefusal(
        new Error("mcp__github__pr_list refused: this server is bound to repo ∈ {acme/service}"),
      ),
    ).toBe("OutOfBounds");
    expect(
      classifyRefusal(
        new Error("mcp__github__pr_create refused by leakPatterns: the text matched fake-token"),
      ),
    ).toBe("Leaked");
  });

  it("keeps a deny rule and an inert allow rule apart", () => {
    // The load-bearing pair. Both mean "the policy refused", and collapsing them would
    // make a rule that matches nothing indistinguishable from a rule someone wrote on
    // purpose — which is the entire finding in sections A and B.
    const denied = classifyRefusal(new Error("x refused: tool y is denied by policy"));
    const unlisted = classifyRefusal(new Error("x refused: tool y is not allowlisted"));
    expect(denied).not.toBe(unlisted);
  });

  it("calls an unrecognised refusal Broken rather than folding it into a neighbour", () => {
    // The fleet guard's exit-code lesson, ported: "not the blocked code" was read as
    // "allowed", so a guard that crashed before inspecting a flag passed its own tests.
    // Anything outside the explicit set is Broken and fails the suite.
    expect(classifyRefusal(new Error("ECONNREFUSED 127.0.0.1:443"))).toBe("Broken");
    expect(classifyRefusal("not an Error at all")).toBe("Broken");
  });
});

describe("the table's own integrity", () => {
  it("names a fixture that exists and carries both halves of the policy", () => {
    for (const policyCase of POLICY_CASES) {
      const parsed = JSON.parse(readFileSync(join(FIXTURES, policyCase.fixture), "utf8")) as {
        permissions?: unknown;
        mcpServers?: unknown;
      };
      // `scope` made the decision joint across two config surfaces, so a fixture that
      // carried only one of them would be half a question.
      expect(parsed.permissions, policyCase.fixture).toBeDefined();
      expect(parsed.mcpServers, policyCase.fixture).toBeDefined();
    }
  });

  it("drives every fixture from at least one case", () => {
    // A fixture nobody drives is a fixture that rots into a description of a policy
    // nothing enforces — the shape of test this directory exists to replace.
    const used = new Set(POLICY_CASES.map((c) => c.fixture));
    expect(readdirSync(FIXTURES).sort()).toEqual([...used].sort());
  });

  it("keeps ids unique and gives every row a reason to exist", () => {
    expect(new Set(POLICY_CASES.map((c) => c.id)).size).toBe(POLICY_CASES.length);
    for (const policyCase of POLICY_CASES) {
      expect(VERDICTS).toContain(policyCase.expect);
      // A `why` that restates the call teaches nothing. The bar is a sentence.
      expect(policyCase.why.length, policyCase.id).toBeGreaterThan(40);
    }
  });

  it("exercises every verdict except Broken, which is never expected", () => {
    // A word no row produces is a word that quietly stops meaning anything. Broken is the
    // exception by construction: it is what the harness says when it has no answer, so a
    // row expecting it would be a row asserting the harness is confused.
    const expected = new Set(POLICY_CASES.map((c) => c.expect));
    expect([...VERDICTS].filter((verdict) => !expected.has(verdict))).toEqual(["Broken"]);
  });

  it("keeps the findings list and the honest-gaps list visible", () => {
    expect(BYPASS_CASES.length).toBeGreaterThan(0);
    expect(NOT_ESTABLISHED.length).toBeGreaterThan(0);
    for (const open of NOT_ESTABLISHED) {
      // The failure this prevents: someone fills in an answer by reasoning and the entry
      // now reads as settled to every future reader. It must announce itself, and it must
      // hand over a next step rather than a shrug.
      expect(open.claim, open.id).toMatch(/NOT ESTABLISHED/);
      expect(open.whereToLookNext.length, open.id).toBeGreaterThan(40);
    }
  });

  it("carries no repository or channel id shaped like a real one", () => {
    // A realistic fake gets pasted into production. Placeholders stay obviously fake.
    const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    for (const fixture of readdirSync(FIXTURES)) {
      const text = readFileSync(join(FIXTURES, fixture), "utf8");
      expect(text, fixture).not.toMatch(uuid);
      expect(text, fixture).toContain("SYNTHETIC");
    }
  });
});
