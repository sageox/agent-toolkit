# Agent Helm chart

This chart runs one or more portable agent bundles in one Helm release. Every identity gets
its own retained PVC, ServiceAccount, and single-replica `Recreate` Deployment. Agents share
an immutable runtime image and release, but not a process, state volume, or secret mount.

The chart consumes ordinary Kubernetes objects rather than generating or owning bundle and
credential data. A bundle reaches the Pod as a directory at `/config`, which an init
container copies onto that agent's claim — so the bundle's transport is a `bundle.volume`
you supply, any Kubernetes VolumeSource, passed through verbatim. Create it however your
tooling creates volumes, and one Secret (or Secrets Store CSI class) for the bundle's
logical `secretRef` files. A ConfigMap is the ordinary choice:

```bash
kubectl -n agents create configmap agent-harry-bundle \
  --from-file=agent.yaml=/srv/agents/harry/agent.yaml \
  --from-file=AGENTS.md=/srv/agents/harry/AGENTS.md \
  --from-file=settings.json=/srv/agents/harry/settings.json \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n agents create secret generic agent-harry \
  --from-file=/srv/agent-secrets/harry \
  --dry-run=client -o yaml | kubectl apply -f -
```

Include `repos.conf` when configured and any other non-secret file referenced by the
manifest. Exclude `.env`, generated state, local memory, and credentials.

Each key of that Secret — or each object a `SecretProviderClass` mounts — becomes one file
at `/mnt/secrets-store/<secretRef>`, and that path is not configurable. It has to agree with
the `Read(//mnt/secrets-store/**)` deny rule in the bundle's own `settings.json`, which Helm
never reads, so a values key would let a release move the mount out from under the one rule
that keeps the agent's brain from reading its credentials.

Copy [`examples/two-agents.values.yaml`](examples/two-agents.values.yaml) into the repository
that owns your deployment, point each `bundle.volume` and secret reference at the objects it
manages, then use Helm directly:

```bash
helm template agents ./deploy/helm \
  --namespace agents --values agents.values.yaml

helm upgrade --install agents ./deploy/helm \
  --namespace agents --create-namespace --values agents.values.yaml
```

Or depend on it, and nest this chart's values under its name. Helm hands every subchart a
`global` key whether or not the parent sets one, so the root values schema accepts it:

```yaml
# Chart.yaml
dependencies:
  - name: agent
    version: 0.10.0
    repository: "file://../agent-toolkit/deploy/helm"
```

```yaml
# values.yaml
agent:
  imageRef: ghcr.io/example/agent-base@sha256:...
  agents:
    harry: { ... }
```

## Where a bundle comes from

`bundle.volume` is a Kubernetes VolumeSource and nothing else — the chart copies it into the
Pod spec without reading it, so any source your cluster can mount works, including one that
did not exist when this chart was written:

```yaml
bundle:
  volume: { configMap: { name: harry-bundle } }                  # the ordinary choice
  # volume: { image: { reference: ghcr.io/me/harry-bundle:v3 } } # Kubernetes 1.33+
  # volume: { persistentVolumeClaim: { claimName: harry-bundle } }
  # volume: { csi: { driver: ..., volumeAttributes: { ... } } }
```

Only the ConfigMap source is capped, at 1 MiB for the serialized object, and only it has to
flatten a bundle's directory tree into keys — a ConfigMap key cannot contain `/`. Set `items`
to map keys back onto destination paths, using the native ConfigMap volume `key`/`path`
mapping; the render refuses a `path` that is absolute, escapes the bundle, or looks like a
credential. Note
that `items` also *narrows* the volume to the keys it lists, which is Kubernetes' behaviour
and not the chart's. Every other source carries a directory tree already, so nested paths,
dotfiles, and arbitrary filenames need no mapping at all.

