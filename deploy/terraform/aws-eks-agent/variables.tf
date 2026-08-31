variable "cluster_name" {
  description = "Existing EKS cluster with Pod Identity and the AWS Secrets Store CSI provider installed."
  type        = string

  validation {
    condition     = length(var.cluster_name) <= 100 && can(regex("^[0-9A-Za-z][A-Za-z0-9_-]*$", var.cluster_name))
    error_message = "cluster_name must be a valid EKS cluster name no longer than 100 characters."
  }
}

variable "release_name" {
  description = "Helm release, ServiceAccount, and agent infrastructure name."
  type        = string

  validation {
    condition     = length(var.release_name) <= 53 && can(regex("^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$", var.release_name))
    error_message = "release_name must be a Kubernetes DNS label no longer than 53 characters."
  }
}

variable "namespace" {
  description = "Kubernetes namespace for the agent."
  type        = string
  default     = "agents"

  validation {
    condition     = length(var.namespace) <= 63 && can(regex("^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$", var.namespace))
    error_message = "namespace must be a Kubernetes DNS label no longer than 63 characters."
  }
}

variable "agent_name" {
  description = "Agent key in the single-bundle Helm values file."
  type        = string

  validation {
    condition     = length(var.agent_name) <= 63 && can(regex("^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$", var.agent_name))
    error_message = "agent_name must be a Kubernetes DNS label no longer than 63 characters."
  }
}


variable "values_file" {
  description = "Absolute path to native single-agent values for the canonical Helm chart."
  type        = string
}


variable "deploy" {
  description = "Create the Helm release after managed secret values have been seeded."
  type        = bool
  default     = false
}

variable "secrets" {
  description = "Logical secretRef file names. Omit existing_secret_name to create a Secrets Manager shell."
  type = map(object({
    existing_secret_name = optional(string)
  }))

  validation {
    condition = length(var.secrets) > 0 && alltrue([
      for alias in keys(var.secrets) : can(regex("^[A-Za-z_][A-Za-z0-9_]*$", alias))
    ])
    error_message = "secrets must use environment-style aliases such as ANTHROPIC_API_KEY."
  }

  validation {
    condition = alltrue([
      for config in values(var.secrets) : config.existing_secret_name == null ? true : (
        length(config.existing_secret_name) <= 512 &&
        can(regex("^[A-Za-z0-9/_+=.@-]+$", config.existing_secret_name))
      )
    ])
    error_message = "existing_secret_name must be a valid non-empty Secrets Manager name no longer than 512 characters."
  }
}



variable "kms_key_arns" {
  description = "Customer-managed KMS key ARNs needed to decrypt referenced secrets."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.kms_key_arns : can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", arn))
    ])
    error_message = "kms_key_arns must contain full KMS key ARNs, not aliases or key IDs."
  }
}


variable "tags" {
  description = "AWS tags added to managed resources."
  type        = map(string)
  default     = {}
}
