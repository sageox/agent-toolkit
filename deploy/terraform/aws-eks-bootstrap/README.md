# AWS EKS secret-provider bootstrap

Install this module once per existing EKS cluster. It installs the EKS Pod Identity Agent
and the AWS Secrets Store CSI provider with its bundled CSI driver. Agent releases consume
those shared components through `../aws-eks-agent`.

Configure the AWS and Helm providers in the root module. The Helm provider must point at
the same cluster named by `cluster_name`. Do not instantiate this module when equivalent
components are already managed by the platform team; import or reuse that installation
instead.

The provider runs on EC2-backed EKS nodes. AWS Fargate is not supported by the AWS Secrets
Store CSI provider.
