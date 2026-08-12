import { describe, expect, it } from "vitest";
import {
  ExecutorCircuitBreaker,
  ExecutorRegistry,
  routeTask,
  selectPolicyBoundFallback,
  type ExecutorDescriptor,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
} from "./router.js";
import type {
  AdaptiveRoutingStats,
  RouterOutcomeAggregate,
} from "./router-adaptive.js";

const decidedAt = new Date("2026-08-01T12:00:00.000Z");

function task(overrides: Partial<RouterTaskSpec> = {}): RouterTaskSpec {
  return {
    taskId: "task-1",
    tenantId: "tenant-1",
    kind: "api-migration",
    goal: "Prepare a verified migration patch",
    idempotencyKey: "migration-1",
    inputArtifactIds: ["artifact-spec", "artifact-source"],
    requiredCapabilities: ["typescript", "verification"],
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
      fallbackFailures: ["timeout", "provider_unavailable"],
    },
    privacy: { classification: "confidential", requiredRegion: "us-east" },
    risk: "medium",
    quality: { minimumScore: 0.8 },
    latency: { maximumMs: 20_000 },
    budget: { maximumUsd: 5 },
    ...overrides,
  };
}

function policy(
  overrides: Partial<RouterPolicySnapshot> = {},
): RouterPolicySnapshot {
  return {
    snapshotId: "policy-1",
    version: 3,
    capturedAt: "2026-08-01T11:00:00.000Z",
    privacy: {
      allowedClassifications: ["public", "internal", "confidential"],
      externalProcessingAllowed: false,
    },
    region: { allowedExecutionRegions: ["us-east", "us-west"] },
    risk: {
      maximumAutonomousRisk: "medium",
      humanReviewAtOrAbove: "high",
    },
    quality: { minimumScore: 0.75 },
    latency: { maximumMs: 30_000 },
    budget: { maximumUsd: 10 },
    ...overrides,
  };
}

function executor(
  executorId: string,
  overrides: Partial<ExecutorDescriptor> = {},
): ExecutorDescriptor {
  return {
    executorId,
    providerId: `provider-${executorId}`,
    kind: "frontier_model",
    version: "2026-08-01",
    deployment: "internal",
    capabilities: ["typescript", "verification"],
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
    estimatedCostUsd: 2,
    ...overrides,
  };
}

function registry(...executors: ExecutorDescriptor[]): ExecutorRegistry {
  const result = new ExecutorRegistry();
  for (const item of executors) result.register(item);
  return result;
}

