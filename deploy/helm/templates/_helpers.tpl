{{- define "agent.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
app.kubernetes.io/name: {{ .Chart.Name | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}

{{- define "agent.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{/*
The name every object of one agent carries. `<release>-<agent>` by default, because one
release usually holds several agents and their objects have to be told apart.

`fullnameOverride` is for the fleet that gives each agent a release of its own: there the
default doubles the agent's name into `buzz-drover-drover`, and the release name cannot
move — per-agent releases are what keep one agent's deploy from touching another's. Setting
it renames this agent's Deployment, PVC, generated ServiceAccount, and CronJobs, so on an
already-deployed agent it is a migration, not a relabel: point `persistence.existingClaim`
at the old claim first, or the new one comes up empty.
*/}}
{{- define "agent.agentFullname" -}}
{{- $raw := default (printf "%s-%s" .root.Release.Name .name) .agent.fullnameOverride -}}
{{- if gt (len $raw) 63 -}}
{{- printf "%s-%s" ($raw | trunc 54 | trimSuffix "-") (sha256sum $raw | trunc 8) -}}
{{- else -}}
{{- $raw -}}
{{- end -}}
{{- end -}}

{{- define "agent.agentSelectorLabels" -}}
{{ include "agent.selectorLabels" .root }}
app.kubernetes.io/component: {{ .name | quote }}
{{- end -}}

{{/*
Staging, the volumes it needs, and the mounts a process running from the agent directory
gets. Defined once and included by every Pod this chart renders, because a job Pod that
staged a bundle differently from the agent Pod — or that quietly missed a shared volume —
would run something nobody reviewed. Every Pod stages for itself: a scheduled run that
waited on another workload to prepare its directory would be lost on a fresh install, and
`backoffLimit: 0` means lost is lost.

The script reads `/config` and nothing else, so `bundle.stageImage` with no `bundle.volume`
means the bundle has to be at `/config` inside that image. Set both and the volume mounts
over the image's copy, which is the ordinary way to stage from a source the runtime image
cannot read on its own.

Either way the image runs this script, so it needs `/bin/sh` and `install`, `mktemp`, `cp`,
`find`, `mkdir`, `mv` and `rm` — busybox is enough, and `scratch` or a distroless base is
not. Nothing at render time can see that; the Deployment never becomes ready, and a
scheduled run is lost.
*/}}
{{- define "agent.stageConfig" -}}
- name: stage-config
  image: {{ default (required "imageRef is required" .root.Values.imageRef) .agent.bundle.stageImage | quote }}
  command: ["/bin/sh", "-ceu"]
  args:
    - |
      # Staged so that a stage running beside it cannot be observed half-done. Copy aside,
      # then land each file by rename, which is atomic: a reader sees the whole old file or
      # the whole new one. `persistence.existingClaim` is the operator's own volume, so this
      # stage cannot assume it is the only thing writing where it lands.
      install -d -m 0700 /agents/{{ .name }}
      stage=$(mktemp -d /agents/.stage.XXXXXX)
      cp -LR /config/. "$stage/"
      rm -f "$stage/.env"
      find "$stage" -type f | while read -r file; do
        dest="/agents/{{ .name }}/${file#$stage/}"
        mkdir -p "${dest%/*}"
        mv -f "$file" "$dest"
      done
      rm -rf "$stage"
      # Only once the bundle has genuinely stopped supplying one. Deleting it up front is
      # what opened a window where a configured agent starts and reads no repositories.
      [ -e /config/repos.conf ] || rm -f /agents/{{ .name }}/repos.conf
      rm -f /agents/{{ .name }}/.env
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    allowPrivilegeEscalation: false
    capabilities:
      drop: ["ALL"]
  volumeMounts:
    {{- if .agent.bundle.volume }}
    - name: config
      mountPath: /config
      readOnly: true
    {{- end }}
    - name: agent-data
      mountPath: /agents
    {{- range $volume := .agent.sharedVolumes }}
    - name: {{ $volume.name }}
      mountPath: {{ $volume.mountPath | quote }}
    {{- end }}
{{- end -}}

{{- define "agent.agentVolumeMounts" -}}
- name: agent-data
  mountPath: /agents
{{- range $volume := .agent.sharedVolumes }}
- name: {{ $volume.name }}
  mountPath: {{ $volume.mountPath | quote }}
{{- end }}
{{- if or .agent.secrets.kubernetesSecret .agent.secrets.csi.secretProviderClass }}
- name: secrets
  mountPath: {{ include "agent.secretsMountPath" . }}
  readOnly: true
{{- end }}
{{- if and .job (include "agent.hasJobSecrets" .agent) }}
- name: job-secrets
  mountPath: {{ include "agent.jobSecretsMountPath" . }}
  readOnly: true
{{- end }}
{{- end -}}

{{/*
Where the secret files land, and the `--secrets` directory every container is told to read.

Under `/mnt` and not `/run`, because `/var/run` is a symlink to `/run` and
`/var/run/secrets` is where the kubelet projects a Pod's identity token. A read-only volume
covering that subtree stops `runc` creating the token's mountpoint, and the container fails
before its first process. Nothing at render time can see it: the manifest is valid, and
`helm template` and `helm lint` both pass.

A constant rather than a value. The path has to agree with the `Read(//mnt/secrets-store/**)`
deny rule in the bundle's own `settings.json`, which Helm never reads — so a values key here
would let a release move the mount out from under the one rule that keeps the brain from
reading it, and render clean while doing so.
*/}}
{{- define "agent.secretsMountPath" -}}/mnt/secrets-store{{- end -}}

{{/*
Whether this agent declares a second, job-only secret source. Empty output is false to an
`if`, which is how a Helm template answers a yes/no question.
*/}}
{{- define "agent.hasJobSecrets" -}}
{{- if .jobSecrets -}}
{{- if or .jobSecrets.kubernetesSecret .jobSecrets.csi.secretProviderClass -}}yes{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Where a job-only secret source is mounted, and the directory `job run --job-secrets` is told
to search first.

A sibling of the agent's mount rather than a path inside it: a CSI or Secret volume is
read-only, so nothing can be mounted underneath one, and two volumes cannot share a mount
point. Two directories is therefore the only shape available, which is why `resolveSecret`
takes a list — and it is a better shape than the alternative anyway, since the agent's own
credentials stay in one place and are rotated once.

A constant like the agent's, for the same reason: a values key here could move the mount out
from under the `Read(//mnt/secrets-store/**)` deny rule's sibling without the render noticing.
*/}}
{{- define "agent.jobSecretsMountPath" -}}/mnt/job-secrets-store{{- end -}}

{{/*
`/agents` is the agent's claim in the Deployment Pod and an `emptyDir` in a job Pod. The
claim is `ReadWriteOnce`, which binds it to one node: a job Pod the scheduler placed on any
other node could not attach it, and sat in `Init:0/1` behind a `Multi-Attach` event until
`activeDeadlineSeconds` killed it — with nothing in the job's own logs, because the body
never started. A scheduled run needs nothing that is on the claim: it stages its own bundle
from `/config`, reads its kill switch through the relay, and writes its verdict under the
container's own tmpdir. Durable state a job body does share with the agent goes on a
`sharedVolumes` claim, which the operator backs with an access mode that allows it.

The bundle arrives on whatever volume the consumer named, passed through verbatim: a
ConfigMap, an image, a claim, a CSI volume. The chart's contract is the directory at
`/config`, never the object behind it, so nothing here branches on which source it is.
No volume at all is the case where the bundle rides inside `bundle.stageImage` instead;
`validate.yaml` refuses a bundle that names neither.
*/}}
{{- define "agent.podVolumes" -}}
- name: agent-data
{{- if .job }}
  emptyDir: {}
{{- else }}
  persistentVolumeClaim:
    claimName: {{ include "agent.claimName" . }}
{{- end }}
{{- with .agent.bundle.volume }}
- name: config
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- range $volume := .agent.sharedVolumes }}
- name: {{ $volume.name }}
  persistentVolumeClaim:
    claimName: {{ $volume.claimName }}
{{- end }}
{{- include "agent.secretVolume" (dict "name" "secrets" "source" .agent.secrets) }}
{{- if and .job (include "agent.hasJobSecrets" .agent) }}
{{- include "agent.secretVolume" (dict "name" "job-secrets" "source" .agent.jobSecrets) }}
{{- end }}
{{- end -}}

