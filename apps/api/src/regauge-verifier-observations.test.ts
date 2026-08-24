import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertPrincipal,
  insertTenant,
  linkRegaugeCampaignToMission,
  type AppDb,
} from "@mendpoint/db";
import { persistVerifierTelemetry } from "@mendpoint/pipeline";
import {
  createAgentVerifier,
  createVerifierEvidencePack,
  type VerifierBackend,
  type VerifierEvidencePackInput,
} from "@mendpoint/verifier";
import { readRegaugeVerifierObservations } from "./regauge-verifier-observations.js";

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
  insertTenant(db, { id: "tenant_a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-24T12:00:00.000Z" });
  insertPrincipal(db, { id: "service_a", tenantId: "tenant_a", kind: "service", subject: "service:regauge-production-bootstrap", displayName: "Service", createdAt: "2026-08-24T12:00:00.000Z" });
  createMission(db, { id: "mission_a", tenantId: "tenant_a", product: "regauge", triggerKind: "migration_objective", objective: "Upgrade Node", ownerPrincipalId: "service_a", eventId: "mission-created", idempotencyKey: "mission-created", correlationId: "campaign_a", createdAt: "2026-08-24T12:00:00.000Z" });
  linkRegaugeCampaignToMission(db, { tenantId: "tenant_a", missionId: "mission_a", regaugeCampaignId: "campaign_a", actorPrincipalId: "service_a", eventId: "mission-linked", idempotencyKey: "mission-linked", correlationId: "campaign_a", createdAt: "2026-08-24T12:00:00.000Z" });
  return db;
}

async function telemetry() {
  const pack: VerifierEvidencePackInput = {
    schemaVersion: "2026-08-17.v1", tenantId: "tenant_a", missionId: "mission_a",
    taskId: "campaign_a:unit_a", product: "regauge", repositoryId: "repo_a",
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
    verificationAttemptId: "completion_campaign_a:unit_a", observedAt: "2026-08-24T12:02:00.000Z",
  })).telemetry;
}

describe("ReGauge verifier production observations", () => {
  it("returns only validated DeepSeek advisory provider evidence for the exact campaign Mission", async () => {
    const db = setup();
    persistVerifierTelemetry(db, { telemetry: await telemetry(), producerPrincipalId: "service_a" });
    expect(readRegaugeVerifierObservations(db, { tenantId: "tenant_a", campaignId: "campaign_a" }))
      .toEqual([expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-flash", totalTokens: 12, advisoryOnly: true, behaviorChanged: false })]);
    expect(() => readRegaugeVerifierObservations(db, { tenantId: "tenant_a", campaignId: "campaign_b" }))
      .toThrow("regauge_verifier_observation_mission_missing");
  });
});
