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

data "aws_region" "current" {}

data "aws_partition" "current" {}

locals {
  service_account_name  = var.release_name
  secret_provider_class = "${var.release_name}-aws-secrets"
  # Cluster-scoped so separate clusters cannot collide inside one AWS account.
  secret_prefix = "/sageox-agent/${var.cluster_name}/${var.release_name}"
  identity_hash = substr(sha256("${var.cluster_name}:${var.namespace}:${var.release_name}"), 0, 12)
  # IAM caps a role name at 64 characters and spends every one of them here:
  # "sageox-agent-" (13) + hash (12) + "-" (1) + a release name truncated to 38.
  # Changing the prefix means changing that 38 to match, or long names stop applying.
  iam_role_name = "sageox-agent-${local.identity_hash}-${substr(var.release_name, 0, 38)}"
  managed_secrets = {
    for alias, config in var.secrets : alias => config
    if config.existing_secret_name == null
  }
  existing_secrets = {
    for alias, config in var.secrets : alias => config
    if config.existing_secret_name != null
  }
}

# Secret metadata is infrastructure; external credential values are deliberately seeded
# after this resource exists so ordinary Terraform state never contains those values.
resource "aws_secretsmanager_secret" "agent" {
  for_each = local.managed_secrets

  name                    = "${local.secret_prefix}/${each.key}"
  description             = "${var.release_name} credential mounted as ${each.key}"
  recovery_window_in_days = 7
  tags                    = merge(var.tags, { Service = "sageox-agent", Agent = var.release_name })
}

data "aws_secretsmanager_secret" "existing" {
  for_each = local.existing_secrets
  name     = each.value.existing_secret_name
}

locals {
  secret_arns = merge(
    { for alias, secret in aws_secretsmanager_secret.agent : alias => secret.arn },
    { for alias, secret in data.aws_secretsmanager_secret.existing : alias => secret.arn },
  )
  secret_names = merge(
    { for alias, secret in aws_secretsmanager_secret.agent : alias => secret.name },
    { for alias, secret in data.aws_secretsmanager_secret.existing : alias => secret.name },
  )
}

resource "aws_iam_role" "agent" {
  name = local.iam_role_name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "pods.eks.amazonaws.com"
      }
      Action = ["sts:AssumeRole", "sts:TagSession"]
      Condition = {
        StringEquals = {
          "aws:RequestTag/eks-cluster-name"           = var.cluster_name
          "aws:RequestTag/kubernetes-namespace"       = var.namespace
          "aws:RequestTag/kubernetes-service-account" = local.service_account_name
        }
      }
    }]
  })
  tags = merge(var.tags, { Service = "sageox-agent", Agent = var.release_name })
}

resource "aws_iam_role_policy" "agent_secrets" {
  name = "read-agent-secrets"
  role = aws_iam_role.agent.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "ReadExactAgentSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
        Resource = values(local.secret_arns)
      }],
      length(var.kms_key_arns) == 0 ? [] : [{
        Sid      = "DecryptSecretKeys"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = sort(tolist(var.kms_key_arns))
        Condition = {
          StringEquals = {
            "kms:ViaService"                  = "secretsmanager.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}"
            "kms:EncryptionContext:SecretARN" = sort(values(local.secret_arns))
          }
        }
      }],
    )
  })
}

resource "aws_eks_pod_identity_association" "agent" {
  cluster_name         = var.cluster_name
  namespace            = var.namespace
  service_account      = local.service_account_name
  role_arn             = aws_iam_role.agent.arn
  disable_session_tags = false
}

# The chart install itself: the CLI-generated values file plus the AWS security values
# this module owns. Credential values are seeded out-of-band and are never inputs here.
resource "helm_release" "agent" {
  count = var.deploy ? 1 : 0

  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true
  chart            = abspath("${path.module}/../../helm")

  atomic          = true
  cleanup_on_fail = true
  lint            = true
  wait            = true
  timeout         = 600

  values = [file(var.values_file), yamlencode({
    agents = {
      (var.agent_name) = {
        serviceAccount = {
          create = true
          name   = local.service_account_name
        }
        secrets = {
          kubernetesSecret = ""
          csi = {
            secretProviderClass = local.secret_provider_class
            provider            = "aws"
            parameters = {
              usePodIdentity = "true"
              objects = yamlencode([
                for alias in sort(keys(local.secret_names)) : {
                  objectName  = local.secret_names[alias]
                  objectType  = "secretsmanager"
                  objectAlias = alias
                }
              ])
            }
          }
        }
      }
    }
  })]

  depends_on = [aws_eks_pod_identity_association.agent]

  lifecycle {
    precondition {
      condition = (
        length(keys(yamldecode(file(var.values_file)).agents)) == 1 &&
        contains(keys(yamldecode(file(var.values_file)).agents), var.agent_name)
      )
      error_message = "values_file must contain exactly the bundle named by agent_name."
    }
  }
}
