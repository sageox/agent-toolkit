output "pod_identity_addon_id" {
  description = "EKS Pod Identity Agent add-on identifier."
  value       = aws_eks_addon.pod_identity_agent.id
}

output "csi_provider_release" {
  description = "Cluster-wide AWS Secrets Store CSI provider Helm release."
  value       = helm_release.secrets_store_csi_provider_aws.name
}
