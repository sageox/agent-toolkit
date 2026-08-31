# policy-cases — executing the tool policy instead of asserting its bytes

An agent's tool policy is an allow/deny list plus, since the repo-bounded GitHub
surface, a repository allowlist and a set of armed write verbs. The obvious way to
test one is to parse the config and check that a rule is present. **That test cannot
fail for the reason you care about.** A rule that is present and inert passes it
perfectly, and a rule whose matching semantics are not what its author believed
passes it perfectly too.

`tool-policy.test.ts` covers the loader — the refusals that stop a policy which only
looks like one from ever starting. This directory covers what happens *after* it
loads: it puts a tool call in front of the real `loadToolPolicy` and the real
`githubHandler` and reports which gate answered.

| File | What it is |
|---|---|
| `cases.ts` | **The artifact that outlives everything here.** (fixture, tool call, expected verdict, why-this-row-exists), plus `NOT_ESTABLISHED` for the claims this table cannot reach. |
| `harness.ts` | Puts one case in front of the real decision path and classifies the answer. |
| `fixtures/` | Synthetic bundles: a `permissions` block and a `github` block in one file. Never an agent's real config, never a real repository. |
| `cases.test.ts` | Drives the table, gates the harness's verdict rule, and gates the table's own integrity. |

## Run it

```bash
npx vitest run packages/core/test/policy-cases
```

No flags, no network, no model turn. The whole decision path is in-process, so every
row runs on every commit — which is the one way this port differs from the fleet's
`testkit/policy`, where reaching the matcher costs a headless model turn and the live
tier is opt-in. What survives that difference is the discipline, not the machinery.

## The three rules everything else follows from

**1. `Allowed` requires positive evidence.** A call is allowed when a request actually
reached GitHub — not when nothing threw. A tool that answered without making a request
looks identical to an allow while proving that no gate was passed, so the harness calls
that `Broken` rather than folding it into its cheerful neighbour. This is the same rule
`verdict.ts` enforces for CI gates one layer up: an unrun gate is `UNKNOWN`, never
`PASS`, because an unrun check and a passing check read identically in prose.

The converse is asserted too: **every refusal must have spent nothing.** A boundary that
reaches GitHub and then says no has already handed a bounded credential to an unbounded
request, and the refusal is theatre.

**2. Distinct causes get distinct words.** There are five ways to be refused here —
unknown tool, unarmed write, denied by a rule, matched by no rule, out of bounds — plus
an argument error and a config that never loaded. The table names the one that answered.
Collapsing them into "it threw" is what lets a case pass for the wrong reason: delete the
repository bound entirely and the two gate-order rows in section D stay green, because
arming and the policy answer first. Only a row that names `OutOfBounds` catches it.

The load-bearing pair is `Denied` (a deny rule fired) versus `Unlisted` (no allow rule
matched). Collapsing those two would make an *inert* rule indistinguishable from a
deliberate refusal — which is the entire finding in sections A and B.

**3. Anything outside the explicit set is `Broken`.** Inherited from the fleet guard's
exit-code lesson, where `64` meant blocked and *anything else* was read as allowed — so a
guard that crashed under `set -euo pipefail` before inspecting a single flag passed its
own allow-direction tests. Here, a refusal whose words match no gate is `Broken`, carries
the boundary's own message, and fails the suite. Rewording a `throw` will do that. That is
the correct failure: those sentences are the boundary's interface to whoever reads the log.

## Reproducing a verdict by hand

Nothing here needs the test runner. The matcher:

```bash
npx tsx -e '
import { readFileSync } from "node:fs";
import { loadToolPolicy } from "./packages/core/src/tool-policy.ts";
const f = "packages/core/test/policy-cases/fixtures/issue-prefix-armed.json";
const policy = loadToolPolicy(readFileSync(f, "utf8"));
for (const t of ["issue_list", "issue_create", "pr_diff"])
  console.log(t, policy.allowsTool(`mcp__github__${t}`));
'
```

