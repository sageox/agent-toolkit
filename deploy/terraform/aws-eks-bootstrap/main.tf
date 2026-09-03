terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.80, < 7.0"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.2"
    }
  }
}

# Pod Identity is cluster infrastructure, so install it once rather than letting each
# agent release compete to own the same add-on.
resource "aws_eks_addon" "pod_identity_agent" {
  cluster_name = var.cluster_name
  addon_name   = "eks-pod-identity-agent"
}

resource "helm_release" "secrets_store_csi_provider_aws" {
  name       = "secrets-provider-aws"
  namespace  = "kube-system"
  repository = "https://aws.github.io/secrets-store-csi-driver-provider-aws"
  chart      = "secrets-store-csi-driver-provider-aws"
  version    = "3.1.2"

  atomic  = true
  wait    = true
  timeout = 600

  values = [yamlencode({
    # Both the provider and bundled driver must reach every schedulable EC2 node.
    tolerations = [{ operator = "Exists" }]
    secrets-store-csi-driver = {
      install = true
      # No mirror into a Kubernetes Secret: the workload mounts Secrets Manager values
      # directly, and a second copy in the API is a second thing to authorize. A separate
      # setting refreshes a mount in place — `enableSecretRotation`, left at its default of
      # off — so rotation here is "seed the new value, restart the Deployment" for every
      # credential, the team brain's token included. That token is the one the runtime
      # re-reads per `ox` child, so enabling the reconciler is what would let it recover
      # without the restart.
      syncSecret = {
        enabled = false
      }
    }
  })]

  depends_on = [aws_eks_addon.pod_identity_agent]
}
