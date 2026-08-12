import { describe, expect, it } from "vitest";
import {
  ExecutorCircuitBreaker,
  ExecutorRegistry,
  PostTrainedAdmissionError,
  resolvePostTrainedExecutor,
  routeTask,
  type AdapterLifecycleRecord,
  type ExecutorDescriptor,
  type PostTrainedConsentSnapshot,
  type PostTrainedAdmissionErrorCode,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
} from "./index.js";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;
const ROLLBACK_DIGEST = `sha256:${"b".repeat(64)}`;

function lifecycle(overrides: Partial<AdapterLifecycleRecord> = {}): AdapterLifecycleRecord {
  return {
    tenantId: "tenant-1",
    adapterId: "adapter-1",
    state: "monitored",
    revision: 7,
    baseModel: { modelId: "base-model-1", license: "commercial", evidenceRef: "evidence://base-model" },
    artifactDigest: DIGEST,
    trainingDataset: {
      datasetId: "dataset-1",
      lineageRefs: ["lineage://dataset-1"],
      consent: { status: "granted", evidenceRefs: ["consent://training"] },
      sufficiency: { representative: true, sampleCount: 1_000, minimumSampleCount: 500, evidenceRefs: ["eval://dataset"] },
    },
    heldOutEvaluation: { reportRef: "eval://held-out", passed: true, successRate: 0.96, regressionRate: 0.01 },
    promotionThresholds: { minimumSuccessRate: 0.9, maximumRegressionRate: 0.02 },
    approvedInfrastructure: { approved: true, marker: "gpu-pool-a", evidenceRef: "infra://approval" },
    servingRevision: "serving-r7",
    monitoringWindow: { startsAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z" },
    rollbackTarget: { servingRevision: "serving-r6", artifactDigest: ROLLBACK_DIGEST },
    approver: { principalId: "reviewer-1", approvedAt: "2026-08-01T00:00:00.000Z", evidenceRef: "approval://human" },
    canaryEvidence: { passed: true, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://passed"] },
    evidenceRefs: ["lifecycle://revision-7"],
    history: [{ revision: 7, from: "promoted", to: "monitored", actorId: "operator-1", occurredAt: "2026-08-02T00:00:00.000Z", evidenceRefs: ["monitor://healthy"] }],
    ...overrides,
  };
}

function consent(overrides: Partial<PostTrainedConsentSnapshot> = {}): PostTrainedConsentSnapshot {
  return {
    tenantId: "tenant-1",
    datasetId: "dataset-1",
    revision: 3,
    status: "active",
    evidenceRefs: ["consent://runtime-3"],
    checkedAt: "2026-08-12T11:59:00.000Z",
    ...overrides,
  };
}

function task(overrides: Partial<RouterTaskSpec> = {}): RouterTaskSpec {
  return {
    taskId: "task-1",
    tenantId: "tenant-1",
    kind: "migration",
    goal: "Repair the migration",
    idempotencyKey: "idem-1",
    inputArtifactIds: ["artifact-1"],
    requiredCapabilities: ["code-repair"],
    allowedTools: ["repository-read"],
    context: { estimatedInputTokens: 2_000, maximumOutputTokens: 1_000 },
    verification: { requiredChecks: ["tests"], requireAll: true, onFailure: "human_handoff" },
    fallbackPolicy: { enabled: true, maxAttempts: 2, sameExecutorRetries: 0, retryableFailures: ["timeout"], fallbackFailures: ["verification_failed"] },
    privacy: { classification: "internal", requiredRegion: "us-east" },
    risk: "medium",
    quality: { minimumScore: 0.8 },
    latency: { maximumMs: 20_000 },
    budget: { maximumUsd: 1 },
    ...overrides,
  };
}

function descriptor(overrides: Partial<ExecutorDescriptor> = {}): ExecutorDescriptor {
  return {
    executorId: "adapter-executor-1",
    providerId: "internal-post-trained",
    kind: "adapter",
    version: "serving-r7",
    deployment: "internal",
    capabilities: ["code-repair"],
    tools: ["repository-read"],
    regions: ["us-east"],
    price: { version: "price-1", currency: "USD", effectiveAt: "2026-08-01T00:00:00.000Z" },
    limits: { maximumInputTokens: 4_000, maximumOutputTokens: 2_000, maximumConcurrentTasks: 2 },
    health: { status: "healthy", checkedAt: "2026-08-12T11:58:00.000Z", evidenceRef: "health://adapter-1" },
    license: { id: "commercial", commercialUse: true, redistribution: "restricted" },
    maximumDataClassification: "internal",
    maximumRisk: "medium",
    qualityScore: 0.95,
    estimatedLatencyMs: 2_000,
    estimatedCostUsd: 0.2,
    ...overrides,
  };
}

function request(state = { lifecycle: lifecycle(), consent: consent() }) {
  return {
    enabled: true,
    now: NOW,
    allowedTenantIds: ["tenant-1"],
    allowedAdapterIds: ["adapter-1"],
    adapterId: "adapter-1",
    expected: {
      lifecycleRevision: 7,
      artifactDigest: DIGEST,
      servingRevision: "serving-r7",
      baseModelId: "base-model-1",
      datasetId: "dataset-1",
      consentRevision: 3,
    },
    task: task(),
    descriptor: descriptor(),
    source: {
      readLifecycle: () => state.lifecycle,
      readConsent: () => state.consent,
    },
    clock: () => NOW,
  } as const;
}

function expectDenied(run: () => unknown, code: PostTrainedAdmissionErrorCode): void {
  expect(run).toThrowError(expect.objectContaining<Partial<PostTrainedAdmissionError>>({ code }));
}

describe("post-trained runtime admission", () => {
  it("is default off and requires both tenant and adapter allowlists", () => {
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), enabled: undefined }), "post_trained_disabled");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), allowedTenantIds: [] }), "tenant_not_allowed");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), allowedAdapterIds: [] }), "adapter_not_allowed");
  });

  it("resolves only an exactly bound promoted or monitored adapter", () => {
    const admitted = resolvePostTrainedExecutor(request());

    expect(admitted.executor).toMatchObject({ kind: "adapter", version: "serving-r7" });
    expect(admitted.bindings).toEqual({
      tenantId: "tenant-1",
      adapterId: "adapter-1",
      lifecycleRevision: 7,
      artifactDigest: DIGEST,
      servingRevision: "serving-r7",
      baseModelId: "base-model-1",
      datasetId: "dataset-1",
      consentRevision: 3,
    });
    expect(() => (admitted.executor.capabilities as string[]).push("mutate")).toThrow();

    for (const [field, value] of [
      ["lifecycleRevision", 8],
      ["artifactDigest", ROLLBACK_DIGEST],
      ["servingRevision", "serving-r8"],
      ["baseModelId", "base-model-2"],
      ["datasetId", "dataset-2"],
      ["consentRevision", 4],
    ] as const) {
      expectDenied(() => resolvePostTrainedExecutor({ ...request(), expected: { ...request().expected, [field]: value } }), "binding_mismatch");
    }
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ state: "canary" }), consent: consent() })), "lifecycle_not_servable");
  });

  it("requires active consent and complete passing promotion evidence", () => {
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle(), consent: consent({ status: "revoked" }) })), "consent_inactive");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ heldOutEvaluation: { reportRef: "eval://failed", passed: false, successRate: 0.96, regressionRate: 0.01 } }), consent: consent() })), "evaluation_failed");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ canaryEvidence: { passed: false, observedAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["canary://failed"] } }), consent: consent() })), "canary_failed");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ approvedInfrastructure: { approved: false, marker: "none", evidenceRef: "infra://denied" } }), consent: consent() })), "infrastructure_unapproved");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ rollbackTarget: undefined }), consent: consent() })), "rollback_missing");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ evidenceRefs: [] }), consent: consent() })), "evidence_missing");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ history: [{ revision: 6, from: "canary", to: "promoted", actorId: "operator-1", occurredAt: "2026-08-01T00:00:00.000Z", evidenceRefs: ["promotion://6"] }] }), consent: consent() })), "binding_mismatch");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle({ canaryEvidence: { passed: true, observedAt: "2026-08-13T00:00:00.000Z", evidenceRefs: ["canary://future"] } }), consent: consent() })), "canary_failed");
    expectDenied(() => resolvePostTrainedExecutor(request({ lifecycle: lifecycle(), consent: consent({ expiresAt: "not-a-date" }) })), "consent_stale");
  });

  it("requires healthy evidence and task eligibility before admission", () => {
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), descriptor: descriptor({ health: { status: "degraded", checkedAt: NOW.toISOString(), evidenceRef: "health://degraded" } }) }), "executor_unhealthy");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), descriptor: descriptor({ health: { status: "healthy", checkedAt: NOW.toISOString(), evidenceRef: "" } }) }), "health_evidence_missing");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), descriptor: descriptor({ kind: "frontier_model" }) }), "executor_not_adapter");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), task: task({ requiredCapabilities: ["missing"] }) }), "task_not_eligible");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), descriptor: descriptor({ version: "serving-r6" }) }), "binding_mismatch");
    expectDenied(() => resolvePostTrainedExecutor({ ...request(), descriptor: descriptor({ providerId: "" }) }), "task_not_eligible");
  });

  it("re-reads lifecycle and consent at pre-dispatch and binds the original task and route", () => {
    const state = { lifecycle: lifecycle(), consent: consent() };
    const admitted = resolvePostTrainedExecutor(request(state));
    const dispatch = { task: task(), executorId: admitted.executor.executorId, executorKind: "adapter" as const, executorVersion: admitted.executor.version };

    expect(admitted.preDispatchGuard.authorize(dispatch)).toMatchObject({ authorized: true, lifecycleRevision: 7, consentRevision: 3 });
    state.consent = consent({ revision: 4, status: "revoked" });
    expectDenied(() => admitted.preDispatchGuard.authorize(dispatch), "consent_inactive");
    state.consent = consent();
    state.lifecycle = lifecycle({ revision: 8 });
    expectDenied(() => admitted.preDispatchGuard.authorize(dispatch), "binding_mismatch");
    state.lifecycle = lifecycle();
    expectDenied(() => admitted.preDispatchGuard.authorize({ ...dispatch, task: task({ taskId: "task-2" }) }), "task_mismatch");
    expectDenied(() => admitted.preDispatchGuard.authorize({ ...dispatch, executorId: "other" }), "dispatch_mismatch");

    const mutableRequest = request(state) as unknown as { expected: { lifecycleRevision: number } } & ReturnType<typeof request>;
    const mutationSafeAdmission = resolvePostTrainedExecutor(mutableRequest);
    (mutableRequest.expected as { lifecycleRevision: number }).lifecycleRevision = 8;
    state.lifecycle = lifecycle({ revision: 8, history: [{ revision: 8, from: "promoted", to: "monitored", actorId: "operator-1", occurredAt: "2026-08-03T00:00:00.000Z", evidenceRefs: ["monitor://8"] }] });
    expectDenied(() => mutationSafeAdmission.preDispatchGuard.authorize(dispatch), "binding_mismatch");
  });

  it("does not outrank deterministic recipes in the existing router", () => {
    const registry = new ExecutorRegistry();
    registry.register(resolvePostTrainedExecutor(request()).executor);
    registry.register(descriptor({ executorId: "recipe-1", providerId: "recipes", kind: "deterministic_recipe", version: "recipe-v1" }));
    const policy: RouterPolicySnapshot = {
      snapshotId: "policy-1",
      version: 1,
      capturedAt: NOW.toISOString(),
      privacy: { allowedClassifications: ["internal"], externalProcessingAllowed: false },
      region: { allowedExecutionRegions: ["us-east"] },
      risk: { maximumAutonomousRisk: "medium", humanReviewAtOrAbove: "high" },
      quality: { minimumScore: 0.8 },
      latency: { maximumMs: 20_000 },
      budget: { maximumUsd: 1 },
    };

    const routed = routeTask({ task: task(), policy, registry, circuitBreaker: new ExecutorCircuitBreaker(), remainingBudgetUsd: 1, decidedAt: NOW });

    expect(routed.action).toBe("execute");
    if (routed.action === "execute") expect(routed.plan.primary.executorKind).toBe("deterministic_recipe");
  });
});
