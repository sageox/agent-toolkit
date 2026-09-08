# Jobs in their own runtime image

A job can run once in a temporary Kubernetes worker without putting Python, a compiler,
or its credentials in the chat image. The existing executable/argv/environment/verdict
contract is unchanged. Local jobs omit `worker` and continue to run as before.

The first supported target is the toolkit Helm chart on Kubernetes 1.34 or newer, with
native Kubernetes Secret references. A shared dispatcher runs **per agent, across its
jobs**. The gateway and scheduled launchers perform the existing admission checks; the
dispatcher owns durable execution and creates the worker. No per-task service is needed.

```mermaid
flowchart LR
  G[Gateway or scheduled launcher] -->|Admitted request| D[Shared dispatcher]
  D --> R[Durable Kubernetes run record]
  D --> W[Temporary worker: toolkit host and task]
  W -->|Bounded verdict| R
  G -->|Status or cancellation| D
```

## Minimal Python job

Build [the example image](../deploy/helm/examples/worker/Dockerfile) from the **same toolkit
release** as the gateway, push it, and use its published digest:

```sh
docker build --build-arg TOOLKIT_IMAGE=ghcr.io/sageox/agent-base@sha256:<toolkit-digest> \
  -t registry.example/tasks:reviewed deploy/helm/examples/worker
docker push registry.example/tasks:reviewed
```

Declare the job in `agent.yaml`. Replace the placeholder with the real 64-character digest.
The optional parameter is delivered as `JOB_PARAM_NUMBER`, never interpolated into argv.

```yaml
jobs:
  - slug: positive-number
    archetype: queue
    description: Check a positive integer in a Python worker.
    trigger: {onRequest: true}
    budget: {wallClockMs: 60000, deadlineHeadroomMs: 5000}
    worker:
      image: registry.example/tasks@sha256:<worker-digest>
      directory: /work
    parameters:
      number: {type: integer, minimum: 1, description: Number to check.}
    run:
      command: python3
      args: [task.py]
      # Optional; provision this separately, only if the task needs it.
      # jobSecrets: {API_TOKEN: TASK_TOKEN}
```

Add the following to this agent's existing chart values. The chart mirrors the trigger,
budget and deployment identity; the image and executable stay in the reviewed manifest.
Provision `task-worker` as a separate ServiceAccount with no Kubernetes RBAC grants. Create
`dispatcher-auth` as a Secret whose `token` key contains at least 32 random characters.
Keep that token out of the agent bundle, brain configuration, and tool policy.

```yaml
agents:
  demo:
    dispatcher: {tokenSecret: dispatcher-auth}
    jobs:
      - slug: positive-number
        suspend: false
        trigger: {schedules: [], timezone: UTC}
        budget: {wallClockMs: 60000, deadlineHeadroomMs: 5000}
        worker:
          serviceAccountName: task-worker
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {cpu: "1", memory: 512Mi}
          # Map only references declared in run.secrets or run.jobSecrets.
          # secrets:
          #   TASK_TOKEN: {name: task-credentials, key: api-token}
```

Run `sageox-agent mcp add jobs` to install the jobs tool policy. `job_run` takes only `job`
and declared `params`. Image, command, credential overrides and fabricated `human` or
`approved` fields are rejected. External runs return an ID promptly. Use `job_status` with
`{job, runId}` for the result; `job_cancel` requests termination. These tools have independent
policy entries: `mcp__jobs__job_status` and `mcp__jobs__job_cancel`.

To automatically post failures and their error explanations, add a report to the job:

```yaml
report:
  surface: slack       # or buzz, using that surface's channel identifier
  channel: C0123456789
  # announce: always   # optional: also announce successful runs
```

The gateway or scheduled launcher posts through the existing channel guards. A failed or
UNKNOWN run includes its exit/failure details and a redacted error excerpt: the last 1,600
characters of stderr, or stdout if stderr is empty. Known worker states such as `OOMKilled`
are included when available. Requested runs also include that explanation in the reply to
the conversation that started them, even when no separate `report` destination is configured.
No manual command, script change, or SDK is needed for this notification.

The excerpt is quoted as job output, not interpreted by the brain. Partial checkpoints and
omitted earlier output are labelled. If no output survived, or the diagnostic lookup fails,
the failure notice still posts and says the extra output is unavailable. Reporting is best-effort;
the durable run ID remains the way to retrieve a result if a chat post cannot arrive.

An operator can also use `sageox-agent job status <slug> --run-id <id>` or `job cancel` with
the same arguments. Outside chart-managed Pods, set `AGENT_JOB_DISPATCHER_URL` and
`AGENT_JOB_DISPATCHER_TOKEN` for that CLI process. An external declaration on an unsupported
deployment fails explicitly; it never falls back to running inside the gateway.

