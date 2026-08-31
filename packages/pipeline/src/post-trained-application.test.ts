import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDomainEvent, createDb, insertArtifactManifest, insertEvidenceRecord, insertPrincipal } from "@mendpoint/db";
import type { AdapterLifecycleRecord, ExecutorDescriptor, PostTrainedConsentSnapshot, RouterPolicySnapshot, RouterTaskSpec } from "@mendpoint/platform";
import { getPostTrainedAdapterEligibility, getPostTrainedAdapterStatus, registerPostTrainedAdapter, rollbackPostTrainedAdapter, routePostTrainedAdapterDryRun } from "./post-trained-application.js";

const roots: string[] = []; const dbs: ReturnType<typeof createDb>[] = [];
afterEach(() => { dbs.splice(0).forEach((db) => db.raw.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const ADAPTER_BYTES = Buffer.from("test-adapter-weights"); const DIGEST = `sha256:${createHash("sha256").update(ADAPTER_BYTES).digest("hex")}`; const ROLLBACK = `sha256:${"b".repeat(64)}`;
function setup() {
  const root = mkdtempSync(join(tmpdir(), "post-trained-"));
  roots.push(root);
  const db = createDb(join(root, "db.sqlite"));
  dbs.push(db);
  insertPrincipal(db, { id: "actor", tenantId: "tenant-1", kind: "human", subject: "operator", displayName: "Operator", createdAt: "2026-08-12T12:00:00.000Z" });
  insertPrincipal(db, { id: "evaluator", tenantId: "tenant-1", kind: "service", subject: "evaluator", displayName: "Independent Evaluator", createdAt: "2026-08-12T12:00:00.000Z" });
  const content = JSON.stringify({ encoding: "base64", bytes: ADAPTER_BYTES.toString("base64"), decodedSha256: DIGEST });
  const sha256 = createHash("sha256").update(content).digest("hex");
  insertArtifactManifest(db, { id: "training-artifact", tenantId: "tenant-1", kind: "post_trained_adapter_artifact", schemaVersion: 1, sha256, mediaType: "application/vnd.mendpoint.post-trained-adapter-bytes+json", sizeBytes: Buffer.byteLength(content), storageRef: "sqlite://training-artifact", content, producerPrincipalId: "actor", createdAt: "2026-08-12T11:00:00.000Z" });
  appendDomainEvent(db, { id: "training-submitted", tenantId: "tenant-1", schemaVersion: 1, eventType: "post_trained_training.submitted", aggregateType: "post_trained_training_job", aggregateId: "training-job-1", actorPrincipalId: "actor", correlationId: "training-1", idempotencyKey: "training-submitted-1", payload: { requestDigest: "request", adapterId: "adapter-1", baseModelId: "base-1", datasetId: "dataset-1", submittedAt: "2026-08-12T10:59:00.000Z" }, createdAt: "2026-08-12T10:59:00.000Z" });
  appendDomainEvent(db, { id: "training-completed", tenantId: "tenant-1", schemaVersion: 1, eventType: "post_trained_training.completed", aggregateType: "post_trained_training_job", aggregateId: "training-job-1", actorPrincipalId: "actor", correlationId: "training-1", idempotencyKey: "training-completed-1", payload: { requestDigest: "request", artifactId: "training-artifact", adapterDigest: DIGEST, datasetId: "dataset-1", completedAt: "2026-08-12T11:00:00.000Z" }, createdAt: "2026-08-12T11:00:00.000Z" });
  const evaluationContent = JSON.stringify({ schemaVersion: 1, kind: "post_trained_independent_evaluation", evaluationId: "evaluation-1", trainingJobId: "training-job-1", candidate: { adapterId: "adapter-1", artifactId: "training-artifact", artifactDigest: DIGEST }, baseline: { executorId: "baseline", revision: "a".repeat(40) }, policy: { minimumSuccessRate: .9, maximumRegressionRate: .02, maximumSecurityRegressions: 0 }, report: { successRate: .96, regressionRate: .01 }, passed: true, completedAt: "2026-08-12T11:30:00.000Z" });
  const evaluationSha = createHash("sha256").update(evaluationContent).digest("hex");
  insertArtifactManifest(db, { id: "evaluation-artifact", tenantId: "tenant-1", kind: "post_trained_independent_evaluation", schemaVersion: 1, sha256: evaluationSha, mediaType: "application/vnd.mendpoint.post-trained-evaluation+json", sizeBytes: Buffer.byteLength(evaluationContent), storageRef: "sqlite://evaluation-artifact", content: evaluationContent, producerPrincipalId: "evaluator", createdAt: "2026-08-12T11:30:00.000Z" });
  insertEvidenceRecord(db, { id: "evaluation-evidence", tenantId: "tenant-1", subjectType: "post_trained_evaluation", subjectId: "evaluation-1", artifactId: "evaluation-artifact", inputArtifactId: "training-artifact", producerPrincipalId: "evaluator", tool: "independent-post-trained-evaluator", toolVersion: "1", verdict: "passed", createdAt: "2026-08-12T11:30:00.000Z" });
  appendDomainEvent(db, { id: "evaluation-completed", tenantId: "tenant-1", schemaVersion: 1, eventType: "post_trained_evaluation.completed", aggregateType: "post_trained_evaluation", aggregateId: "evaluation-1", actorPrincipalId: "evaluator", correlationId: "evaluation-1", idempotencyKey: "evaluation-completed-1", payload: { requestDigest: "eval-request", artifactId: "evaluation-artifact", trainingJobId: "training-job-1", adapterId: "adapter-1", passed: true, successRate: .96, regressionRate: .01, overlapCount: 0, completedAt: "2026-08-12T11:30:00.000Z" }, createdAt: "2026-08-12T11:30:00.000Z" });
  appendDomainEvent(db, { id: "canary-completed", tenantId: "tenant-1", schemaVersion: 1, eventType: "post_trained_canary.completed", aggregateType: "post_trained_canary", aggregateId: "adapter-1", actorPrincipalId: "actor", correlationId: "canary-1", idempotencyKey: "canary-completed-1", payload: { adapterDigest: DIGEST, servingRevision: "serve-7", passed: true, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://1"] }, createdAt: "2026-08-01T00:00:00.000Z" });
  return db;
}
function lifecycle(): AdapterLifecycleRecord { return { tenantId: "tenant-1", adapterId: "adapter-1", state: "monitored", revision: 7, baseModel: { modelId: "base-1", license: "commercial", evidenceRef: "evidence://base" }, artifactDigest: DIGEST, trainingDataset: { datasetId: "dataset-1", lineageRefs: ["lineage://1"], consent: { status: "granted", evidenceRefs: ["consent://train"] }, sufficiency: { representative: true, sampleCount: 1000, minimumSampleCount: 500, evidenceRefs: ["eval://data"] } }, heldOutEvaluation: { reportRef: "evaluation-artifact", passed: true, successRate: .96, regressionRate: .01 }, promotionThresholds: { minimumSuccessRate: .9, maximumRegressionRate: .02 }, approvedInfrastructure: { approved: true, marker: "gpu-a", evidenceRef: "infra://approved" }, servingRevision: "serve-7", monitoringWindow: { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z" }, rollbackTarget: { servingRevision: "serve-6", artifactDigest: ROLLBACK }, approver: { principalId: "human", approvedAt: "2026-08-01T00:00:00.000Z", evidenceRef: "approval://1" }, canaryEvidence: { passed: true, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://1"] }, evidenceRefs: ["lifecycle://7"], history: [{ revision: 7, from: "promoted", to: "monitored", actorId: "actor", occurredAt: "2026-08-02T00:00:00.000Z", evidenceRefs: ["monitor://1"] }] }; }
function consent(): PostTrainedConsentSnapshot { return { tenantId: "tenant-1", datasetId: "dataset-1", revision: 3, status: "active", evidenceRefs: ["consent://runtime"], checkedAt: "2026-08-12T11:59:00.000Z" }; }
function descriptor(): ExecutorDescriptor { return { executorId: "executor-1", providerId: "internal", kind: "adapter", version: "serve-7", deployment: "internal", capabilities: ["repair"], tools: ["repo-read"], regions: ["us-east"], price: { version: "p1", currency: "USD", effectiveAt: "2026-08-01T00:00:00.000Z" }, limits: { maximumInputTokens: 4000, maximumOutputTokens: 2000, maximumConcurrentTasks: 2 }, health: { status: "healthy", checkedAt: "2026-08-12T11:58:00.000Z", evidenceRef: "health://1" }, license: { id: "commercial", commercialUse: true, redistribution: "restricted" }, maximumDataClassification: "internal", maximumRisk: "medium", qualityScore: .95, estimatedLatencyMs: 1000, estimatedCostUsd: .2 }; }
function task(): RouterTaskSpec { return { taskId: "task-1", tenantId: "tenant-1", kind: "repair", goal: "Repair", idempotencyKey: "task-idem", inputArtifactIds: ["input"], requiredCapabilities: ["repair"], allowedTools: ["repo-read"], context: { estimatedInputTokens: 1000, maximumOutputTokens: 500 }, verification: { requiredChecks: ["tests"], requireAll: true, onFailure: "human_handoff" }, fallbackPolicy: { enabled: false, maxAttempts: 1, sameExecutorRetries: 0, retryableFailures: [], fallbackFailures: [] }, privacy: { classification: "internal", requiredRegion: "us-east" }, risk: "medium", quality: { minimumScore: .8 }, latency: { maximumMs: 5000 }, budget: { maximumUsd: 1 } }; }
function policy(): RouterPolicySnapshot { return { snapshotId: "policy-1", version: 1, capturedAt: "2026-08-12T11:00:00.000Z", privacy: { allowedClassifications: ["internal"], externalProcessingAllowed: false }, region: { allowedExecutionRegions: ["us-east"] }, risk: { maximumAutonomousRisk: "medium", humanReviewAtOrAbove: "critical" }, quality: { minimumScore: .8 }, latency: { maximumMs: 5000 }, budget: { maximumUsd: 1 } }; }

describe("post trained application", () => {
  it("durably registers tenant scoped manifest and performs route dry run with fresh consent recheck", () => {
    const db = setup(); let consentReads = 0; const evidenceChecks: Array<{ refs: readonly string[]; subjectTypes: readonly string[]; subjectId: string }> = [];
    const registration = { tenantId: "tenant-1", adapterId: "adapter-1", trainingJobId: "training-job-1", actorPrincipalId: "actor", idempotencyKey: "register-1", registeredAt: "2026-08-12T12:00:00.000Z", lifecycle: lifecycle(), consent: consent(), descriptor: descriptor() };
    const authority = { enabled: true as const, authorizeHumanApprover: () => true, verifyEvidence: (_tenant: string, refs: readonly string[], expected: { subjectTypes: readonly string[]; subjectId: string }) => { evidenceChecks.push({ refs, ...expected }); return true; }, readConsent: (_tenant: string, _dataset: string, stored: PostTrainedConsentSnapshot) => stored };
    const first = registerPostTrainedAdapter(db, registration, authority);
    expect(registerPostTrainedAdapter(db, registration, authority)).toEqual(first);
    expect(registerPostTrainedAdapter(db, { ...registration, registeredAt: "2026-08-12T12:05:00.000Z" }, authority)).toEqual(first);
    expect(getPostTrainedAdapterStatus(db, "tenant-1", "adapter-1", { enabled: true }).lifecycle).toMatchObject({ state: "monitored", approver: { principalId: "actor", approvedAt: "2026-08-12T12:00:00.000Z", evidenceRef: expect.stringMatching(/^evidence_/) } });
    const result = routePostTrainedAdapterDryRun(db, { tenantId: "tenant-1", adapterId: "adapter-1", task: task(), policy: policy(), remainingBudgetUsd: 1, now: new Date("2026-08-12T12:00:00.000Z") }, { enabled: true, verifyEvidence: () => true, readConsent: (_tenant, _dataset, stored) => { consentReads++; return stored; } });
    expect(result.action).toBe("execute"); expect(result.authorization.authorized).toBe(true); expect(consentReads).toBeGreaterThanOrEqual(2);
    expect(evidenceChecks).toContainEqual({ refs: ["consent://runtime", "consent://train"], subjectTypes: ["learning_consent"], subjectId: "dataset-1" });
    expect(evidenceChecks).toContainEqual({ refs: ["evaluation-artifact"], subjectTypes: ["post_trained_evaluation"], subjectId: "evaluation-1", artifactIds: ["evaluation-artifact"] });
    expect(evidenceChecks).toContainEqual({ refs: ["canary://1"], subjectTypes: ["post_trained_canary"], subjectId: "adapter-1" });
    expect(db.raw.prepare("SELECT COUNT(*) c FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_adapter'").get("tenant-1")).toEqual({ c: 2 });
  });

  it("is default off and does not reveal cross tenant adapters", () => {
    const db = setup();
    expect(() => getPostTrainedAdapterStatus(db, "tenant-1", "adapter-1", { enabled: false })).toThrow("post_trained_application_disabled");
    expect(() => getPostTrainedAdapterStatus(db, "tenant-2", "adapter-1", { enabled: true })).toThrow("post_trained_adapter_not_found");
  });

  it("rejects registration not bound to the exact completed training artifact and current consent", () => {
    const db = setup(); const registration = { tenantId: "tenant-1", adapterId: "adapter-1", trainingJobId: "wrong-job", actorPrincipalId: "actor", idempotencyKey: "register-2", registeredAt: "2026-08-12T12:00:00.000Z", lifecycle: lifecycle(), consent: consent(), descriptor: descriptor() };
    const authority = { enabled: true as const, authorizeHumanApprover: () => true, verifyEvidence: () => true, readConsent: (_tenant: string, _dataset: string, stored: PostTrainedConsentSnapshot) => stored };
    expect(() => registerPostTrainedAdapter(db, registration, authority)).toThrow("post_trained_training_completion_missing");
    expect(() => registerPostTrainedAdapter(db, { ...registration, trainingJobId: "training-job-1" }, { enabled: true, authorizeHumanApprover: () => true, verifyEvidence: () => true })).toThrow("post_trained_consent_authority_missing");
    expect(() => registerPostTrainedAdapter(db, { ...registration, trainingJobId: "training-job-1", adapterId: "adapter-other", lifecycle: { ...lifecycle(), adapterId: "adapter-other" } }, authority)).toThrow("post_trained_training_completion_mismatch");
    expect(() => registerPostTrainedAdapter(db, { ...registration, trainingJobId: "training-job-1", lifecycle: { ...lifecycle(), baseModel: { ...lifecycle().baseModel, modelId: "base-other" } } }, authority)).toThrow("post_trained_training_completion_mismatch");
    expect(() => registerPostTrainedAdapter(db, { ...registration, trainingJobId: "training-job-1", lifecycle: { ...lifecycle(), heldOutEvaluation: { ...lifecycle().heldOutEvaluation!, successRate: .99 } } }, authority)).toThrow("post_trained_independent_evaluation_mismatch");
    expect(() => registerPostTrainedAdapter(db, { ...registration, trainingJobId: "training-job-1", lifecycle: { ...lifecycle(), canaryEvidence: { ...lifecycle().canaryEvidence!, evidenceRefs: ["canary://substituted"] } } }, authority)).toThrow("post_trained_canary_mismatch");
  });

  it("requires a durable human promotion and removes a rolled back adapter from routing immediately", () => {
    const db = setup(); const registration = { tenantId: "tenant-1", adapterId: "adapter-1", trainingJobId: "training-job-1", actorPrincipalId: "actor", idempotencyKey: "register-human", registeredAt: "2026-08-12T12:00:00.000Z", lifecycle: lifecycle(), consent: consent(), descriptor: descriptor() };
    const authority = { enabled: true as const, authorizeHumanApprover: (_tenant: string, principalId: string) => principalId === "actor", verifyEvidence: () => true, readConsent: (_tenant: string, _dataset: string, stored: PostTrainedConsentSnapshot) => stored };
    expect(() => registerPostTrainedAdapter(db, registration, { ...authority, authorizeHumanApprover: () => false })).toThrow("post_trained_human_approval_required");
    registerPostTrainedAdapter(db, registration, authority);
    const rolledBack = rollbackPostTrainedAdapter(db, { tenantId: "tenant-1", adapterId: "adapter-1", actorPrincipalId: "actor", expectedArtifactDigest: DIGEST, reason: "Canary regression", idempotencyKey: "rollback-1", rolledBackAt: "2026-08-12T12:10:00.000Z" }, authority);
    expect(rolledBack.lifecycle.state).toBe("rolled_back");
    expect(rollbackPostTrainedAdapter(db, { tenantId: "tenant-1", adapterId: "adapter-1", actorPrincipalId: "actor", expectedArtifactDigest: DIGEST, reason: "Canary regression", idempotencyKey: "rollback-1", rolledBackAt: "2026-08-12T12:11:00.000Z" }, authority)).toEqual(rolledBack);
    expect(() => rollbackPostTrainedAdapter(db, { tenantId: "tenant-1", adapterId: "adapter-1", actorPrincipalId: "actor", expectedArtifactDigest: DIGEST, reason: "Different rollback", idempotencyKey: "rollback-other", rolledBackAt: "2026-08-12T12:11:00.000Z" }, authority)).toThrow("post_trained_rollback_replay_mismatch");
    expect(rolledBack.lifecycle.history.at(-1)?.evidenceRefs[0]).toMatch(/^evidence_/);
    expect(db.raw.prepare("SELECT COUNT(*) c FROM artifact_manifests WHERE tenant_id = ? AND kind = 'post_trained_human_rollback'").get("tenant-1")).toEqual({ c: 1 });
    expect(getPostTrainedAdapterEligibility(db, { tenantId: "tenant-1", adapterId: "adapter-1", task: task(), now: new Date("2026-08-12T12:10:00.000Z") }, authority)).toMatchObject({ eligible: false, reason: "lifecycle_not_servable" });
  });
});
import { createHash } from "node:crypto";
