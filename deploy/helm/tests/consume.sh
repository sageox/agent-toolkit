#!/usr/bin/env bash
# Rendered-output test for the three things a chart *consumer* needs and the reference AWS
# path never exercises. Run it directly, or from CI:
#
#   deploy/helm/tests/consume.sh
#
# Each was found by a fleet migrating onto the chart, not by the chart's own examples — the
# reference path installs the chart directly, with EKS Pod Identity, one release holding
# every agent. A consumer who does none of those three hits all three.
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$chart/examples/two-agents.values.yaml"

rendered=""
fail() {
  printf 'consume.sh: %s\n' "$1" >&2
  exit 1
}
present() { grep -qF -- "$1" <<<"$rendered" || fail "expected in rendered output: $1"; }
absent() { grep -qF -- "$1" <<<"$rendered" && fail "unexpected in rendered output: $1"; return 0; }

# 1. The chart renders as a subchart. Helm hands every subchart a `global` key whether or
# not the parent sets one, so a root schema that forbids unknown properties rejects the
# obvious spelling of "depend on this chart" before rendering a line. Nothing below sets
# `global`; if it had to, this would not be the bug it was.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/charts"
cp -R "$chart" "$work/charts/agent"
chart_version=$(sed -n 's/^version: //p' "$chart/Chart.yaml")
cat > "$work/Chart.yaml" <<YAML
apiVersion: v2
name: wrapper
type: application
version: 0.1.0
dependencies:
  - name: agent
    version: $chart_version
    repository: ""
YAML

# The README shows that `dependencies:` entry with a version pinned, so it goes stale on
# every chart bump — and a stale pin resolves the chart from before whatever the bump was
# for, which is the one thing a consumer copying it cannot see.
grep -qF "version: $chart_version" "$chart/README.md" \
  || fail "README's dependency example does not pin the current chart version $chart_version"
{ echo 'agent:'; sed 's/^/  /' "$values"; } > "$work/values.yaml"

rendered=$(helm template wrapper "$work")
present "kind: Deployment"
present "name: wrapper-harry"

# 2. IRSA is expressed as an annotation on the ServiceAccount and nowhere else —
# `podAnnotations` is release-wide and lands on the Pod, so it is not a substitute.
# 3. An agent names its own objects, for the fleet whose release is already named after it.
overlay="$work/overlay.yaml"
cat > "$overlay" <<'YAML'
agents:
  harry:
    fullnameOverride: harry
    serviceAccount:
      annotations:
        eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/harry
YAML

rendered=$(helm template agents "$chart" --values "$values" --values "$overlay" \
  --show-only templates/serviceaccount.yaml)
present "eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/harry"
present "name: harry"
# The annotation is one agent's, not the release's: ida shares the release and gets none.
present "name: agents-ida"
[ "$(grep -cF 'role-arn' <<<"$rendered")" = 1 ] || fail "role-arn annotation is not per-agent"

# The override reaches every object of that agent, including the ones whose name is built
# from it. One left on the default would be an object the fleet's roll call cannot find —
# or, for the claim, an empty volume.
rendered=$(helm template agents "$chart" --values "$values" --values "$overlay")
present "name: harry-shift"
present "claimName: harry"
absent "agents-harry"
# An agent that sets nothing keeps the default name.
present "name: agents-ida"

# The `agents` keys were unique because they are map keys, and that was the whole reason
# two agents could not collide. An override is the first thing that can break it — against
# another override, or against another agent's default — so the render refuses while both
# names are still in view, rather than leaving Kubernetes to resolve it by overwrite.
collides() {
  local why="$1" want="$2" out; shift 2
  out=$(helm template agents "$chart" --values "$values" "$@" 2>&1) \
    && fail "expected a refusal: $why"
  grep -qF "$want" <<<"$out" \
    || fail "refused for the wrong reason: $why"
}
collides "two agents share one override" "every agent of a release" \
  --set agents.harry.fullnameOverride=shared --set agents.ida.fullnameOverride=shared
collides "an override equals another agent's default name" "every agent of a release" \
  --set agents.harry.fullnameOverride=agents-ida
# A job's object is `<agent>-<slug>`, so two agents can read one hyphen differently and
# arrive at the same CronJob with no override in sight.
collides "two agents split one CronJob name at a different hyphen" "every scheduled job" \
  --set agents.harry.fullnameOverride=foo --set agents.harry.jobs[0].slug=bar-baz \
  --set agents.ida.fullnameOverride=foo-bar --set agents.ida.jobs[0].slug=baz

