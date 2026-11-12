#!/usr/bin/env bash
# Rendered-output test for agents.<name>.authTag. Run it directly, or from CI:
#
#   deploy/helm/tests/authtag.sh
#
# The runtime drops a BUZZ_AUTH_TAG it cannot parse as the NIP-OA tuple without an error,
# so a malformed tag must be refused at render time or it silently leaves the agent
# "owner unavailable".
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$chart/examples/two-agents.values.yaml"

owner=$(printf 'a%.0s' {1..64})
sig=$(printf 'b%.0s' {1..128})
conditions='kind=1&created_at<1900000000'
tag_json="[\"auth\",\"$owner\",\"$conditions\",\"$sig\"]"

rendered=""
fail() {
  printf 'authtag.sh: %s\n' "$1" >&2
  exit 1
}
counted() {
  local want="$1" needle="$2" got
  got=$(grep -cF -- "$needle" <<<"$rendered" || true)
  [ "$got" = "$want" ] || fail "expected $want × '$needle', found $got"
}
render() {
  rendered=$(helm template agents "$chart" --values "$values" \
    --show-only templates/deployment.yaml --show-only templates/cronjob.yaml "$@")
}
# `--set-string` splits on commas, so a string tag goes in through a values file.
string_tag() {
  printf "agents:\n  harry:\n    authTag: '%s'\n" "$1" >"$work/string.yaml"
  printf '%s\n' "$work/string.yaml"
}
refuses() {
  local why="$1" out
  shift
  out=$(helm template agents "$chart" --values "$values" "$@" 2>&1) \
    && fail "expected a refusal: $why"
  grep -qF "authTag" <<<"$out" || fail "refused for the wrong reason: $why: $out"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

render
counted 0 'BUZZ_AUTH_TAG'
deployments=$(grep -c '^kind: Deployment$' <<<"$rendered")
cronjobs=$(grep -c '^kind: CronJob$' <<<"$rendered")
harry_hosts=$(awk '/^kind: /{k=$2} /^  name: /{if (k=="Deployment"||k=="CronJob") print $2}' <<<"$rendered" | grep -c 'harry' || true)
[ "$deployments" -ge 1 ] && [ "$cronjobs" -ge 1 ] || fail 'example renders no Deployment or no CronJob'
[ "$harry_hosts" -ge 2 ] || fail 'example gives harry no scheduled job host'

# Every BUZZ_AUTH_TAG the render sets must parse, as the runtime parses it, to the tag.
# Compared parsed, not as text: Helm's toJson escapes `<` and `&`, which JSON.parse undoes.
tags_parse_to_tag() {
  local got
  got=$(grep -A1 -F 'name: BUZZ_AUTH_TAG' <<<"$rendered" | sed -n 's/^ *value: //p' \
    | TAG="$tag_json" python3 -c '
import json, os, sys
want = json.loads(os.environ["TAG"])
print(sum(json.loads(json.loads(line)) == want for line in sys.stdin))')
  [ "$got" = "$1" ] || fail "expected $1 × BUZZ_AUTH_TAG parsing to the tag, found $got"
}

# A JSON string, as `buzz` prints a minted tag.
render --values "$(string_tag "$tag_json")"
counted "$harry_hosts" 'name: BUZZ_AUTH_TAG'
tags_parse_to_tag "$harry_hosts"

# A YAML list renders the same JSON the runtime parses.
cat >"$work/list.yaml" <<YAML
agents:
  harry:
    authTag: ["auth", "$owner", "$conditions", "$sig"]
YAML
render --values "$work/list.yaml"
counted "$harry_hosts" 'name: BUZZ_AUTH_TAG'
tags_parse_to_tag "$harry_hosts"

refuses 'a string that is not JSON' --values "$(string_tag 'not-json')"
refuses 'a JSON tuple with the wrong label' \
  --values "$(string_tag "[\"p\",\"$owner\",\"$conditions\",\"$sig\"]")"
refuses 'an owner that is not 64 lowercase hex' \
  --values "$(string_tag "[\"auth\",\"${owner:0:63}\",\"$conditions\",\"$sig\"]")"
cat >"$work/short.yaml" <<YAML
agents:
  harry:
    authTag: ["auth", "$owner", "$conditions"]
YAML
refuses 'a list of three' --values "$work/short.yaml"
cat >"$work/badsig.yaml" <<YAML
agents:
  harry:
    authTag: ["auth", "$owner", "$conditions", "nothex"]
YAML
refuses 'a list whose signature is not hex' --values "$work/badsig.yaml"

printf 'authtag.sh: ok\n'
