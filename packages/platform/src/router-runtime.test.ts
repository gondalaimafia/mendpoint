import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutorCircuitBreaker,
  ExecutorRegistry,
  type ExecutorDescriptor,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
} from "./router.js";
import {
  InMemoryRouterEvidenceStore,
  JsonlRouterEvidenceStore,
  PolicyRouterRuntime,
} from "./router-runtime.js";

const roots: string[] = [];
const decidedAt = new Date("2026-08-01T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function task(): RouterTaskSpec {
  return {
    taskId: "warden-task-1",
    tenantId: "tenant-1",
    kind: "warden-api-repair",
    goal: "Prepare and verify an API client repair",
    idempotencyKey: "warden-task-1-route",
    inputArtifactIds: ["artifact-failure", "artifact-source"],
    requiredCapabilities: ["warden", "typescript", "verification"],
    allowedTools: ["repository.read", "workspace.patch", "verification.run"],
    context: { estimatedInputTokens: 8_000, maximumOutputTokens: 4_000 },
    verification: {
      requiredChecks: ["tests", "security"],
      requireAll: true,
      onFailure: "human_handoff",
    },
    fallbackPolicy: {
      enabled: true,
      maxAttempts: 3,
      sameExecutorRetries: 1,
      retryableFailures: ["timeout", "rate_limited", "provider_unavailable"],
      fallbackFailures: ["timeout", "provider_unavailable", "verification_failed"],
    },
    privacy: { classification: "confidential", requiredRegion: "us-east" },
    risk: "medium",
    quality: { minimumScore: 0.8 },
    latency: { maximumMs: 20_000 },
    budget: { maximumUsd: 5 },
  };
}

function policy(): RouterPolicySnapshot {
  return {
    snapshotId: "tenant-1-policy-7",
    version: 7,
    capturedAt: "2026-08-01T11:00:00.000Z",
    privacy: {
      allowedClassifications: ["public", "internal", "confidential"],
      externalProcessingAllowed: false,
    },
    region: { allowedExecutionRegions: ["us-east"] },
    risk: {
      maximumAutonomousRisk: "medium",
      humanReviewAtOrAbove: "high",
    },
    quality: { minimumScore: 0.75 },
    latency: { maximumMs: 30_000 },
    budget: { maximumUsd: 6 },
  };
}

function executor(
  executorId: string,
  overrides: Partial<ExecutorDescriptor> = {},
): ExecutorDescriptor {
  return {
    executorId,
    providerId: `provider-${executorId}`,
    kind: executorId.includes("recipe") ? "deterministic_recipe" : "frontier_model",
    version: "2026-08-01",
    deployment: "internal",
    capabilities: ["warden", "typescript", "verification"],
    tools: ["repository.read", "workspace.patch", "verification.run"],
    regions: ["us-east"],
    price: { version: "price-2026-08", currency: "USD", effectiveAt: "2026-08-01T00:00:00.000Z" },
    limits: { maximumInputTokens: 128_000, maximumOutputTokens: 16_000, maximumConcurrentTasks: 10 },
    health: { status: "healthy", checkedAt: "2026-08-01T11:59:00.000Z", evidenceRef: `health:${executorId}` },
    license: { id: "commercial-service", commercialUse: true, redistribution: "not_applicable" },
    maximumDataClassification: "restricted",
    maximumRisk: "medium",
    qualityScore: 0.9,
    estimatedLatencyMs: 5_000,
    estimatedCostUsd: 1,
    ...overrides,
  };
}

function registry(...items: ExecutorDescriptor[]): ExecutorRegistry {
  const result = new ExecutorRegistry();
  for (const item of items) result.register(item);
  return result;
}

function prepare(
  runtime: PolicyRouterRuntime,
  executors?: ExecutorRegistry,
  routedTask: RouterTaskSpec = task(),
) {
  return runtime.prepare({
    task: routedTask,
    policy: policy(),
    registry:
      executors ??
      registry(
        executor("warden-recipe", { qualityScore: 0.95 }),
        executor("approved-model", { qualityScore: 0.9 }),
        executor("external-unapproved", {
          deployment: "external",
          qualityScore: 1,
          estimatedCostUsd: 0.1,
        }),
      ),
    remainingBudgetUsd: 5,
    decidedAt,
    retryPolicy: {
      maxAttempts: 3,
      sameExecutorRetries: 1,
      fallbackEnabled: true,
      retryableErrorCodes: ["timeout", "provider_unavailable"],
    },
  });
}

