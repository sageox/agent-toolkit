// The case table: (fixture, tool call, expected verdict, why this row exists).
// This file is the point of the whole directory.
//
// WHY IT EXISTS. `tool-policy.test.ts` covers the loader's refusals, and it covers them
// well — but the loader is not where the policy is enforced. Enforcement is `matches()`,
// three lines, plus the gates the broker runs in front of every MCP call. On tool names
// alone the only question a policy could answer was "is this tool name allowed", and three
// lines were an honest answer to it. `scope` made the policy ARGUMENT-SHAPED: a call now
// carries a bound argument, and a decision depends on the manifest as well as the settings
// file.
// A test that greps a rule out of JSON cannot fail for any of the reasons that now
// matter. A rule that is present and inert passes it perfectly.
//
// HOW TO USE IT. Every row runs against the real loader and the real broker on every
// commit — the whole decision path is in-process, so there is no expensive tier here and
// no opt-in flag. What this table cannot reach is `NOT_ESTABLISHED` at the bottom, and
// those are claims about the OTHER matcher, not claims nobody got round to running.
//
// HOW TO EXTEND IT. Add a row the moment you write a comment asserting what the policy
// does. If the claim is worth a comment it is worth a row, and a row you cannot fill in
// belongs in `NOT_ESTABLISHED` where a human can see the gap.

import type { Verdict } from "./harness.ts";

export interface PolicyCase {
  readonly id: string;
  /** File name in ./fixtures. Always synthetic — never an agent's real bundle. */
  readonly fixture: string;
  /** The bare tool name, as the brain would call it. */
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly expect: Verdict;
  /**
   * True when the expected verdict IS the finding — an `Allowed` that should not be, or a
   * refusal that silently breaks the agent. Kept separate from `expect` because the suite
   * asserts behaviour while a human reads risk, and conflating them is how "the tests
   * pass" comes to mean "we are fine".
   */
  readonly bypass: boolean;
  /** Why this row exists. The comment it replaces, or the belief it executes. */
  readonly why: string;
}

