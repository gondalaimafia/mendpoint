import { describe, expect, it } from "vitest";
import {
  assessVpcDeployment,
  type VpcDeploymentContract,
} from "./vpc-deployment.js";

function contract(): VpcDeploymentContract {
  return {
    version: "2026-08-02.v1",
    deploymentId: "customer-a-prod",
    cloud: "approved-cloud",
    region: "us-central-1",
    network: {
      publicIngress: false,
      ingressCidrs: ["10.20.0.0/16"],
      defaultDeny: true,
      privateDns: true,
      allowedEgress: ["scm", "model", "security-updates"],
    },
    privateServices: {
      scmUrl: "https://scm.customer.internal",
      modelUrl: "https://model.customer.private",
    },
    encryption: {
      customerManagedKeyUri: "kms://customer-a/mendpoint",
      keyRegion: "us-central-1",
      rotationDays: 90,
    },
    residency: { dataRegion: "us-central-1", backupsRegion: "us-central-1" },
    customerLogs: { destination: "customer://security-logs/mendpoint", retentionDays: 365 },
    automation: {
      artifactDigest: `sha256:${"a".repeat(64)}`,
      revision: "b".repeat(40),
      rollbackRevision: "c".repeat(40),
    },
    approvals: {},
  };
}

describe("VPC deployment contract", () => {
  it("keeps a valid reference contract blocked until external approvals are retained", () => {
    expect(assessVpcDeployment(contract())).toEqual({
      contractValid: true,
      deploymentReady: false,
      issues: [],
      externalBlockers: ["approved cloud account and region", "approved enterprise network"],
    });
  });

  it("becomes ready only with both named approval evidence references", () => {
    const input: VpcDeploymentContract = {
      ...contract(),
      approvals: {
        cloudAccountEvidenceRef: "approval://cloud/customer-a/us-central-1",
        enterpriseNetworkEvidenceRef: "approval://network/customer-a/vpc-1",
      },
    };
    expect(assessVpcDeployment(input)).toMatchObject({
      contractValid: true,
      deploymentReady: true,
      externalBlockers: [],
    });
  });

  it("fails closed for public paths, incomplete egress, residency drift, and mutable automation", () => {
    const base = contract();
    const input = {
      ...base,
      network: { ...base.network, publicIngress: true, allowedEgress: ["scm"] },
      privateServices: { ...base.privateServices, scmUrl: "https://github.com" },
      residency: { ...base.residency, backupsRegion: "us-east-1" },
      automation: { ...base.automation, artifactDigest: "latest" },
    } as unknown as VpcDeploymentContract;
    expect(assessVpcDeployment(input)).toMatchObject({
      contractValid: false,
      deploymentReady: false,
      issues: expect.arrayContaining([
        "public_ingress_forbidden",
        "egress_model_required",
        "egress_security-updates_required",
        "private_scm_url_invalid",
        "residency_region_mismatch",
        "automation_digest_invalid",
      ]),
    });
  });

  it("rejects invalid IPv4 network ranges", () => {
    const base = contract();
    const input = {
      ...base,
      network: { ...base.network, ingressCidrs: ["999.20.0.0/77"] },
    } as VpcDeploymentContract;
    expect(assessVpcDeployment(input).issues).toContain("approved_ingress_cidrs_required");
  });
});
