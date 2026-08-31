# GitHub review operations

Use these commands after `scripts/pr-review-state.sh` identifies the PR and thread IDs. Substitute
shell variables only after reading them from GitHub; never guess node IDs or comment IDs.

On GitHub Enterprise, add `--hostname "$pr_host"` to every `gh api` call below, using the host from
the PR URL. A bare `gh api graphql` targets the CLI default host, not the PR's host.

## State model

A complete review snapshot needs four independent GitHub surfaces:

1. `pullRequest.reviewThreads` for inline threads and `isResolved`.
2. Pull-request reviews for reviewer state and reviewed commit.
3. Issue comments for reviewer summaries that may be edited in place.
4. Check runs for CI/reviewer status and the exact head SHA.

The bundled state script collects all four. `gh pr view --comments` is not a substitute because it
does not return inline review threads.

## Reply to an inline comment

Use the root review comment's numeric `databaseId` from the state JSON:

```bash
gh api "repos/{owner}/{repo}/pulls/$pr/comments/$comment_id/replies" \
  -f body="Fixed in $sha: <concise explanation and validation>."
```

For an incorrect finding, explain why with specific evidence. Do not claim a fix was pushed until
the referenced commit exists on the PR branch.

## Resolve a review thread

Use the thread's GraphQL node `id`, not a numeric review-comment ID:

```bash
gh api graphql \
  -f query='mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{id isResolved}}}' \
  -F thread="$thread_id"
```

Resolve only after replying and pushing the fix, or after posting the evidence that makes a change
unnecessary. GitHub rules may require every thread—including outdated threads—to be resolved.

## Reply to a conversation comment

Conversation comments have no thread-resolution state. Add a PR comment only when a response is
needed:

```bash
gh pr comment "$pr" --body "<reviewer and finding reference>: <disposition and evidence>"
```

Avoid duplicate status comments on every poll. Reviewer summary comments are often edited in
place, so track their ID and `updatedAt`.

## Freshness rules

- Match `checkRuns[].headSha`, `reviews[].commitId`, and any reviewer-provided commit marker to the
  current `pr.headRefOid`.
- A successful check on an older SHA does not satisfy the current round.
- A push starts a new round even when no files touched the line associated with an old finding.
- When a reviewer posts no explicit commit ID, require its check run for the current head to
  complete, require the tracked summary's `updatedAt` to be at or after the round floor defined
  below, and only then wait for two stable post-check snapshots. Stability alone does not make a
  summary current.
- The round floor is the *earliest* start you have observed among that reviewer's check runs for the
  current `headRefOid`. Record it the first time you see the lane start on this head and never
  advance it while the head is unchanged. A rerun on the same SHA means wait for completion again;
  it never invalidates a summary already accepted for that SHA. Only a new head starts a new round.
- Anchor on `startedAt`, never on `completedAt`: a reviewer routinely publishes its summary seconds
  before marking its own check complete, so a `completedAt` floor rejects a genuinely current review.
  `startedAt` is still bound to `headSha`, so an unchanged summary from an earlier round — written
  before this head's lane began — is correctly excluded.

## Reviewer detection

Discover reviewers case-insensitively across check names, check app slugs, review authors, comment
authors, repository instructions, and the PR's earlier rounds. CodeRabbit may appear as
`coderabbitai` or `coderabbitai[bot]`; Greptile commonly contains `greptile`. Treat these as identity
examples, not mandatory integrations. Require a reviewer only when repository policy, PR history,
or the user establishes that expectation.

Do not manufacture an undocumented retrigger command. Prefer automatic review-on-push. If a check
or bot comment provides a retrigger link or command, use it only for this PR. If an expected
integration is not installed or requires interactive authorization, request human input.

## Failed checks

Inspect details before retrying:

```bash
gh pr checks "$pr"
gh run view "$run_id" --log-failed
```

Fix deterministic failures. Treat skipped and neutral non-required checks as terminal rather than
failed. Retry an infrastructure-only failure when GitHub exposes a safe rerun and current
permissions allow it. Keep monitoring reviews independently when CI and reviewer checks do not
depend on each other. Never interpret an API error or malformed payload as an empty clean result.