describe("policy router runtime evidence", () => {
  it("persists a policy-bound decision with explicit constraints and replay", () => {
    const runtime = new PolicyRouterRuntime(
      new InMemoryRouterEvidenceStore(),
      new ExecutorCircuitBreaker(),
    );
    const result = prepare(runtime);

    expect(result.action).toBe("execute");
    expect(result.selectedExecutorId).toBe("warden-recipe");
    expect(result.evidence.prepared.constraints).toMatchObject({
      classification: "confidential",
      externalProcessingAllowed: false,
      requiredRegion: "us-east",
      maximumBudgetUsd: 5,
      maximumLatencyMs: 20_000,
      minimumQualityScore: 0.8,
    });
    expect(result.evidence.prepared.excludedExecutors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executorId: "external-unapproved",
          reasons: expect.arrayContaining(["privacy_disallowed"]),
        }),
      ]),
    );
    expect(result.evidence.prepared.rationale).toContain(
      "Eligible executors are ordered by deterministic class, health, quality, cost, latency, then stable executor identity",
    );
    expect(runtime.replay(result.envelopeId)).toMatchObject({ matches: true });
  });

  it("records retry, fallback, actual cost, verification, and final outcome", () => {
    const runtime = new PolicyRouterRuntime(
      new InMemoryRouterEvidenceStore(),
      new ExecutorCircuitBreaker(),
    );
    const prepared = prepare(runtime);
    const retry = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-1",
      executorId: "warden-recipe",
      providerId: "provider-warden-recipe",
      outcome: "failed",
      startedAt: "2026-08-01T12:00:01.000Z",
      completedAt: "2026-08-01T12:00:03.000Z",
      actualLatencyMs: 2_000,
      actualCostUsd: 0.4,
      errorCode: "timeout",
      verification: {
        verdict: "failed",
        evidenceArtifactIds: ["verify-attempt-1"],
        verifierId: "warden-verifier",
        verifierVersion: "1",
      },
    });
    expect(retry.action).toBe("retry");
    expect(retry.dispatch).toMatchObject({
      executorId: "warden-recipe",
      attempt: 2,
      kind: "retry",
      notBefore: "2026-08-01T12:00:04.000Z",
    });

    const fallback = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-2",
      executorId: "warden-recipe",
      providerId: "provider-warden-recipe",
      outcome: "failed",
      startedAt: "2026-08-01T12:00:04.000Z",
      completedAt: "2026-08-01T12:00:06.000Z",
      actualLatencyMs: 2_000,
      actualCostUsd: 0.5,
      errorCode: "provider_unavailable",
      verification: {
        verdict: "failed",
        evidenceArtifactIds: ["verify-attempt-2"],
        verifierId: "warden-verifier",
      },
    });
    expect(fallback.action).toBe("fallback");
    expect(fallback.dispatch).toMatchObject({
      executorId: "approved-model",
      attempt: 3,
      kind: "fallback",
      fallbackFromExecutorId: "warden-recipe",
    });

    const complete = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-3",
      executorId: "approved-model",
      providerId: "provider-approved-model",
      outcome: "succeeded",
      startedAt: "2026-08-01T12:00:07.000Z",
      completedAt: "2026-08-01T12:00:09.000Z",
      actualLatencyMs: 2_000,
      actualCostUsd: 0.6,
      actualQualityScore: 0.93,
      verification: {
        verdict: "passed",
        evidenceArtifactIds: ["verify-attempt-3"],
        verifierId: "warden-verifier",
      },
    });
    expect(complete.action).toBe("completed");
    expect(complete.evidence.finalOutcome).toMatchObject({
      outcome: "succeeded",
      totalActualCostUsd: 1.5,
      attempts: 3,
    });
    expect(complete.evidence.attempts.map((item) => item.verification.verdict)).toEqual([
      "failed",
      "failed",
      "passed",
    ]);
    const duplicate = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-3",
      executorId: "approved-model",
      providerId: "provider-approved-model",
      outcome: "succeeded",
      startedAt: "2026-08-01T12:00:07.000Z",
      completedAt: "2026-08-01T12:00:09.000Z",
      actualLatencyMs: 2_000,
      actualCostUsd: 0.6,
      actualQualityScore: 0.93,
      verification: {
        verdict: "passed",
        evidenceArtifactIds: ["verify-attempt-3"],
        verifierId: "warden-verifier",
      },
    });
    expect(duplicate.action).toBe("completed");
  });

  it("fails closed when actual cost is unavailable before another attempt", () => {
    const runtime = new PolicyRouterRuntime(
      new InMemoryRouterEvidenceStore(),
      new ExecutorCircuitBreaker(),
    );
    const prepared = prepare(runtime);
    const result = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-unknown-cost",
      executorId: "warden-recipe",
      providerId: "provider-warden-recipe",
      outcome: "failed",
      startedAt: "2026-08-01T12:00:01.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      actualLatencyMs: 1_000,
      actualCostUsd: null,
      errorCode: "timeout",
      verification: {
        verdict: "failed",
        evidenceArtifactIds: [],
        verifierId: "warden-verifier",
      },
    });

    expect(result.action).toBe("human_handoff");
    expect(result.reason).toBe("actual_cost_unavailable");
    expect(result.evidence.finalOutcome?.totalActualCostUsd).toBeNull();
  });

  it("does not send a non retryable failure to another executor", () => {
    const runtime = new PolicyRouterRuntime(
      new InMemoryRouterEvidenceStore(),
      new ExecutorCircuitBreaker(),
    );
    const prepared = prepare(runtime);
    const result = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-invalid-request",
      executorId: "warden-recipe",
      providerId: "provider-warden-recipe",
      outcome: "failed",
      startedAt: "2026-08-01T12:00:01.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      actualLatencyMs: 1_000,
      actualCostUsd: 0.1,
      errorCode: "invalid_request",
      verification: {
        verdict: "failed",
        evidenceArtifactIds: [],
        verifierId: "warden-verifier",
      },
    });

    expect(result.action).toBe("human_handoff");
    expect(result.reason).toBe("no_policy_compliant_retry");
    expect(result.evidence.dispatches).toHaveLength(1);
  });

  it("escalates an explicit verification failure without retrying the same executor", () => {
    const runtime = new PolicyRouterRuntime(
      new InMemoryRouterEvidenceStore(),
      new ExecutorCircuitBreaker(),
    );
    const prepared = prepare(runtime);
    const result = runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: "attempt-verification-failed",
      executorId: "warden-recipe",
      providerId: "provider-warden-recipe",
      outcome: "failed",
      startedAt: "2026-08-01T12:00:01.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      actualLatencyMs: 1_000,
      actualCostUsd: 0.1,
      errorCode: "verification_failed",
      verification: {
        verdict: "failed",
        evidenceArtifactIds: ["verification:failed"],
        verifierId: "warden-verifier",
      },
    });

    expect(result).toMatchObject({ action: "human_handoff", reason: "verification_failed" });
    expect(result.evidence.dispatches).toHaveLength(1);
    expect(result.evidence.attempts[0]?.errorCode).toBe("verification_failed");
  });

  it("survives process-local reconstruction from JSONL and detects tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-router-runtime-"));
    roots.push(root);
    const path = join(root, "routing-evidence.jsonl");
    const breaker = new ExecutorCircuitBreaker();
    const first = new PolicyRouterRuntime(new JsonlRouterEvidenceStore(path), breaker);
    const prepared = prepare(first);
    const second = new PolicyRouterRuntime(new JsonlRouterEvidenceStore(path), breaker);

    expect(second.getEvidence(prepared.envelopeId).prepared.decision.decisionId).toBe(
      prepared.evidence.prepared.decision.decisionId,
    );
    expect(second.replay(prepared.envelopeId).matches).toBe(true);

    appendFileSync(path, "{not-json}\n", "utf8");
    expect(() => second.getEvidence(prepared.envelopeId)).toThrow(
      "Router evidence JSON is invalid",
    );
  });

  it("persists only a digest for a confidential task goal", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-router-private-goal-"));
    roots.push(root);
    const path = join(root, "routing-evidence.jsonl");
    const breaker = new ExecutorCircuitBreaker();
    const runtime = new PolicyRouterRuntime(
      new JsonlRouterEvidenceStore(path),
      breaker,
    );
    const secretGoal =
      "Repair the confidential client using sk_live_example_secret_value";
    const prepared = prepare(runtime, undefined, { ...task(), goal: secretGoal });
    const persisted = readFileSync(path, "utf8");

    expect(persisted).not.toContain(secretGoal);
    expect(persisted).not.toContain("sk_live_example_secret_value");
    expect(persisted).toMatch(/"goalDigest":"[a-f0-9]{64}"/);
    expect(runtime.replay(prepared.envelopeId).matches).toBe(true);
  });

  it("rejects noncanonical policy timestamps", () => {
    const runtime = new PolicyRouterRuntime(
      new InMemoryRouterEvidenceStore(),
      new ExecutorCircuitBreaker(),
    );

    expect(() =>
      runtime.prepare({
        task: task(),
        policy: {
          ...policy(),
          capturedAt: "2026-08-01T06:00:00-05:00",
        },
        registry: registry(executor("warden-recipe")),
        remainingBudgetUsd: 5,
        decidedAt,
      }),
    ).toThrow("Router policy capture time is invalid");
  });
});