## Images, sources and credentials

The compatible image retains `/app/bin/sageox-agent`, Node and the toolkit dependencies.
It supports UID/GID 10001 and a writable temporary directory and `/dev/termination-log`.
The dispatcher invokes `sageox-agent job worker`; the host invokes the declared executable
without a shell. A compiled Rust or C binary works by changing `run.command` to its path,
with the same verdict artifact as Python. A missing runtime or incompatible host produces
an unsuccessful or unknown run, never an automatic fallback or replay.

Source is **baked into the digest-pinned worker image**. `worker.directory` selects its
working directory. No gateway bundle files, mutable repository checkout, shared PVC, or
local index are inherited. Mount injection and arbitrary third-party images are outside
this initial contract. `report.probe` is rejected for external workers because their hosts
do not hold channel credentials. The gateway can still post ordinary job results.

The worker receives only the secret references its manifest declares, selected individually
from its profile and projected into its host's environment. Neither gateway nor dispatcher
mounts these values. The worker body receives only the existing declared environment
envelope. Do not place task credentials in `agents.<name>.secrets`, a gateway `.env`, or
the Terraform module's gateway secret list.

The chart gives **only the dispatcher** permission to create Jobs and maintain run
ConfigMaps, and create per-run claim Secrets owned by their worker Jobs. Run ConfigMaps
contain only a token hash; the claim Secret is projected into that worker and garbage-collected
with its Job. The dispatcher cannot read Secrets directly, but creating workloads is privileged: keep
its identity and API capability outside the brain. Gateway and workers do not mount a
Kubernetes API token. A worker has its own ServiceAccount; the chart rejects reuse of the
gateway or dispatcher accounts and Kubernetes Secret objects across every agent in the
release. Accounts and credentials provisioned outside this release still require an
operator to check their permissions.

Install the release in a **dedicated namespace** (for example, `helm install agents
./deploy/helm --namespace agent-workloads --create-namespace ...`). This namespace is the
trust boundary: Kubernetes RBAC cannot constrain Job or ConfigMap creation by label or
name prefix. Dispatchers in one namespace must be mutually trusted; deploy mutually
untrusted agents in separate releases and namespaces, with appropriately scoped cloud
identities and admission policy. Application ownership labels prevent accidental collisions,
but do not isolate a compromised dispatcher from other workloads in its namespace.

A distinct ServiceAccount is not sufficient if cloud identities share permissions. When
adding IRSA, EKS Pod Identity or another cloud integration, provision a separate worker
role and ensure the gateway cannot retrieve its credentials, assume that role, create
workloads, read run ConfigMaps, or exec into workers. Worker cloud identity is consumer
provisioning; the Terraform gateway module does not provision it. Apply cluster admission
and network policies appropriate to your namespace. Allow gateway/launcher-to-dispatcher
and worker-to-dispatcher TCP 8090, and dispatcher-to-Kubernetes API access. Existing
gateway NetworkPolicy values do not automatically apply to dispatcher/worker Pods.

## Triggers and lifecycle

For a job supporting both requests and schedules, add schedules and a kill switch in its
manifest and mirror the schedules in chart values. CronJobs still invoke the toolkit host,
which dispatches the **same** worker declaration. Scheduled launcher Pods have no worker
credential mounts or Kubernetes token. A request-only job needs no fake schedule or switch.
The existing owner-derived human bypass applies only to automation posture; domain safety
checks in the body remain its responsibility. No new approval workflow is introduced.

Run IDs are backed by ConfigMaps, independent of gateway/dispatcher restarts. Repeating the
same job and inputs within the same inbound message reuses an ID; use a new message for a
new intentional execution. Scheduled launcher replacements use the scheduling Job's UID.
Atomic ConfigMap creation and resource-version updates serialize workers across processes
and across triggers. Overlap is refused, not queued.

Each admission stores the reviewed job and its worker identity, secret references and
resource limits. A dispatcher restart or profile update cannot change an admitted run's
configuration. The values of referenced Secrets remain managed by Kubernetes; rotating a
Secret before a worker starts changes the value it receives.

If claim Secret creation is rejected or its response is lost, the dispatcher requests
cancellation and reports that dispatch failure as UNKNOWN without retrying execution.
The first durable stop reason is retained when cancellations race. Cleanup removes any
resulting worker before releasing its overlap lock. If the Kubernetes API cannot persist
cancellation, the run remains uncertain: an already admitted worker may still execute
once. A failed cancellation write is never reported as a finished or stopped run.