// ---------------------------------------------------------------------------
// A — The rule language, which is Claude Code's and not ours.
//
// `settings.json` is read twice: Claude Code decides whether the brain may call a tool,
// `ToolPolicy` decides whether the gateway will serve one. So the only correct semantics
// for `matches()` are Claude Code's, and the rows here are that language executed —
// a bare `mcp__<server>` is the whole server, `mcp__<server>__<tool>` is one tool, and a
// `*` is a glob over the whole name.
//
// It used to be a trailing-prefix comparison instead, which agreed with that language on
// the two spellings the CLI writes and disagreed on every other one. A4 and A6 are the
// rows that were inert; A2 is the row that was never a divergence at all and reads as one
// until you check.
// ---------------------------------------------------------------------------
const RULE_LANGUAGE: readonly PolicyCase[] = [
  {
    id: "A0-wildcard-allows-a-read",
    fixture: "read-only-wildcard.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "Positive control. Without it every refusal below is worthless: a table whose fixtures never allowed anything would 'contain' every attack by containing everything, and would keep passing if the surface stopped working entirely.",
  },
  {
    id: "A1-a-tool-name-glob-reaches-inside-a-token",
    fixture: "issue-prefix-allowed.json",
    tool: "issue_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "Pins the mechanism rather than the symptom. `mcp__github__issue_*` reaches `issue_list` because a tool-name glob spans anything after the anchor and there is no token boundary to stop it — which is Claude Code's rule too: its docs give `mcp__github__get_*` as matching that server's `get_` tools. Read beside A2.",
  },
  {
    id: "A2-a-read-shaped-glob-also-allows-the-armed-write",
    fixture: "issue-prefix-allowed.json",
    tool: "issue_create",
    args: { repo: "acme/service", title: "a bug" },
    expect: "Allowed",
    bypass: true,
    why: "A sharp edge that both matchers share, which is why it is a row and not a bug: one rule written to grant the issue reads grants the issue write too, because `issue_create` starts with `issue_`. Narrowing it here would make the gateway disagree with the layer it backs up, so the repair is not in the matcher — the bound and the scan are what stand between this rule and a write nobody meant to grant, and this row is the reason a tool-name allowlist must never be the only control.",
  },
  {
    id: "A2b-and-reaches-nothing-past-its-anchor",
    fixture: "issue-prefix-allowed.json",
    tool: "pr_diff",
    args: { repo: "acme/service", number: 4 },
    expect: "Unlisted",
    bypass: false,
    why: "The bound on A2, and the row that stops the glob rows from passing vacuously. Widening `matches()` to a real glob is only safe if the anchor still holds — a `*` that had started spanning the server segment as well would produce A1 and A2's verdicts unchanged while granting the whole surface, and this is the only row that would notice.",
  },
  {
    id: "A3-a-bare-server-name-allows-the-server",
    fixture: "server-allowed.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "`mcp__github` is the first spelling Claude Code's documentation reaches for, and it used to match nothing here — so an operator who granted a server that way had a working policy on one side of the file and an agent with no GitHub tools on the other. Paired with B1, which is the same spelling pointed the other way and the dangerous half.",
  },
  {
    id: "A4-a-doubled-star-reaches-the-server",
    fixture: "doubled-star.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "The spelling an operator is most likely to reach for: `Read(//mnt/secrets-store/**)` sits in the deny list of the same file and is a real glob, so `**` looks transferable. It now is. It used to be inert — one trailing `*` was stripped and the other matched as a literal asterisk — and a whole surface disappeared without a word being said about it.",
  },
  {
    id: "A5-an-exact-tool-name-still-matches-exactly",
    fixture: "read-only-wildcard.json",
    tool: "issue_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "Isolation for the glob rows. Every one of them widens what a rule reaches, so the table needs a row that fails if widening went too far and started matching on something other than the name — this is the plain case with no glob semantics in play at all.",
  },
  {
    id: "A6-an-allow-glob-that-names-no-server-is-refused-when-the-config-is-read",
    fixture: "unanchored-allow-glob.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Rejected",
    bypass: false,
    why: "`mcp__*__pr_list` reads as 'this tool from whichever server provides it' and grants nothing: Claude Code honours an allow glob only after a literal `mcp__<server>__` prefix and skips an unanchored one with a warning. Honouring it here would make the gateway strictly more permissive than the layer it backs up, and skipping it quietly is how a grant that grants nothing survives review — so the policy is refused when it is read, with the two spellings that work named in the message.",
  },
];

