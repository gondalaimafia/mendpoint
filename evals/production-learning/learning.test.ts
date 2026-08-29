import { describe, expect, it } from "vitest";
import {
  assertExternalProviderTransmissionAllowed,
  validateBenchmarkLearningEvent,
  type BenchmarkLearningEvent,
  type BenchmarkLearningOutcome,
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
      consentDecisionRef: "consent://benchmark-tenant-a/governed-learning/v1",
      consentGranted: true,
      licenseCompatible: true,
      externalProviderAllowed: false,
      containsRepositoryContent: false,
      containsCustomerData: false,
      containsPrivateReasoning: false,
      sealedDataset: outcome === "failed",
    },
    economics: { costUsd: 0.1, latencyMs: 1_000 },
    createdAt: "2026-08-28T23:00:00.000Z",
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
    expect(() => assertExternalProviderTransmissionAllowed(event())).toThrow(
      "external_provider_transmission_not_authorized",
    );
  });

  it("permits only an explicitly authorized, license compatible, consented event", () => {
    const value = event();
    value.governance.externalProviderAllowed = true;
    expect(() => assertExternalProviderTransmissionAllowed(value)).not.toThrow();
  });
});
