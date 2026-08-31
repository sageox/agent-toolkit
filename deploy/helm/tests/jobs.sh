#!/usr/bin/env bash
# Rendered-output test for the job CronJobs. Run it directly, or from CI:
#
#   deploy/helm/tests/jobs.sh
#
# It asserts on rendered YAML rather than on the template, because the failure this
# guards against is absence: a job that renders nothing looks exactly like an agent that
# declared none.
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
values="$chart/examples/two-agents.values.yaml"

rendered=""
fail() {
  printf 'jobs.sh: %s\n' "$1" >&2
  exit 1
}
present() { grep -qF -- "$1" <<<"$rendered" || fail "expected in rendered output: $1"; }
absent() { grep -qF -- "$1" <<<"$rendered" && fail "unexpected in rendered output: $1"; return 0; }
counted() {
  local want="$1" needle="$2" got
  got=$(grep -cF -- "$needle" <<<"$rendered" || true)
  [ "$got" = "$want" ] || fail "expected $want × '$needle', found $got"
}
matched() {
  local want="$1" pattern="$2" got
  got=$(grep -cE -- "$pattern" <<<"$rendered" || true)
  [ "$got" = "$want" ] || fail "expected $want lines matching /$pattern/, found $got"
}

render() {
  rendered=$(helm template agents "$chart" --values "$values" \
    --show-only templates/cronjob.yaml "$@")
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Three declared jobs across two agents: one scheduled, one on-request, one parked.
render

counted 2 "kind: CronJob"
# Anchored, because a separator swallowed into the end of the preceding line still reads as
# `---` to a substring search while collapsing both objects into one document — of which
# only the last would ever be applied.
matched 2 "^---$"
present "name: agents-harry-shift"
present "name: agents-ida-sweep"
# An on-request job declares no schedule and so renders no scheduled object.
absent "inbox"

present 'schedule: "0 */4 * * 1-5"'
present 'timeZone: "America/New_York"'
present 'schedule: "0 3 * * 0"'
present 'timeZone: "UTC"'

# The deadline is the budget plus its headroom, in whole seconds: 1800000 + 300000, and
# 3600000 + 300000.
counted 1 "activeDeadlineSeconds: 2100"
counted 1 "activeDeadlineSeconds: 3900"

# The hard switch parks exactly the job that declared it.
counted 1 "suspend: true"
counted 1 "suspend: false"

# Single-flight and no platform retry, on every rendered job.
counted 2 "concurrencyPolicy: Forbid"
counted 2 "backoffLimit: 0"
counted 2 "restartPolicy: Never"

# The host runs, never the body: it reads the job's own argv from the bundle and owns the
# rest of the envelope. The trigger is stamped by the door, so a scheduled object may only
# ever claim `schedule`.
present "- job"
present "- run"
present '- "shift"'
present "- --trigger"
counted 2 "- schedule"
present "- --bundle"
present "- /agents/harry"
present "- --secrets"
counted 2 "- /mnt/secrets-store"
# Nothing in the rendered object names the job body — that stays in the manifest.
absent "runner/"

present "claimName: agents-harry"
present "mountPath: /mnt/secrets-store"

# Every scheduled Pod stages its own bundle. One that waited on the Deployment to have gone
# first would lose its run on a fresh install, and nothing retries it. It stages by rename
# rather than in place, because that same claim is being staged by the agent Pod and by
# every other job of this agent.
counted 2 "name: stage-config"
present 'dest="/agents/harry/${file#$stage/}"'
present 'dest="/agents/ida/${file#$stage/}"'
present "name: agent-harry-bundle"
# `repos.conf` goes only once the ConfigMap has stopped supplying one — never up front,
# which is a window where a configured agent starts and reads no repositories.
present '[ -e /config/repos.conf ] || rm -f /agents/harry/repos.conf'
matched 0 '^ *rm -f /agents/harry/repos\.conf$'

# A budget that is not a whole number of seconds rounds up. Rounding down would spend the
# headroom the declaration reserved for a job's closing writes.
render --set agents.harry.jobs[0].budget.wallClockMs=1800001
counted 1 "activeDeadlineSeconds: 2101"

# Without the knob no rendered Pod mounts a token, which is the only credential in-cluster
# API auth has.
render
counted 2 "automountServiceAccountToken: false"

# `automountJobToken` reaches the job Pods of the agent that set it, and no further: ida
# shares the release and keeps its false.
render --set agents.harry.serviceAccount.automountJobToken=true
counted 1 "automountServiceAccountToken: true"
counted 1 "automountServiceAccountToken: false"

# And reaches neither other object, with both agents asking. The Deployment is the property
# the knob's name is protecting — its Pod runs an LLM over untrusted channel text. The
# ServiceAccount stays false too, and a Pod spec that states this field wins over it, which
# is what keeps the token on the job Pods and off anything else naming that identity.
# One set of flags for both renders, so the guard is provably reading the release that
# turned the token on rather than a differently-spelled one that never did.
both=(--set agents.harry.serviceAccount.automountJobToken=true
      --set agents.ida.serviceAccount.automountJobToken=true)
render "${both[@]}"
counted 2 "automountServiceAccountToken: true"
for template in deployment serviceaccount; do
  rendered=$(helm template agents "$chart" --values "$values" "${both[@]}" \
    --show-only "templates/$template.yaml")
  counted 2 "automountServiceAccountToken: false"
  absent "automountServiceAccountToken: true"
done

# A credential only a job needs, kept off the Pod that runs the brain. This is the one
# assertion here about a boundary rather than a rendering, and the boundary is an absence —
# which is what nothing on a cluster reports. A chart that mounted the job source in both
# places would render valid YAML, pass every other check in this file, and put a write
# credential beside a prompt-injection surface.
split="$work/split.yaml"
cat > "$split" <<'YAML'
agents:
  harry:
    secrets: { kubernetesSecret: agent-harry, csi: { secretProviderClass: "" } }
    jobSecrets: { kubernetesSecret: agent-harry-job, csi: { secretProviderClass: "" } }
YAML

# Anchored: `agent-harry` is a prefix of `agent-harry-job`, so an unanchored absence check
# would read the job's own secret as the agent's and pass on the very rendering it refuses.
rendered=$(helm template agents "$chart" --values "$values" --values "$split" \
  --show-only templates/deployment.yaml)
matched 1 "secretName: agent-harry$"
matched 0 "secretName: agent-harry-job$"
# Not the volume, not the mount, not the flag. The Deployment Pod is the one that runs an
# LLM over untrusted channel text; every one of these reaching it is the finding.
absent "job-secrets"
absent "/mnt/job-secrets-store"

# The job Pod mounts both: its own source *and* the agent's. Additive rather than a swap,
# because the job process still resolves the agent's credentials for its status post and its
# kill switch — and both of those swallow a resolve failure, so a swap would disarm a switch
# and lose a report with nothing but a note on the stdout of a Pod nobody reads.
rendered=$(helm template agents "$chart" --values "$values" --values "$split" \
  --show-only templates/cronjob.yaml)
matched 1 "secretName: agent-harry-job$"
matched 1 "secretName: agent-harry$"
present "mountPath: /mnt/job-secrets-store"
present "mountPath: /mnt/secrets-store"

# The flag, because the mount alone resolves nothing: `job run` searches the job directory
# only when told to, and the order is what makes the job source win.
present "- --job-secrets"
present "- /mnt/job-secrets-store"
present "- --secrets"

# ida splits nothing and is unchanged, so this is per agent and not a release-wide flip.
# Two occurrences across both CronJobs — harry's volume and harry's mount — and none of
# them ida's.
matched 1 "secretName: agent-ida$"
counted 2 "name: job-secrets"

# Absent, every Pod mounts what it always did and no flag appears.
rendered=$(helm template agents "$chart" --values "$values")
counted 0 "job-secrets"
for template in deployment cronjob; do
  rendered=$(helm template agents "$chart" --values "$values" --show-only "templates/$template.yaml")
  matched 1 "secretName: agent-harry$"
done

# A source no Pod mounts. `jobSecrets` reaches the CronJob Pods this chart renders and
# nothing else, so an agent with no schedule has moved no credential while reading as though
# it had.
unmounted="$work/unmounted.yaml"
cat > "$unmounted" <<'YAML'
agents:
  ida:
    jobs:
      - slug: inbox
        suspend: false
        trigger: { schedules: [], timezone: UTC }
        budget: { wallClockMs: 600000, deadlineHeadroomMs: 300000 }
    jobSecrets: { kubernetesSecret: ida-job, csi: { secretProviderClass: "" } }
YAML
out=$(helm template agents "$chart" --values "$values" --values "$unmounted" 2>&1) \
  && fail "expected a refusal: jobSecrets on an agent with no schedule"
grep -qF "declares no schedule" <<<"$out" \
  || fail "refused for the wrong reason: jobSecrets with no schedule"

# Two sources, two classes — and a name is still an object this chart creates, so both go
# through the same collision check, including against each other.
csi="$work/csi.yaml"
cat > "$csi" <<'YAML'
agents:
  harry:
    secrets: { kubernetesSecret: "", csi: { secretProviderClass: harry-agent, provider: aws } }
    jobSecrets: { kubernetesSecret: "", csi: { secretProviderClass: harry-job, provider: aws } }
YAML
rendered=$(helm template agents "$chart" --values "$values" --values "$csi" \
  --show-only templates/secretproviderclass.yaml)
counted 2 "kind: SecretProviderClass"
present "name: harry-agent"
present "name: harry-job"

out=$(helm template agents "$chart" --values "$values" --values "$csi" \
  --set agents.harry.jobSecrets.csi.secretProviderClass=harry-agent 2>&1) \
  && fail "expected a refusal: one agent creating one class from both its sources"
grep -qF "harry/secrets and harry/jobSecrets" <<<"$out" \
  || fail "refused for the wrong reason: one class from two sources"

printf 'jobs.sh: ok\n'
