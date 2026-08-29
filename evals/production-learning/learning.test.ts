import { describe, expect, it } from "vitest";
import {
  PREFLIGHT_REVISION,
  PROVIDER_AUTHORITY_ENVELOPE,
  PROVIDER_EXPIRED_AUTHORITY_ENVELOPE,
  PROVIDER_MISMATCH_AUTHORITY_ENVELOPE,
  installTestAuthorityTrustRoots,
} from "./authority-fixtures.test-support.js";
import {
  assertExternalProviderTransmissionAllowed,
  validateBenchmarkLearningEvent,
  verifyExternalProviderTransmissionAuthority,
  type BenchmarkLearningEvent,
  type BenchmarkLearningOutcome,
  type ExternalProviderTransmissionAuthority,
} from "./learning.js";

const SHA = "a".repeat(64);
const REVISION = PREFLIGHT_REVISION;
installTestAuthorityTrustRoots();
process.env.MENDPOINT_PRODUCTION_REVISION = REVISION;

function event(outcome: BenchmarkLearningOutcome = "accepted"): BenchmarkLearningEvent {
  return {
    schemaVersion: "mendpoint.benchmark-learning-event.v1",
    eventId: `event-${outcome}`,
    idempotencyKey: `case:FET-C001:${outcome}:1`,
    caseId: "FET-C001",
    product: "fettler",
    outcome,
    factClass: outcome === "failed" ? "model_failure" : "repository_fact",
    sink: outcome === "failed" ? "sealed_evaluation" : "change_graph",
    lineage: {
      productionRevision: REVISION,
      executionDigest: SHA,
      receiptDigest: "receipt://FET-C001/run-1",
      repositoryId: "repo-a",
      repositoryCommit: REVISION,
      repositorySnapshotDigest: SHA,
      licenseDecisionRef: "license://repo-a/v1",
      provenanceRef: "provenance://repo-a/revision-b",
      graphVersion: "graph-v1",
      policyVersion: "policy-v1",
      modelId: "configured:model-v1",
      routerVersion: "router-v1",
      recipeVersion: null,
      deterministicVerificationRef: "oracle://FET-C001/run-1",
      parentEventId: null,
    },
    governance: {
      tenantId: "benchmark-tenant-a",
      consent: { decision: "granted", purpose: "governed_learning", evidenceRef: "consent://benchmark-tenant-a/governed-learning/v1" },
      license: { decision: "compatible", intendedUse: "governed_learning", evidenceRef: "license://repo-a/v1" },
      externalProvider: { decision: "denied", providerId: null, purpose: null, sharedTrainingAllowed: false, repositoryContentAllowed: false, retention: "none" },
      containsRepositoryContent: false,
      containsCustomerData: false,
      containsPrivateReasoning: false,
      sealedDataset: outcome === "failed",
    },
    economics: { costUsd: 0.1, latencyMs: 1_000 },
    createdAt: "2026-08-28T23:00:00.000Z",
  };
}

function authority(value: BenchmarkLearningEvent): ExternalProviderTransmissionAuthority {
  void value;
  process.env.MENDPOINT_PRODUCTION_REVISION = REVISION;
  return verifyExternalProviderTransmissionAuthority(PROVIDER_AUTHORITY_ENVELOPE);
}

