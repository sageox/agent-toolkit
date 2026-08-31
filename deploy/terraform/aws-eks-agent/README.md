# AWS EKS agent

This specialized adapter adds one agent to an existing EKS cluster. The generic Helm chart
supports fleets, while this module intentionally accepts a values file containing exactly
one bundle so it can give that identity a least-privilege IAM role. It creates recoverable Secrets
Manager secret shells, an exact-secret IAM policy, an EKS Pod Identity association, a
provider-neutral `SecretProviderClass`, and finally the canonical agent Helm release.

Secret values are not Terraform inputs. Bootstrap in two phases:

1. Create a native single-agent Helm values file, the volume its bundle comes from, and an
   explicit set of logical `secretRef` names in the Terraform caller.
2. Apply with `deploy = false` to create the secret shells and IAM wiring.
3. Seed the reported `managed_secret_names` using `seed-secrets.sh` or your existing secret
   delivery system.
4. Set `deploy = true`, inspect the plan, and apply again.

To reuse a secret managed elsewhere, set `existing_secret_name` for that logical alias:

```hcl
secrets = {
  ANTHROPIC_API_KEY = {}
  BUZZ_NSEC         = {}
  GITHUB_TOKEN = {
    existing_secret_name = "/shared/read-only-github-token"
  }
}
```

The workload mounts Secrets Manager values directly at `/mnt/secrets-store`; it does not copy
them into a Kubernetes Secret. If an existing secret uses a customer-managed KMS key, add
that exact key ARN to `kms_key_arns`. The resulting decrypt permission also requires a
regional Secrets Manager request carrying one of this agent's exact secret ARNs as its KMS
encryption context; the workload cannot use the permission for direct KMS decrypt calls.

Managed secrets are named `/sageox-agent/<cluster_name>/<release_name>/<secretRef>`, so
separate clusters cannot collide inside one AWS account. The Pod Identity role trust
policy also requires the exact EKS cluster, namespace, and ServiceAccount session tags.

To rotate a credential, put a new Secrets Manager version and restart the Deployment; the
new pod mounts the current values.
