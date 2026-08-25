import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  linkRegaugeCampaignToMission,
  revokeLearningConsent,
  type AppDb,
} from "@mendpoint/db";
import {
  beginVerifierAdvisoryProviderOperation,
  persistVerifierAdvisoryProviderResponse,
  persistVerifierTelemetry,
} from "@mendpoint/pipeline";
import {
  createAgentVerifier,
  createVerifierEvidencePack,
  type VerifierBackend,
  type VerifierEvidencePackInput,
} from "@mendpoint/verifier";
import { readRegaugeVerifierObservations } from "./regauge-verifier-observations.js";
import { REGAUGE_VERIFIER_CONSENT_PURPOSE } from "./regauge-verifier-consent.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "regauge-verifier-observation-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant_regauge_canary", slug: "tenant-regauge-canary", name: "ReGauge canary", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "service_a", tenantId: "tenant_regauge_canary", kind: "service", subject: "service:regauge-production-bootstrap", displayName: "Service", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "reviewer_a", tenantId: "tenant_regauge_canary", kind: "human", subject: "reviewer", displayName: "Reviewer", createdAt: "2026-08-24T11:58:00.000Z" });
  createMission(db, { id: "mission_a", tenantId: "tenant_regauge_canary", product: "regauge", triggerKind: "migration_objective", objective: "Upgrade Node", ownerPrincipalId: "service_a", eventId: "mission-created", idempotencyKey: "mission-created", correlationId: "campaign_regauge_canary_20260814", createdAt: "2026-08-24T12:00:00.000Z" });
  linkRegaugeCampaignToMission(db, { tenantId: "tenant_regauge_canary", missionId: "mission_a", regaugeCampaignId: "campaign_regauge_canary_20260814", actorPrincipalId: "service_a", eventId: "mission-linked", idempotencyKey: "mission-linked", correlationId: "campaign_regauge_canary_20260814", createdAt: "2026-08-24T12:00:00.000Z" });
  grantLearningConsent(db, { id: "consent_a", tenantId: "tenant_regauge_canary", consentVersion: 1, purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE, residencyRegion: "cn", authorizedByPrincipalId: "reviewer_a", supersedesConsentId: null, effectiveAt: "2026-08-24T11:59:00.000Z", expiresAt: "2026-11-20T23:59:59.000Z", reason: "Approved exact ReGauge advisory", idempotencyKey: "consent-a", createdAt: "2026-08-24T11:59:30.000Z" });
  return db;
}

async function telemetry() {
  const pack: VerifierEvidencePackInput = {
    schemaVersion: "2026-08-17.v1", tenantId: "tenant_regauge_canary", missionId: "mission_a",
    taskId: "campaign_regauge_canary_20260814:unit_a", product: "regauge", repositoryId: "repo_a",
    snapshotDigest: digest("snapshot"), objective: "Verify migration.", risk: "high",
    governance: { dataClassification: "confidential", requiredRegion: "cn", processingRegion: "cn", externalModelAllowed: true, mayLeaveTenantBoundary: true, consentId: "consent_a", consentActive: true },
    allowedChangedPaths: ["package.json"],
    criteria: [{ id: "correctness", title: "Correctness", description: "Correct.", hard: true, weight: 1 }],
    sources: [{ id: "tests", kind: "verification", digest: digest("tests"), locator: "tests", content: "Tests passed." }],
    checks: [{ id: "tests", status: "passed", evidenceRefs: ["tests"], candidateIds: null }],
    candidates: [{ candidateId: "candidate_a", artifactDigest: digest("candidate"), kind: "completion", observableOutput: "Completed.", changedPaths: ["package.json"], evidenceRefs: ["tests"], deterministicCheckIds: ["tests"], hardCriterionResults: [{ criterionId: "correctness", status: "passed", evidenceRefs: ["tests"] }] }],
    assembledAt: "2026-08-24T12:01:00.000Z", assemblerVersion: "test/1",
  };
  const backend: VerifierBackend = {
    descriptor: { backendId: "deepseek", provider: "deepseek", model: "deepseek-v4-flash", backendRevision: "deepseek-v4-flash-2026-08-24", mode: "nonthinking_logprobs" },
    score: async (request) => ({ requestId: request.requestId, criterionId: request.criterion.id, scores: { candidate_a: 0.9 }, rawResponseDigest: digest("response"), recognizedProbabilityMass: 1, usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 2, reasoningTokens: 0, totalTokens: 12 }, estimatedCostUsd: 0.001, latencyMs: 2 }),
  };
  return (await createAgentVerifier({ enabled: true, rolloutMode: "advisory", backend, evaluations: 1, pivots: 1, seed: 0, maximumCandidates: 1 }).verify({
    pack: createVerifierEvidencePack(pack), incumbentCandidateId: "candidate_a",
    verificationAttemptId: "completion_campaign_regauge_canary_20260814:unit_a", observedAt: "2026-08-24T12:02:00.000Z",
  })).telemetry;
}

describe("ReGauge verifier production observations", () => {
  it("returns only validated DeepSeek advisory provider evidence for the exact campaign Mission", async () => {
    const db = setup();
    const durableTelemetry = await telemetry();
    const operation = beginVerifierAdvisoryProviderOperation(db, {
      tenantId: "tenant_regauge_canary",
      verificationAttemptId: durableTelemetry.verificationAttemptId,
      evidencePackDigest: durableTelemetry.evidencePackDigest,
      providerRequestId: "request_a",
      requestBodySha256: digest("request"),
      expectedConsentId: "consent_a",
      consentPurpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
      authorizationDeadline: "2026-11-20T23:59:59.000Z",
      requestedAt: "2026-08-24T12:01:30.000Z",
      producerPrincipalId: "service_a",
    });
    expect(operation.status).toBe("ready");
    persistVerifierAdvisoryProviderResponse(db, {
      tenantId: "tenant_regauge_canary",
      operationId: operation.operationId,
      response: { status: 200, headers: {}, body: { id: "response_a" } },
      providerProcessedAt: "2026-08-24T12:01:45.000Z",
      producerPrincipalId: "service_a",
    });
    persistVerifierTelemetry(db, { telemetry: durableTelemetry, producerPrincipalId: "service_a" });
    revokeLearningConsent(db, { id: "consent_revoked", tenantId: "tenant_regauge_canary", consentId: "consent_a", consentVersion: 2, authorizedByPrincipalId: "reviewer_a", reason: "revoked after processing", idempotencyKey: "consent-revoked", createdAt: "2026-08-24T12:03:00.000Z" });
    expect(readRegaugeVerifierObservations(db, { tenantId: "tenant_regauge_canary", campaignId: "campaign_regauge_canary_20260814" }))
      .toEqual([expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-flash", totalTokens: 12, consentId: "consent_a", consentEffectiveAt: "2026-08-24T11:59:00.000Z", consentGrantedAt: "2026-08-24T11:59:30.000Z", providerRequestedAt: "2026-08-24T12:01:30.000Z", providerProcessedAt: "2026-08-24T12:01:45.000Z", consentRecordDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/), advisoryOnly: true, behaviorChanged: false })]);
    expect(() => readRegaugeVerifierObservations(db, { tenantId: "tenant_regauge_canary", campaignId: "campaign_b" }))
      .toThrow("regauge_verifier_observation_scope_invalid");
  });
});
