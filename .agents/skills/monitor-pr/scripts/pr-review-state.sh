#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 [pull-request-number-or-url]" >&2
  exit 2
}

if [[ $# -gt 1 ]]; then
  usage
fi

for required in gh jq; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "error: required command not found: $required" >&2
    exit 1
  fi
done

pr_selector="${1:-}"

state_dir="$(mktemp -d "${TMPDIR:-/tmp}/pr-review-state.XXXXXX")"
trap 'rm -rf "$state_dir"' EXIT

pr_view_fields=number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,statusCheckRollup
if [[ -n "$pr_selector" ]]; then
  gh pr view "$pr_selector" --json "$pr_view_fields" >"$state_dir/pr.json"
else
  gh pr view --json "$pr_view_fields" >"$state_dir/pr.json"
fi

pr_number="$(jq -r '.number' "$state_dir/pr.json")"
head_sha="$(jq -r '.headRefOid' "$state_dir/pr.json")"

# Derive the host and repository from the resolved PR URL, not the working directory, so a
# selector that names a PR in another repository or on Enterprise stays consistent with the
# API calls. Without the host, every `gh api` request falls back to the CLI default host.
pr_path="$(jq -r '.url' "$state_dir/pr.json")"
pr_path="${pr_path#*://}"
pr_host="${pr_path%%/*}"
pr_path="${pr_path#*/}"
owner="${pr_path%%/*}"
repo="${pr_path#*/}"
repo="${repo%%/*}"
repo_with_owner="$owner/$repo"

if [[ -z "$pr_host" || -z "$owner" || -z "$repo" ]]; then
  echo "error: could not determine the host and repository for the selected pull request" >&2
  exit 1
fi

gh api --hostname "$pr_host" graphql --paginate --slurp \
  -f query='query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$endCursor){nodes{id isResolved isOutdated path line originalLine comments(first:100){totalCount nodes{id databaseId author{login} body url createdAt updatedAt}}} pageInfo{hasNextPage endCursor}}}}}' \
  -F owner="$owner" \
  -F repo="$repo" \
  -F number="$pr_number" \
  >"$state_dir/threads.json"

gh api --hostname "$pr_host" --paginate --slurp \
  "repos/$repo_with_owner/pulls/$pr_number/reviews?per_page=100" \
  >"$state_dir/reviews.json"
gh api --hostname "$pr_host" --paginate --slurp \
  "repos/$repo_with_owner/issues/$pr_number/comments?per_page=100" \
  >"$state_dir/comments.json"
gh api --hostname "$pr_host" --paginate --slurp \
  -H "Accept: application/vnd.github+json" \
  "repos/$repo_with_owner/commits/$head_sha/check-runs?per_page=100&filter=latest" \
  >"$state_dir/checks.json"

# Fail closed. GitHub GraphQL can return HTTP 200 with an `errors` member or a null PR, and a
# malformed/partial response must never be flattened into an apparently empty, clean snapshot.
jq -e '
  type == "array" and length > 0
  and all(.[]; (has("errors") | not))
  and all(.[]; .data.repository.pullRequest != null)
  and all(.[]; (.data.repository.pullRequest.reviewThreads.nodes | type) == "array")
  and all(.[]; (.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage | type) == "boolean")
  and .[-1].data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage == false
' "$state_dir/threads.json" >/dev/null || {
  echo "error: review-thread response is unreadable or incomplete" >&2
  exit 1
}

jq -e 'type == "array" and length > 0 and all(.[]; type == "array")' \
  "$state_dir/reviews.json" "$state_dir/comments.json" >/dev/null || {
  echo "error: review or comment response is unreadable or incomplete" >&2
  exit 1
}

jq -e '
  type == "array" and length > 0
  and all(.[]; type == "object" and (.check_runs | type) == "array")
' "$state_dir/checks.json" >/dev/null || {
  echo "error: check response is unreadable or incomplete" >&2
  exit 1
}

jq -n \
  --arg repo "$repo_with_owner" \
  --arg collectedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile pr "$state_dir/pr.json" \
  --slurpfile threadPages "$state_dir/threads.json" \
  --slurpfile reviewPages "$state_dir/reviews.json" \
  --slurpfile commentPages "$state_dir/comments.json" \
  --slurpfile checkPages "$state_dir/checks.json" \
  '{
    repository: $repo,
    collectedAt: $collectedAt,
    pr: $pr[0],
    threads: [
      $threadPages[0][]?.data.repository.pullRequest.reviewThreads.nodes[]?
      | . + {commentsTruncated: (.comments.totalCount > (.comments.nodes | length))}
      | .comments = .comments.nodes
    ],
    reviews: [
      $reviewPages[0][][]?
      | {
          id,
          nodeId: .node_id,
          author: .user.login,
          state,
          body,
          commitId: .commit_id,
          submittedAt: .submitted_at,
          url: .html_url
        }
    ],
    issueComments: [
      $commentPages[0][][]?
      | {
          id,
          nodeId: .node_id,
          author: .user.login,
          body,
          createdAt: .created_at,
          updatedAt: .updated_at,
          url: .html_url
        }
    ],
    checkRuns: [
      $checkPages[0][]?.check_runs[]?
      | {
          id,
          name,
          app: .app.slug,
          status,
          conclusion,
          headSha: .head_sha,
          startedAt: .started_at,
          completedAt: .completed_at,
          url: .html_url,
          detailsUrl: .details_url
        }
    ]
  }'