// ---------------------------------------------------------------------------
// B — Deny, where the same spellings mean something different.
//
// Claude Code's allow and deny globs are deliberately asymmetric: a deny glob matches the
// full tool name, an allow glob has to name one server. The gateway has to reproduce both
// halves, and the deny half is the one that must never be looser here — the brain holds
// the capability token for every hosted server and can reach one directly, which is why
// `githubHandler` re-checks at all. A deny the brain's own permission layer honours and
// this one ignores is a hole in the backstop, not a redundancy.
// ---------------------------------------------------------------------------
const DENY_REACH: readonly PolicyCase[] = [
  {
    id: "B0-deny-beats-a-wildcard-allow",
    fixture: "wildcard-but-denied.json",
    tool: "pr_create",
    args: { repo: "acme/service", title: "t", head: "fix", base: "main" },
    expect: "Denied",
    bypass: false,
    why: "Control, and the statement of the rule: a write armed in the manifest and denied in the policy is refused. Without this row every Denied below could be read as 'deny rules do not work in this table' rather than as the rule firing.",
  },
  {
    id: "B1-a-bare-server-name-denies-the-server",
    fixture: "server-denied.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Denied",
    bypass: false,
    why: "THE FINDING, repaired. `mcp__github` is how Claude Code spells the whole server, and it used to be compared exactly here and match nothing — the broadest-looking line in the file was the one that did nothing, and a reader who saw it stopped looking for the gap it appeared to close. The failure direction is what made this the worst of the four: the brain's own layer refused the tool while the gateway, which exists precisely for the case where the brain skips that layer, did not.",
  },
  {
    id: "B1b-a-deny-glob-may-name-no-server-at-all",
    fixture: "unanchored-deny-glob.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Denied",
    bypass: false,
    why: "The asymmetry, executed. `mcp__*__pr_list` is refused as an allow rule (A6) and honoured as a deny rule, because Claude Code matches a deny glob against the full tool name — so the same string is a grant that grants nothing and a refusal that refuses. Reproducing only the allow half would have left this deny inert on the layer that cannot be bypassed.",
  },
  {
    id: "B1c-and-leaves-the-rest-of-the-server-alone",
    fixture: "unanchored-deny-glob.json",
    tool: "issue_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "Isolation for B1b. A deny glob that swallowed the whole server would produce B1b's verdict for the wrong reason, and would look like a working rule while quietly costing the agent every other tool — which is B2's defect arriving by a different route.",
  },
  {
    id: "B2-a-deny-written-for-the-write-kills-the-reads",
    fixture: "issue-prefix-denied.json",
    tool: "issue_list",
    args: { repo: "acme/service" },
    expect: "Denied",
    bypass: true,
    why: "A2's mechanism pointed the other way, and it is an outage rather than an exposure: `mcp__github__issue_*` written to shut off `issue_create` also shuts off `issue_list` and `issue_view`, so an agent whose job is working an issue backlog quietly stops being able to read one. It fails safe and it fails silently, which is why nobody finds it until someone asks why the agent has gone quiet.",
  },
  {
    id: "B3-and-the-write-it-was-actually-aimed-at",
    fixture: "issue-prefix-denied.json",
    tool: "issue_create",
    args: { repo: "acme/service", title: "a bug" },
    expect: "Denied",
    bypass: false,
    why: "Pins B2 as over-reach rather than a broken rule. The deny does hit its intended target; the finding is everything else it takes with it.",
  },
];

// ---------------------------------------------------------------------------
// C — The bound. `scope`'s argument-shaped half.
//
// The bound is `allowed.includes(value)` — one exact string comparison, deliberately
// unforgiving about spelling, and FAIL-CLOSED: a call that names no bound argument at all
// is refused rather than waved through. What the rows here measure is WHICH GATE answered
// and WHETHER THE CALL WAS RELAYED. A refusal issued after the relay has already handed a
// bounded credential's authority to an unbounded call, and "it threw" cannot tell those
// apart.
// ---------------------------------------------------------------------------
const REPOSITORY_BOUND: readonly PolicyCase[] = [
  {
    id: "C0-a-bound-repository-reaches-github",
    fixture: "two-repos-bound.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Allowed",
    bypass: false,
    why: "Control for the whole section, and the only row in it that proves the fixture can reach the server at all. Every OutOfBounds below is measured against this.",
  },
  {
    id: "C1-the-bound-is-a-set-not-a-single-repository",
    fixture: "two-repos-bound.json",
    tool: "pr_list",
    args: { repo: "acme/tools" },
    expect: "Allowed",
    bypass: false,
    why: "The second bound repository works too. Stated because a bound that only ever honoured its first entry would pass C0 and C2 unchanged, and would strand every agent given two repositories.",
  },
  {
    id: "C2-an-unbound-repository-never-reaches-github",
    fixture: "two-repos-bound.json",
    tool: "pr_list",
    args: { repo: "acme/other" },
    expect: "OutOfBounds",
    bypass: false,
    why: "The bound itself, and the reason the driver asserts an empty request list on every refusal: a refusal issued after the relay would mean the gateway spent a bounded credential on an unbounded repository and then reported a refusal, which is theatre.",
  },
  {
    id: "C3-a-url-spelling-is-not-the-repository",
    fixture: "two-repos-bound.json",
    tool: "pr_list",
    args: { repo: "https://github.com/acme/service" },
    expect: "OutOfBounds",
    bypass: false,
    why: "One spelling, checked one way — the URL form is the one a brain reaches for unprompted, because it is what the tool output it just read contains. A bound value is the operator's own string and nothing normalises either side of the comparison, so every other spelling of the same repository is refused too.",
  },
  {
    id: "C4-a-missing-bound-argument-is-refused-not-waved-through",
    fixture: "two-repos-bound.json",
    tool: "pr_list",
    args: {},
    expect: "OutOfBounds",
    bypass: false,
    why: "The fail-closed half, and the row the whole design turns on. A third-party server's org-wide tools take no repository argument at all, so 'check it when present' would refuse exactly the calls that were already bounded and admit exactly the ones that escape — the bound would read as a bound while being the opposite. Absent is out of bounds.",
  },
];

