mock_provider "aws" {
  override_during = plan

  mock_data "aws_region" {
    defaults = {
      region = "us-west-2"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      dns_suffix = "amazonaws.com"
    }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn  = "arn:aws:secretsmanager:us-west-2:111122223333:secret:agent-harry-abc123"
      name = "/sageox-agent/test/agent-harry/ANTHROPIC_API_KEY"
    }
  }
}

mock_provider "helm" {}

run "kms_decrypt_is_bound_to_exact_secrets_manager_context" {
  command = plan

  variables {
    cluster_name = "test-cluster"
    release_name = "agent-harry"
    agent_name   = "harry"
    values_file  = "unused-while-deploy-is-false.yaml"
    deploy       = false
    secrets = {
      ANTHROPIC_API_KEY = {}
    }
    kms_key_arns = ["arn:aws:kms:us-west-2:111122223333:key/00000000-0000-0000-0000-000000000000"]
  }

  assert {
    condition = (
      jsondecode(aws_iam_role_policy.agent_secrets.policy).Statement[1].Condition.StringEquals["kms:ViaService"] ==
      "secretsmanager.us-west-2.amazonaws.com"
    )
    error_message = "KMS decrypt must be callable only through the regional Secrets Manager service."
  }

  assert {
    condition = contains(
      jsondecode(aws_iam_role_policy.agent_secrets.policy).Statement[1].Condition.StringEquals["kms:EncryptionContext:SecretARN"],
      "arn:aws:secretsmanager:us-west-2:111122223333:secret:agent-harry-abc123",
    )
    error_message = "KMS decrypt must require the exact agent secret ARN in its encryption context."
  }
}