Each source costs what that source costs at Pod start, and the chart takes none of them on
your behalf. An `image:` source is one more pull from a registry the node already pulls
`imageRef` from, with the same node credential — pin it by digest for the same reason
`imageRef` is pinned by digest, and note that a failed pull on a CronJob loses that run
under `backoffLimit: 0`, the same class of failure as an `imageRef` pull failure. A
`persistentVolumeClaim:` or `csi:` source costs whatever that driver costs at attach — and
on an agent that declares a schedule it has to be mountable from more than one node,
normally `ReadWriteMany`. A job Pod mounts the bundle source too, and `ReadWriteOnce` binds
a volume to whichever node holds it: the job Pod then sits in `Init:0/1` behind a
`Multi-Attach` event until its deadline kills it, unless it happened to land beside the
Deployment. `readOnly: true` does not help — the limit is on nodes, not on writers. The
chart cannot check this for you: values carry a `claimName`, the access mode lives on the
claim, and the chart tooling deliberately does not contact the cluster. The agent's own
claim is [not mounted in a job Pod](#jobs) for this reason; a bundle claim still is, on
every scheduled run.

Nothing here caps what a bundle may carry. On an uncapped source a runner can ship
`node_modules`, a compiled binary, or a model file; whether it *should* is a policy you set,
not a limit of this chart.

Bundle files must be readable by uid 10001. `fsGroup` covers claim and CSI sources; a
ConfigMap or image source carries its own modes, so a `COPY --chmod=600` in the image that
builds a bundle breaks staging. A `secret:` bundle volume is not refused — it is your
cluster — but the staging script drops `.env` and the render refuses credential-looking
`items` paths, so a credential put there is neither staged nor unnoticed.

### Staging from an image

`bundle.stageImage` is the image the init container runs, defaulting to `imageRef`. With no
`bundle.volume` at all, the bundle rides inside that image at `/config`:

```yaml
bundle:
  stageImage: ghcr.io/me/harry-bundle@sha256:...
```

```dockerfile
FROM busybox:1.37
COPY bundle/ /config/
```

The base matters: this image runs the staging script, so it needs `/bin/sh` along with
`install`, `mktemp`, `cp`, `find`, `mkdir`, `mv` and `rm`. Busybox or any distro base has
them; `scratch` and distroless do not, and nothing at render time can tell — the Deployment
never becomes ready, and a scheduled run is lost.

That is the same artifact an `image:` volume would carry, for a cluster below 1.33 where an
image volume is not available. It is not a per-agent runtime image: the agent container still
runs the one pinned `imageRef`, and only the bundle's transport is per-agent. Setting both
`stageImage` and `volume` is the ordinary way to stage from a source the runtime image cannot
read on its own — the volume mounts over the image's own `/config`. Setting neither is
refused at render.

### Rolling a bundle

The Pod template carries a hash of the whole `bundle` stanza, so any change of source — a
renamed ConfigMap, a new image digest, a different claim — rolls that agent and no other.
What is *inside* the source stays out of view: editing a same-name ConfigMap in place, or
repushing a mutable tag, rolls nothing, so prefer immutable or content-hashed names and
digests, and restart the Deployment by hand if you edit in place.

Two limits of the copy onto the claim, both from the bundle sharing one directory with the
agent's mutable state — cursors, checkouts, and indexes cannot be replaced wholesale, so the
bundle cannot either. A file dropped from the bundle is not removed from the claim; only
`repos.conf` is, because it is the one name whose absence changes behaviour. And a bundle is
staged file by file rather than all at once, so a stage that reads a source mid-change — a
same-name ConfigMap being refreshed under it — can leave two generations mixed until the
next stage. Immutable sources keep that to the one apply that changes them.

`podAnnotations`, `nodeSelector`, `tolerations`, `priorityClassName`, and
[`networkPolicy`](#network-policy) are release-wide.
Resources, secret sources, persistence, shutdown grace, and shared volumes are per agent.
Use `persistence.existingClaim` for operator-owned state, and add one `sharedVolumes` entry
for each shared brain path. Shared-memory claims must support access from every participating
workload, normally `ReadWriteMany`. If a manifest enables age-encrypted vault slices, put
the matching `identitySecret` file in that agent's existing Secret or CSI mount; the public
recipient belongs in `agent.yaml`, never the private identity.

The chart deliberately fixes every identity to one replica. Put the agent name from
`agent.yaml` at the corresponding `agents.<name>` key, and keep
`terminationGracePeriodSeconds` greater than the manifest's `limits.turnTimeoutMs`. The
schema's floor holds it above the default `limits.turnTimeoutMs` of 120000 and can hold it
no higher, because Helm never reads the manifest that sets it — an agent that raises that
timeout has to raise this with it, and nothing will say so. Overshooting is free: the
kubelet terminates the Pod as soon as the process exits, so the number bounds a hung
shutdown rather than lengthening an ordinary one.

## Cloud identity

`serviceAccount.annotations` lands on that agent's generated ServiceAccount. It is where a
cloud identity that binds *to a ServiceAccount* goes — EKS IRSA's
`eks.amazonaws.com/role-arn`, GKE Workload Identity's `iam.gke.io/gcp-service-account`.
`podAnnotations` is not a substitute: it is release-wide and lands on the Pod.

```yaml
agents:
  harry:
    serviceAccount:
      create: true
      name: ""
      annotations:
        eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/agent-harry
```

`automountServiceAccountToken: false` does not stand in IRSA's way: the identity webhook
injects its own projected token volume, keyed off that annotation. That is a *cloud*
identity and separate from
[the cluster-API token a job may mount](#a-job-that-reads-the-kubernetes-api). The reference
AWS composition in [`../terraform/aws-eks-agent`](../terraform/aws-eks-agent) needs no
annotation at all — EKS Pod Identity associates a role by ServiceAccount *name* — so this
is for the cluster without that add-on, which is a cluster-wide install and not a per-agent
one.

### The containers this chart names

Three, and they are fixed:

| Container | Where | What runs in it |
|---|---|---|
| `agent` | Deployment Pod | the gateway, and the brain as its subprocess |
| `job` | CronJob Pod | `sageox-agent job run <slug>` |
| `stage-config` | init container of both | the bundle copy into `/agents` |

They are listed because a cluster add-on that acts on *some* containers needs their names,
and nothing else here would tell you them. EKS's IRSA webhook is the case worth spelling
out: `eks.amazonaws.com/skip-containers` excludes named containers from having
`AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` injected, and `agent` is the one worth
excluding — it is where an LLM reads untrusted channel text.

```yaml
podAnnotations:
  eks.amazonaws.com/skip-containers: "agent,job"
```

`podAnnotations` is release-wide and lands on every Pod, so one value has to name the
containers of both. **Whether a name matching no container in a given Pod is ignored or
rejected is the webhook's behaviour and is not asserted here** — this chart renders the
annotation it is given and knows nothing about the add-on reading it. Check it against your
own cluster before counting on it, and if the webhook objects, set the annotation on the
Deployment through your own tooling rather than release-wide.

Excluding the injection is worth doing and is not the control that stops an injected turn
reaching AWS. That is the tool policy having no shell verb and the image having no `aws`
binary — a property of the policy and the image contents, not of the Pod's identity. It
would stop holding the moment a migrated agent's policy allowed a shell verb, which is the
reason to exclude the container rather than rely on it.

## Network policy

`networkPolicy` renders one NetworkPolicy per agent, covering that agent's Deployment Pod
and its CronJob Pods — they carry the same selector labels, and a scheduled run reaches the
same network the agent does. The block is release-wide, so every agent of the release gets
the same rules; the objects are per agent, so an agent's roll call still accounts for its
own.

This is the cluster's word for egress and not the agent's. The
[egress guard](../../docs/guide/chat-surfaces.md) decides which channels a message may
reach and runs inside the process; a NetworkPolicy decides which hosts the Pod may open a
connection to, and knows nothing about messages. Neither substitutes for the other, and
nothing here changes the guard.

```yaml
networkPolicy:
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector: {}
          podSelector: { matchLabels: { k8s-app: kube-dns } }
      ports: [{ protocol: UDP, port: 53 }, { protocol: TCP, port: 53 }]
    - to:
        - ipBlock: { cidr: 0.0.0.0/0, except: ["169.254.169.254/32"] }
      ports: [{ protocol: TCP, port: 443 }]
```

`ingress` and `egress` are Kubernetes NetworkPolicy rules, passed through verbatim — the API
server validates a peer, and a list here of the peers this chart knew would refuse the next
one Kubernetes adds.

`policyTypes` is the switch, and there is no `enabled` beside it. A NetworkPolicy that names
no direction is not inert: Kubernetes defaults an empty `policyTypes` to `Ingress`, so it
would render a deny-all-ingress rule rather than nothing at all. Empty means no object. A
direction named with no rules is the deliberate deny-all for that direction —
`policyTypes: ["Egress"]` on its own cuts every outbound connection, DNS included. Rules
written for a direction `policyTypes` does not name are refused at render, because a policy
restricts only the directions it lists and the cluster would apply the object while ignoring
them.

Whether any of this is *enforced* belongs to the cluster. On one whose CNI does not implement
NetworkPolicy the object applies cleanly and constrains nothing, so it is a declaration of
intent until you have checked otherwise — worth knowing before it is counted as a mitigation.

## Object names

Every object of one agent is named `<release>-<agent>`, because one release usually holds
several agents. Set `fullnameOverride` when the release is already named after the agent
and that default would double it into `buzz-drover-drover` — per-agent releases are worth
keeping during a fleet migration, since they stop one agent's deploy from touching another's.

```yaml
agents:
  drover:
    fullnameOverride: buzz-drover
```

It renames the Deployment, PVC, generated ServiceAccount, and CronJobs together. On an
agent that is already deployed that makes it a migration rather than a relabel: point
`persistence.existingClaim` at the old claim first, or the new Deployment comes up on an
empty volume.

It must also be unique within the release, including against the names the release's other
agents take by default. The `agents` keys could not collide, being map keys, and this is the
first value that can. The render refuses rather than leave two agents sharing one Deployment,
and refuses the CronJob collision no override is needed to reach as well: a job's object is
`<agent>-<slug>`, so `foo` with a `bar-baz` job and `foo-bar` with a `baz` job are one
CronJob. A name is qualified by its kind, so a CronJob matching another agent's Deployment is
a resemblance rather than a collision — one agent's Deployment, claim and ServiceAccount
already share a name on purpose.

`serviceAccount.name` and `secrets.csi.secretProviderClass` are refused on the same terms.
They are the two names you supply outright for an object the chart creates, so neither is
qualified by the agent's, and both name an identity: two agents creating one ServiceAccount
means the surviving `role-arn` decides which cloud role both assume, and two creating one
SecretProviderClass means one agent mounts the other's credentials. Either way both Pods
name the object and mount whatever definition survived, so the loss shows up as the wrong
identity rather than a failed start. Sharing one on purpose is still open, as a reference
rather than a second definition: set `serviceAccount.create: false`, or name a
`secretProviderClass` with no `provider`, on every agent but the one that owns it.

## Jobs

A job is declared in `agent.yaml` and nowhere else
([the contract](../../docs/deployment-contract.md#jobs)). Helm cannot read an
operator-supplied bundle at render time, so `agents.<name>.jobs` mirrors the
clock and the bound from that declaration, and nothing else. There is no `archetype`, no
`killSwitch`, no deadline of its own, and not even the job's own argv — `job run` reads
that from the manifest — so these values say when a job runs and cannot say what it is or
what it may do. Mirror every declared job: one left out renders no schedule, and no scan
can tell that apart from an agent that declared none.

Each `trigger.schedules` entry becomes one `CronJob` named for its agent and slug,
suspended when `suspend` is set, `concurrencyPolicy: Forbid`, `backoffLimit: 0` with
`restartPolicy: Never`, and `activeDeadlineSeconds` derived as `wallClockMs +
deadlineHeadroomMs` rounded up to the second. The deadline is never a value of its own: one
set below the budget SIGKILLs the job inside the window that headroom reserves for its
closing writes. Rounding up rather than down keeps this object the backstop, so the host's
own SIGTERM at the budget and SIGKILL at the deadline always land first. A job with no
schedule renders no scheduled object, which is the correct rendering of an on-request job —
start one by hand with `sageox-agent job run <slug> --trigger on-request`. `timeZone` needs
Kubernetes 1.27 or newer.

Each Job execs `sageox-agent job run <slug> --trigger schedule` against the same bundle the
Deployment runs, so the envelope is the host's: admission past both switches, single-flight,
the budget's bow-out, the run record, and the verdict. The trigger is stamped by the door it
came through, which is why a scheduled object can only ever claim `schedule`.

A job run is the same identity, not a second workload: it runs with that agent's
ServiceAccount, secret mount, shared volumes, and resource numbers. It stages that bundle
itself, with the same init container the agent Pod runs — a job that waited on the
Deployment to have gone first would lose its run on a fresh install, and nothing retries it.

What it does not get is the agent's claim. `/agents` in a job Pod is an `emptyDir`, fresh
for the run and gone with it, because the claim is `ReadWriteOnce` and a job Pod mounting it
could only attach where the Deployment Pod already ran — anywhere else the Pod sat in
`Init:0/1` behind a `Multi-Attach error for volume` until `activeDeadlineSeconds` killed it,
with empty logs, because the body never started. Nothing a run needs is on that claim: it
stages its own bundle, reads its kill switch through the relay, and writes its verdict
under the container's own tmpdir. A job body that genuinely shares durable state with the
agent gets a `sharedVolumes` entry, on a claim you back with an access mode that allows two
Pods to mount it — `ReadWriteMany` for anything that may land on a second node.

### A job that reads the Kubernetes API

No Pod this chart renders mounts a ServiceAccount token by default, and the projected token
at `/var/run/secrets/kubernetes.io/serviceaccount` is the only credential in-cluster API
auth has — so a job that watches its own namespace gets nothing back until you say
otherwise:

```yaml
agents:
  beekeeper:
    serviceAccount:
      create: true
      name: ""
      automountJobToken: true
```

That mounts the token on this agent's **CronJob** Pods. The Deployment Pod's
`automountServiceAccountToken: false` is unconditional and no value changes it: that Pod
runs an LLM over untrusted channel text, and a cluster token in reach of a prompt injection
is a different thing entirely. A job Pod runs the argv its `agent.yaml` declared, with no
brain in the loop, which is why it is the one that can be trusted with one. The knob is
named for the job and not the agent so that no single line can conflate the two.

A mounted token by itself authorises nothing. Bind the reads you want with your own `Role`
and `RoleBinding` against `serviceAccount.name` — this chart renders neither, and has no
opinion about what a job may read.

### A credential only the job may hold

`jobSecrets` is a second secret source, mounted by this agent's **CronJob** Pods alongside
`secrets` and searched ahead of it when a job body resolves a ref. It takes the same two
shapes `secrets` does, and the chart creates a `SecretProviderClass` for each source that
names a `provider`.

```yaml
agents:
  harry:
    # Every Pod. A credential absent here is not a file in the container that runs the brain.
    secrets:
      kubernetesSecret: agent-harry
      csi: { secretProviderClass: "" }
    # The scheduled job's Pod, and nothing else.
    jobSecrets:
      kubernetesSecret: agent-harry-job
      csi: { secretProviderClass: "" }
```

Without it, every Pod of an agent mounts one source, so a credential only a job needs — a PAT
that pushes branches, a token that files issues — is a file in the Pod that runs an LLM over
untrusted channel text. Nothing *reads* it there: the tool policy denies
`Read(//mnt/secrets-store/**)`, the brain's own environment is an allowlist, and the value
reaches the job body and no other process. But that is a policy holding the line, and a
policy is a file that can be wrong. `jobSecrets` puts the kernel back in front of it: what is
not in `secrets` is not in the container, whatever any policy says.

It **adds** rather than replaces. The job Pod mounts both, at `/mnt/job-secrets-store` and
`/mnt/secrets-store`, and `job run` is passed both directories in that order. That matters
more than it looks: a job process resolves the agent's own credentials too — the surface key
its status post is signed with, the key its kill switch is read with — and **both of those
swallow a failure to resolve.** A design that swapped one source for the other would answer a
forgotten credential with a disarmed kill switch and a lost status post, announced only as a
note on the stdout of a Pod nobody reads. Mounting both means the agent's credentials stay in
one place, rotated once, and splitting a job's credential out can never cost a job its switch
or its report.

Two consequences worth knowing before you split a credential out:

- **It reaches scheduled runs only.** A run started on request — from chat, or by hand —
  executes inside the gateway's own process, in the Deployment Pod, which is passed no second
  directory. That is the boundary working, not a gap in it: it is also what stops a
  prompt-injected turn reaching a write credential through a job it may ask for. So the
  bundle has to name which refs moved — `run.jobSecrets` on the job — and a job declaring
  one may not arm `trigger.onRequest`. Give such a job a schedule and no `onRequest`, keep
  the credential in `secrets` and take the weaker guarantee knowingly, or give the
  credentialed work a job of its own that nothing may ask for.

  Naming them there is also what lets the Deployment start. `sageox-agent run` resolves every
  `run.secrets` ref against its own mount before it opens a socket and refuses the launch on
  one that does not, so a credential that moved here but stayed spelled `secrets` is a
  crashlooping agent rather than a quietly weaker one. `run.jobSecrets` is left out of that
  inventory, and the refusal names it — so the Pod's log carries the fix, not only this page.
- **The render refuses `jobSecrets` on an agent with no schedule**, because no Pod would then
  mount it and the field would read as though it had moved a credential it had not.

There is deliberately no `Read(//mnt/job-secrets-store/**)` deny rule to add. That directory
does not exist in the Pod the brain runs in, and a deny rule covering nothing is the kind of
rule that reads as a control and is not.

