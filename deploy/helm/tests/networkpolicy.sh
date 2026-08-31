#!/usr/bin/env bash
# Rendered-output test for the per-agent NetworkPolicy. Run it directly, or from CI:
#
#   deploy/helm/tests/networkpolicy.sh
#
# Two failures are worth a test here and neither shows up on a cluster. A policy whose
# podSelector has drifted off the agent's Pods applies cleanly and restricts nothing, and so
# does one written for a direction `policyTypes` never named — both are objects that look
# installed and are not.
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$chart/examples/two-agents.values.yaml"

rendered=""
fail() {
  printf 'networkpolicy.sh: %s\n' "$1" >&2
  exit 1
}
present() { grep -qF -- "$1" <<<"$rendered" || fail "expected in rendered output: $1"; }
absent() { grep -qF -- "$1" <<<"$rendered" && fail "unexpected in rendered output: $1"; return 0; }
counted() {
  local want="$1" needle="$2" got
  got=$(grep -cF -- "$needle" <<<"$rendered" || true)
  [ "$got" = "$want" ] || fail "expected $want × '$needle', found $got"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

render() { rendered=$(helm template agents "$chart" --values "$values" "$@"); }
# The policies alone. Asserting a name against the whole chart could not fail: the
# Deployment, PVC and ServiceAccount of each agent already carry it.
policies() {
  rendered=$(helm template agents "$chart" --values "$values" \
    --show-only templates/networkpolicy.yaml "$@")
}

# Nothing by default. The chart declared no NetworkPolicy before this existed, and a release
# that says nothing about traffic must keep getting none — an empty `policyTypes` renders no
# object rather than a policy that names no direction, which Kubernetes reads as deny-all
# ingress.
render
counted 0 "kind: NetworkPolicy"

# A direction with no rules is the deliberate deny-all, and it is one object per agent.
policies --set 'networkPolicy.policyTypes={Egress}'
counted 2 "kind: NetworkPolicy"
present "- Egress"
absent "- Ingress"
# One object per agent, named for that agent. A policy that took the release's name instead
# would be two objects of one kind and one name in one namespace: on upgrade the second
# patches the first, and one agent's rules become both agents'.
present "name: agents-harry"
present "name: agents-ida"
# No empty `egress:` key beside it: a list that rendered as `egress: []` would be the same
# deny-all, but `egress: null` is not, and `with` is what keeps the key out entirely.
absent "egress:"
absent "ingress:"

# The policy selects the agent's own Pods. `matchLabels` sits at the same indentation in the
# NetworkPolicy's `podSelector` and the Deployment's `selector`, and both are built from one
# helper — so the two extractions have to come out identical, in the same agent order.
# Nothing on a cluster reports a selector that matches no Pod: the object applies, and the
# traffic it was written to cut keeps flowing.
match_labels() { awk '/^    matchLabels:$/{f=1;next} f&&/^      [a-z]/{sub(/^ +/,"");print;next} f{f=0}'; }
policy_selector=$(helm template agents "$chart" --values "$values" \
  --set 'networkPolicy.policyTypes={Egress}' \
  --show-only templates/networkpolicy.yaml | match_labels)
deployment_selector=$(helm template agents "$chart" --values "$values" \
  --show-only templates/deployment.yaml | match_labels)
[ -n "$policy_selector" ] || fail "no podSelector matchLabels in the rendered NetworkPolicy"
[ "$policy_selector" = "$deployment_selector" ] || fail "the policy does not select the agent's Pods:
policy:
$policy_selector
deployment:
$deployment_selector"

# And the job Pods with them. A scheduled run makes the same calls the agent does, so a
# selector that reached only the Deployment would let every job out through a policy that
# reads as covering the agent.
# The CronJob object's own metadata carries these labels too, so the assertion has to read
# the Pod template specifically — `jobTemplate.spec.template.metadata.labels`, the only
# labels a NetworkPolicy selects on.
job_pod_labels() {
  awk '/^          labels:$/{f=1;next} f&&/^            [a-z]/{sub(/^ +/,"");print;next} f{f=0}'
}
cronjob_labels=$(helm template agents "$chart" --values "$values" \
  --show-only templates/cronjob.yaml | job_pod_labels)
[ -n "$cronjob_labels" ] || fail "no Pod template labels in the rendered CronJob"
while read -r label; do
  grep -qxF -- "$label" <<<"$cronjob_labels" \
    || fail "the policy's selector does not reach the CronJob Pods: $label"
done <<<"$policy_selector"

# Rules pass through verbatim, the way a `bundle.volume` does — no peer gets a branch of its
# own, including one Kubernetes has not added yet.
cat > "$work/rules.yaml" <<'YAML'
networkPolicy:
  policyTypes: ["Ingress", "Egress"]
  ingress:
    - from: [{ podSelector: { matchLabels: { app: probe } } }]
  egress:
    - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: ["169.254.169.254/32"] } }]
      ports: [{ protocol: TCP, port: 443 }]
YAML
policies --values "$work/rules.yaml"
counted 2 "- Ingress"
counted 2 "- Egress"
# Under the direction they were written for, not merely somewhere in the object. Swapping
# the two blocks renders every rule against the opposite direction — inbound opened to the
# world, outbound narrowed to a probe — and each rule is still present in the output.
section() {
  awk -v head="  $1:" '$0 == head {f = 1; next} f && /^[^ ]/ {f = 0} f && /^  [a-z]/ {f = 0} f'
}
egress=$(section egress <<<"$rendered")
ingress=$(section ingress <<<"$rendered")
grep -qF "cidr: 0.0.0.0/0" <<<"$egress" || fail "the egress rule did not render under egress"
grep -qF "169.254.169.254/32" <<<"$egress" || fail "the egress peer's exception is missing"
grep -qF "app: probe" <<<"$ingress" || fail "the ingress rule did not render under ingress"
grep -qF "app: probe" <<<"$egress" && fail "an ingress rule rendered under egress"
grep -qF "cidr:" <<<"$ingress" && fail "an egress rule rendered under ingress"

# Rules for a direction `policyTypes` does not name apply nowhere: Kubernetes restricts only
# the directions a policy lists, and ignores the rest without complaint. Refused at render
# while both halves are still in view.
refuses() {
  local why="$1" want="$2" out; shift 2
  out=$(helm template agents "$chart" --values "$values" "$@" 2>&1) \
    && fail "expected a refusal: $why"
  grep -qF "$want" <<<"$out" || fail "refused for the wrong reason: $why"
}
refuses "egress rules with no Egress policyType" "does not name Egress" \
  --values "$work/rules.yaml" --set 'networkPolicy.policyTypes={Ingress}'
refuses "ingress rules with no Ingress policyType" "does not name Ingress" \
  --values "$work/rules.yaml" --set 'networkPolicy.policyTypes={Egress}'
# Including the case where it names no direction at all, which renders no object — so the
# rules would otherwise vanish with nothing said.
cat > "$work/no-direction.yaml" <<'YAML'
networkPolicy:
  policyTypes: []
YAML
refuses "rules with an empty policyTypes" "does not name" \
  --values "$work/rules.yaml" --values "$work/no-direction.yaml"

# The schema only knows the two directions Kubernetes has.
refuses "a policyType Kubernetes does not define" "policyTypes" \
  --set 'networkPolicy.policyTypes={Sideways}'

printf 'networkpolicy.sh: ok\n'