// ---------------------------------------------------------------------------
// D — Gate order.
//
// Three gates run before any relay: allowlisted, then bounded, then scanned. Order is
// invisible when only one of them would refuse, which is why every row here arranges for
// TWO to be true at once and names the one that answers. This is where a case passing for
// the wrong reason actually lives — delete the bound check and D1 stays green.
// ---------------------------------------------------------------------------
const GATE_ORDER: readonly PolicyCase[] = [
  {
    id: "D0-the-bound-answers-before-the-scan",
    fixture: "leak-patterns.json",
    tool: "pr_create",
    args: { repo: "acme/other", title: "t", head: "fix", base: "main", body: "ghp_AAAAAAAABBBB" },
    expect: "OutOfBounds",
    bypass: false,
    why: "Out of bounds AND carrying something the scan would refuse; the bound answers. Order matters here for the same reason it does in the chat chokepoint: the cheap local comparison runs before the one that reads every string, and a build that reversed them would still refuse this call while doing more work to reach the same answer.",
  },
  {
    id: "D1-the-policy-answers-before-the-bound",
    fixture: "issue-prefix-denied.json",
    tool: "issue_list",
    args: { repo: "acme/other" },
    expect: "Denied",
    bypass: false,
    why: "Denied AND out of bounds; the policy answers. The gateway re-checks the policy here rather than trusting the brain's permission layer, because the brain holds this server's bearer token and can reach it directly — so which of the two refused is a fact about where the boundary is.",
  },
  {
    id: "D2-the-bound-is-the-last-gate-and-still-holds",
    fixture: "two-repos-bound.json",
    tool: "pr_create",
    args: { repo: "acme/other", title: "t", head: "fix", base: "main" },
    expect: "OutOfBounds",
    bypass: false,
    why: "Allowed and out of bounds — every gate in front of the bound waved this through, so the bound is the only thing refusing, and it refuses a write. The chain matters: widening the policy is a routine change, and this row is what keeps that change from quietly becoming a repository-scope change too.",
  },
  {
    id: "D3-the-scan-is-the-last-gate-and-still-holds",
    fixture: "leak-patterns.json",
    tool: "pr_create",
    args: { repo: "acme/service", title: "t", head: "fix", base: "main", body: "ghp_AAAAAAAABBBB" },
    expect: "Leaked",
    bypass: false,
    why: "Allowed and in bounds, so the scan is the only thing left that can refuse. It reads every argument rather than a list of the ones that publish: a per-tool list fails open the first time somebody forgets an entry, and over-scanning an identifier costs a false refusal, which fails closed.",
  },
];