Before running its body, a worker claims that run once through the dispatcher. Replacement
Pods cannot claim it again. A lost claim response can prevent execution; it never authorizes
a second attempt. A lost dispatch response may leave a run uncertain through its deadline;
the dispatcher never retries a potentially completed mutation. Consumer-specific
idempotency and reconciliation are still required for external effects.

The budget starts at admission, including time waiting for a Pod. The host sends SIGTERM
at the remaining wall-clock budget and SIGKILL at its deadline; the Kubernetes Job has a
matching active deadline and no retries. Cancellation deletes the actual Job and waits for
termination before releasing overlap protection. `cancelling` is not a completed
cancellation. Cancellation cannot undo side effects, and a chat timeout cannot decide the
worker's outcome.

Model-facing results contain host-minted outcome, process execution facts, and PASS/FAIL/UNKNOWN
gate counts. Raw logs, gate names, artifact prose, exception text and credentials are **never
returned through jobs MCP**. The gateway separately attaches the bounded redacted error
excerpt to automatic chat reports. The artifact read is capped at 64 KiB; the worker's summary fits Kubernetes'
4 KiB termination message. A missing/corrupt result, interrupted execution or lost worker
is UNKNOWN, even if a container exited zero. A process that exits nonzero with a readable
host result retains the existing FAIL verdict semantics.

An uncaught script exception that exits nonzero therefore produces FAIL, even if the
script never writes an artifact. The lifecycle outcome can still be `completed`: it means
the process finished, while the verdict says whether it succeeded. A zero exit without a
valid, nonempty verdict artifact is UNKNOWN.

This model-facing result is a verdict summary, with no general data payload. Script-written
`detail` fields are stripped at the worker boundary. Automatic error reports use captured
stderr/stdout; the larger diagnostic archive is retained separately for deeper debugging.

The dispatcher copies the bounded result to the run record **before** deleting the Job.
Results remain retrievable for seven days. Afterwards the record becomes an UNKNOWN
tombstone and cannot be replayed under that ID. Tombstones remain until an operator removes
them; deleting them also removes duplicate protection for those historical requests.
Back up run ConfigMaps if recovering across loss of the cluster is required. A gateway
restart may lose its in-flight chat reply callback; status retrieval remains authoritative.

## Retained diagnostics

No script changes or SDK are needed. The worker host captures stdout and stderr, retaining
the last **8 KiB of each stream**, and records the process exit code, signal, execution
state, and timestamps. The dispatcher adds the reviewed image digest and worker Pod facts
before cleanup. `truncated: true` means earlier output was discarded. Full redacted output
also goes to the Pod's normal log streams for the deployment's existing log collector.

The host removes known declared credential values and its run capability before forwarding
or retaining output. Redaction spans stream chunks and precedes truncation. Credentials
that the script encodes, abbreviates, or otherwise transforms, dynamically obtained
credentials, and other sensitive business data may remain, so these
logs are still private operator data. Restrict ConfigMap read access in the agent namespace;
neither the gateway nor the brain needs that access.

Checkpoints are sent once a second and after process termination through a **write-only,
run-scoped** capability. A finished host attempts to persist its final checkpoint before
exiting. Cancellation, a killed worker, or an unavailable dispatcher may leave only the last
checkpoint; `complete: false` explicitly marks that limitation. If the host never starts,
the record still identifies the image and any observed Pod state, such as `ImagePullBackOff`.
A diagnostic checkpoint never substitutes for a missing verdict or authorizes a replay.

`job_status` returns safe process facts and `diagnostics: {ref, complete}`. Chat reports
automatically include the failure class or exit code, the redacted error excerpt, and that
reference. The gateway retrieves the excerpt through its authenticated `/failure-report`
endpoint, which returns at most 2,000 characters and is not exposed through MCP. It sends
the text directly through the existing guarded report/reply path, without attaching it to
model-facing run records.

The full diagnostic archive remains operator-only. The following command is **optional
for deeper debugging**, not required to receive failure explanations:

```sh
sageox-agent job diagnostics run-<40-character-reference> \
  --namespace agents --context operator-context
```

Use the exact `diagnostics.ref` from status, which differs from the run ID. This command
requires `kubectl` and permission to read the referenced ConfigMap; it uses the current
Kubernetes context if `--context` is omitted. It does not require an agent bundle or a
dispatcher bearer token. The returned JSON includes `stdout`, `stderr`, process facts,
the image digest, and observed worker Pod facts.

Diagnostics and results expire together seven days after the run finishes. Deleting a
worker does not delete either record. Loss of a node or dispatcher connectivity can lose
the final unacknowledged log tail; durable checkpoints remain available across restarts.

See the Kubernetes documentation for [Job lifecycle and deadlines](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
and [optimistic concurrency](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions).