```
issue_list { ok: true }
issue_create { ok: true }        <- A2: the write, from a rule written for the reads
pr_diff { ok: false, reason: "tool mcp__github__pr_diff is not allowlisted" }
```

The third line is the one to keep an eye on: it is `A2b`, and it is what says the glob is
still anchored to its server rather than quietly matching everything.

For a whole call rather than a name, `runPolicyCase` in `harness.ts` is three arguments
and returns the verdict plus every request the call made.

## One file, two matchers

`permissions.allow` is read **twice** — by Claude Code, deciding whether the brain may call
a tool, and by `ToolPolicy`, deciding whether the gateway will serve one. So `matches()`
does not get to have semantics of its own; it has to be Claude Code's rule language, or the
operator is editing one file that means two things.

The deny direction is the half that must never be looser here. `githubHandler` and
`surfaceEgressHandler` re-check the policy at all because the brain holds the capability
token for every gateway-hosted server and can reach one directly, skipping Claude Code
entirely — so a deny rule the brain's own permission layer honours and the gateway ignores
is a hole in the backstop, not a redundancy.

The language, from Claude Code's permissions documentation:

| Rule | Means |
|---|---|
| `mcp__github` | every tool that server provides |
| `mcp__github__pr_list` | that one tool |
| `mcp__github__*`, `mcp__github__get_*` | a glob over the tool name, anchored to one literal server |
| `mcp__*`, `mcp__*__pr_list` | **deny only** — a glob over the whole name. As an allow rule it is skipped and grants nothing |

## Findings this directory encodes

These were the four divergences from that language, all of them now repaired in
`matches()`. The rows remain because a repair with no row is a belief again.

- **A bare `mcp__github` deny denied nothing.** The broadest-looking line in the file did
  nothing, and this is the one that failed *open*: Claude Code refused the tool while the
  gateway — the layer that exists for the case where the brain skips Claude Code — did not.
  Case `B1`.
- **A deny glob naming no server was inert.** `mcp__*__pr_list` is a full-tool-name glob to
  Claude Code and was a literal string here. Same failure direction as `B1`. Case `B1b`.
- **`mcp__github` as an allow granted nothing**, so an operator who granted a server the way
  the documentation spells it got an agent with no GitHub tools. Case `A3`.
- **`mcp__github__**` was inert**, in the spelling an operator is most likely to reach for:
  `Read(//mnt/secrets-store/**)` sits in the deny list of the same file and is a real glob. Case
  `A4`.

Two rows are sharp edges rather than divergences — both matchers agree, and the agreement is
the hazard:

- **`mcp__github__issue_*` grants the armed `issue_create`.** A tool-name glob spans anything
  after its anchor, in both matchers. Narrowing it here would create a divergence rather than
  fix one, so the repair is not in `matches()`: arming is what stands between that rule and a
  write nobody granted, and this is the row that says arming must never be the only control.
  Cases `A2`, `A2b`.
- **The same glob on the deny side is an outage.** A rule aimed at `issue_create` also removes
  `issue_list` and `issue_view`, and it fails safe and silently. Case `B2`.

One row records where the defect class is structurally closed:

- **The repository bound cannot go inert.** A glob-spelled `repos: ["acme/*"]` is refused by
  `RepoSlug` when the config is read, rather than matching nothing at call time. Case `E0`.

## What this table cannot reach

It executes one of the two matchers. The agreement above is read from Claude Code's
published rule language, not observed — which is `NOT_ESTABLISHED` entry `N1`, along with
`N2`, whether an ACP tool call even carries a name a `Bash(...)` rule can match. They are
entries with a next step rather than rows with invented verdicts, because a gap someone can
see is worth more than a verdict someone made up.

## Adding a case

Add one the moment you write a comment asserting what the policy does. If the claim is
worth a comment it is worth a row — and a row you cannot fill in is a claim you have not
checked, which is what `NOT_ESTABLISHED` is for. State it so it could be falsified, say
what it costs if it is wrong, and name the next concrete step. `cases.test.ts` gates all
three.