describe("governed benchmark learning lineage", () => {
  it("represents every required reviewer and execution outcome", () => {
    for (const outcome of ["accepted", "rejected", "corrected", "failed", "rolled_back", "reviewer_modified"] as const) {
      expect(validateBenchmarkLearningEvent(event(outcome))).toEqual([]);
    }
  });

  it("keeps each learning fact class in its authority sink", () => {
    const value = event();
    value.factClass = "organization_preference";
    expect(validateBenchmarkLearningEvent(value)).toContain(
      "organization_preference must route only to organization_memory",
    );
  });

  it("requires model failures to remain in sealed evaluation data", () => {
    const value = event("failed");
    value.governance.sealedDataset = false;
    expect(validateBenchmarkLearningEvent(value)).toContain(
      "model failures must enter a sealed evaluation dataset",
    );
  });

  it("rejects invalid runtime enums and non-boolean sealedDataset values", () => {
    const value = event() as unknown as Record<string, unknown>;
    value.product = "fettler-ish";
    value.outcome = "accepted-ish";
    value.factClass = "repository-ish";
    value.sink = "graph-ish";
    const governance = value.governance as Record<string, unknown>;
    governance.sealedDataset = "false";
    (governance.externalProvider as Record<string, unknown>).decision = "allow";
    expect(validateBenchmarkLearningEvent(value as unknown as BenchmarkLearningEvent)).toEqual(expect.arrayContaining([
      "product must be fettler or regauge",
      "outcome is invalid",
      "factClass is invalid",
      "sink is invalid",
      "external provider decision is invalid",
      "governance.sealedDataset must be boolean",
    ]));
  });

  it("denies external provider transmission without an explicit compatible decision", () => {
    expect(() => assertExternalProviderTransmissionAllowed(event(), authority(event()))).toThrow(
      "external_provider_transmission_not_authorized",
    );
  });

  it("permits only an explicitly authorized, license compatible, consented event", () => {
    const value = event();
    value.governance.externalProvider = { decision: "allowed", providerId: "provider-a", purpose: "case_execution", sharedTrainingAllowed: false, repositoryContentAllowed: false, retention: "none" };
    expect(() => assertExternalProviderTransmissionAllowed(value, authority(value))).not.toThrow();
  });

  it("rejects an unverified or mismatched provider authority and any shared-training permission", () => {
    const value = event();
    value.governance.externalProvider = { decision: "allowed", providerId: "provider-a", purpose: "case_execution", sharedTrainingAllowed: false, repositoryContentAllowed: false, retention: "none" };
    const selfAuthorized = PROVIDER_AUTHORITY_ENVELOPE.payload as unknown as ExternalProviderTransmissionAuthority;
    expect(() => assertExternalProviderTransmissionAllowed(value, selfAuthorized)).toThrow("external_provider_authority_not_verified");
    const mismatched = verifyExternalProviderTransmissionAuthority(PROVIDER_MISMATCH_AUTHORITY_ENVELOPE);
    expect(() => assertExternalProviderTransmissionAllowed(value, mismatched)).toThrow("external_provider_authority_mismatch:snapshot");
    (value.governance.externalProvider as unknown as { sharedTrainingAllowed: boolean }).sharedTrainingAllowed = true;
    expect(validateBenchmarkLearningEvent(value)).toContain("external provider shared training must be exactly denied");
  });

  it("rejects tampered, foreign, expired, wrong-key, wrong-digest, and stale-revision authorities", () => {
    const value = event();
    const tampered = structuredClone(PROVIDER_AUTHORITY_ENVELOPE);
    tampered.payload = { ...tampered.payload, providerId: "provider-b" };
    expect(() => verifyExternalProviderTransmissionAuthority(tampered)).toThrow("authority_signature_invalid");
    const foreignIssuer = structuredClone(PROVIDER_AUTHORITY_ENVELOPE);
    foreignIssuer.issuer = "foreign-authority";
    expect(() => verifyExternalProviderTransmissionAuthority(foreignIssuer)).toThrow("authority_issuer_not_trusted");
    const foreignKey = structuredClone(PROVIDER_AUTHORITY_ENVELOPE);
    foreignKey.keyId = "foreign-key";
    expect(() => verifyExternalProviderTransmissionAuthority(foreignKey)).toThrow("authority_issuer_not_trusted");
    process.env.MENDPOINT_EXTERNAL_PROVIDER_TRUSTED_KEY_SHA256 = "0".repeat(64);
    expect(() => verifyExternalProviderTransmissionAuthority(PROVIDER_AUTHORITY_ENVELOPE)).toThrow("authority_public_key_digest_mismatch");
    installTestAuthorityTrustRoots();
    expect(() => verifyExternalProviderTransmissionAuthority(PROVIDER_EXPIRED_AUTHORITY_ENVELOPE)).toThrow("authority_time_window_invalid");
    process.env.MENDPOINT_PRODUCTION_REVISION = "c".repeat(40);
    expect(() => verifyExternalProviderTransmissionAuthority(PROVIDER_AUTHORITY_ENVELOPE)).toThrow("authority_production_revision_not_current");
    delete process.env.MENDPOINT_PRODUCTION_REVISION;
    expect(() => verifyExternalProviderTransmissionAuthority(PROVIDER_AUTHORITY_ENVELOPE)).toThrow("authority_current_production_revision_unavailable");
    process.env.MENDPOINT_PRODUCTION_REVISION = REVISION;
    delete process.env.MENDPOINT_EXTERNAL_PROVIDER_PUBLIC_KEY_SPKI_BASE64;
    expect(() => verifyExternalProviderTransmissionAuthority(PROVIDER_AUTHORITY_ENVELOPE)).toThrow("authority_trust_root_unavailable");
    installTestAuthorityTrustRoots();
  });
});
