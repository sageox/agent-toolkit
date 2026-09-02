# Deployment contract

The agent runtime is the product; Compose, Kubernetes, and future targets are thin adapters
around it. A deployment target must preserve this contract instead of translating
`agent.yaml` into a second configuration model.

| Concern | Contract |
|---|---|
| Agent definition | Supply one complete bundle directory; its host location is not part of the contract. |
| Process | Run the image entrypoint with `run --bundle <directory>`. |
| Credentials | Mount one file per `secretRef` under `/mnt/secrets-store` — the path is fixed, not a target's to choose, because the bundle's own `settings.json` denies the brain that directory by name and no target can see that file. Never place secret values in generated manifests. A missing one is a failed launch, not a degraded run: `run` checks every declared reference before it connects, and names each one it could not resolve. |
| Encrypted vaults | When a brain declares `age`, provide the `age` binary and mount its `identitySecret` only where decryption is allowed; the public recipient remains in the bundle. Without the identity, plaintext remains available and encrypted slices are denied. The project image already includes `age`. |
| Mutable state | The agent directory is writable and durable. It holds cursors, local memory, repository checkouts, and code indexes across restarts. |
| Identity | Run exactly one replica for an agent identity. Two replicas would answer twice and race on one cursor. |
| Shutdown | Allow longer than `limits.turnTimeoutMs` between `SIGTERM` and `SIGKILL`. |
| Warmup | Connect first. Repository clone/fetch, indexing, cache fills, and other recoverable warmup never gate the agent process. The runtime enforces its half: only a precondition decides whether `run` starts, and no capability health ever does. See [Startup and readiness](startup-and-readiness.md). |
| Jobs | Run every entry in `jobs[]` on its declared schedule, under a deadline derived from its budget, without overlap and without retry. An agent whose declared jobs render nothing deploys looking healthy with no scheduled work. See [Jobs](#jobs). |

The runtime does not need an inbound port: Buzz and Slack use outbound connections. A target
therefore should not create a Service or Ingress unless a future surface explicitly needs
one.

## Jobs

`jobs[]` declares an agent's scheduled work — a trigger, a hard switch, a bound, and the
process to run ([the jobs RFC](design/2026-08-19-jobs-rfc.md)). It lives in `agent.yaml`
for the reason at the top of this file: a job declared in a target's own values is the
second configuration model, and that is how a fleet arrives at twelve jobs described in six
different charts.

[The canonical chart](#kubernetes-chart) implements this clause, and `sageox-agent job run
<slug>` is what it execs. The clause was written ahead of both deliberately — a target that
renders a job with no clause to implement decides the deadline, the retry policy, and the
overlap rule inside its own template, which is the second configuration model this contract
exists to prevent.

A target that supports jobs owes each declared job:

| Per declared job | From |
|---|---|
| A scheduled run of `run.command` with `run.args`, in the declared zone | `trigger.schedules`, `trigger.timezone` |
| No scheduled run while the job is parked by its hard switch | `suspend` |
| A platform deadline of `wallClockMs + deadlineHeadroomMs`, rounded up where the target's unit is coarser | `budget` |
| Single-flight — a run that would overlap a running one is refused, never queued | — |
| No platform retry — a failed run is a failed run | — |
| A writable bundle directory and somewhere the verdict artifact lands — durable between runs is not owed | `Agent definition`, above |

`run.command` and `run.args` are a list, and the list is the whole interface: no shell
string, so nothing can be word-split or interpolated into one.

`suspend` parks the clock, not the job. A human may still start a parked job on request,
and that run is the runtime's to admit — it arrives through the agent process the target
already deploys, never through a scheduled object
([RFC §6.3](design/2026-08-19-jobs-rfc.md#63-the-switch-parks-automation-not-the-job)). What
a target owes is that the schedule itself does not fire.

The deadline is derived, never a setting of its own. An operator who can set it independently
will eventually set it below the budget, and the job is then SIGKILLed inside the window
`deadlineHeadroomMs` reserves for its closing writes — a claimed item stays claimed and a
half-written change dangles. A target whose deadline is coarser than a millisecond —
Kubernetes counts `activeDeadlineSeconds` in whole seconds — rounds the sum **up**. Rounding
down is the same failure reached by arithmetic: it spends headroom the declaration reserved.

Overlap and retry are refused for one reason between them: a second copy of a run, or an
automatic re-run of a failed one, spends a budget nobody widened. Kubernetes spells the two
`concurrencyPolicy: Forbid` and `backoffLimit: 0` with `restartPolicy: Never`; other targets
spell them differently and owe the same behavior. Single-flight holds per scheduled object,
which is all a target can offer — two triggers on one job can still overlap, and closing
that is the runtime's open problem, not the target's
([RFC §10](design/2026-08-19-jobs-rfc.md#10-single-flight)).

A target invents no schedule, no retry, and no deadline the manifest did not declare. A job
with `onRequest: true` and no schedules therefore renders nothing scheduled, and that is the
correct rendering: inventing a cron so an on-request job exists as a schedulable object is
the fake trigger this declaration
[deletes](design/2026-08-19-jobs-rfc.md#51-a-scheduleless-job-is-legal-here-and-it-is-not-in-the-fleet-today).

A job body's environment is **declared, not inherited**: it is built from the same six-variable
allowlist every spawned child gets, plus whatever `run.env`, `run.secrets`, `run.jobSecrets`,
and `run.passthrough` name ([the job body contract](job-contract.md#what-the-host-passes-in)).
A target therefore owes a job run the `secretRef` mounts, not a copy of the gateway's
environment — and a job that needs the pod's cloud identity says so by name in
`run.passthrough`, which is a grant a reviewer can read rather than an inheritance nobody
wrote down.

A job run is the same agent — the same bundle directory and the same `secretRef` mounts the
rows above already require, not a second deployment carrying configuration of its own. The
same bundle, though, is not necessarily the same *copy*: a target may stage a run one of its
own, and [the chart](#kubernetes-chart) does, because a job Pod sharing the agent's
`ReadWriteOnce` claim could not start off the node the agent runs on. A job body's files are
therefore its run's, and anything it needs to outlive the run belongs in a store it reaches
over the network rather than beside the bundle. A
target **may** add a second mount that a scheduled run gets and the agent's own workload does
not, and one that does closes a gap policy cannot: a credential absent from the agent's mount
is not a file in the process that runs the brain. Added, never substituted — a job run
resolves the agent's own credentials as well, for the surface its status post is signed with
and the switch it is admitted past, and a target that swapped one mount for the other would
answer a missing credential with a disarmed switch and a lost report rather than a refusal.
A run started on request gets no such mount: it executes inside the gateway's own process,
off the agent's own, so a ref that lives only in the scheduled mount cannot resolve there.
Which refs those are is the bundle's to say — `run.jobSecrets` — and a job naming one may not
arm `trigger.onRequest`, so no target has to make that pairing work. And a job run is not a
second replica: it serves no surface and holds no cursor, so `Identity` above is untouched.
The rest of the envelope is the runtime's rather than the target's — trigger
provenance, admission past a parked switch, the soft kill switch read from the agent's own
memory, the budget's own bow-out, the run record, and the verdict artifact the job writes. A
target supplies a clock, a process, a deadline, and durable state.

## Kubernetes chart

[`deploy/helm`](../deploy/helm) is the canonical Kubernetes
implementation. It consumes native references to Secrets, CSI classes, and PVCs, and takes
the bundle's own source as a Kubernetes VolumeSource, so Helm, Kustomize, Terraform, Pulumi,
Argo CD, and Flux can own those objects without a toolkit-specific translation step.

A short init container copies non-secret files from that volume, mounted read-only at
`/config`, into the agent directory — the agent's persistent claim in the Deployment Pod, a
per-run `emptyDir` in a job Pod; the long-running container then uses the same paths and
command as Compose. Which volume carries the bundle is the operator's choice — a ConfigMap,
an image, a claim, a CSI volume — and nothing below `/config` depends on the answer.
Repository checkouts and `ox` indexes stay on that PVC, while clone, fast-forward fetch,
and index refresh happen behind agent startup.

The chart tooling deliberately does not contact the cluster. A release may mount an existing
Kubernetes Secret, consume an existing Secrets Store CSI `SecretProviderClass`, or create a
provider-neutral class from non-secret provider parameters. CSI mode mounts external values
directly and does not duplicate them into a Kubernetes Secret.

The install commands live once, in [the chart's README](../deploy/helm/README.md),
so they cannot drift from the chart.

Each agent gets one replica, `Recreate` rollout strategy, an unprivileged UID, a dedicated
ServiceAccount with token automount disabled, file-mounted secrets, and its own
`ReadWriteOnce` PVC. One release may contain many such workloads. Configuration changes
restart only the affected identity.

Jobs render as one `CronJob` per declared schedule, carrying the schedule, the zone, the
hard switch, the derived deadline, single-flight, and no retry — the whole of the clause
above and nothing beyond it. Each Job execs `sageox-agent job run <slug> --trigger schedule`
against the bundle the Deployment already runs, so the rest of the envelope stays where the
clause puts it: the host reads the job's own argv, admits it past both switches, bows out at
the budget, and mints the verdict. The declaration reaches the chart as a mirror of `jobs[]`
in that agent's values, because Helm cannot read an operator-supplied bundle at render
time; the mirror carries the clock and the bound only — not the argv, not the switch —
so it cannot become a second place a job is decided.
[The chart's README](../deploy/helm/README.md#jobs) has the rendered shape and the one thing
a job Pod does not share — the agent's `ReadWriteOnce` claim, which would tie its placement
to the agent's node. It stages its bundle onto an `emptyDir` of its own instead, and a body
that does share durable state with the agent gets a `sharedVolumes` claim whose access mode
says so.

A job Pod is the one pod spec that may hold a cluster token, opted into per agent with
`serviceAccount.automountJobToken` and off by default. It runs the argv its `agent.yaml`
declared with no brain in the loop, where the agent Pod runs an LLM over untrusted channel
text and so mounts no token whatever the values say. The chart grants no permissions with
it: what the token may read is a `Role` and `RoleBinding` the consumer owns.

Terraform installs the same chart through an ordinary `helm_release` resource pointed at
`deploy/helm`; [`deploy/terraform/aws-eks-agent`](../deploy/terraform/aws-eks-agent)
does exactly that. Credential values are not Terraform inputs.

[`deploy/terraform/aws-eks-bootstrap`](../deploy/terraform/aws-eks-bootstrap) installs the
cluster-wide EKS Pod Identity and AWS CSI components. The per-agent
[`aws-eks-agent`](../deploy/terraform/aws-eks-agent) module creates Secrets Manager metadata,
exact-secret IAM permission, the Pod Identity association, CSI parameters, and the Helm
release. It intentionally creates secret values out-of-band so normal Terraform state
never contains external credentials. See the [ground-up AWS guide](aws-eks-deployment.md).

To rotate a credential, put the new value in the external store and restart the
Deployment — the new pod mounts current values, and the runtime resolves credentials at
process startup. The current single-container tier also
shares a filesystem between the gateway and its brain subprocess. Kubernetes secret sourcing
does not create a filesystem boundary; a future hardened tier must isolate those processes.

The runtime runs `ox index code` and verifies `ox code status`; it does not run `ox daemon`.
The daemon synchronizes SageOx ledger state and is not the repository-index readiness
mechanism.

Shared brains require a volume that is genuinely shared between agent deployments. Add the
same existing ReadWriteMany claim to each participant's native `sharedVolumes` values at the
path declared in its manifest. Filesystem permissions remain the deployment operator's
authorization boundary. For `*.md.age` slices, also mount the matching logical age identity
only into workloads authorized to decrypt them; do not copy the identity into the bundle or
Helm values.
