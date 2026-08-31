variable "cluster_name" {
  description = "Existing EKS cluster that will run toolkit agents."
  type        = string

  validation {
    condition     = trimspace(var.cluster_name) != ""
    error_message = "cluster_name must not be empty."
  }
}