{{/*
One secret volume, from whichever of the two sources a `secretRef` file may arrive through.
Written once because the job mount has to be the same kind of thing the agent mount is — a
second spelling would eventually accept a source here that the other refuses.
*/}}
{{- define "agent.secretVolume" -}}
{{- if .source.kubernetesSecret }}
- name: {{ .name }}
  secret:
    secretName: {{ .source.kubernetesSecret }}
    defaultMode: 288
{{- else if .source.csi.secretProviderClass }}
- name: {{ .name }}
  csi:
    driver: secrets-store.csi.k8s.io
    readOnly: true
    volumeAttributes:
      secretProviderClass: {{ .source.csi.secretProviderClass }}
{{- end }}
{{- end -}}

{{/*
The name of one job's scheduled object. Truncated to 52 rather than 63: Kubernetes
appends a timestamp to a CronJob's name to build each Job's, and validates the CronJob
name against the shorter limit.

A job with two schedules is two objects, so the index disambiguates them — and only then,
because appending `-1` to every single-schedule job would rename every object in the fleet
the day a second schedule appears somewhere else.
*/}}
{{- define "agent.jobFullname" -}}
{{- $raw := printf "%s-%s" (include "agent.agentFullname" .) .job.slug -}}
{{- if gt (int .total) 1 -}}
{{- $raw = printf "%s-%d" $raw (add1 .index) -}}
{{- end -}}
{{- if gt (len $raw) 52 -}}
{{- printf "%s-%s" ($raw | trunc 43 | trimSuffix "-") (sha256sum $raw | trunc 8) -}}
{{- else -}}
{{- $raw -}}
{{- end -}}
{{- end -}}

{{- define "agent.claimName" -}}
{{- if .agent.persistence.existingClaim -}}
{{- .agent.persistence.existingClaim -}}
{{- else -}}
{{- include "agent.agentFullname" . -}}
{{- end -}}
{{- end -}}

{{- define "agent.serviceAccountName" -}}
{{- if .agent.serviceAccount.name -}}
{{- .agent.serviceAccount.name -}}
{{- else -}}
{{- include "agent.agentFullname" . -}}
{{- end -}}
{{- end -}}
