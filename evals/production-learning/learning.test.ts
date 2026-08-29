import { describe, expect, it } from "vitest";
import {
  assertExternalProviderTransmissionAllowed,
  validateBenchmarkLearningEvent,
  type BenchmarkLearningEvent,
  type BenchmarkLearningOutcome,
  type ExternalProviderTransmissionAuthority,
} from "./learning.js";

const SHA = "a".repeat(64);
const REVISION = "b".repeat(40);

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
  return {
    tenantId: value.governance.tenantId,
    repositoryId: value.lineage.repositoryId,
    repositoryCommit: value.lineage.repositoryCommit,
    repositorySnapshotDigest: value.lineage.repositorySnapshotDigest,
    providerId: "provider-a",
    purpose: "case_execution",
    consentEvidenceRef: value.governance.consent.evidenceRef,
    licenseEvidenceRef: value.governance.license.evidenceRef,
    sharedTrainingAllowed: false,
    repositoryContentAllowed: false,
  };
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

  it("rejects self-authorized provider transmission and any shared-training permission", () => {
    const value = event();
    value.governance.externalProvider = { decision: "allowed", providerId: "provider-a", purpose: "case_execution", sharedTrainingAllowed: false, repositoryContentAllowed: false, retention: "none" };
    const trusted = authority(value);
    trusted.repositorySnapshotDigest = "c".repeat(64);
    expect(() => assertExternalProviderTransmissionAllowed(value, trusted)).toThrow("external_provider_authority_mismatch:snapshot");
    (value.governance.externalProvider as unknown as { sharedTrainingAllowed: boolean }).sharedTrainingAllowed = true;
    expect(validateBenchmarkLearningEvent(value)).toContain("external provider shared training must be exactly denied");
  });
});
