# Run it for real

<sub>[Setup guide](../../SETUP.md) · 4 of 6 · run these commands from the repository root</sub>

## Step 8 — check before you run

```bash
./bin/sageox-agent doctor
```

Verifies the config parses, every credential resolves, the tool policy is valid, each MCP
server starts and has tools the policy admits, `ox` can authenticate, and that you have not
left a networked surface answering `anyone`. **Non-zero exit on any problem**, so it works
in a script.

## Step 9a — keep it running (macOS)

Install the ACP brain as a real binary first. A background service must not depend on
`npx` downloading it at startup:

```bash
npm install -g @agentclientprotocol/claude-agent-acp@0.68.0
```

```bash
AGENT=harry
mkdir -p ~/Library/LaunchAgents
if command -v mise >/dev/null 2>&1; then
  NODE_BIN_DIR="$(mise where node)/bin"
else
  NODE_BIN_DIR="$(dirname "$(command -v node)")"
fi
RUNTIME_PATH="$NODE_BIN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
sed -e "s|AGENT_BIN|$(pwd)/bin/sageox-agent|g" \
    -e "s|AGENT_HOME|$HOME/.config/agent-toolkit/agents/$AGENT|g" \
    -e "s|AGENT_NAME|$AGENT|g" \
    -e "s|RUNTIME_PATH|$RUNTIME_PATH|g" \
    deploy/ai.sageox.agent.plist.example \
  > ~/Library/LaunchAgents/ai.sageox.$AGENT.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.sageox.$AGENT.plist
tail -f ~/.config/agent-toolkit/agents/$AGENT/agent.log
```

One plist per agent — each has its own Label and log, and none needs a working directory.
Starts at login, restarts on crash, backs off 30s so a broken config cannot hot-loop.

```bash
launchctl kickstart -k gui/$(id -u)/ai.sageox.$AGENT     # restart
launchctl bootout gui/$(id -u)/ai.sageox.$AGENT          # stop and unload
```

**If it dies immediately** it is almost always `PATH` — launchd gives a minimal one. The
generated plist includes the directory of the currently selected Node; regenerate it after
changing Node installations. `agent.error.log` says which executable is missing.

## Step 9b — or deploy one or more bundles with Compose

Deployment uses the target's native artifacts. Every release publishes the runtime image to
`ghcr.io/sageox/agent-base` for `linux/amd64` and `linux/arm64`; it contains the
gateway, adapters, ACP bridge, and runtime binaries, but no agent identity, configuration,
or secret. Pulling it needs no GitHub account:

```bash
docker pull ghcr.io/sageox/agent-base:latest
```

Use a release tag for human-readable upgrades and pin its registry digest in production —
each [GitHub Release](https://github.com/sageox/agent-toolkit/releases) records the
digest it published, and the registry answers the same question for any tag without an
account:

```bash
docker buildx imagetools inspect ghcr.io/sageox/agent-base:0.1.0
```

A release tag is immutable: it is published once and never repointed, so a digest read from
either place stays the answer. That one immutable OCI image runs every bundle and gives
operators reproducible rollbacks and vulnerability scanning.

Building it yourself is only necessary for a fork, or when an agent needs an additional
system binary:

```bash
docker build -f deploy/docker/Dockerfile -t <registry>/<image>:<version> .
```

A deployment supplies bundle directories and secret bindings. Each secret directory contains
one file per logical `secretRef`; create those directories with SOPS, Dokploy, CI, or any
other secret distributor. The framework never stages or copies deployment credentials.

Copy [`deploy/docker/compose.yaml`](../../deploy/docker/compose.yaml) into the repository that owns
your deployment, set its paths, and run Compose directly:

```bash
export AGENT_IMAGE=ghcr.io/sageox/agent-base@sha256:<digest>
export AGENT_UID=$(id -u)
export AGENT_GID=$(id -g)
export HARRY_BUNDLE=~/.config/agent-toolkit/agents/harry
export HARRY_SECRETS=/srv/agent-secrets/harry
export IDA_BUNDLE=~/.config/agent-toolkit/agents/ida
export IDA_SECRETS=/srv/agent-secrets/ida

docker compose -f deploy/docker/compose.yaml config
docker compose -f deploy/docker/compose.yaml up -d
docker compose -f deploy/docker/compose.yaml logs -f harry
```

Compose runs each container as `AGENT_UID:AGENT_GID`, which must be the numeric
owner of every writable bundle it mounts. Bind mounts preserve host ownership; using the
image's default UID for a bundle owned by someone else would make state, memory, and
repository workspaces read-only.

The two example services share the image but not their bundle or secret mounts. The local
development `.env` is masked inside every container. Add another service to the Compose
file for another agent; mount shared markdown brains into each participating service at
the path declared in its manifest.

The runtime accepts any bundle path directly:

```bash
./bin/sageox-agent doctor --bundle /path/to/agent
./bin/sageox-agent run --bundle /path/to/agent
```

That is the complete runtime contract deployment adapters target.

## Step 9c — or deploy several bundles in one Helm release

The chart consumes Secrets and PVCs created by your own Kubernetes tooling, and mounts each
bundle from a volume you name.
Each agent gets a retained PVC, ServiceAccount, and singleton Deployment; agents share a
release and image without sharing a process or failure domain.

```bash
kubectl create namespace agents --dry-run=client -o yaml | kubectl apply -f -

kubectl -n agents create configmap agent-harry-bundle \
  --from-file=agent.yaml="$HARRY_BUNDLE/agent.yaml" \
  --from-file=AGENTS.md="$HARRY_BUNDLE/AGENTS.md" \
  --from-file=settings.json="$HARRY_BUNDLE/settings.json" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agents create configmap agent-ida-bundle \
  --from-file=agent.yaml="$IDA_BUNDLE/agent.yaml" \
  --from-file=AGENTS.md="$IDA_BUNDLE/AGENTS.md" \
  --from-file=settings.json="$IDA_BUNDLE/settings.json" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n agents create secret generic agent-harry \
  --from-file=/srv/agent-secrets/harry --dry-run=client -o yaml | kubectl apply -f -
kubectl -n agents create secret generic agent-ida \
  --from-file=/srv/agent-secrets/ida --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install agents ./deploy/helm \
  --namespace agents --create-namespace \
  --values deploy/helm/examples/two-agents.values.yaml
```

Add `repos.conf` when repositories are configured, along with any other non-secret file the
manifest references. Do not add `.env`, generated state, local memory, or secret files.

Copy the example values into your deployment repository and change the image, ConfigMap,
Secret, storage, and scheduling settings there. Use `helm template` or `helm install
--dry-run` to preview objects without contacting or changing a cluster. GitOps users can
produce immutable, hash-named bundle ConfigMaps with Kustomize and update only
`agents.<name>.bundle.volume`. If you update a same-name ConfigMap instead, restart that
agent's Deployment because its init container copies configuration only at Pod start.

A ConfigMap is the ordinary bundle source and the only one capped, at 1 MiB. `bundle.volume`
takes any Kubernetes VolumeSource, so a bundle that outgrows that cap moves to an image, a
claim, or a CSI volume without the chart changing — see
[the chart's README](../../deploy/helm/README.md#where-a-bundle-comes-from).

Values and rendered manifests contain only references, never bundle contents or credential
values. Bind an existing per-agent PVC with `persistence.existingClaim`, a Secrets Store CSI
class with `secrets.csi.secretProviderClass`, and each shared brain with a `sharedVolumes`
entry pointing at an existing ReadWriteMany claim.

---

[← Give it memory and tools](memory-and-tools.md) · [Reference →](reference.md)
