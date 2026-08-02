export const VPC_DEPLOYMENT_CONTRACT_VERSION = "2026-08-02.v1" as const;

export type VpcDeploymentContract = Readonly<{
  version: typeof VPC_DEPLOYMENT_CONTRACT_VERSION;
  deploymentId: string;
  cloud: string;
  region: string;
  network: Readonly<{
    publicIngress: false;
    ingressCidrs: readonly string[];
    defaultDeny: true;
    privateDns: true;
    allowedEgress: readonly ("scm" | "model" | "security-updates")[];
  }>;
  privateServices: Readonly<{
    scmUrl: string;
    modelUrl: string;
  }>;
  encryption: Readonly<{
    customerManagedKeyUri: string;
    keyRegion: string;
    rotationDays: number;
  }>;
  residency: Readonly<{
    dataRegion: string;
    backupsRegion: string;
  }>;
  customerLogs: Readonly<{
    destination: string;
    retentionDays: number;
  }>;
  automation: Readonly<{
    artifactDigest: string;
    revision: string;
    rollbackRevision: string;
  }>;
  approvals: Readonly<{
    cloudAccountEvidenceRef?: string;
    enterpriseNetworkEvidenceRef?: string;
  }>;
}>;

export type VpcDeploymentAssessment = Readonly<{
  contractValid: boolean;
  deploymentReady: boolean;
  issues: readonly string[];
  externalBlockers: readonly string[];
}>;

const ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function privateHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname.endsWith(".internal") || url.hostname.endsWith(".private"));
  } catch {
    return false;
  }
}

function ipv4Cidr(value: string): boolean {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(value);
  if (!match) return false;
  return match[1]!.split(".").every((octet) => Number(octet) <= 255) &&
    Number(match[2]) <= 32;
}

export function assessVpcDeployment(
  contract: VpcDeploymentContract,
): VpcDeploymentAssessment {
  const issues: string[] = [];
  if (contract.version !== VPC_DEPLOYMENT_CONTRACT_VERSION) issues.push("version_invalid");
  if (!ID.test(contract.deploymentId)) issues.push("deployment_id_invalid");
  if (!present(contract.cloud)) issues.push("cloud_required");
  if (!present(contract.region)) issues.push("region_required");
  if (contract.network.publicIngress !== false) issues.push("public_ingress_forbidden");
  if (contract.network.defaultDeny !== true) issues.push("default_deny_required");
  if (contract.network.privateDns !== true) issues.push("private_dns_required");
  if (contract.network.ingressCidrs.length === 0 || contract.network.ingressCidrs.some((cidr) => !ipv4Cidr(cidr))) {
    issues.push("approved_ingress_cidrs_required");
  }
  const egress = new Set(contract.network.allowedEgress);
  for (const destination of ["scm", "model", "security-updates"] as const) {
    if (!egress.has(destination)) issues.push(`egress_${destination}_required`);
  }
  if (egress.size !== contract.network.allowedEgress.length) issues.push("egress_duplicate");
  if (!privateHttps(contract.privateServices.scmUrl)) issues.push("private_scm_url_invalid");
  if (!privateHttps(contract.privateServices.modelUrl)) issues.push("private_model_url_invalid");
  if (!present(contract.encryption.customerManagedKeyUri)) issues.push("customer_managed_key_required");
  if (contract.encryption.keyRegion !== contract.region) issues.push("key_region_mismatch");
  if (!Number.isSafeInteger(contract.encryption.rotationDays) || contract.encryption.rotationDays < 1) {
    issues.push("key_rotation_invalid");
  }
  if (contract.residency.dataRegion !== contract.region || contract.residency.backupsRegion !== contract.region) {
    issues.push("residency_region_mismatch");
  }
  if (!present(contract.customerLogs.destination)) issues.push("customer_log_destination_required");
  if (!Number.isSafeInteger(contract.customerLogs.retentionDays) || contract.customerLogs.retentionDays < 1) {
    issues.push("customer_log_retention_invalid");
  }
  if (!DIGEST.test(contract.automation.artifactDigest)) issues.push("automation_digest_invalid");
  if (!REVISION.test(contract.automation.revision)) issues.push("automation_revision_invalid");
  if (!REVISION.test(contract.automation.rollbackRevision)) issues.push("rollback_revision_invalid");
  if (contract.automation.revision === contract.automation.rollbackRevision) issues.push("rollback_revision_must_differ");

  const externalBlockers = [
    ...(present(contract.approvals.cloudAccountEvidenceRef) ? [] : ["approved cloud account and region"]),
    ...(present(contract.approvals.enterpriseNetworkEvidenceRef) ? [] : ["approved enterprise network"]),
  ];
  return Object.freeze({
    contractValid: issues.length === 0,
    deploymentReady: issues.length === 0 && externalBlockers.length === 0,
    issues: Object.freeze(issues),
    externalBlockers: Object.freeze(externalBlockers),
  });
}
