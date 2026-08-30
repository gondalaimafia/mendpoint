import { describe, expect, it } from "vitest";
import {
  assessCustomerReadiness,
  computeCustomerReadiness,
  CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA,
  CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
  verifyCustomerSandboxReceipt,
  type CustomerQualificationAttestation,
  type CustomerReadinessInput,
  type CustomerSandboxReceiptVerification,
} from "./customer-readiness.js";

const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const REGISTER_DIGEST = `sha256:${"1".repeat(64)}`;
const CLAIMS_DIGEST = `sha256:${"2".repeat(64)}`;
const EVIDENCE_DIGEST = `sha256:${"3".repeat(64)}`;
const NOW = "2026-08-30T12:00:00.000Z";

function attestation(): CustomerQualificationAttestation {
  return {
    schemaVersion: CUSTOMER_QUALIFICATION_ATTESTATION_SCHEMA,
    qualifiedRevision: REVISION,
    requirementRegisterDigest: REGISTER_DIGEST,
    publicClaimsRegistryDigest: CLAIMS_DIGEST,
    evidenceManifestDigest: EVIDENCE_DIGEST,
    qualification: {
      outcome: "qualified",
      requirementCount: CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
      qualifiedRequirementCount: CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
    },
  };
}

function verifiedReceipt(): CustomerSandboxReceiptVerification {
  return {
    status: "verified",
    app: "mendpoint-sandbox",
    image: `registry.fly.io/mendpoint-sandbox@sha256:${"4".repeat(64)}`,
    policyDigest: `sha256:${"5".repeat(64)}`,
    testedAt: "2026-08-30T11:55:00.000Z",
    expiresAt: "2026-08-30T12:55:00.000Z",
  };
}

function readyInput(overrides: Partial<CustomerReadinessInput> = {}): CustomerReadinessInput {
  return {
    activation: "required",
    declaration: "1",
    releaseRevision: REVISION,
    qualificationAttestation: attestation(),
    trustRoots: {
      requirementRegisterDigest: REGISTER_DIGEST,
      publicClaimsRegistryDigest: CLAIMS_DIGEST,
      evidenceManifestDigest: EVIDENCE_DIGEST,
    },
    profileBlockers: [],
    sandboxReceipt: verifiedReceipt(),
    criticalHealth: [{ name: "database", ok: true }],
    revokedEvidenceIds: [],
    now: NOW,
    ...overrides,
  };
}

