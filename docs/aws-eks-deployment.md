# Deploy an agent on AWS EKS

This is the reference AWS composition, not a mandatory cluster design. Bring an EKS cluster
created by Terraform, CloudFormation, CDK, eksctl, or a platform team; the agent modules do
not take ownership of its VPC, node groups, endpoint exposure, or access controls.

## 1. Prepare the cluster

The cluster needs Linux EC2 worker nodes, dynamic `ReadWriteOnce` volume provisioning (for
example the EBS CSI add-on and a default StorageClass), and restricted node IMDS access. The
AWS Secrets Store CSI provider does not support Fargate.

Configure AWS and Helm providers in a Terraform root. The Helm provider must authenticate to
the same cluster passed to the module:

```hcl
provider "aws" {
  region = "us-west-2"
}

data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

provider "helm" {
  kubernetes = {
    host                   = data.aws_eks_cluster.this.endpoint
    cluster_ca_certificate = base64decode(data.aws_eks_cluster.this.certificate_authority[0].data)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", var.cluster_name]
    }
  }
}

module "agent_cluster_secrets" {
  source       = "./deploy/terraform/aws-eks-bootstrap"
  cluster_name = var.cluster_name
}
```

Run `terraform init`, inspect the plan, and apply once. If the platform team already owns
EKS Pod Identity or the CSI provider, do not instantiate this module; reuse their installation.

## 2. Create native agent deployment inputs

```bash
kubectl -n agents create configmap agent-harry-bundle \
  --from-file=agent.yaml="$HOME/.config/agent-toolkit/agents/harry/agent.yaml" \
  --from-file=AGENTS.md="$HOME/.config/agent-toolkit/agents/harry/AGENTS.md" \
  --from-file=settings.json="$HOME/.config/agent-toolkit/agents/harry/settings.json" \
  --dry-run=client -o yaml | kubectl apply -f -
```

Create `harry.values.yaml` from the chart's native values schema. The `imageRef` digest is
recorded on the [release](https://github.com/sageox/agent-toolkit/releases) of the
version you are deploying; pin that, not a tag:

```yaml
imageRef: ghcr.io/sageox/agent-base@sha256:<digest>
agents:
  harry:
    bundle: { volume: { configMap: { name: agent-harry-bundle } } }
    serviceAccount: { create: true, name: "" }
    secrets:
      kubernetesSecret: ""
      csi: { secretProviderClass: "" }
    persistence: { size: 10Gi }
    terminationGracePeriodSeconds: 130
    resources: {}
    sharedVolumes: []
```

Commit the ConfigMap source and values to the deployment repository through its normal
Kustomize, Terraform, or GitOps workflow. Neither object contains credentials.

## 3. Create secret metadata and least-privilege identity

In a second Terraform root, configure the same AWS and Helm providers and instantiate one
module per agent:

```hcl
locals {
  # Logical secretRef names used by harry's manifest and configured MCP servers.
  harry_secret_names = toset([
    "ANTHROPIC_API_KEY",
    "BUZZ_NSEC",
  ])
}

module "harry" {
  source = "./deploy/terraform/aws-eks-agent"

  cluster_name = var.cluster_name
  release_name = "agent-harry"
  agent_name   = "harry"
  namespace    = "agents"
  values_file  = abspath("${path.module}/harry.values.yaml")

  secrets = {
    for name in local.harry_secret_names : name => {}
  }

  # First apply creates secret shells and identity but not a pod that would fail
  # while those shells have no values.
  deploy = false
}
```

The IAM policy contains the exact resolved secret ARNs—never a wildcard over an environment
or account. To reuse a centrally managed credential instead of creating a duplicate:

```hcl
secrets = {
  ANTHROPIC_API_KEY = {}
  BUZZ_NSEC         = {}
  GITHUB_TOKEN = {
    existing_secret_name = "/shared/fine-grained-read-only-github-token"
  }
}
```

Apply and save the `managed_secret_names` output. No secret values have entered Terraform.

## 4. Seed values

Have SOPS, CI, or another secret delivery system materialize one owner-readable file per
logical secretRef, then upload the files without printing their contents:

```bash
./deploy/terraform/aws-eks-agent/seed-secrets.sh \
  /sageox-agent/my-eks-cluster/agent-harry ./harry-secrets
```

Replace `my-eks-cluster` with `cluster_name`. The script uses the AWS CLI's `file://` input
and prints only secret names. For production, an existing SOPS, HCP Terraform
ephemeral-variable, CI credential broker, or secret-rotation workflow may seed the same
entries instead. Do not use ordinary Terraform `secret_string`
arguments for external credentials: even values marked `sensitive` are stored in state.

## 5. Deploy and verify

Set `deploy = true`, inspect the plan, and apply again. The module creates the dedicated
ServiceAccount, a provider-neutral AWS `SecretProviderClass`, and the canonical Helm release.
Secrets are mounted directly at `/mnt/secrets-store`; no Kubernetes Secret is created.

```bash
kubectl -n agents get serviceaccount,pvc,pod
kubectl -n agents describe pod -l app.kubernetes.io/instance=agent-harry
kubectl -n agents logs deployment/agent-harry
```

If the pod remains in `ContainerCreating`, inspect its events and the provider logs in
`kube-system`. The usual causes are an unseeded secret, an IAM ARN missing from the role,
Pod Identity not installed, or the CSI provider missing from the selected node.

## Rotation and recovery

Put a new Secrets Manager version, then restart the Deployment. The new pod mounts the
current values; the runtime resolves credentials at process startup, so a restart is the
rotation step either way.

The team brain's SageOx token is the one credential that can skip the restart, and only
where the mount is refreshed under it: the gateway reads it for every `ox` child, but the
bootstrap module leaves the CSI driver's `enableSecretRotation` at its default of off, so
on this path the file never changes and the restart is still the rotation step. Enable that
setting if you want the credential to recover from a rotation on its own, and see
[the deployment contract](deployment-contract.md) for why it is the only one that could.

Managed secret deletion uses a 7-day recovery window. The chart-managed PVC is
retained on Helm uninstall. Confirm both retained data sets before permanently deleting them.

## Security boundary

Pod Identity grants only `DescribeSecret` and `GetSecretValue` for this release's exact
secret ARNs. When explicit KMS keys are configured, decrypt is additionally limited to the
regional Secrets Manager service and a `SecretARN` encryption context matching one of those
exact secrets, so the workload cannot directly decrypt unrelated ciphertext under a shared
key. Its role trust policy also requires session tags matching the exact EKS cluster,
namespace, and ServiceAccount. Direct CSI mode avoids a second copy in the Kubernetes API.
Keep node IMDS restricted: Pod Identity is a pod-level boundary, and every container in this
pod receives the same role credentials.

The current image still runs the gateway and brain subprocess in one container, so they share
its filesystem. Tool policy and environment allowlisting reduce exposure but are not an OS
filesystem boundary. A hardened future tier must run the brain in a separately isolated
container and mount surface, repository, and signing credentials only into the gateway.