# A name is qualified by its kind. One agent's Deployment, claim and ServiceAccount already
# share a name deliberately, so a CronJob that matches another agent's Deployment is a
# resemblance and not a collision — Kubernetes keeps them apart, and refusing it would turn
# a legal release away.
helm template agents "$chart" --values "$values" \
  --set agents.harry.jobs[0].slug=sweep --set agents.ida.fullnameOverride=agents-harry-sweep \
  >/dev/null || fail "refused a CronJob and a Deployment that only share a name"

# `serviceAccount.name` and `secrets.csi.secretProviderClass` are the two names a consumer
# supplies outright for an object this chart creates, so neither is qualified by the map key
# that makes agents unique. Both name the agent's identity, and a collision in either is
# silent: the surviving definition is what every Pod naming it mounts, so the agent that lost
# assumes the other's cloud role or reads the other's credentials rather than failing.
collides "two agents create one ServiceAccount" "belongs to one agent" \
  --set agents.harry.serviceAccount.name=shared --set agents.ida.serviceAccount.name=shared
# No override needed: an explicit name can equal another agent's default.
collides "a ServiceAccount name equals another agent's default" "belongs to one agent" \
  --set agents.harry.serviceAccount.name=agents-ida

# Creation is what collides, not the name — so the two cases differ by one `provider`. As
# written, harry owns the class and ida names it: a reference to an object the chart does not
# render, which is how agents share one operator-owned class. Giving ida a provider too makes
# it a second definition of one name.
csi="$work/csi.yaml"
cat > "$csi" <<'YAML'
agents:
  harry:
    secrets: { kubernetesSecret: "", csi: { secretProviderClass: shared, provider: aws } }
  ida:
    secrets: { kubernetesSecret: "", csi: { secretProviderClass: shared } }
YAML
collides "two agents create one SecretProviderClass" "belongs to one agent" \
  --values "$csi" --set agents.ida.secrets.csi.provider=aws
rendered=$(helm template agents "$chart" --values "$values" --values "$csi") \
  || fail "refused an agent referencing another's SecretProviderClass"
[ "$(grep -cF 'kind: SecretProviderClass' <<<"$rendered")" = 1 ] || fail "shared class is not one object"

# The same for a ServiceAccount the chart does not create: a name two agents may both take.
rendered=$(helm template agents "$chart" --values "$values" \
  --set agents.harry.serviceAccount.create=false --set agents.harry.serviceAccount.name=shared \
  --set agents.ida.serviceAccount.create=false --set agents.ida.serviceAccount.name=shared) \
  || fail "refused two agents sharing an operator-owned ServiceAccount"
[ "$(grep -cF 'kind: ServiceAccount' <<<"$rendered")" = 0 ] || fail "referenced ServiceAccount was created"

# The window between SIGTERM and SIGKILL has to outlast a turn, or a turn is killed inside
# its own budget and leaves no record of having been. Helm never reads the manifest that
# sets `limits.turnTimeoutMs`, so the schema can only hold the floor above the default —
# which is the value nearly every agent runs, and the one a plausible number like 30 loses.
out=$(helm template agents "$chart" --values "$values" \
  --set agents.harry.terminationGracePeriodSeconds=30 2>&1) \
  && fail "accepted a grace period shorter than the default turn timeout"
grep -qF 'terminationGracePeriodSeconds' <<<"$out" \
  || fail "refused for the wrong reason: short grace period"
helm template agents "$chart" --values "$values" \
  --set agents.harry.terminationGracePeriodSeconds=121 >/dev/null \
  || fail "refused the shortest grace period that outlasts a default turn"

# Nothing this chart renders mounts under `/run`. `/var/run` is a symlink to `/run`, and
# `/var/run/secrets` is where the kubelet projects a Pod's identity token, so a read-only
# volume covering that subtree stops `runc` creating the token's mountpoint and the
# container fails before its first process. Render time cannot see it — the manifest is
# valid, `helm lint --strict` and `helm template` both pass, and the pod reaches
# `RunContainerError` only on a cluster that projects a token. The assertion is the blunt
# rule rather than the exact one, because `/run` in a container is the kubelet's, and this
# chart has no reason to put anything there.
rendered=$(helm template agents "$chart" --values "$values")
under_run=$(grep -E '^ *mountPath: "?/(var/)?run(/|"|$)' <<<"$rendered" || true)
[ -z "$under_run" ] || fail "mounts under /run, over the kubelet's projected token subtree:
$under_run"

printf 'consume.sh: ok\n'
