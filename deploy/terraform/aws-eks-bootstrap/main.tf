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
      # No rotation reconciler: the runtime resolves credentials at process startup, so
      # rotation is "seed the new value, restart the Deployment" either way.
      syncSecret = {
        enabled = false
      }
    }
  })]

  depends_on = [aws_eks_addon.pod_identity_agent]
}
