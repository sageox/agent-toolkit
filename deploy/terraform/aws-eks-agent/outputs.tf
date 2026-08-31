output "managed_secret_names" {
  description = "Secrets Manager shells that must be seeded before setting deploy=true."
  value       = { for alias, secret in aws_secretsmanager_secret.agent : alias => secret.name }
}

output "all_secret_names" {
  description = "Logical aliases and resolved Secrets Manager names mounted into the agent."
  value       = local.secret_names
}

output "pod_identity_role_arn" {
  description = "Least-privilege IAM role associated with this agent's ServiceAccount."
  value       = aws_iam_role.agent.arn
}

output "secret_provider_class" {
  description = "Secrets Store CSI class created with the agent Helm release."
  value       = local.secret_provider_class
}