// ---------------------------------------------------------------------------
// E — Refused when the config is read, not at the first call.
//
// The one place this repo does better than the rules it inherited, kept as a row so it
// stays true. Everything in sections A and B is an inert rule discovered at call time;
// the bound cannot have that defect, because a spelling that would be inert is refused by
// the scope schema while the manifest is being parsed.
// ---------------------------------------------------------------------------
const REFUSED_AT_LOAD: readonly PolicyCase[] = [
  {
    id: "E0-a-glob-spelled-bound-is-refused-when-the-config-is-read",
    fixture: "glob-repo-bound.json",
    tool: "pr_list",
    args: { repo: "acme/service" },
    expect: "Rejected",
    bypass: false,
    why: "`scope: {repo: [\"acme/*\"]}` is the same instinct that produces A4, and here it cannot become an inert rule: the bound is an exact comparison, so a glob would refuse every call, and the schema refuses the spelling at load instead. The row exists to keep that true — a scope schema that accepted `*` would turn the bound into section A.",
  },
];

export const POLICY_CASES: readonly PolicyCase[] = Object.freeze([
  ...RULE_LANGUAGE,
  ...DENY_REACH,
  ...REPOSITORY_BOUND,
  ...GATE_ORDER,
  ...REFUSED_AT_LOAD,
]);

/** Cases whose expected verdict is itself a finding. Read this list first. */
export const BYPASS_CASES: readonly PolicyCase[] = POLICY_CASES.filter((c) => c.bypass);

/**
 * Claims this table cannot reach.
 *
 * Carried rather than dropped, and carried here rather than as rows with invented
 * verdicts, because a gap someone can see is worth more than a verdict someone made up.
 * Both entries are about the OTHER matcher: `permissions.allow` is read twice, once by
 * Claude Code deciding whether the brain may call a tool and once by `ToolPolicy` deciding
 * whether the gateway will serve it, and this repo can only execute the second.
 */
export interface OpenQuestion {
  readonly id: string;
  /** The unsettled claim, stated so it could be falsified. */
  readonly claim: string;
  /** What it costs if the claim is wrong. */
  readonly whyItMatters: string;
  /** The next concrete step. Not "investigate" — the command, or the file. */
  readonly whereToLookNext: string;
}

export const NOT_ESTABLISHED: readonly OpenQuestion[] = Object.freeze([
  {
    id: "N1-agreement-is-documented-not-observed",
    claim:
      "NOT ESTABLISHED by execution: that Claude Code's matcher actually behaves the way `matches()` now reproduces. Every rule in section A was settled against the published rule language, and none of it was run.",
    whyItMatters:
      "The repair is only worth what the agreement is worth. This table executes one of the two matchers that read `settings.json`, so a documented behaviour that is stale, version-dependent, or subtly different in a spelling the documentation does not cover would drift here silently — and the deny direction is where drift costs something, because the gateway is the layer the brain cannot skip.",
    whereToLookNext:
      "The private policy testkit's `testkit/policy/README.md` § Reproducing a verdict by hand drives a rule through `claude --print --settings <fixture> --setting-sources '' --permission-mode dontAsk` and reads `permission_denials`. These fixtures are already the right shape for it: run `server-denied.json`, `unanchored-deny-glob.json`, and `doubled-star.json`, which are the three whose meaning changed, and record what comes back.",
  },
  {
    id: "N2-what-an-acp-tool-name-actually-looks-like",
    claim:
      "NOT ESTABLISHED: whether the brain's ACP tool calls carry a name a `Bash(...)` rule can match. `brain-acp.ts` passes `toolCall.name` straight to `allowsTool`, and a rule is matched against the whole name — so `Bash(git status)` grants nothing if the real agent sends `Bash`.",
    whyItMatters:
      "It is the same failure this directory exists for, one surface over: `brain-acp.test.ts` drives a fake agent that sends `Bash(git status)` as the name, so the belief is encoded in the fixture that was written to confirm it. If the real shape is the bare tool name, then either every Bash rule is inert or every Bash call is refused, and the tests cannot tell which.",
    whereToLookNext:
      "Record one real session: run an agent with `provider: claude-acp` against a scratch bundle and log `ctx.params.toolCall.name` before the policy sees it. If the name is bare, the fix is in `brain-acp.ts` — match the argument-carrying rule against the name plus its input — and this table gains a section for it.",
  },
]);