describe("Gate 7 policy router", () => {
  it("routes around a provider outage using only an eligible fallback", () => {
    const breaker = new ExecutorCircuitBreaker({
      failureThreshold: 1,
      openDurationMs: 60_000,
    });
    breaker.recordProviderFailure("provider-a", decidedAt);
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("executor-a", {
          providerId: "provider-a",
          qualityScore: 0.99,
        }),
        executor("executor-a-backup", {
          providerId: "provider-a",
          qualityScore: 0.97,
        }),
        executor("executor-b", {
          providerId: "provider-b",
          qualityScore: 0.92,
        }),
      ),
      circuitBreaker: breaker,
      remainingBudgetUsd: 5,
      decidedAt,
    });

    expect(outcome.action).toBe("execute");
    if (outcome.action !== "execute") throw new Error("expected execution");
    expect(outcome.plan.primary.executorId).toBe("executor-b");
    expect(
      outcome.decision.evaluations.find(
        (candidate) => candidate.executorId === "executor-a",
      )?.reasons,
    ).toContain("circuit_open");
    expect(
      outcome.decision.evaluations.find(
        (candidate) => candidate.executorId === "executor-a-backup",
      )?.reasons,
    ).toContain("circuit_open");
  });

  it("hands off when the policy budget is exhausted", () => {
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(executor("executor-a")),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 0,
      decidedAt,
    });

    expect(outcome.action).toBe("human_handoff");
    if (outcome.action !== "human_handoff") throw new Error("expected handoff");
    expect(outcome.handoff.reason).toBe("budget_exhausted");
    expect(outcome.handoff.requiredRole).toBe("human_reviewer");
    expect(outcome.decision.evaluations[0].reasons).toContain("budget_exceeded");
  });

  it("does not allow a fallback to bypass privacy policy", () => {
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("safe-primary", { qualityScore: 0.95 }),
        executor("external-bypass", {
          deployment: "external",
          qualityScore: 0.99,
          estimatedCostUsd: 0.1,
        }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    });

    expect(outcome.action).toBe("execute");
    if (outcome.action !== "execute") throw new Error("expected execution");
    expect(outcome.plan.primary.executorId).toBe("safe-primary");
    expect(outcome.plan.fallbacks).toHaveLength(0);
    expect(
      outcome.decision.evaluations.find(
        (candidate) => candidate.executorId === "external-bypass",
      )?.reasons,
    ).toContain("privacy_disallowed");

    const fallback = selectPolicyBoundFallback({
      plan: outcome.plan,
      failedExecutorIds: ["safe-primary"],
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      at: decidedAt,
      tenantId: "tenant-1",
    });
    expect("action" in fallback && fallback.action).toBe("human_handoff");
  });

  it("rechecks remaining budget before selecting a policy-bound fallback", () => {
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("executor-a", { qualityScore: 0.95, estimatedCostUsd: 2 }),
        executor("executor-b", { qualityScore: 0.9, estimatedCostUsd: 2 }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 3,
      decidedAt,
    });
    if (outcome.action !== "execute") throw new Error("expected execution");

    const fallback = selectPolicyBoundFallback({
      plan: outcome.plan,
      failedExecutorIds: ["executor-a"],
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 1,
      at: decidedAt,
      tenantId: "tenant-1",
    });

    expect("action" in fallback && fallback.action).toBe("human_handoff");
  });

  it("always hands high-risk work to a human even if policy is weaker", () => {
    const outcome = routeTask({
      task: task({ risk: "high" }),
      policy: policy({
        risk: {
          maximumAutonomousRisk: "critical",
          humanReviewAtOrAbove: "critical",
        },
      }),
      registry: registry(
        executor("executor-a", { maximumRisk: "critical" }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    });

    expect(outcome.action).toBe("human_handoff");
    if (outcome.action !== "human_handoff") throw new Error("expected handoff");
    expect(outcome.handoff.reason).toBe("high_risk");
  });

  it("is reproducible across registry insertion order", () => {
    const a = executor("executor-a", {
      providerId: "provider-z",
      qualityScore: 0.9,
      estimatedCostUsd: 1,
    });
    const b = executor("executor-b", {
      providerId: "provider-a",
      qualityScore: 0.9,
      estimatedCostUsd: 1,
    });
    const shared = {
      task: task(),
      policy: policy(),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    };

    const first = routeTask({ ...shared, registry: registry(b, a) });
    const second = routeTask({ ...shared, registry: registry(a, b) });

    expect(first.action).toBe("execute");
    expect(second.action).toBe("execute");
    if (first.action !== "execute" || second.action !== "execute") {
      throw new Error("expected execution");
    }
    expect(first.plan.primary.executorId).toBe("executor-a");
    expect(second.plan.primary.executorId).toBe("executor-a");
    expect(first.decision).toEqual(second.decision);
  });

  it("prefers an eligible deterministic recipe before higher scoring model executors", () => {
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("frontier", { kind: "frontier_model", qualityScore: 0.99, estimatedCostUsd: 0.5 }),
        executor("recipe", { kind: "deterministic_recipe", qualityScore: 0.81, estimatedCostUsd: 1 }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    });
    if (outcome.action !== "execute") throw new Error("expected execution");
    expect(outcome.plan.primary).toMatchObject({
      executorId: "recipe",
      executorKind: "deterministic_recipe",
      executorVersion: "2026-08-01",
      priceVersion: "price-2026-08",
    });
    expect(outcome.plan.fallbacks[0]?.executorId).toBe("frontier");
  });

  it("fails closed on tool, hard limit, health, and commercial license boundaries", () => {
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("tool-missing", { tools: ["repository.read"] }),
        executor("too-small", { limits: { maximumInputTokens: 1_000, maximumOutputTokens: 1_000, maximumConcurrentTasks: 1 } }),
        executor("unavailable", { health: { status: "unavailable", checkedAt: "2026-08-01T11:59:00.000Z", evidenceRef: "health:unavailable" } }),
        executor("unlicensed", { license: { id: "research-only", commercialUse: false, redistribution: "restricted" } }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    });
    if (outcome.action !== "human_handoff") throw new Error("expected handoff");
    const byId = new Map(outcome.decision.evaluations.map((item) => [item.executorId, item.reasons]));
    expect(byId.get("tool-missing")).toContain("tool_missing");
    expect(byId.get("too-small")).toContain("hard_limit_exceeded");
    expect(byId.get("unavailable")).toContain("executor_unhealthy");
    expect(byId.get("unlicensed")).toContain("license_disallowed");
  });

  it("hands off when every executor violates at least one constraint", () => {
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("wrong-region", { regions: ["eu-west"] }),
        executor("low-quality", { qualityScore: 0.2 }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    });

    expect(outcome.action).toBe("human_handoff");
    if (outcome.action !== "human_handoff") throw new Error("expected handoff");
    expect(outcome.handoff.reason).toBe("no_eligible_executor");
    expect(outcome.decision.selectedExecutorId).toBeNull();
  });

  it("reproduces the static ranking on a cold-start adaptive history", () => {
    const shared = {
      task: task(),
      policy: policy(),
      registry: registry(
        executor("executor-a", { qualityScore: 0.9 }),
        executor("executor-b", { qualityScore: 0.85 }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    };

    const staticOutcome = routeTask(shared);
    const coldStart = routeTask({ ...shared, adaptiveStats: [] });

    if (staticOutcome.action !== "execute" || coldStart.action !== "execute") {
      throw new Error("expected execution");
    }
    expect(coldStart.plan.primary.executorId).toBe(
      staticOutcome.plan.primary.executorId,
    );
    expect(coldStart.decision).toEqual(staticOutcome.decision);
  });

  it("prefers an out-performing model once history favors it", () => {
    function aggregate(
      executorId: string,
      samples: number,
      acceptedSamples: number,
    ): RouterOutcomeAggregate {
      return {
        executorId,
        taskKind: "api-migration",
        providerId: `provider-${executorId}`,
        samples,
        acceptedSamples,
        costSamples: 0,
        totalCostUsd: 0,
        latencySamples: 0,
        totalLatencyMs: 0,
      };
    }
    const shared = {
      task: task(),
      policy: policy(),
      registry: registry(
        executor("executor-high", { qualityScore: 0.9 }),
        executor("executor-learn", { qualityScore: 0.85 }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
    };

    const staticOutcome = routeTask(shared);
    if (staticOutcome.action !== "execute") throw new Error("expected execution");
    expect(staticOutcome.plan.primary.executorId).toBe("executor-high");

    const history: AdaptiveRoutingStats = [
      aggregate("executor-high", 8, 0),
      aggregate("executor-learn", 8, 8),
    ];
    const adaptiveOutcome = routeTask({ ...shared, adaptiveStats: history });
    if (adaptiveOutcome.action !== "execute") throw new Error("expected execution");
    expect(adaptiveOutcome.plan.primary.executorId).toBe("executor-learn");
    expect(adaptiveOutcome.plan.fallbacks[0]?.executorId).toBe("executor-high");
  });

  it("never lets adaptive history override a policy gate", () => {
    // executor-learn is below the quality gate; a perfect history cannot make it
    // eligible, and adaptive ordering only re-orders eligible candidates.
    const history: AdaptiveRoutingStats = [
      {
        executorId: "executor-learn",
        taskKind: "api-migration",
        providerId: "provider-executor-learn",
        samples: 20,
        acceptedSamples: 20,
        costSamples: 0,
        totalCostUsd: 0,
        latencySamples: 0,
        totalLatencyMs: 0,
      },
    ];
    const outcome = routeTask({
      task: task(),
      policy: policy(),
      registry: registry(
        executor("executor-high", { qualityScore: 0.9 }),
        executor("executor-learn", { qualityScore: 0.2 }),
      ),
      circuitBreaker: new ExecutorCircuitBreaker(),
      remainingBudgetUsd: 5,
      decidedAt,
      adaptiveStats: history,
    });
    if (outcome.action !== "execute") throw new Error("expected execution");
    expect(outcome.plan.primary.executorId).toBe("executor-high");
    expect(
      outcome.decision.evaluations.find(
        (candidate) => candidate.executorId === "executor-learn",
      )?.reasons,
    ).toContain("quality_below_minimum");
  });

  it("rejects malformed runtime policy values before evaluating executors", () => {
    expect(() =>
      routeTask({
        task: task({ risk: "unknown" as RouterTaskSpec["risk"] }),
        policy: policy(),
        registry: registry(executor("executor-a")),
        circuitBreaker: new ExecutorCircuitBreaker(),
        remainingBudgetUsd: 5,
        decidedAt,
      }),
    ).toThrow("Task risk is invalid");
    expect(() =>
      routeTask({
        task: task(),
        policy: policy({ region: { allowedExecutionRegions: [""] } }),
        registry: registry(executor("executor-a")),
        circuitBreaker: new ExecutorCircuitBreaker(),
        remainingBudgetUsd: 5,
        decidedAt,
      }),
    ).toThrow("policy regions are invalid");
    expect(() =>
      routeTask({
        task: task({ verification: { requiredChecks: [], requireAll: true, onFailure: "human_handoff" } }),
        policy: policy(),
        registry: registry(executor("executor-a")),
        circuitBreaker: new ExecutorCircuitBreaker(),
        remainingBudgetUsd: 5,
        decidedAt,
      }),
    ).toThrow("Task verification policy is invalid");
  });
});