describe("computed customer readiness", () => {
  it("never lets the deployment declaration alone produce required readiness", () => {
    const assessment = computeCustomerReadiness({ activation: "required", declaration: "1", now: NOW });
    expect(assessment.status).toBe("indeterminate");
    expect(assessment.reasons).toEqual(expect.arrayContaining([
      "release_revision_indeterminate",
      "qualification_trust_roots_missing",
      "qualification_attestation_missing",
      "sandbox_receipt_unavailable",
      "critical_health_indeterminate",
    ]));
  });

  it("returns ready only for an exact qualified revision, three matching digests, and fresh receipt", () => {
    const assessment = computeCustomerReadiness(readyInput());
    expect(assessment).toMatchObject({
      status: "ready",
      declared: "ready",
      activation: "required",
      reasons: [],
      sourceRevision: REVISION,
    });
    expect(assessment.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a qualification attested for another exact release revision", () => {
    const assessment = computeCustomerReadiness(readyInput({ releaseRevision: OTHER_REVISION }));
    expect(assessment.status).toBe("not_ready");
    expect(assessment.reasons).toContain("qualification_revision_mismatch");
    expect(assessment.sourceRevision).toBe(OTHER_REVISION);
  });

  it.each([
    ["requirement register", "requirementRegisterDigest", "qualification_register_digest_mismatch"],
    ["public claims registry", "publicClaimsRegistryDigest", "qualification_public_claims_digest_mismatch"],
    ["evidence manifest", "evidenceManifestDigest", "qualification_evidence_manifest_digest_mismatch"],
  ] as const)("rejects a %s digest mismatch", (_name, field, reason) => {
    const roots = {
      requirementRegisterDigest: REGISTER_DIGEST,
      publicClaimsRegistryDigest: CLAIMS_DIGEST,
      evidenceManifestDigest: EVIDENCE_DIGEST,
      [field]: `sha256:${"f".repeat(64)}`,
    };
    const assessment = computeCustomerReadiness(readyInput({ trustRoots: roots }));
    expect(assessment.status).toBe("not_ready");
    expect(assessment.reasons).toContain(reason);
  });

  it.each([
    ["absent", undefined, "qualification_attestation_missing"],
    ["non-object", "attestation", "qualification_attestation_malformed"],
    ["extra field", { ...attestation(), claims: [] }, "qualification_attestation_malformed"],
    ["bad revision", { ...attestation(), qualifiedRevision: "main" }, "qualification_attestation_malformed"],
  ])("fails closed for %s qualification input", (_name, qualificationAttestation, reason) => {
    const assessment = computeCustomerReadiness(readyInput({ qualificationAttestation }));
    expect(assessment.status).toBe("indeterminate");
    expect(assessment.reasons).toContain(reason);
  });

  it("requires the attested 101 of 101 outcome without re-evaluating claim states", () => {
    const incomplete = structuredClone(attestation()) as unknown as Record<string, unknown>;
    incomplete.qualification = {
      outcome: "qualified",
      requirementCount: CUSTOMER_QUALIFICATION_REQUIREMENT_COUNT,
      qualifiedRequirementCount: 100,
    };
    const assessment = computeCustomerReadiness(readyInput({ qualificationAttestation: incomplete }));
    expect(assessment.status).toBe("not_ready");
    expect(assessment.reasons).toContain("qualification_outcome_incomplete");
    expect(Object.keys(attestation())).not.toContain("claims");
    expect(computeCustomerReadiness(readyInput()).status).toBe("ready");
  });

  it.each([
    ["invalid", "sandbox_receipt_invalid"],
    ["expired", "sandbox_receipt_expired"],
    ["scope_mismatch", "sandbox_receipt_scope_mismatch"],
    ["revoked", "sandbox_receipt_revoked"],
  ] as const)("rejects a %s sandbox receipt", (status, reason) => {
    const assessment = computeCustomerReadiness(readyInput({ sandboxReceipt: { status } }));
    expect(assessment.status).toBe("not_ready");
    expect(assessment.reasons).toContain(reason);
  });

  it("rechecks receipt expiry at the supplied current time instead of caching a prior success", () => {
    const receipt = verifiedReceipt();
    expect(computeCustomerReadiness(readyInput({ sandboxReceipt: receipt })).status).toBe("ready");
    const later = computeCustomerReadiness(readyInput({
      sandboxReceipt: receipt,
      now: "2026-08-30T12:55:00.000Z",
    }));
    expect(later.status).toBe("not_ready");
    expect(later.reasons).toContain("sandbox_receipt_expired");
  });

  it.each([
    ["profile blocker", { profileBlockers: ["browser_identity_missing"] }, "customer_profile_blocked"],
    ["critical health", { criticalHealth: [{ name: "database", ok: false }] }, "critical_health_failed"],
    ["evidence revocation", { revokedEvidenceIds: ["evidence-17"] }, "evidence_revoked"],
  ])("blocks readiness for %s", (_name, override, reason) => {
    const assessment = computeCustomerReadiness(readyInput(override));
    expect(assessment.status).toBe("not_ready");
    expect(assessment.reasons).toContain(reason);
  });

  it("fails closed when required critical health evidence is absent", () => {
    const assessment = computeCustomerReadiness(readyInput({ criticalHealth: undefined }));
    expect(assessment.status).toBe("indeterminate");
    expect(assessment.reasons).toContain("critical_health_indeterminate");
  });

  it.each([
    ["absent", undefined],
    ["malformed", [""]],
  ])("fails closed when required revocation evidence is %s", (_name, revokedEvidenceIds) => {
    const assessment = computeCustomerReadiness(readyInput({
      revokedEvidenceIds: revokedEvidenceIds as readonly string[] | undefined,
    }));
    expect(assessment.status).toBe("indeterminate");
    expect(assessment.reasons).toContain("evidence_revocation_state_indeterminate");
    expect(assessment.digest).not.toBe(computeCustomerReadiness(readyInput()).digest);
  });

  it("produces a stable canonical digest independent of object and set ordering", () => {
    const first = computeCustomerReadiness(readyInput({
      criticalHealth: [{ name: "worker", ok: true }, { name: "database", ok: true }],
      revokedEvidenceIds: ["revoked-b", "revoked-a"],
      trustRoots: {
        requirementRegisterDigest: REGISTER_DIGEST,
        publicClaimsRegistryDigest: CLAIMS_DIGEST,
        evidenceManifestDigest: EVIDENCE_DIGEST,
      },
    }));
    const second = computeCustomerReadiness(readyInput({
      criticalHealth: [{ name: "database", ok: true }, { name: "worker", ok: true }],
      revokedEvidenceIds: ["revoked-a", "revoked-b"],
      trustRoots: {
        evidenceManifestDigest: EVIDENCE_DIGEST,
        publicClaimsRegistryDigest: CLAIMS_DIGEST,
        requirementRegisterDigest: REGISTER_DIGEST,
      },
    }));
    expect(first.digest).toBe(second.digest);
  });

  it("preserves staged inactive compatibility but fails closed once required", () => {
    expect(assessCustomerReadiness({ MENDPOINT_CUSTOMER_READY: "1" }, [], { now: NOW }))
      .toMatchObject({ status: "ready", activation: "inactive_compatibility" });
    const required = assessCustomerReadiness({
      MENDPOINT_CUSTOMER_READY: "1",
      MENDPOINT_CUSTOMER_QUALIFICATION_MODE: "required",
    }, [], { now: NOW });
    expect(required.status).toBe("indeterminate");
    expect(required.reasons).toContain("qualification_attestation_missing");
  });

  it("delegates raw sandbox authority to the existing platform verifier", () => {
    expect(verifyCustomerSandboxReceipt({}, NOW)).toEqual({ status: "unavailable" });
  });
});
