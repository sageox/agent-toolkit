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
refuses() {
  local why="$1" want="$2" out
  shift 2
  out=$(helm template agents "$chart" --values "$values" "$@" 2>&1) \
    && fail "expected a refusal: $why"
  grep -qF "$want" <<<"$out" || fail "refused for the wrong reason: $why"
}
dispatcher_account_from() {
  local yaml="$1" account
  account=$(awk '/^kind: ServiceAccount$/{found=1;next} found && /^  name:/{print $2;exit}' <<<"$yaml")
  [ -n "$account" ] || fail 'rendered dispatcher has no ServiceAccount name'
  printf '%s\n' "$account"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A chart is commonly copied into a consumer's infra tree without this repository's docs.
# Every job-contract/external-jobs link must therefore stay absolute and version-pinned.
copied_chart="$work/copied-chart"
cp -R "$chart" "$copied_chart"
readme="$copied_chart/README.md"
if grep -Eq '\.\./\.\./docs/(job-contract|external-jobs)\.md' "$readme"; then
  fail 'copied chart README contains a repository-relative job documentation link'
fi
# The exact multiset, not a total plus the set of distinct values: `external-jobs.md` is
# linked twice, so a count alone still passes when one of those two is replaced by a copy
# of another pinned link. Matched at any tag rather than at this release's, so a link left
# behind on the previous one is reported as the stale link it is.
release_docs='https://github.com/sageox/agent-toolkit/blob/v0.5.0/docs'
expected=$(printf '%s\n' \
  "$release_docs/external-jobs.md" \
  "$release_docs/external-jobs.md" \
  "$release_docs/external-jobs.md#structured-answers" \
  "$release_docs/job-contract.md#structured-work-events-schema-1" \
  "$release_docs/job-contract.md#what-a-body-finds-on-disk" | sort)
# Assigned rather than piped into the comparison: under `pipefail` a `grep` that matches
# nothing fails the assignment, and `set -e` would then kill the script before the
# assertion below could name what was wrong.
found=$(grep -oE 'https://github\.com/sageox/agent-toolkit/blob/[^/]+/docs/(job-contract|external-jobs)\.md(#[^)[:space:]]+)?' "$readme" | sort) || found=''
[ "$found" = "$expected" ] || fail "pinned job documentation links in the copied chart README do not match the release:
$(diff <(printf '%s\n' "$expected") <(printf '%s\n' "$found") | sed 's/^/  /')"

# Three declared jobs across two agents: one scheduled, one on-request, one parked.
render

absent 'name: AGENT_WORK_EVENTS'
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

present "mountPath: /mnt/secrets-store"

# `/agents` is this Pod's own, never the agent's `ReadWriteOnce` claim. A job Pod that
# mounted the claim could only attach where the Deployment Pod already ran; on any other
# node it sat in `Init:0/1` behind a `Multi-Attach` event until its deadline killed it, and
# its logs were empty because the body never started.
counted 2 "emptyDir: {}"
absent "claimName: agents-harry"
absent "claimName: agents-ida"
# And nothing pins a job Pod anywhere, which is what a job that needs no claim buys: it
# runs on whichever node has room, whatever the agent Pod is doing.
absent "name: checkouts"
absent "podAffinity"

# The Deployment keeps the claim. Its `/agents` holds the cursors, local memory, checkouts
# and indexes the contract calls durable, so gating the mount on the wrong side of `.job`
# would lose every one of them on the next rollout and render just as cleanly.
rendered=$(helm template agents "$chart" --values "$values" --show-only templates/deployment.yaml)
present "claimName: agents-harry"
present "claimName: agents-ida"
absent "emptyDir"
absent 'name: AGENT_WORK_EVENTS'

# Work events reach both CLI hosts, only for the agent that opted in. This includes
# local CronJobs, which otherwise have no env stanza at all.
for template in deployment cronjob; do
  rendered=$(helm template agents "$chart" --values "$values" \
    --set agents.harry.workEvents=true --show-only "templates/$template.yaml")
  counted 1 'name: AGENT_WORK_EVENTS'
  if ! grep -A1 -F 'name: AGENT_WORK_EVENTS' <<<"$rendered" | grep -qF 'value: "1"'; then
    fail "work events must use the runtime's exact opt-in value in $template"
  fi
  rendered=$(helm template agents "$chart" --values "$values" \
    --set agents.harry.workEvents=false --show-only "templates/$template.yaml")
  absent 'name: AGENT_WORK_EVENTS'
done
refuses "a string workEvents value" "workEvents" \
  --set-string agents.harry.workEvents=false

# `persistence.jobCheckouts` mounts the one thing on the claim a scheduled run could not
# cheaply build for itself: the checkouts the agent Pod clones and fast-forwards. Narrowed
# by `subPath` to `workspace/repos`, so `workspace/ox-data`, `state.json` and the local
# memory vault stay in the Deployment Pod — an index `ox` cannot write is reported corrupt
# and answers a search from nothing, and the other two are not a job's to read.
render --set agents.harry.persistence.jobCheckouts=true
counted 2 "name: checkouts"
present "mountPath: /agents/harry/workspace/repos"
present "subPath: harry/workspace/repos"
matched 1 "claimName: agents-harry$"
# Read-only, and said on the mount. The agent fast-forwards that tree at every start, so a
# body writing there is a second writer on a tree it does not own — and `ox` pointed at a
# writable index deletes the store the moment it reads one as corrupt.
if ! grep -A2 -F "mountPath: /agents/harry/workspace/repos" <<<"$rendered" | grep -qF "readOnly: true"; then
  fail "the checkouts mount must be read-only"
fi
# Not on the claim reference, though: the kubelet creates a missing `subPath` directory
# through it, and an agent that has never had a repos.conf has no `workspace/repos` yet.
if grep -A2 -E "claimName: agents-harry$" <<<"$rendered" | grep -qF "readOnly"; then
  fail "the checkouts claim reference must not be read-only"
fi

# The claim is ReadWriteOnce, so the Pod has to land where the agent Pod already holds it.
# Required and not preferred: a Pod scheduled elsewhere waits behind a `Multi-Attach` event
# with empty logs, and `DoesNotExist` keeps another job Pod of the same agent — which
# carries the same selector labels — from standing in for the Deployment's.
counted 1 "podAffinity:"
present "requiredDuringSchedulingIgnoredDuringExecution:"
absent "preferredDuringSchedulingIgnoredDuringExecution:"
present "topologyKey: kubernetes.io/hostname"
present "operator: DoesNotExist"
present "key: agent-toolkit/job"

# `/agents` is still each job Pod's own `emptyDir` — the run stages its bundle there, and
# the claim it now reads supplies one directory inside that tree and nothing else. ida sets
# nothing, so this is per agent and not a release-wide flip.
counted 2 "emptyDir: {}"
rendered=$(helm template agents "$chart" --values "$values" \
  --set agents.harry.persistence.jobCheckouts=true --show-only templates/deployment.yaml)
absent "name: checkouts"
absent "podAffinity"

# Every scheduled Pod stages its own bundle, into the `emptyDir` above. One that waited on
# the Deployment to have gone first would lose its run on a fresh install, and nothing
# retries it.
render
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
refuses "jobSecrets on an agent with no schedule" \
  "ida: jobSecrets is mounted by scheduled job Pods only, and this agent declares no schedule" \
  --values "$unmounted"

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

refuses "one agent creating one class from both its sources" \
  "harry/secrets and harry/jobSecrets would both create a SecretProviderClass named harry-agent" \
  --values "$csi" --set agents.harry.jobSecrets.csi.secretProviderClass=harry-agent


# External schedules are launchers: they retain admission credentials, but receive no
# task credentials, mutable checkout, or Kubernetes token. One dispatcher serves all jobs.
refuses "external worker below the supported Kubernetes floor" \
  "harry/shift: external worker requires Kubernetes 1.34 or newer" \
  --kube-version 1.33.0 \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker'
render --kube-version 1.33.0
counted 2 'kind: CronJob'

# THE FLOOR ON A REAL CLUSTER. Every managed distribution reports its GitVersion with a
# build suffix, which semver reads as a prerelease; the cases above use bare versions and
# so cannot tell a working floor from one that refuses every cluster it is meant to admit.
refuses "external worker below the floor on a managed distribution" \
  "harry/shift: external worker requires Kubernetes 1.34 or newer" \
  --kube-version v1.33.9-eks-bca9cf6 \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker'

render --kube-version v1.34.9-eks-bca9cf6 \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker'
counted 2 'kind: CronJob'

render --kube-version 1.34.0 \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set agents.harry.workEvents=true \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker' \
  --set 'agents.harry.jobs[0].worker.secrets.TASK_TOKEN.name=task-credentials' \
  --set 'agents.harry.jobs[0].worker.secrets.TASK_TOKEN.key=token' \
  --set agents.harry.jobSecrets.kubernetesSecret=old-job-secrets \
  --set agents.harry.jobSecrets.csi.secretProviderClass= \
  --set agents.harry.persistence.jobCheckouts=true \
  --set agents.harry.serviceAccount.automountJobToken=true
present 'name: AGENT_JOB_DISPATCHER_URL'
present 'name: AGENT_JOB_REQUEST_ID'
counted 1 'name: AGENT_WORK_EVENTS'
absent 'task-credentials'
absent 'old-job-secrets'
absent 'mountPath: /agents/harry/workspace/repos'
absent 'automountServiceAccountToken: true'

# The value comes from the Job controller's UID label, not the launcher's Pod UID. Every
# replacement Pod for one Job therefore presents the same dispatcher request identity.
printf '%s\n' "$rendered" >"$work/external-cronjob.yaml"
if ! pnpm --filter @sageox/agent-toolkit-core exec node --input-type=module \
  - "$work/external-cronjob.yaml" <<'NODE'
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const cronJobs = parseAllDocuments(readFileSync(process.argv[2], "utf8"))
  .map((document) => document.toJS())
  .filter((resource) => resource?.kind === "CronJob");
const launchers = cronJobs.flatMap((resource) => {
  const pod = resource.spec.jobTemplate.spec.template.spec;
  const requestId = pod.containers.flatMap((container) => container.env ?? [])
    .find((entry) => entry.name === "AGENT_JOB_REQUEST_ID");
  return requestId ? [{ pod, requestId }] : [];
});
if (launchers.length !== 1) throw new Error("expected one external scheduled launcher");
if (launchers[0].requestId?.valueFrom?.fieldRef?.fieldPath
  !== "metadata.labels['batch.kubernetes.io/controller-uid']") {
  throw new Error("scheduled launcher request identity is not the owning Job UID");
}
if (launchers[0].pod.automountServiceAccountToken !== false) {
  throw new Error("external scheduled launcher must not mount a Kubernetes token");
}
NODE
then
  fail 'external scheduled launcher identity is invalid'
fi

rendered=$(helm template agents "$chart" --values "$values" \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker' \
  --set 'agents.harry.sharedVolumes[0].name=shared-state' \
  --set 'agents.harry.sharedVolumes[0].mountPath=/shared' \
  --set 'agents.harry.sharedVolumes[0].claimName=shared-state' \
  --show-only templates/dispatcher.yaml)
counted 1 'kind: Deployment'
absent 'mountPath: /mnt/secrets-store'
absent 'mountPath: /mnt/job-secrets-store'
absent 'name: shared-state'

# Assert relationships on parsed resources. Independent substring checks cannot prove that
# a Role verb belongs to the intended resource or that a container mount exists in its Pod.
printf '%s\n' "$rendered" >"$work/dispatcher.yaml"
if ! pnpm --filter @sageox/agent-toolkit-core exec node --input-type=module \
  - "$work/dispatcher.yaml" <<'NODE'
import { readFileSync } from "node:fs";
import { parseAllDocuments } from "yaml";

const resources = parseAllDocuments(readFileSync(process.argv[2], "utf8"))
  .map((document) => document.toJS())
  .filter(Boolean);
const find = (kind) => resources.find((resource) => resource.kind === kind);
const serviceAccount = find("ServiceAccount");
const deployment = find("Deployment");
const role = find("Role");

if (!serviceAccount?.metadata?.name) throw new Error("dispatcher ServiceAccount has no name");
if (deployment?.spec?.template?.spec?.serviceAccountName !== serviceAccount.metadata.name) {
  throw new Error("dispatcher Deployment does not use its ServiceAccount");
}

const pod = deployment.spec.template.spec;
const volumes = new Set((pod.volumes ?? []).map((volume) => volume.name));
for (const container of [...(pod.initContainers ?? []), ...(pod.containers ?? [])]) {
  for (const mount of container.volumeMounts ?? []) {
    if (!volumes.has(mount.name)) {
      throw new Error(`${container.name} mount ${mount.name} has no declared volume`);
    }
  }
}

const expectedRules = [
  { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
  { apiGroups: [""], resources: ["configmaps"], verbs: ["get", "list", "create", "update", "delete"] },
  { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "create", "delete"] },
  { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
];
if ((role?.rules ?? []).length !== expectedRules.length) {
  throw new Error("dispatcher Role grants an unexpected number of rules");
}
for (const expected of expectedRules) {
  const rule = role?.rules?.find((candidate) =>
    JSON.stringify(candidate.resources) === JSON.stringify(expected.resources));
  if (JSON.stringify(rule?.verbs) !== JSON.stringify(expected.verbs)
    || JSON.stringify(rule?.apiGroups) !== JSON.stringify(expected.apiGroups)) {
    throw new Error(`dispatcher Role rule for ${expected.resources[0]} is incorrect`);
  }
}
NODE
then
  fail 'dispatcher resource relationships are invalid'
fi

refuses "worker without dispatcher" \
  "harry/shift: external worker requires dispatcher.tokenSecret" \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker'
refuses "worker sharing the gateway identity" \
  "harry/shift: worker must use a separate ServiceAccount from the gateway" \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=agents-harry'

# Isolation covers every agent in a release, including externally managed accounts.
refuses "worker sharing another gateway identity" \
  "harry/shift: worker must use a separate ServiceAccount from the gateway" \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=agents-ida'
for secret in agent-ida ida-dispatcher-auth ida-job-secrets; do
  refuses "worker sharing another agent's $secret secret" \
    "harry/shift: worker secret TASK_TOKEN ($secret) must be separate from gateway, dispatcher, and scheduled-job secrets" \
    --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
    --set agents.ida.dispatcher.tokenSecret=ida-dispatcher-auth \
    --set agents.ida.jobSecrets.kubernetesSecret=ida-job-secrets \
    --set agents.ida.jobSecrets.csi.secretProviderClass= \
    --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker' \
    --set "agents.harry.jobs[0].worker.secrets.TASK_TOKEN.name=$secret" \
    --set 'agents.harry.jobs[0].worker.secrets.TASK_TOKEN.key=token'
done
rendered=$(helm template agents "$chart" --values "$values" \
  --set agents.ida.dispatcher.tokenSecret=ida-dispatcher-auth --show-only templates/dispatcher.yaml)
broken_dispatcher=${rendered/kind: ServiceAccount/kind: MissingServiceAccount}
if diagnostic=$(dispatcher_account_from "$broken_dispatcher" 2>&1); then
  fail 'dispatcher account extraction accepted a render without a ServiceAccount'
fi
[ "$diagnostic" = 'jobs.sh: rendered dispatcher has no ServiceAccount name' ] \
  || fail 'dispatcher account extraction failed without its specific diagnostic'
dispatcher_account=$(dispatcher_account_from "$rendered")
refuses "worker sharing another dispatcher identity" \
  "harry/shift: worker must not use the dispatcher ServiceAccount" \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set agents.ida.dispatcher.tokenSecret=ida-dispatcher-auth \
  --set "agents.harry.jobs[0].worker.serviceAccountName=$dispatcher_account"
refuses "gateway sharing another dispatcher identity" \
  "harry: gateway must not use the dispatcher ServiceAccount $dispatcher_account" \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set agents.ida.dispatcher.tokenSecret=ida-dispatcher-auth \
  --set "agents.harry.serviceAccount.name=$dispatcher_account"

# Fail at chart validation, before a profile can crash the dispatcher at startup.
for resource in 'cpu=1' 'requests.cpu=1' 'limits.memory=128'; do
  case "$resource" in
    cpu=1) want="additional properties 'cpu' not allowed" ;;
    requests.cpu=1) want="at '/agents/harry/jobs/0/worker/resources/requests/cpu': got number, want string" ;;
    limits.memory=128) want="at '/agents/harry/jobs/0/worker/resources/limits/memory': got number, want string" ;;
  esac
  refuses "invalid worker resources: $resource" "$want" \
    --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
    --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker' \
    --set "agents.harry.jobs[0].worker.resources.$resource"
done
rendered=$(helm template agents "$chart" --values "$values" \
  --set agents.harry.dispatcher.tokenSecret=dispatcher-auth \
  --set 'agents.harry.jobs[0].worker.serviceAccountName=task-worker' \
  --set-string 'agents.harry.jobs[0].worker.resources.requests.cpu=1' \
  --set-string 'agents.harry.jobs[0].worker.resources.limits.memory=128Mi' \
  --show-only templates/dispatcher.yaml)
present '\"resources\":{\"limits\":{\"memory\":\"128Mi\"},\"requests\":{\"cpu\":\"1\"}}'

printf 'jobs.sh: ok\n'
