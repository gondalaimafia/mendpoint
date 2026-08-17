import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDomainEvent, createDb, insertArtifactManifest, insertEvidenceRecord, insertPrincipal, insertTenant, type AppDb } from "@mendpoint/db";
import { admitGovernedLearningEvent, governedLearningAdmissionIds, postTrainedCanaryResultDigest, postTrainedEvaluationResultDigest, postTrainedReconciliationResultDigest } from "@mendpoint/pipeline";
import type { AdapterLifecycleRecord, ExecutorDescriptor, PostTrainedConsentSnapshot } from "@mendpoint/platform";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { advancedAiAttestationCryptoFromEnv, advancedAiEvaluationRuntimeFromEnv, advancedAiTrainingRuntimeFromEnv, createAdvancedAiApplicationRoutes, createDurableAttestationScopeAuthority, createDurablePostTrainedEvidenceAuthority } from "./advanced-ai-applications.js";

const dirs: string[] = []; const dbs: AppDb[] = [];
afterEach(() => { dbs.splice(0).forEach((db) => db.raw.close()); dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });
const now = "2026-08-12T12:00:00.000Z"; const DIGEST = `sha256:${"a".repeat(64)}`; const ROLLBACK = `sha256:${"b".repeat(64)}`;
function lifecycle(): AdapterLifecycleRecord { return { tenantId: "tenant-a", adapterId: "adapter-1", state: "monitored", revision: 7, baseModel: { modelId: "base-1", license: "commercial", evidenceRef: "evidence://base" }, artifactDigest: DIGEST, trainingDataset: { datasetId: "dataset-1", lineageRefs: ["lineage://1"], consent: { status: "granted", evidenceRefs: ["consent://train"] }, sufficiency: { representative: true, sampleCount: 1000, minimumSampleCount: 500, evidenceRefs: ["eval://data"] } }, heldOutEvaluation: { reportRef: "eval://held", passed: true, successRate: .96, regressionRate: .01 }, promotionThresholds: { minimumSuccessRate: .9, maximumRegressionRate: .02 }, approvedInfrastructure: { approved: true, marker: "gpu-a", evidenceRef: "infra://approved" }, servingRevision: "serve-7", monitoringWindow: { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z" }, rollbackTarget: { servingRevision: "serve-6", artifactDigest: ROLLBACK }, approver: { principalId: "human", approvedAt: "2026-08-01T00:00:00.000Z", evidenceRef: "approval://1" }, canaryEvidence: { passed: true, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://1"] }, evidenceRefs: ["lifecycle://7"], history: [{ revision: 7, from: "promoted", to: "monitored", actorId: "actor", occurredAt: "2026-08-02T00:00:00.000Z", evidenceRefs: ["monitor://1"] }] }; }
function consent(): PostTrainedConsentSnapshot { return { tenantId: "tenant-a", datasetId: "dataset-1", revision: 3, status: "active", evidenceRefs: ["consent://runtime"], checkedAt: "2026-08-12T11:59:00.000Z" }; }
function descriptor(): ExecutorDescriptor { return { executorId: "executor-1", providerId: "internal", kind: "adapter", version: "serve-7", deployment: "internal", capabilities: ["repair"], tools: ["repo-read"], regions: ["us-east"], price: { version: "p1", currency: "USD", effectiveAt: "2026-08-01T00:00:00.000Z" }, limits: { maximumInputTokens: 4000, maximumOutputTokens: 2000, maximumConcurrentTasks: 2 }, health: { status: "healthy", checkedAt: "2026-08-12T11:58:00.000Z", evidenceRef: "health://1" }, license: { id: "commercial", commercialUse: true, redistribution: "restricted" }, maximumDataClassification: "internal", maximumRisk: "medium", qualityScore: .95, estimatedLatencyMs: 1000, estimatedCostUsd: .2 }; }
function task() { return { taskId: "task-1", tenantId: "tenant-a", kind: "repair", goal: "Repair", idempotencyKey: "task-idem", inputArtifactIds: ["input"], requiredCapabilities: ["repair"], allowedTools: ["repo-read"], context: { estimatedInputTokens: 1000, maximumOutputTokens: 500 }, verification: { requiredChecks: ["tests"], requireAll: true, onFailure: "human_handoff" }, fallbackPolicy: { enabled: false, maxAttempts: 1, sameExecutorRetries: 0, retryableFailures: [], fallbackFailures: [] }, privacy: { classification: "internal", requiredRegion: "us-east" }, risk: "medium", quality: { minimumScore: .8 }, latency: { maximumMs: 5000 }, budget: { maximumUsd: 1 } }; }
function policy() { return { snapshotId: "policy-1", version: 1, capturedAt: "2026-08-12T11:00:00.000Z", privacy: { allowedClassifications: ["internal"], externalProcessingAllowed: false }, region: { allowedExecutionRegions: ["us-east"] }, risk: { maximumAutonomousRisk: "medium", humanReviewAtOrAbove: "critical" }, quality: { minimumScore: .8 }, latency: { maximumMs: 5000 }, budget: { maximumUsd: 1 } }; }
function fixture(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "advanced-ai-api-")); dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite")); dbs.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: now });
  insertPrincipal(db, { id: "actor", tenantId: "tenant-a", kind: "human", subject: "actor", displayName: "Actor", createdAt: now });
  insertPrincipal(db, { id: "evaluator", tenantId: "tenant-a", kind: "service", subject: "evaluator", displayName: "Evaluator", createdAt: now });
  insertPrincipal(db, { id: "canary", tenantId: "tenant-a", kind: "service", subject: "canary", displayName: "Canary", createdAt: now });
  const keys = generateKeyPairSync("ed25519");
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => { c.set("principal", { id: "public-actor", tenantId: c.req.header("x-tenant") ?? "tenant-a", role: (c.req.header("x-role") ?? "admin") as "admin" }); c.set("trustPrincipalId", "actor"); c.set("requestId", "request-1"); await next(); });
  app.route("/advanced-ai", createAdvancedAiApplicationRoutes({
    db, enabled, now: () => now, authorizeAttestationScope: () => true, authorizeDataset: () => true,
    signer: { keyId: "key-1", algorithm: "ed25519", sign: (bytes) => new Uint8Array(sign(null, bytes, keys.privateKey)) },
    trustPolicy: { resolve: () => ({ keyId: "key-1", algorithm: "ed25519", publicKey: keys.publicKey, principalId: "actor", service: "mendpoint-attestation", tenantIds: ["tenant-a"], predicateTypes: ["https://mendpoint.ai/attestations/software/v1"], validFrom: "2026-08-01T00:00:00.000Z", validUntil: "2026-09-01T00:00:00.000Z", revokedAt: null }) },
    attestationPrincipalId: "actor", readConsent: (_t, _d, stored) => stored, verifyEvidence: () => true, authorizeHumanApprover: (_tenant, principalId) => principalId === "actor",
    trainingWorkerId: "api-worker", trainingAuthorityId: "trainer-authority", trainingProcessingBoundary: "tenant_local", trainingTimeoutMs: 1000, trainingLeaseMs: 5000,
    verifyReconciliation: (receipt) => receipt.signature === "test-signature",
    trainer: {
      train: async (request) => { const result = { status: "completed" as const, adapterBase64: Buffer.from(`local:${request.requestDigest}`).toString("base64"), evidenceRefs: ["training://local"], completedAt: now }; return { result, receipt: { tenantId: request.tenantId, jobId: request.jobId, requestDigest: request.requestDigest, leaseGeneration: request.leaseGeneration, authorityId: request.authorityId, outcome: result.status, resultDigest: postTrainedReconciliationResultDigest(result), observedAt: now, signature: "test-signature" } }; },
      reconcile: async (request) => { const result = { status: "pending" as const }; return { result, receipt: { tenantId: request.tenantId, jobId: request.jobId, requestDigest: request.requestDigest, leaseGeneration: request.leaseGeneration, authorityId: request.authorityId, outcome: result.status, resultDigest: postTrainedReconciliationResultDigest(result), observedAt: now, signature: "test-signature" } }; },
    },
    evaluationWorkerId: "evaluation-worker", evaluationPrincipalId: "evaluator", evaluationAuthorityId: "evaluation-authority", evaluationProcessingBoundary: "tenant_local", evaluationTimeoutMs: 1000, evaluationLeaseMs: 5000,
    evaluationExpected: { baseline: { executorId: "baseline-frontier", revision: "7".repeat(40) }, evaluator: { harnessVersion: "harness-v1", graderVersion: "grader-v1" }, policy: { minimumSuccessRate: .9, maximumRegressionRate: .02, maximumSecurityRegressions: 0 } },
    authorizeEvaluationDataset: () => true,
    verifyEvaluationReceipt: (receipt) => receipt.signature === "evaluation-signature",
    evaluator: {
      evaluate: async (request) => {
        const holdout = JSON.parse(request.holdout.content) as { examples: unknown[] };
        const result = { status: "completed" as const, report: { candidateAdapterId: request.candidate.adapterId, candidateArtifactDigest: request.candidate.artifactDigest, baselineExecutorId: request.baseline.executorId, baselineRevision: request.baseline.revision, cohortId: request.holdout.artifactId, cohortRevision: request.holdout.sha256.slice(0, 40), cohortDigest: `sha256:${request.holdout.sha256}`, split: "holdout" as const, harnessVersion: request.evaluator.harnessVersion, graderVersion: request.evaluator.graderVersion, trainingDatasetId: request.trainingDatasetId, trainingSplitManifestDigest: request.trainingSplitManifestDigest, taskCount: holdout.examples.length, successRate: .96, regressionRate: .01, securityRegressionCount: 0, overlapCheck: { comparedScenarioCount: holdout.examples.length + request.training.reduce((count, item) => count + (JSON.parse(item.content) as { examples: unknown[] }).examples.length, 0), overlapCount: 0 }, evidenceRefs: ["evaluation://local"] }, completedAt: now };
        return { result, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: result.status, resultDigest: postTrainedEvaluationResultDigest(result), observedAt: now, signature: "evaluation-signature" } };
      },
      reconcile: async () => { throw new Error("unexpected_evaluation_reconcile"); },
    },
    canaryWorkerId: "canary-worker", canaryPrincipalId: "canary", canaryAuthorityId: "canary-authority", canaryTimeoutMs: 1000, canaryLeaseMs: 5000,
    canaryExpected: { servingRevision: "serve-7", mode: "canary", allocationPercent: 5, policy: { minimumSuccessRate: .95, maximumErrorRate: .02, maximumPolicyViolations: 0, maximumP95LatencyMs: 1000, maximumCostUsd: 1 } },
    verifyCanaryReceipt: (receipt) => receipt.signature === "canary-signature",
    canaryRunner: {
      run: async (request) => { const result = { status: "completed" as const, report: { adapterId: request.adapter.adapterId, adapterDigest: request.adapter.artifactDigest, evaluationArtifactId: request.evaluation.artifactId, servingRevision: request.servingRevision, mode: request.mode, allocationPercent: request.allocationPercent, sampleCount: 50, successRate: .98, errorRate: .01, policyViolationCount: 0, p95LatencyMs: 400, costUsd: .2, evidenceRefs: ["canary-probe://local"] }, completedAt: now }; return { result, receipt: { canaryId: request.canaryId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: result.status, resultDigest: postTrainedCanaryResultDigest(result), observedAt: now, signature: "canary-signature" } }; },
      reconcile: async () => { throw new Error("unexpected_canary_reconcile"); },
    },
  }));
  return { app, db };
}
const SPLIT_MANIFEST = "a".repeat(64);
function add(db: AppDb, id: string, kind = id) { const split = kind === "learning_dataset_corpus" ? "train" : kind === "learning_dataset_validation" ? "validation" : kind === "learning_dataset_holdout" ? "holdout" : null; const content = JSON.stringify(split ? { id, datasetSplit: split, splitManifestDigest: SPLIT_MANIFEST, examples: [{ sourceEventId: `${id}-event`, sourceEventDigest: "b".repeat(64), specialization: { splitGroupId: `${id}-group` }, datasetSplit: split, task: { scenarioId: `${id}-scenario`, sourceRevision: createHash("sha1").update(id).digest("hex"), sourceDigest: `sha256:${createHash("sha256").update(id).digest("hex")}` } }] } : { id }); const digest = createHash("sha256").update(content).digest("hex"); insertArtifactManifest(db, { id, tenantId: "tenant-a", kind, schemaVersion: 1, sha256: digest, mediaType: "application/json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://${id}`, content, producerPrincipalId: "actor", createdAt: now }); }
function addTrainingAuthority(db: AppDb, prefix: string) { add(db, `${prefix}-corpus`, "learning_dataset_corpus"); add(db, `${prefix}-validation`, "learning_dataset_validation"); add(db, `${prefix}-holdout`, "learning_dataset_holdout"); }

function admitFlywheelEvent(db: AppDb, input: Readonly<{
  eventId: string;
  product: "fettler" | "regauge";
  splitGroupId: string;
  migrationFamily: string;
  sourceObjectId: string;
}>): void {
  const ids = governedLearningAdmissionIds("tenant-a", input.eventId);
  const observedAt = "2026-08-12T11:00:00.000Z";
  const event = {
    schemaVersion: 1,
    eventId: input.eventId,
    product: input.product,
    missionId: input.sourceObjectId,
    repositoryId: "repository-flywheel",
    taskType: input.product === "fettler" ? "api_remediation" : "legacy_migration",
    capability: "remediation_generation",
    specialization: { provider: "stripe", framework: "hono", language: "typescript", runtime: "node-20", migrationFamily: input.migrationFamily, riskClass: "medium", splitGroupId: input.splitGroupId },
    execution: { modelId: "baseline-frontier", adapterId: null, routerDecisionId: `route-${input.eventId}`, fallback: false },
    references: { graphContextArtifactId: null, inputArtifactId: ids.sourceArtifactId, proposedActionArtifactId: ids.redactedArtifactId },
    prediction: { summary: "Apply the evidence-bound migration.", evidenceRefs: [ids.redactionEvidenceId] },
    observedOutcome: { status: "corrected", summary: "The corrected migration passed deterministic verification.", attribution: "model_behavior", evidenceRefs: [ids.verificationEvidenceId] },
    verification: { verdict: "passed", evidenceRefs: [ids.verificationEvidenceId] },
    reviewerDecision: { decision: "modified", evidenceRefs: [ids.reviewDecisionId] },
    correction: { artifactId: ids.redactedArtifactId, substantive: true },
    confidence: 0.9,
    economics: { inputTokens: 800, outputTokens: 180, latencyMs: 900, costUsd: 0.01 },
    governance: { tenantId: "tenant-a", residencyRegion: "local", consentId: "consent-flywheel", sourceClass: "synthetic_ground_truth", provenanceQualifiers: ["deterministically_verified", "human_corrected"], mayLeaveTenantBoundary: false },
    createdAt: observedAt,
  } as const;
  admitGovernedLearningEvent(db, {
    tenantId: "tenant-a",
    purpose: "adapter_training",
    sourceObjectType: input.product === "fettler" ? "fettler_agent_run" : "transformer_adaptive_candidate",
    sourceObjectId: input.sourceObjectId,
    event,
    actorPrincipalId: "actor",
    idempotencyKey: `admit-${input.eventId}`,
    createdAt: now,
  }, {
    resolve: () => ({
      revision: createHash("sha1").update(input.eventId).digest("hex"),
      snapshotDigest: `sha256:${createHash("sha256").update(`snapshot:${input.eventId}`).digest("hex")}`,
      scenarioId: input.eventId,
      syntheticFamilyId: input.splitGroupId.slice(0, input.splitGroupId.lastIndexOf(":")),
      outcomeAttribution: "model_behavior",
      verificationVerdict: "passed",
      sourceClass: "synthetic_ground_truth",
      provenanceQualifiers: ["deterministically_verified", "human_corrected"],
      correctionSubstantive: true,
      reviewerPrincipalId: "actor",
      reviewRationale: "Ground truth and deterministic verification agree.",
      contaminationFree: true,
    }),
    redact: (content) => ({ ok: true, content, redactionCount: 0 }),
  });
}

describe("advanced AI applications API", () => {
  it("governs learning consent, status, and corpus materialization without trusting caller identity", async () => {
    const { app, db } = fixture();
    const grant = await app.request("/advanced-ai/learning/consents", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "learning-consent-1" },
      body: JSON.stringify({
        id: "learning-consent-1",
        tenantId: "attacker-tenant",
        consentVersion: 1,
        purpose: "fettler-api-engineering",
        residencyRegion: "us-central",
        effectiveAt: now,
        reason: "Train only on reviewed and redacted outcomes.",
      }),
    });
    expect(grant.status).toBe(201);
    await expect(grant.json()).resolves.toMatchObject({
      id: "learning-consent-1",
      tenantId: "tenant-a",
      action: "granted",
      evidenceId: expect.stringMatching(/^evidence_/),
    });
    expect((db.raw.prepare("SELECT tenant_id FROM learning_consents WHERE id = ?").get("learning-consent-1") as { tenant_id: string }).tenant_id).toBe("tenant-a");

    const status = await app.request("/advanced-ai/learning/status");
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      tenantId: "tenant-a",
      activeConsentCount: 1,
      learningRecordCount: 0,
      datasetCount: 0,
    });

    const emptyCorpus = await app.request("/advanced-ai/learning/corpora", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "empty-corpus" },
      body: JSON.stringify({ purpose: "fettler-api-engineering", temporalCutoffAt: "2026-08-12T11:59:00.000Z" }),
    });
    expect(emptyCorpus.status).toBe(400);
    await expect(emptyCorpus.json()).resolves.toEqual({ error: "learning_dataset_empty" });
    expect((db.raw.prepare("SELECT COUNT(*) count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);

    const revoke = await app.request("/advanced-ai/learning/consents/learning-consent-1/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "learning-consent-revoke-1" },
      body: JSON.stringify({ id: "learning-consent-revocation-1", consentVersion: 2, reason: "Stop future model training." }),
    });
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({ action: "revoked", supersedesConsentId: "learning-consent-1" });
  });

  it("keeps learning governance tenant admin only with zero writes on denial", async () => {
    const { app, db } = fixture();
    const response = await app.request("/advanced-ai/learning/consents", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "denied", "x-role": "viewer" },
      body: JSON.stringify({ id: "denied", consentVersion: 1, purpose: "x", residencyRegion: "local", effectiveAt: now, reason: "Denied" }),
    });
    expect(response.status).toBe(403);
    expect((db.raw.prepare("SELECT COUNT(*) count FROM learning_consents").get() as { count: number }).count).toBe(0);
  });

  it("fails closed when durable attestation evidence cannot prove a passing post-edit verification", () => {
    const { db } = fixture();
    const authorized = createDurableAttestationScopeAuthority()(db, {
      tenantId: "tenant-a", repositoryId: "repo", runId: "run", correlationId: "corr",
      actorPrincipalId: "actor", idempotencyKey: "attest-baseline", outcome: "passed",
      issuedAt: now, artifacts: { sourceIds: [], snapshotId: "snapshot", candidateId: "candidate", verificationIds: [], policyId: "policy", deliveryId: null, rollbackId: null, waiverId: null },
    }, {
      tenantId: "tenant-a", repositoryId: "repo", runId: "run", correlationId: "corr",
      sourceArtifacts: [], snapshotArtifact: { artifactId: "snapshot", sha256: "a".repeat(64) },
      candidateArtifact: { artifactId: "candidate", sha256: "b".repeat(64) }, verificationArtifacts: [],
      policyArtifact: { artifactId: "policy", sha256: "c".repeat(64) }, deliveryArtifact: null,
      rollbackArtifact: null, waiverArtifact: null,
    });
    expect(authorized).toBe(false);
  });
  it("is production default off", async () => { const { app } = fixture(false); expect((await app.request("/advanced-ai/attestations/a")).status).toBe(404); expect((await app.request("/advanced-ai/post-trained/adapters/a")).status).toBe(404); });
  it("constructs signer and trust only from a matching injected key pair", async () => { const keys = generateKeyPairSync("ed25519"); const wrong = generateKeyPairSync("ed25519"); expect(advancedAiAttestationCryptoFromEnv({})).toEqual({}); const env = { MENDPOINT_ATTESTATION_KEY_ID: "key-env", MENDPOINT_ATTESTATION_PRIVATE_KEY_PKCS8_BASE64: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), MENDPOINT_ATTESTATION_PUBLIC_KEY_SPKI_BASE64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"), MENDPOINT_ATTESTATION_TENANT_IDS: "tenant-a", MENDPOINT_ATTESTATION_PRINCIPAL_ID: "actor", MENDPOINT_ATTESTATION_KEY_VALID_FROM: "2026-08-01T00:00:00.000Z", MENDPOINT_ATTESTATION_KEY_VALID_UNTIL: "2026-09-01T00:00:00.000Z" }; const crypto = advancedAiAttestationCryptoFromEnv(env); expect(crypto.signer?.keyId).toBe("key-env"); expect(crypto.attestationPrincipalId).toBe("actor"); expect(await crypto.trustPolicy?.resolve?.("key-env")).toMatchObject({ tenantIds: ["tenant-a"] }); expect(advancedAiAttestationCryptoFromEnv({ ...env, MENDPOINT_ATTESTATION_PUBLIC_KEY_SPKI_BASE64: wrong.publicKey.export({ format: "der", type: "spki" }).toString("base64") })).toEqual({}); });
  it("constructs a bound trainer only from complete env and performs no network at startup", async () => { const { db } = fixture(); let calls = 0; const receipt = { tenantId: "tenant-a", jobId: "job", requestDigest: "digest", leaseGeneration: 1, authorityId: "trainer-authority", outcome: "pending", resultDigest: postTrainedReconciliationResultDigest({ status: "pending" }), observedAt: now, signature: "0".repeat(64) }; const transport = async (url: string | URL | Request, init?: RequestInit) => { calls++; const request = JSON.parse(String(init?.body)) as { jobId: string; requestDigest: string }; return new Response(JSON.stringify({ jobId: request.jobId, requestDigest: request.requestDigest, receipt, result: { status: "pending" } }), { status: 200, headers: { "content-type": "application/json" } }); }; expect(advancedAiTrainingRuntimeFromEnv(db, {}, transport as typeof fetch)).toEqual({}); const runtime = advancedAiTrainingRuntimeFromEnv(db, { MENDPOINT_POST_TRAINED_TRAINER_URL: "http://localhost:9999/trainer/", MENDPOINT_POST_TRAINED_TRAINER_TOKEN: "secret", MENDPOINT_POST_TRAINED_TRAINER_TIMEOUT_MS: "1000", MENDPOINT_POST_TRAINED_LEASE_MS: "5000", MENDPOINT_POST_TRAINED_WORKER_ID: "worker-1", MENDPOINT_POST_TRAINED_TRAINER_AUTHORITY_ID: "trainer-authority", MENDPOINT_POST_TRAINED_RECEIPT_HMAC_SECRET: "a".repeat(32), MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED: "1" }, transport as typeof fetch); expect(calls).toBe(0); expect(runtime.trainer).toBeDefined(); const result = await runtime.trainer!.train({ tenantId: "tenant-a", jobId: "job", adapterId: "adapter", requestDigest: "digest", leaseGeneration: 1, authorityId: "trainer-authority", baseModelId: "base", corpus: [], recipe: { epochs: 1, maximumExamples: 1, seed: 1 }, signal: new AbortController().signal }); expect(result).toEqual({ receipt, result: { status: "pending" } }); expect(calls).toBe(1); });
  it("constructs an independent evaluator only from its own complete environment", async () => {
    const { db } = fixture(); let calls = 0;
    const transport = async (_url: string | URL | Request, init?: RequestInit) => { calls++; const request = JSON.parse(String(init?.body)) as { evaluationId: string; requestDigest: string; authorityId: string }; const result = { status: "pending" as const }; return new Response(JSON.stringify({ evaluationId: request.evaluationId, requestDigest: request.requestDigest, result, receipt: { evaluationId: request.evaluationId, authorityId: request.authorityId, requestDigest: request.requestDigest, outcome: result.status, resultDigest: postTrainedEvaluationResultDigest(result), observedAt: now, signature: "0".repeat(64) } }), { status: 200 }); };
    expect(advancedAiEvaluationRuntimeFromEnv(db, {}, transport as typeof fetch)).toEqual({});
    const runtime = advancedAiEvaluationRuntimeFromEnv(db, { MENDPOINT_POST_TRAINED_EVALUATOR_URL: "http://localhost:9998/evaluator/", MENDPOINT_POST_TRAINED_EVALUATOR_TOKEN: "secret", MENDPOINT_POST_TRAINED_EVALUATOR_RECEIPT_HMAC_SECRET: "b".repeat(32), MENDPOINT_POST_TRAINED_EVALUATION_WORKER_ID: "evaluation-worker", MENDPOINT_POST_TRAINED_EVALUATOR_PRINCIPAL_ID: "evaluator", MENDPOINT_POST_TRAINED_EVALUATOR_AUTHORITY_ID: "evaluation-authority", MENDPOINT_POST_TRAINED_EVALUATION_EXTERNAL_PROCESSING_APPROVED: "1", MENDPOINT_POST_TRAINED_BASELINE_EXECUTOR_ID: "baseline", MENDPOINT_POST_TRAINED_BASELINE_REVISION: "7".repeat(40), MENDPOINT_POST_TRAINED_EVALUATION_HARNESS_VERSION: "h1", MENDPOINT_POST_TRAINED_EVALUATION_GRADER_VERSION: "g1", MENDPOINT_POST_TRAINED_MINIMUM_SUCCESS_RATE: ".9", MENDPOINT_POST_TRAINED_MAXIMUM_REGRESSION_RATE: ".02", MENDPOINT_POST_TRAINED_MAXIMUM_SECURITY_REGRESSIONS: "0", MENDPOINT_POST_TRAINED_EVALUATOR_TIMEOUT_MS: "1000", MENDPOINT_POST_TRAINED_EVALUATION_LEASE_MS: "5000" }, transport as typeof fetch);
    expect(calls).toBe(0); expect(runtime.evaluator).toBeDefined();
    const result = await runtime.evaluator!.evaluate({ evaluationId: "evaluation", requestDigest: "digest", authorityId: "evaluation-authority", candidate: { adapterId: "adapter", artifactId: "artifact", artifactDigest: DIGEST, contentBase64: "YQ==" }, baseline: { executorId: "baseline", revision: "7".repeat(40) }, trainingDatasetId: "dataset", trainingSplitManifestDigest: SPLIT_MANIFEST, training: [], holdout: { artifactId: "holdout", sha256: "a".repeat(64), content: "{}" }, evaluator: { harnessVersion: "h1", graderVersion: "g1" }, policy: { minimumSuccessRate: .9, maximumRegressionRate: .02, maximumSecurityRegressions: 0 }, signal: new AbortController().signal });
    expect(result.result).toEqual({ status: "pending" }); expect(calls).toBe(1);
  });
  it("binds consent evidence to the dataset through the durable consent authority", () => {
    const { db } = fixture();
    db.raw.prepare("INSERT OR IGNORE INTO tenants (id, slug, name, created_at) VALUES (?, ?, ?, ?)").run("tenant-a", "tenant-a", "Tenant A", now);
    db.raw.prepare("INSERT INTO learning_dataset_versions (id, tenant_id, purpose, residency_region, version, temporal_cutoff_at, status, dataset_sha256, created_by_principal_id, sealed_by_principal_id, sealed_at, idempotency_key, request_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("dataset-1", "tenant-a", "adapter_training", "local", 1, now, "sealed", "d".repeat(64), "actor", "actor", now, "dataset-idem", "e".repeat(64), now);
    db.raw.prepare("INSERT INTO learning_consents (id, tenant_id, consent_version, action, purpose, residency_region, authorized_by_principal_id, supersedes_consent_id, effective_at, expires_at, reason, idempotency_key, request_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("consent-1", "tenant-a", 1, "granted", "adapter_training", "local", "actor", null, now, null, "approved", "consent-idem", "f".repeat(64), now);
    add(db, "consent-artifact", "learning_consent_evidence");
    insertEvidenceRecord(db, { id: "consent-evidence", tenantId: "tenant-a", subjectType: "learning_consent", subjectId: "consent-1", artifactId: "consent-artifact", producerPrincipalId: "actor", tool: "consent-authority", toolVersion: "1", verdict: "passed", createdAt: now });
    const verify = createDurablePostTrainedEvidenceAuthority(db);
    expect(verify("tenant-a", ["consent-evidence"], { subjectTypes: ["learning_consent"], subjectId: "dataset-1" })).toBe(true);
    expect(verify("tenant-a", ["consent-evidence"], { subjectTypes: ["learning_consent"], subjectId: "dataset-other" })).toBe(false);
    expect(verify("tenant-a", ["consent-evidence"], { subjectTypes: ["post_trained_training_job"], subjectId: "dataset-1" })).toBe(false);
  });
  it("requires tenant administration for issuance and adapter registration", async () => { const { app } = fixture(); const headers = { "content-type": "application/json", "idempotency-key": "denied", "x-role": "viewer" }; expect((await app.request("/advanced-ai/attestations", { method: "POST", headers, body: "{}" })).status).toBe(403); expect((await app.request("/advanced-ai/post-trained/adapters", { method: "POST", headers, body: "{}" })).status).toBe(403); });
  it("issues, retrieves and cryptographically verifies authoritative attestations", async () => { const { app, db } = fixture(); ["source", "snapshot", "candidate", "verification", "policy"].forEach((id) => add(db, id)); const issued = await app.request("/advanced-ai/attestations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "attest-1" }, body: JSON.stringify({ repositoryId: "repo", runId: "run", correlationId: "corr", outcome: "passed", artifacts: { sourceIds: ["source"], snapshotId: "snapshot", candidateId: "candidate", verificationIds: ["verification"], policyId: "policy", deliveryId: null, rollbackId: null, waiverId: null } }) }); expect(issued.status).toBe(201); const value = await issued.json() as { attestationId: string }; expect((await app.request(`/advanced-ai/attestations/${value.attestationId}`)).status).toBe(200); const verified = await app.request(`/advanced-ai/attestations/${value.attestationId}/verify`, { method: "POST" }); expect(verified.status).toBe(200); expect(await verified.json()).toMatchObject({ verified: true, attestationId: value.attestationId }); expect((await app.request(`/advanced-ai/attestations/${value.attestationId}`, { headers: { "x-tenant": "tenant-b" } })).status).toBe(404); });
  it("registers only after independent holdout evaluation and canary evidence", async () => {
    const { app, db } = fixture(); addTrainingAuthority(db, "registration");
    const trainedResponse = await app.request("/advanced-ai/post-trained/training-jobs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "train-register" }, body: JSON.stringify({ jobId: "job-register", adapterId: "adapter-1", baseModelId: "base-1", datasetId: "dataset-1", purpose: "adapter_training", residencyRegion: "local", trainingCorpusArtifactIds: ["registration-corpus"], validationArtifactId: "registration-validation", holdoutArtifactId: "registration-holdout", splitManifestDigest: SPLIT_MANIFEST, recipe: { epochs: 1, maximumExamples: 10, seed: 1 } }) });
    const trained = await trainedResponse.json() as { adapterDigest: string }; expect(trainedResponse.status).toBe(201);
    const evaluationResponse = await app.request("/advanced-ai/post-trained/evaluations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "evaluate-register" }, body: JSON.stringify({ evaluationId: "evaluation-register", trainingJobId: "job-register", adapterId: "adapter-1", baseline: { executorId: "baseline-frontier", revision: "7".repeat(40) }, evaluator: { harnessVersion: "harness-v1", graderVersion: "grader-v1" }, policy: { minimumSuccessRate: .9, maximumRegressionRate: .02, maximumSecurityRegressions: 0 } }) });
    expect(evaluationResponse.status).toBe(201);
    const evaluation = await evaluationResponse.json() as { evaluationId: string; status: string; reportArtifactId: string; successRate: number; regressionRate: number };
    expect(evaluation).toMatchObject({ evaluationId: "evaluation-register", status: "passed" });
    const canaryResponse = await app.request("/advanced-ai/post-trained/canaries", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "canary-register" }, body: JSON.stringify({ canaryId: "canary-register", adapterId: "adapter-1", trainingJobId: "job-register", evaluationId: evaluation.evaluationId }) });
    const canary = await canaryResponse.json() as { status: string; observedAt: string; evidenceRefs: string[] }; expect(canaryResponse.status).toBe(201); expect(canary.status).toBe("passed");
    const registered = await app.request("/advanced-ai/post-trained/adapters", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "register-1" }, body: JSON.stringify({ adapterId: "adapter-1", trainingJobId: "job-register", lifecycle: { ...lifecycle(), artifactDigest: trained.adapterDigest, heldOutEvaluation: { reportRef: evaluation.reportArtifactId, passed: true, successRate: evaluation.successRate, regressionRate: evaluation.regressionRate }, canaryEvidence: { passed: true, observedAt: canary.observedAt, evidenceRefs: canary.evidenceRefs } }, consent: consent(), descriptor: descriptor() }) });
    expect(registered.status).toBe(201);
    expect(await (await app.request("/advanced-ai/post-trained/adapters/adapter-1")).json()).toMatchObject({ adapterId: "adapter-1", trainingJobId: "job-register", lifecycle: { state: "monitored" } });
    const eligibility = await app.request("/advanced-ai/post-trained/adapters/adapter-1/eligibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: task() }) }); expect(await eligibility.json()).toMatchObject({ eligible: true, adapterId: "adapter-1" });
    const dryRun = await app.request("/advanced-ai/post-trained/adapters/adapter-1/route-dry-run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: task(), policy: policy(), remainingBudgetUsd: 1 }) }); expect(await dryRun.json()).toMatchObject({ action: "execute", dryRun: true, authorization: { authorized: true } });
    const rollback = await app.request("/advanced-ai/post-trained/adapters/adapter-1/rollback", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "rollback-register" }, body: JSON.stringify({ expectedArtifactDigest: trained.adapterDigest, reason: "Canary regression" }) }); expect(rollback.status).toBe(200); expect(await rollback.json()).toMatchObject({ lifecycle: { state: "rolled_back" } });
    const afterRollback = await app.request("/advanced-ai/post-trained/adapters/adapter-1/eligibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: task() }) }); expect(await afterRollback.json()).toMatchObject({ eligible: false, reason: "lifecycle_not_servable" });
    expect((await app.request("/advanced-ai/post-trained/adapters/adapter-1", { headers: { "x-tenant": "tenant-b" } })).status).toBe(404);
  });
  it("joins governed Fettler and ReGauge outcomes through training, canary, routing, and rollback", async () => {
    const { app, db } = fixture();
    const grant = await app.request("/advanced-ai/learning/consents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "consent-flywheel" }, body: JSON.stringify({ id: "consent-flywheel", consentVersion: 1, purpose: "adapter_training", residencyRegion: "local", effectiveAt: "2026-08-12T10:00:00.000Z", reason: "Authorize only redacted verified migration lessons." }) });
    expect(grant.status).toBe(201);
    admitFlywheelEvent(db, { eventId: "fettler-train", product: "fettler", sourceObjectId: "fettler-run-1", migrationFamily: "response-field-replacement", splitGroupId: "repository-a:response-field-replacement" });
    admitFlywheelEvent(db, { eventId: "regauge-validation", product: "regauge", sourceObjectId: "regauge-candidate-1", migrationFamily: "family-7", splitGroupId: "repository-a:family-7" });
    admitFlywheelEvent(db, { eventId: "regauge-holdout", product: "regauge", sourceObjectId: "regauge-candidate-2", migrationFamily: "family-3", splitGroupId: "repository-a:family-3" });

    const corpusResponse = await app.request("/advanced-ai/learning/corpora", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "corpus-flywheel" }, body: JSON.stringify({ purpose: "adapter_training", temporalCutoffAt: "2026-08-12T11:30:00.000Z" }) });
    expect(corpusResponse.status).toBe(201);
    const corpus = await corpusResponse.json() as { datasetVersionId: string; artifactId: string; validationArtifactId: string; holdoutArtifactId: string; splitManifestDigest: string; trainExampleCount: number; validationExampleCount: number; holdoutExampleCount: number };
    expect(corpus).toMatchObject({ trainExampleCount: 1, validationExampleCount: 1, holdoutExampleCount: 1 });

    const trainResponse = await app.request("/advanced-ai/post-trained/training-jobs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "train-flywheel" }, body: JSON.stringify({ jobId: "job-flywheel", adapterId: "adapter-flywheel", baseModelId: "base-1", datasetId: corpus.datasetVersionId, purpose: "adapter_training", residencyRegion: "local", trainingCorpusArtifactIds: [corpus.artifactId], validationArtifactId: corpus.validationArtifactId, holdoutArtifactId: corpus.holdoutArtifactId, splitManifestDigest: corpus.splitManifestDigest, recipe: { epochs: 1, maximumExamples: 10, seed: 7 } }) });
    expect(trainResponse.status).toBe(201);
    const trained = await trainResponse.json() as { adapterDigest: string };
    const evaluationResponse = await app.request("/advanced-ai/post-trained/evaluations", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "evaluate-flywheel" }, body: JSON.stringify({ evaluationId: "evaluation-flywheel", trainingJobId: "job-flywheel", adapterId: "adapter-flywheel" }) });
    expect(evaluationResponse.status).toBe(201);
    const evaluation = await evaluationResponse.json() as { evaluationId: string; reportArtifactId: string; successRate: number; regressionRate: number };
    const canaryResponse = await app.request("/advanced-ai/post-trained/canaries", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "canary-flywheel" }, body: JSON.stringify({ canaryId: "canary-flywheel", adapterId: "adapter-flywheel", trainingJobId: "job-flywheel", evaluationId: evaluation.evaluationId }) });
    expect(canaryResponse.status).toBe(201);
    const canary = await canaryResponse.json() as { observedAt: string; evidenceRefs: string[] };

    const baseLifecycle = lifecycle();
    const registered = await app.request("/advanced-ai/post-trained/adapters", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "register-flywheel" }, body: JSON.stringify({
      adapterId: "adapter-flywheel",
      trainingJobId: "job-flywheel",
      lifecycle: { ...baseLifecycle, adapterId: "adapter-flywheel", artifactDigest: trained.adapterDigest, trainingDataset: { ...baseLifecycle.trainingDataset, datasetId: corpus.datasetVersionId }, heldOutEvaluation: { reportRef: evaluation.reportArtifactId, passed: true, successRate: evaluation.successRate, regressionRate: evaluation.regressionRate }, canaryEvidence: { passed: true, observedAt: canary.observedAt, evidenceRefs: canary.evidenceRefs } },
      consent: { ...consent(), datasetId: corpus.datasetVersionId },
      descriptor: descriptor(),
    }) });
    expect(registered.status).toBe(201);
    const eligible = await app.request("/advanced-ai/post-trained/adapters/adapter-flywheel/eligibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: task() }) });
    expect(await eligible.json()).toMatchObject({ eligible: true, adapterId: "adapter-flywheel" });
    const rolledBack = await app.request("/advanced-ai/post-trained/adapters/adapter-flywheel/rollback", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "rollback-flywheel" }, body: JSON.stringify({ expectedArtifactDigest: trained.adapterDigest, reason: "Bounded canary regression drill." }) });
    expect(rolledBack.status).toBe(200);
    const blocked = await app.request("/advanced-ai/post-trained/adapters/adapter-flywheel/eligibility", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: task() }) });
    expect(await blocked.json()).toMatchObject({ eligible: false, reason: "lifecycle_not_servable" });
  });
  it("runs a bounded local training fixture and exposes durable job status", async () => { const { app, db } = fixture(); addTrainingAuthority(db, "learning"); const response = await app.request("/advanced-ai/post-trained/training-jobs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "train-1" }, body: JSON.stringify({ jobId: "job-1", adapterId: "adapter-1", baseModelId: "base-1", datasetId: "dataset-1", purpose: "adapter_training", residencyRegion: "local", trainingCorpusArtifactIds: ["learning-corpus"], validationArtifactId: "learning-validation", holdoutArtifactId: "learning-holdout", splitManifestDigest: SPLIT_MANIFEST, recipe: { epochs: 1, maximumExamples: 10, seed: 1 } }) }); expect(response.status).toBe(201); expect(await response.json()).toMatchObject({ jobId: "job-1", status: "completed", adapterArtifactId: expect.stringMatching(/^artifact_/) }); expect(await (await app.request("/advanced-ai/post-trained/training-jobs/job-1")).json()).toMatchObject({ status: "completed" }); });
});
