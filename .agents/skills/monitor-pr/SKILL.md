---
name: monitor-pr
description: Create or update a GitHub pull request, monitor CI and review feedback, inspect every thread and summary, fix valid findings, explain and resolve invalid findings, commit and push, and repeat until the current head is clean. Use when asked to open a PR and babysit reviews, watch a PR for comments, address automated or human review feedback, clear existing review threads, or keep fixing a PR until all required checks and reviews are resolved. Pause only when human input or access is genuinely required.
---

# Monitor PR

Own the selected pull request from its current state through a clean review result. Continue
monitoring, fixing, testing, committing, pushing, replying, and resolving without an arbitrary
iteration limit. Do not merge unless the user explicitly asks.

Read [`references/github-review-operations.md`](references/github-review-operations.md) before the
first GitHub mutation. Use [`scripts/pr-review-state.sh`](scripts/pr-review-state.sh) for every full
review snapshot so inline threads and edited summary comments are never omitted.

## Non-negotiable contract

- Keep working while a safe, in-scope action can make progress.
- Evaluate every finding on its merits. Never blanket-dismiss bot comments, nitpicks, or outdated
  threads.
- Treat an outdated thread as unresolved until its claim has been checked against the current code.
- Preserve unrelated user changes and repository conventions. Never force-push or rewrite history
  unless explicitly authorized.
- Fail closed: an unreadable or partial GitHub response is unknown state, never a clean result.
- Require only signals configured for this repository or named by the user. Do not require a
  particular review vendor merely because this skill knows about it.
- Prove every completion condition against the same current remote head SHA.

## 1. Preflight and create or find the PR

1. Read repository instructions. Inspect `git status`, the current branch, remotes, and the complete
   diff from the intended base. For an existing PR, use its actual `baseRefName`; otherwise use the
   user-specified or repository-default branch.
2. Do not create a PR from its target branch or detached HEAD. Request input only when selecting a
   safe feature branch would change the user's intent.
3. Run the repository's relevant tests and review the full diff. Commit only task-related changes
   with a repository-conforming message. Leave unrelated changes untouched.
4. Verify GitHub authentication, push normally, then find the PR for the branch and create one if
   absent. Include a concise summary and test evidence.
5. Record the PR number, URL, base, branch, and head SHA. Continue on the same PR for every round.

Invocation authorizes normal pushes to the scoped feature branch, PR creation or updates, review
replies, and thread resolution. It does not authorize merging, closing, force-pushing, changing
repository settings, or creating unrelated issues.

## 2. Establish the expected signals

Discover the completion requirements from branch protection, repository instructions, the user's
request, and the PR's checks, reviews, comments, and history. Expected signals can include:

- Required CI checks and review approvals.
- Automated reviewers that are configured for the repository or have started on this PR.
- A reviewer explicitly named by the user, such as CodeRabbit, Greptile, or a human reviewer.

Match integrations across check names, app slugs, review authors, and comment authors; do not assume
one exact login. Once an expected reviewer starts on a head, wait for it to finish and inspect its
output. If an expected integration never appears after CI starts and several snapshots, use only an
already-documented retrigger mechanism. If it is absent or inaccessible, request human input.

## 3. Monitor the current head

For each head SHA:

1. Run `scripts/pr-review-state.sh <pr-number-or-url>`.
2. Wait until required checks and expected reviewer lanes reach a terminal state for that SHA. A
   check or review attached only to an older commit is stale.
3. Prefer a platform-native background monitor when one is available. Otherwise take snapshots in
   bounded intervals, normally no more often than every 60 seconds. Never hide an unbounded sleep
   loop inside one blocking shell call.
4. Keep the user updated during a long watch. Do not return a final result while required work is
   pending.
5. After checks and reviewers complete, take two unchanged snapshots separated by 30-60 seconds to
   catch late or edited feedback.
6. Read review threads, pull-request reviews, conversation comments, and check runs. If any
   `commentsTruncated` value is true, fetch the remaining comments before classification.

Skipped or neutral checks are not failures unless repository rules make them required. Failed or
cancelled required checks are unclean. API degradation is unknown, so keep monitoring.

## 4. Classify every finding

Maintain a ledger keyed by thread or stable comment ID. Include human feedback and every automated
reviewer, not only the expected lanes. Classify each unresolved thread or actionable summary item:

- `valid`: reproduce or trace the problem, make the smallest complete fix, and add or update
  regression coverage.
- `already-fixed`: verify the current code and the PR's own base, then reply with the evidence.
- `incorrect`: reply with concise code, test, or behavior evidence; do not make appeasement changes.
- `out-of-scope`: do not silently widen the PR. Link an existing tracking issue, or request
  authorization before creating one or expanding scope.
- `needs-human`: exhaust safe investigation, then state the exact decision and tradeoff required.

Deduplicate equivalent findings from multiple reviewers: fix once, then reply to and resolve each
thread. Treat labels such as "nitpick" or "trivial" as severity hints, not dismissal rules. Treat
summary or walkthrough comments as findings even when they do not create resolvable threads.

## 5. Validate, push, reply, and resolve

1. Run focused tests for fixes, then the repository's required validation suite.
2. Re-read the complete diff for scope, security, and accidental changes.
3. Commit one coherent review round and push normally to the same branch.
4. Reply to every handled inline finding with its disposition and pushed commit SHA or evidence,
   even if the reviewer auto-resolved the thread after the push.
5. Resolve any handled thread that remains open, but only after its fix is pushed or its
   explanatory reply is posted. Include outdated threads.
6. Re-run the state script, record the new remote head SHA, and return to monitoring. Every push
   invalidates the previous clean determination and can trigger new feedback.

Treat validation and CI failures as findings. Retry only infrastructure failures that are clearly
transient and safely rerunnable; fix deterministic failures at their source.

## Batch and stacked PRs

For a request to clear existing feedback rather than watch live, fetch and classify all current
threads before editing, make one coherent fix round, reply and resolve in a batch, then re-fetch.
Keep iterating if the push produces new comments.

For multiple dependent PRs, work from the lowest dependency upward. Determine each PR's own base,
fix the finding in the layer that owns the code, and propagate it using the repository's documented
stack workflow. Never assume a project-specific stack tool or fix the same defect independently in
multiple layers.

## Completion gate

Finish only when two stable snapshots prove all of these for one current remote head SHA:

- Local HEAD equals the PR's remote head and no task-related change is uncommitted. Report any
  preserved, unrelated working-tree changes.
- Every required check passes; skipped or neutral non-required checks do not block completion.
- Every expected reviewer completed for the current head and reports no actionable finding. An
  integration that is not configured is not required.
- Every review thread is resolved, including outdated threads.
- No actionable pull-request review, summary, walkthrough, or conversation comment remains.
- GitHub responses are complete and parseable, with no new or edited feedback between snapshots.

Report the PR URL, final head SHA, rounds completed, fixes made, tests run, intentionally declined or
deferred findings, and final reviewer/check state. Do not merge unless separately requested.

## Human-input gate

Pause only for an action or decision the agent cannot safely supply: missing GitHub access, an
expected reviewer integration that is unavailable, interactive authentication, an unresolved
product or security choice, conflicting mandatory requirements, authorization to expand scope or
create a follow-up issue, or a destructive operation. State exactly what is blocked and resume the
loop after the user answers; do not treat the pause as completion.
