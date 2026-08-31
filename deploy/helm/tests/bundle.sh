#!/usr/bin/env bash
# Rendered-output test for where a bundle comes from. Run it directly, or from CI:
#
#   deploy/helm/tests/bundle.sh
#
# The chart's contract is a directory at `/config` that `stage-config` copies onto the
# claim. `bundle.volume` is whatever Kubernetes will mount there, passed through verbatim,
# and `bundle.stageImage` is the image that does the copying — two passthroughs, so the
# thing worth asserting is that no source gets a branch of its own and that the one shape
# with a hand-written key-to-path mapping is still checked.
set -euo pipefail

chart="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image=ghcr.io/example/agent-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
bundle_image=ghcr.io/example/harry-bundle@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

rendered=""
fail() {
  printf 'bundle.sh: %s\n' "$1" >&2
  exit 1
}
absent() { grep -qF -- "$1" <<<"$rendered" && fail "unexpected in rendered output: $1"; return 0; }
counted() {
  local want="$1" needle="$2" got
  got=$(grep -cF -- "$needle" <<<"$rendered" || true)
  [ "$got" = "$want" ] || fail "expected $want × '$needle', found $got"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# One agent with one scheduled job, so every render below produces both a Deployment and a
# CronJob. Only the `bundle:` block, passed in already indented, differs between them.
values() {
  local name="$1"
  { cat <<YAML
imageRef: $image
agents:
  harry:
YAML
    cat
    cat <<'YAML'
    serviceAccount: { create: true, name: "" }
    secrets: { kubernetesSecret: "", csi: { secretProviderClass: "" } }
    persistence: { size: 10Gi }
    jobs:
      - slug: shift
        suspend: false
        trigger: { schedules: ["0 3 * * *"], timezone: UTC }
        budget: { wallClockMs: 600000, deadlineHeadroomMs: 300000 }
    terminationGracePeriodSeconds: 130
    resources: {}
    sharedVolumes: []
YAML
  } > "$work/$name.yaml"
}

render() { rendered=$(helm template agents "$chart" --values "$work/$1.yaml" "${@:2}"); }

# The staging script is what proves there is no per-source branching: it is one block, and
# it has to come out byte for byte the same whatever the bundle rides on. From `command:`
# rather than from the container's name, because the image above it is the second knob and
# is meant to differ; the script that runs under it is not.
staging() {
  sed -n '/command: \["\/bin\/sh"/,/securityContext:/p' <<<"$rendered" | sha256sum
}
same_staging() {
  [ "$(staging)" = "$configmap_staging" ] \
    || fail "a $1 bundle stages differently from a ConfigMap one"
}

values configmap <<'YAML'
    bundle:
      volume:
        configMap:
          name: agent-harry-bundle
          items:
            - { key: hidden-policy, path: .tool-policy.yaml }
YAML

values image <<'YAML'
    bundle:
      volume:
        image:
          reference: ghcr.io/example/harry-bundle:v3
          pullPolicy: IfNotPresent
YAML

values claim <<'YAML'
    bundle:
      volume:
        persistentVolumeClaim:
          claimName: harry-bundle
          readOnly: true
YAML

# 1. Every source renders both workloads from the same template, and the VolumeSource
# arrives verbatim — including `pullPolicy` and `readOnly`, fields the chart has no
# knowledge of and could not have copied deliberately.
render configmap
counted 1 "kind: Deployment"
counted 1 "kind: CronJob"
counted 2 "name: agent-harry-bundle"
counted 2 "path: .tool-policy.yaml"
configmap_staging=$(staging)

render image
counted 1 "kind: Deployment"
counted 1 "kind: CronJob"
counted 2 "reference: ghcr.io/example/harry-bundle:v3"
counted 2 "pullPolicy: IfNotPresent"
same_staging image

render claim
counted 1 "kind: Deployment"
counted 1 "kind: CronJob"
counted 2 "claimName: harry-bundle"
same_staging claim

# Every source mounts at the one path the script reads — one mount and one volume in each
# of the two Pods — and none of them reaches the agent container: the bundle is staged onto
# the claim, and the agent runs from there.
counted 2 "mountPath: /config"
counted 4 "name: config"

# 2. A `stageImage` with no volume: that image runs the copy, and there is no `config`
# volume to mount, because the bundle is already at `/config` inside it.
values staged <<YAML
    bundle:
      stageImage: $bundle_image
YAML
render staged
counted 2 "image: \"$bundle_image\""
absent "mountPath: /config"
absent "name: config"
same_staging staged
# The agent container still runs the one pinned runtime. Only the bundle's transport moved.
counted 2 "image: \"$image\""

# `stageImage` alongside a volume is the ordinary way to stage from a source the runtime
# image cannot read on its own: the image runs, and the volume mounts over its own /config.
values both <<'YAML'
    bundle:
      stageImage: ghcr.io/example/unpacker:1
      volume:
        configMap:
          name: agent-harry-bundle
YAML
render both
counted 2 'image: "ghcr.io/example/unpacker:1"'
counted 2 "mountPath: /config"

# 3. A bundle with neither is refused at render. Rendered, it is a `stage-config` with
# nothing at `/config`: `cp -LR /config/.` fails the init container, and on the CronJob
# path that is a run lost under `backoffLimit: 0`.
refuses() {
  local name="$1" want="$2" out
  out=$(helm template agents "$chart" --values "$work/$name.yaml" "${@:3}" 2>&1) \
    && fail "$name rendered where it should have been refused: $want"
  grep -qF "$want" <<<"$out" || fail "$name was refused for some other reason than: $want"
}
values empty <<'YAML'
    bundle: {}
YAML
refuses empty "bundle needs a volume or a stageImage"

# 4. Only a ConfigMap source carries a key-to-path mapping a consumer wrote by hand, so it
# is the one shape where an escaping or credential-shaped destination can still be spelled.
# Both checks predate `bundle.volume` and have to keep reaching through it.
refuses configmap "must stay inside the bundle" \
  --set 'agents.harry.bundle.volume.configMap.items[0].key=x' \
  --set 'agents.harry.bundle.volume.configMap.items[0].path=../escape'
refuses configmap "must stay inside the bundle" \
  --set 'agents.harry.bundle.volume.configMap.items[0].key=x' \
  --set 'agents.harry.bundle.volume.configMap.items[0].path=/agent.yaml'
refuses configmap "refusing credential path" \
  --set 'agents.harry.bundle.volume.configMap.items[0].key=x' \
  --set 'agents.harry.bundle.volume.configMap.items[0].path=secrets/token'
refuses configmap "refusing credential path" \
  --set 'agents.harry.bundle.volume.configMap.items[0].key=x' \
  --set 'agents.harry.bundle.volume.configMap.items[0].path=.env'

# 5. The roll annotation covers the whole `bundle` stanza, so a Pod template changes on any
# change of source. Keyed on the ConfigMap name alone, a bundle that moved to a new image
# digest — or to a different claim — rolled nothing at all.
annotation() {
  render "$1" --show-only templates/deployment.yaml
  grep -F 'agent-toolkit/bundle-sha256:' <<<"$rendered"
}
base=$(annotation configmap)
[ "$(annotation configmap)" = "$base" ] || fail "the roll annotation is not stable across renders"
for changed in image claim staged both; do
  [ "$(annotation "$changed")" != "$base" ] \
    || fail "the roll annotation did not change for a $changed bundle"
done
# Including a change Helm makes no other use of: the digest inside an image source.
rolled=$(helm template agents "$chart" --values "$work/image.yaml" \
  --set 'agents.harry.bundle.volume.image.reference=ghcr.io/example/harry-bundle:v4' \
  --show-only templates/deployment.yaml | grep -F 'agent-toolkit/bundle-sha256:')
[ "$rolled" != "$(annotation image)" ] \
  || fail "the roll annotation did not change for a new image reference"

printf 'bundle.sh: ok\n'
