import { createHash } from "node:crypto";
import type { ImpactCoverage } from "@mendpoint/shared";
import {
  adaptiveAggregateKey,
  effectiveRoutingMetrics,
  indexAdaptiveStats,
  type AdaptiveRoutingStats,
} from "./router-adaptive.js";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type TaskRisk = "low" | "medium" | "high" | "critical";

export const ROUTER_FAILURE_CODES = Object.freeze([
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "executor_unavailable",
  "tool_denied",
  "invalid_request",
  "invalid_output",
  "verification_failed",
  "security_violation",
  "budget_exhausted",
  "cancelled",
] as const);

export type RouterFailureCode = (typeof ROUTER_FAILURE_CODES)[number];
export type ExecutorKind =
  | "deterministic_recipe"
  | "adapter"
  | "local_model"
  | "open_model"
  | "frontier_model";

/**
 * Product discriminator (§13.2). The orchestrator that owns the mission —
 * `warden` (repair) or `transformer` (recipe migration). Optional on the
 * TaskSpec; no production caller supplies it yet.
 */
export const ROUTER_PRODUCTS = Object.freeze([
  "warden",
  "transformer",
] as const);
export type RouterProduct = (typeof ROUTER_PRODUCTS)[number];

/**
 * Change blast radius (§12.3, §13.2). A structured measure of how far a change
 * reaches, used as a risk input. Not available at either production routing call
 * site today (impact analysis runs after routing), so this is optional.
 */
export type RouterBlastRadius = Readonly<{
  impactedFiles: number;
  impactedSurfaces: number;
  repositoryCount: number;
}>;

export type RouterTaskSpec = Readonly<{
  taskId: string;
  tenantId: string;
  kind: string;
  goal: string;
  idempotencyKey: string;
  inputArtifactIds: readonly string[];
  requiredCapabilities: readonly string[];
  /**
   * Tools every candidate executor must provide for this task. The gate excludes
   * any executor missing one.
   *
   * Three-valued on purpose (§13.2): `undefined` is the honest "no
   * tool-eligibility claim declared" state — distinct from `[]`, which is a
   * declaration that the task requires no tools and passes trivially. An
   * undeclared requirement is unverifiable, so `evaluateExecutor` refuses it
   * (`tool_requirement_undeclared`) rather than reading the empty `.some()` as a
   * pass; every production caller declares its real tool needs. Making the empty
   * array stand in for "unspecified" is exactly the fail-open this field closes.
   */
  allowedTools?: readonly string[];
  context: Readonly<{
    estimatedInputTokens: number;
    maximumOutputTokens: number;
  }>;
  verification: Readonly<{
    requiredChecks: readonly string[];
    requireAll: true;
    onFailure: "human_handoff" | "eligible_fallback";
  }>;
  fallbackPolicy: Readonly<{
    enabled: boolean;
    maxAttempts: number;
    sameExecutorRetries: number;
    retryableFailures: readonly RouterFailureCode[];
    fallbackFailures: readonly RouterFailureCode[];
  }>;
  privacy: Readonly<{
    classification: DataClassification;
    requiredRegion?: string;
  }>;
  risk: TaskRisk;
  quality: Readonly<{ minimumScore: number }>;
  latency: Readonly<{ maximumMs: number }>;
  budget: Readonly<{ maximumUsd: number }>;
  /**
   * Product discriminator (§13.2). Optional; no production caller supplies it
   * yet. When present it becomes part of the deterministic decision fingerprint.
   */
  product?: RouterProduct;
  /**
   * Change blast radius (§12.3, §13.2). Optional; not available pre-routing
   * today. When present it becomes part of the deterministic decision
   * fingerprint.
   */
  blastRadius?: RouterBlastRadius;
  /**
   * Graph/impact coverage (§11.7, §12.4, §13.2). Optional: the router runs
   * before impact analysis exists today, so no production caller supplies it
   * yet. When present and incomplete on high-risk work it drives
   * `graph_coverage_incomplete` escalation (§13.7). When present it becomes part
   * of the deterministic decision fingerprint.
   */
  coverage?: ImpactCoverage;
}>;

export type RouterPolicySnapshot = Readonly<{
  snapshotId: string;
  version: number;
  capturedAt: string;
  privacy: Readonly<{
    allowedClassifications: readonly DataClassification[];
    externalProcessingAllowed: boolean;
  }>;
  region: Readonly<{ allowedExecutionRegions: readonly string[] }>;
  risk: Readonly<{
    maximumAutonomousRisk: TaskRisk;
    humanReviewAtOrAbove: TaskRisk;
  }>;
  quality: Readonly<{ minimumScore: number }>;
  latency: Readonly<{ maximumMs: number }>;
  budget: Readonly<{ maximumUsd: number }>;
}>;

export type ExecutorDescriptor = Readonly<{
  executorId: string;
  providerId: string;
  kind: ExecutorKind;
  version: string;
  deployment: "internal" | "external";
  capabilities: readonly string[];
  tools: readonly string[];
  regions: readonly string[];
  price: Readonly<{
    version: string;
    currency: string;
    effectiveAt: string;
  }>;
  limits: Readonly<{
    maximumInputTokens: number;
    maximumOutputTokens: number;
    maximumConcurrentTasks: number;
  }>;
  health: Readonly<{
    status: "healthy" | "degraded" | "unavailable";
    checkedAt: string;
    evidenceRef: string;
  }>;
  license: Readonly<{
    id: string;
    commercialUse: boolean;
    redistribution: "allowed" | "restricted" | "not_applicable";
  }>;
  maximumDataClassification: DataClassification;
  maximumRisk: TaskRisk;
  qualityScore: number;
  estimatedLatencyMs: number;
  estimatedCostUsd: number;
}>;

export const ROUTER_REGISTRY_SCHEMA_VERSION = 1 as const;

export type ExecutorRegistryContract = Readonly<{
  schemaVersion: typeof ROUTER_REGISTRY_SCHEMA_VERSION;
  registryId: string;
  version: number;
}>;

export type ExecutorRegistryBinding = ExecutorRegistryContract &
  Readonly<{ fingerprint: string }>;

const DEFAULT_EXECUTOR_REGISTRY_CONTRACT: ExecutorRegistryContract =
  Object.freeze({
    schemaVersion: ROUTER_REGISTRY_SCHEMA_VERSION,
    registryId: "default-executor-registry",
    version: 1,
  });

export class ExecutorRegistry {
  readonly #executors = new Map<string, ExecutorDescriptor>();
  readonly #contract: ExecutorRegistryContract;

  constructor(
    contract: ExecutorRegistryContract = DEFAULT_EXECUTOR_REGISTRY_CONTRACT,
  ) {
    validateRegistryContract(contract);
    this.#contract = Object.freeze({ ...contract });
  }

  register(descriptor: ExecutorDescriptor): void {
    validateExecutor(descriptor);
    if (this.#executors.has(descriptor.executorId)) {
      throw new Error("Executor already registered");
    }
    this.#executors.set(descriptor.executorId, freezeExecutor(descriptor));
  }

  unregister(executorId: string): boolean {
    return this.#executors.delete(executorId);
  }

  get(executorId: string): ExecutorDescriptor | undefined {
    return this.#executors.get(executorId);
  }

  list(): readonly ExecutorDescriptor[] {
    return Object.freeze(
      [...this.#executors.values()].sort((a, b) =>
        compareText(a.executorId, b.executorId),
      ),
    );
  }

  binding(): ExecutorRegistryBinding {
    return Object.freeze({
      ...this.#contract,
      fingerprint: fingerprint({
        ...this.#contract,
        executors: this.list(),
      }),
    });
  }
}

export type CircuitBreakerConfig = Readonly<{
  failureThreshold: number;
  openDurationMs: number;
}>;

export type CircuitBreakerState = Readonly<{
  state: "closed" | "open" | "half_open";
  consecutiveFailures: number;
  openedAt?: string;
  retryAt?: string;
}>;

type MutableCircuit = {
  consecutiveFailures: number;
  openedAtMs?: number;
};

export class ExecutorCircuitBreaker {
  readonly #config: CircuitBreakerConfig;
  readonly #states = new Map<string, MutableCircuit>();

  constructor(
    config: CircuitBreakerConfig = {
      failureThreshold: 3,
      openDurationMs: 30_000,
    },
  ) {
    if (
      !Number.isInteger(config.failureThreshold) ||
      config.failureThreshold < 1 ||
      !Number.isFinite(config.openDurationMs) ||
      config.openDurationMs <= 0
    ) {
      throw new Error("Invalid circuit breaker configuration");
    }
    this.#config = Object.freeze({ ...config });
  }

  recordFailure(executorId: string, at: Date): CircuitBreakerState {
    return this.#recordFailure(`executor:${executorId}`, at);
  }

  recordProviderFailure(providerId: string, at: Date): CircuitBreakerState {
    return this.#recordFailure(`provider:${providerId}`, at);
  }

  recordSuccess(executorId: string): CircuitBreakerState {
    return this.#recordSuccess(`executor:${executorId}`);
  }

  recordProviderSuccess(providerId: string): CircuitBreakerState {
    return this.#recordSuccess(`provider:${providerId}`);
  }

  state(executorId: string, at: Date): CircuitBreakerState {
    return this.#state(`executor:${executorId}`, at);
  }

  providerState(providerId: string, at: Date): CircuitBreakerState {
    return this.#state(`provider:${providerId}`, at);
  }

  allows(executorId: string, providerId: string, at: Date): boolean {
    return (
      this.state(executorId, at).state !== "open" &&
      this.providerState(providerId, at).state !== "open"
    );
  }

  #recordFailure(key: string, at: Date): CircuitBreakerState {
    const atMs = validTime(at);
    const current = this.#states.get(key) ?? { consecutiveFailures: 0 };
    const state = this.#state(key, at);
    const consecutiveFailures =
      state.state === "half_open"
        ? this.#config.failureThreshold
        : current.consecutiveFailures + 1;
    const openedAtMs =
      consecutiveFailures >= this.#config.failureThreshold
        ? atMs
        : current.openedAtMs;
    this.#states.set(key, { consecutiveFailures, openedAtMs });
    return this.#state(key, at);
  }

  #recordSuccess(key: string): CircuitBreakerState {
    this.#states.delete(key);
    return Object.freeze({ state: "closed", consecutiveFailures: 0 });
  }

  #state(key: string, at: Date): CircuitBreakerState {
    const atMs = validTime(at);
    const current = this.#states.get(key);
    if (current?.openedAtMs === undefined) {
      return Object.freeze({
        state: "closed",
        consecutiveFailures: current?.consecutiveFailures ?? 0,
      });
    }
    const retryAtMs = current.openedAtMs + this.#config.openDurationMs;
    return Object.freeze({
      state: atMs >= retryAtMs ? "half_open" : "open",
      consecutiveFailures: current.consecutiveFailures,
      openedAt: new Date(current.openedAtMs).toISOString(),
      retryAt: new Date(retryAtMs).toISOString(),
    });
  }
}

/** Runtime availability boundary used by the policy router and deterministic replay. */
export type ExecutorAvailability = Readonly<{
  allows(executorId: string, providerId: string, at: Date): boolean;
}>;

export type RoutingExclusionReason =
  | "capability_missing"
  | "tool_missing"
  | "tool_requirement_undeclared"
  | "hard_limit_exceeded"
  | "executor_unhealthy"
  | "license_disallowed"
  | "privacy_disallowed"
  | "region_disallowed"
  | "risk_disallowed"
  | "quality_below_minimum"
  | "latency_exceeded"
  | "budget_exceeded"
  | "circuit_open";

export type ExecutorEvaluation = Readonly<{
  executorId: string;
  providerId: string;
  executorKind: ExecutorKind;
  executorVersion: string;
  priceVersion: string;
  healthStatus: ExecutorDescriptor["health"]["status"];
  eligible: boolean;
  reasons: readonly RoutingExclusionReason[];
  executionRegion?: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
}>;

const POLICY_BOUND_ROUTE: unique symbol = Symbol("policy-bound-route");

export type PolicyBoundExecutorRoute = Readonly<{
  tenantId: string;
  taskFingerprint: string;
  executorId: string;
  providerId: string;
  executorKind: ExecutorKind;
  executorVersion: string;
  priceVersion: string;
  executionRegion: string;
  policySnapshotId: string;
  policyFingerprint: string;
  registryFingerprint: string;
  maximumCostUsd: number;
  routePosition: number;
  routeFingerprint: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
  [POLICY_BOUND_ROUTE]: true;
}>;

export type RoutingPlan = Readonly<{
  taskId: string;
  tenantId: string;
  taskFingerprint: string;
  policySnapshotId: string;
  policyFingerprint: string;
  registry: ExecutorRegistryBinding;
  maximumCostUsd: number;
  primary: PolicyBoundExecutorRoute;
  fallbacks: readonly PolicyBoundExecutorRoute[];
  planFingerprint: string;
}>;

export type HumanHandoffReason =
  | "high_risk"
  | "graph_coverage_incomplete"
  | "no_eligible_executor"
  | "budget_exhausted"
  | "fallback_exhausted"
  | "verification_failed"
  | "retry_exhausted"
  | "non_retryable_failure"
  | "tenant_mismatch"
  | "route_invalid";

export type HumanHandoff = Readonly<{
  action: "human_handoff";
  taskId: string;
  tenantId: string;
  policySnapshotId: string;
  reason: HumanHandoffReason;
  summary: string;
  requiredRole: "human_reviewer";
  excludedExecutors: readonly ExecutorEvaluation[];
}>;

export type RoutingDecisionRecord = Readonly<{
  decisionId: string;
  taskId: string;
  tenantId: string;
  policySnapshotId: string;
  policyFingerprint: string;
  registry: ExecutorRegistryBinding;
  decidedAt: string;
  action: "execute" | "human_handoff";
  selectedExecutorId: string | null;
  fallbackExecutorIds: readonly string[];
  remainingBudgetUsd: number;
  evaluations: readonly ExecutorEvaluation[];
  handoffReason?: HumanHandoffReason;
}>;

export type ExecutionActualTelemetryRecord = Readonly<{
  decisionId: string;
  taskId: string;
  tenantId: string;
  policySnapshotId: string;
  executorId: string | null;
  providerId: string | null;
  attempt: number;
  outcome: "succeeded" | "failed" | "cancelled" | "human_handoff";
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  actualCostUsd: number;
  actualQualityScore?: number;
  errorCode?: string;
  fallbackFromExecutorId?: string;
}>;

export type RoutingOutcome =
  | Readonly<{
      action: "execute";
      plan: RoutingPlan;
      decision: RoutingDecisionRecord;
    }>
  | Readonly<{
      action: "human_handoff";
      handoff: HumanHandoff;
      decision: RoutingDecisionRecord;
    }>;

export type RouteTaskInput = Readonly<{
  task: RouterTaskSpec;
  policy: RouterPolicySnapshot;
  registry: ExecutorRegistry;
  circuitBreaker: ExecutorAvailability;
  remainingBudgetUsd: number;
  decidedAt: Date;
  /**
   * Recorded outcome aggregates that adapt the ranking of eligible candidates.
   * Undefined (the default) keeps routing byte-identical to the static-only
   * ranking. Adaptivity only re-orders eligible candidates; it never changes
   * eligibility, so policy, privacy, region, risk, quality, latency, budget,
   * and circuit-breaker gates are unaffected.
   */
  adaptiveStats?: AdaptiveRoutingStats;
}>;

export function routeTask(input: RouteTaskInput): RoutingOutcome {
  validateTask(input.task);
  validatePolicy(input.policy);
  if (!Number.isFinite(input.remainingBudgetUsd) || input.remainingBudgetUsd < 0) {
    throw new Error("Invalid remaining budget");
  }
  validTime(input.decidedAt);

  const policyFingerprint = fingerprint(input.policy);
  const effectiveBudget = Math.min(
    input.task.budget.maximumUsd,
    input.policy.budget.maximumUsd,
    input.remainingBudgetUsd,
  );

  // §13.7 escalation: high-risk work must not proceed on thin evidence. This
  // fires only when coverage is EXPLICITLY present and shows incompleteness
  // (basis !== "analyzed"); absent coverage falls through to the risk-policy
  // human-review gate below, preserving existing behaviour. It is checked before
  // that gate so the more specific coverage reason wins over "high_risk".
  // NOTE: no production caller supplies `coverage` yet (the router runs before
  // impact analysis exists), so this is a tested mechanism, not a live
  // production trigger. Closing that gap requires a pre-routing coverage
  // estimate or two-phase routing and is an ADR-gated design decision.
  if (
    riskRank(input.task.risk) >= riskRank("high") &&
    coverageIsIncomplete(input.task.coverage)
  ) {
    return handoffOutcome(
      input,
      policyFingerprint,
      [],
      "graph_coverage_incomplete",
      "Graph coverage is incomplete for high-risk work",
    );
  }

  const requiresHuman =
    riskRank(input.task.risk) >=
    Math.min(riskRank("high"), riskRank(input.policy.risk.humanReviewAtOrAbove));

  if (requiresHuman) {
    return handoffOutcome(
      input,
      policyFingerprint,
      [],
      "high_risk",
      "Task risk requires a human reviewer",
    );
  }

  const evaluations = input.registry.list().map((executor) =>
    evaluateExecutor(
      executor,
      input.task,
      input.policy,
      input.circuitBreaker,
      input.decidedAt,
      effectiveBudget,
    ),
  );
  const eligible = evaluations
    .filter((evaluation) => evaluation.eligible)
    .sort(
      input.adaptiveStats
        ? adaptiveEligibleComparator(input.task.kind, input.adaptiveStats)
        : compareEligible,
    );

  if (eligible.length === 0) {
    const budgetExhausted =
      effectiveBudget <= 0 ||
      (evaluations.length > 0 &&
        evaluations.every((evaluation) =>
          evaluation.reasons.includes("budget_exceeded"),
        ));
    return handoffOutcome(
      input,
      policyFingerprint,
      evaluations,
      budgetExhausted ? "budget_exhausted" : "no_eligible_executor",
      budgetExhausted
        ? "No executor fits the remaining policy budget"
        : "No executor satisfies the policy snapshot",
    );
  }

  const registry = input.registry.binding();
  const taskFingerprint = fingerprint(routingTaskIdentity(input.task));
  const routes = eligible.map((evaluation, routePosition) =>
    bindRoute(
      evaluation,
      input.task.tenantId,
      taskFingerprint,
      input.policy.snapshotId,
      policyFingerprint,
      registry.fingerprint,
      effectiveBudget,
      routePosition,
    ),
  );
  const unsignedPlan: Omit<RoutingPlan, "planFingerprint"> = {
    taskId: input.task.taskId,
    tenantId: input.task.tenantId,
    taskFingerprint,
    policySnapshotId: input.policy.snapshotId,
    policyFingerprint,
    registry,
    maximumCostUsd: effectiveBudget,
    primary: routes[0],
    fallbacks: Object.freeze(routes.slice(1)),
  };
  const plan: RoutingPlan = Object.freeze({
    ...unsignedPlan,
    planFingerprint: routingPlanFingerprint(unsignedPlan),
  });
  const decision = decisionRecord(
    input,
    policyFingerprint,
    evaluations,
    "execute",
    plan.primary.executorId,
    plan.fallbacks.map((route) => route.executorId),
  );
  return Object.freeze({ action: "execute", plan, decision });
}

export type SelectFallbackInput = Readonly<{
  plan: RoutingPlan;
  failedExecutorIds: readonly string[];
  circuitBreaker: ExecutorAvailability;
  remainingBudgetUsd: number;
  at: Date;
  tenantId: string;
}>;

export function selectPolicyBoundFallback(
  input: SelectFallbackInput,
): PolicyBoundExecutorRoute | HumanHandoff {
  if (!Number.isFinite(input.remainingBudgetUsd) || input.remainingBudgetUsd < 0) {
    throw new Error("Invalid remaining budget");
  }
  validTime(input.at);
  if (input.plan.tenantId !== input.tenantId) {
    return fallbackHandoff(
      input,
      "tenant_mismatch",
      "Fallback plan belongs to a different tenant",
    );
  }
  if (!isValidRoutingPlan(input.plan)) {
    return fallbackHandoff(
      input,
      "route_invalid",
      "Fallback plan is malformed or no longer policy bound",
    );
  }
  const failed = new Set(input.failedExecutorIds);
  const maximumCostUsd = Math.min(
    input.plan.maximumCostUsd,
    input.remainingBudgetUsd,
  );
  const next = input.plan.fallbacks.find(
    (candidate) =>
      candidate.policySnapshotId === input.plan.policySnapshotId &&
      candidate.policyFingerprint === input.plan.policyFingerprint &&
      candidate.registryFingerprint === input.plan.registry.fingerprint &&
      candidate.tenantId === input.plan.tenantId &&
      candidate.routeFingerprint === routeFingerprint(candidate) &&
      candidate[POLICY_BOUND_ROUTE] === true &&
      !failed.has(candidate.executorId) &&
      candidate.expectedCostUsd <= maximumCostUsd &&
      input.circuitBreaker.allows(
        candidate.executorId,
        candidate.providerId,
        input.at,
      ),
  );
  if (next) return next;

  return fallbackHandoff(
    input,
    maximumCostUsd <= 0 ? "budget_exhausted" : "fallback_exhausted",
    maximumCostUsd <= 0
      ? "No policy budget remains for fallback execution"
      : "No policy compliant fallback executor remains",
  );
}

function fallbackHandoff(
  input: SelectFallbackInput,
  reason: HumanHandoffReason,
  summary: string,
): HumanHandoff {
  return Object.freeze({
    action: "human_handoff",
    taskId: typeof input.plan.taskId === "string" ? input.plan.taskId : "unknown",
    tenantId: input.tenantId,
    policySnapshotId:
      typeof input.plan.policySnapshotId === "string"
        ? input.plan.policySnapshotId
        : "unknown",
    reason,
    summary,
    requiredRole: "human_reviewer",
    excludedExecutors: Object.freeze([]),
  });
}

function isValidRoutingPlan(plan: RoutingPlan): boolean {
  if (
    !plan.taskId?.trim() ||
    !plan.tenantId?.trim() ||
    !/^[a-f0-9]{64}$/.test(plan.taskFingerprint) ||
    !plan.policySnapshotId?.trim() ||
    !/^[a-f0-9]{64}$/.test(plan.policyFingerprint) ||
    !Number.isFinite(plan.maximumCostUsd) ||
    plan.maximumCostUsd < 0 ||
    !plan.registry ||
    !/^[a-f0-9]{64}$/.test(plan.registry.fingerprint) ||
    !Array.isArray(plan.fallbacks) ||
    !/^[a-f0-9]{64}$/.test(plan.planFingerprint)
  ) {
    return false;
  }
  try {
    validateRegistryContract(plan.registry);
  } catch {
    return false;
  }
  const routes = [plan.primary, ...plan.fallbacks];
  if (plan.planFingerprint !== routingPlanFingerprint(plan)) return false;
  return routes.every(
    (candidate, routePosition) =>
      candidate?.[POLICY_BOUND_ROUTE] === true &&
      candidate.tenantId === plan.tenantId &&
      candidate.taskFingerprint === plan.taskFingerprint &&
      candidate.policySnapshotId === plan.policySnapshotId &&
      candidate.policyFingerprint === plan.policyFingerprint &&
      candidate.registryFingerprint === plan.registry.fingerprint &&
      candidate.maximumCostUsd === plan.maximumCostUsd &&
      candidate.routePosition === routePosition &&
      candidate.routeFingerprint === routeFingerprint(candidate) &&
      typeof candidate.executorId === "string" &&
      candidate.executorId.trim().length > 0 &&
      typeof candidate.providerId === "string" &&
      candidate.providerId.trim().length > 0 &&
      typeof candidate.executionRegion === "string" &&
      candidate.executionRegion.trim().length > 0 &&
      Number.isFinite(candidate.expectedQualityScore) &&
      candidate.expectedQualityScore >= 0 &&
      candidate.expectedQualityScore <= 1 &&
      Number.isFinite(candidate.expectedLatencyMs) &&
      candidate.expectedLatencyMs >= 0 &&
      Number.isFinite(candidate.expectedCostUsd) &&
      candidate.expectedCostUsd >= 0,
  );
}

function evaluateExecutor(
  executor: ExecutorDescriptor,
  task: RouterTaskSpec,
  policy: RouterPolicySnapshot,
  breaker: ExecutorAvailability,
  at: Date,
  effectiveBudget: number,
): ExecutorEvaluation {
  const reasons: RoutingExclusionReason[] = [];
  if (
    task.requiredCapabilities.some(
      (capability) => !executor.capabilities.includes(capability),
    )
  ) {
    reasons.push("capability_missing");
  }
  if (task.allowedTools === undefined) {
    // An undeclared tool requirement is a refusal to make a tool-eligibility
    // claim, not a pass. `[].some()` would read as "no restriction", so the
    // absence is rejected rather than silently admitted (§13.2, fail-closed).
    reasons.push("tool_requirement_undeclared");
  } else if (task.allowedTools.some((tool) => !executor.tools.includes(tool))) {
    reasons.push("tool_missing");
  }
  if (
    task.context.estimatedInputTokens > executor.limits.maximumInputTokens ||
    task.context.maximumOutputTokens > executor.limits.maximumOutputTokens
  ) {
    reasons.push("hard_limit_exceeded");
  }
  if (executor.health.status === "unavailable") reasons.push("executor_unhealthy");
  if (!executor.license.commercialUse) reasons.push("license_disallowed");
  if (
    !policy.privacy.allowedClassifications.includes(task.privacy.classification) ||
    classificationRank(executor.maximumDataClassification) <
      classificationRank(task.privacy.classification) ||
    (executor.deployment === "external" &&
      !policy.privacy.externalProcessingAllowed)
  ) {
    reasons.push("privacy_disallowed");
  }
  const executionRegion = chooseRegion(executor, task, policy);
  if (!executionRegion) reasons.push("region_disallowed");
  if (
    riskRank(task.risk) > riskRank(policy.risk.maximumAutonomousRisk) ||
    riskRank(task.risk) > riskRank(executor.maximumRisk)
  ) {
    reasons.push("risk_disallowed");
  }
  const minimumQuality = Math.max(
    task.quality.minimumScore,
    policy.quality.minimumScore,
  );
  if (executor.qualityScore < minimumQuality) {
    reasons.push("quality_below_minimum");
  }
  const maximumLatency = Math.min(
    task.latency.maximumMs,
    policy.latency.maximumMs,
  );
  if (executor.estimatedLatencyMs > maximumLatency) {
    reasons.push("latency_exceeded");
  }
  if (executor.estimatedCostUsd > effectiveBudget) {
    reasons.push("budget_exceeded");
  }
  if (!breaker.allows(executor.executorId, executor.providerId, at)) {
    reasons.push("circuit_open");
  }
  return Object.freeze({
    executorId: executor.executorId,
    providerId: executor.providerId,
    executorKind: executor.kind,
    executorVersion: executor.version,
    priceVersion: executor.price.version,
    healthStatus: executor.health.status,
    eligible: reasons.length === 0,
    reasons: Object.freeze(reasons),
    executionRegion,
    expectedQualityScore: executor.qualityScore,
    expectedLatencyMs: executor.estimatedLatencyMs,
    expectedCostUsd: executor.estimatedCostUsd,
  });
}

function compareEligible(a: ExecutorEvaluation, b: ExecutorEvaluation): number {
  return (
    EXECUTOR_KIND_RANK[a.executorKind] - EXECUTOR_KIND_RANK[b.executorKind] ||
    HEALTH_RANK[a.healthStatus] - HEALTH_RANK[b.healthStatus] ||
    b.expectedQualityScore - a.expectedQualityScore ||
    a.expectedCostUsd - b.expectedCostUsd ||
    a.expectedLatencyMs - b.expectedLatencyMs ||
    compareText(a.executorId, b.executorId)
  );
}

/**
 * Mirrors {@link compareEligible} but ranks quality, cost, and latency on the
 * history-adjusted effective metrics. Deterministic class and health remain the
 * primary keys so structural preferences (deterministic recipes first, healthy
 * before degraded) are preserved; only otherwise-comparable candidates are
 * re-ordered. With no matching aggregate the effective metrics equal the static
 * baseline, so an empty or cold-start history reproduces {@link compareEligible}.
 */
function adaptiveEligibleComparator(
  taskKind: string,
  stats: AdaptiveRoutingStats,
): (a: ExecutorEvaluation, b: ExecutorEvaluation) => number {
  const index = indexAdaptiveStats(stats);
  const metricsFor = (evaluation: ExecutorEvaluation) =>
    effectiveRoutingMetrics(
      {
        qualityScore: evaluation.expectedQualityScore,
        costUsd: evaluation.expectedCostUsd,
        latencyMs: evaluation.expectedLatencyMs,
      },
      index.get(
        adaptiveAggregateKey(
          evaluation.executorId,
          taskKind,
          evaluation.providerId,
        ),
      ),
    );
  return (a, b) => {
    const am = metricsFor(a);
    const bm = metricsFor(b);
    return (
      EXECUTOR_KIND_RANK[a.executorKind] - EXECUTOR_KIND_RANK[b.executorKind] ||
      HEALTH_RANK[a.healthStatus] - HEALTH_RANK[b.healthStatus] ||
      bm.qualityScore - am.qualityScore ||
      am.costUsd - bm.costUsd ||
      am.latencyMs - bm.latencyMs ||
      compareText(a.executorId, b.executorId)
    );
  };
}

function chooseRegion(
  executor: ExecutorDescriptor,
  task: RouterTaskSpec,
  policy: RouterPolicySnapshot,
): string | undefined {
  const allowed = executor.regions
    .filter((region) => policy.region.allowedExecutionRegions.includes(region))
    .filter(
      (region) =>
        task.privacy.requiredRegion === undefined ||
        region === task.privacy.requiredRegion,
    )
    .sort(compareText);
  return allowed[0];
}

function bindRoute(
  evaluation: ExecutorEvaluation,
  tenantId: string,
  taskFingerprint: string,
  policySnapshotId: string,
  policyFingerprint: string,
  registryFingerprint: string,
  maximumCostUsd: number,
  routePosition: number,
): PolicyBoundExecutorRoute {
  if (!evaluation.eligible || !evaluation.executionRegion) {
    throw new Error("Cannot bind an ineligible executor");
  }
  const route = {
    tenantId,
    taskFingerprint,
    executorId: evaluation.executorId,
    providerId: evaluation.providerId,
    executorKind: evaluation.executorKind,
    executorVersion: evaluation.executorVersion,
    priceVersion: evaluation.priceVersion,
    executionRegion: evaluation.executionRegion,
    policySnapshotId,
    policyFingerprint,
    registryFingerprint,
    maximumCostUsd,
    routePosition,
    expectedQualityScore: evaluation.expectedQualityScore,
    expectedLatencyMs: evaluation.expectedLatencyMs,
    expectedCostUsd: evaluation.expectedCostUsd,
  };
  return Object.freeze({
    ...route,
    routeFingerprint: fingerprint(route),
    [POLICY_BOUND_ROUTE]: true as const,
  });
}

function routeFingerprint(route: PolicyBoundExecutorRoute): string {
  return fingerprint({
    tenantId: route.tenantId,
    taskFingerprint: route.taskFingerprint,
    executorId: route.executorId,
    providerId: route.providerId,
    executorKind: route.executorKind,
    executorVersion: route.executorVersion,
    priceVersion: route.priceVersion,
    executionRegion: route.executionRegion,
    policySnapshotId: route.policySnapshotId,
    policyFingerprint: route.policyFingerprint,
    registryFingerprint: route.registryFingerprint,
    maximumCostUsd: route.maximumCostUsd,
    routePosition: route.routePosition,
    expectedQualityScore: route.expectedQualityScore,
    expectedLatencyMs: route.expectedLatencyMs,
    expectedCostUsd: route.expectedCostUsd,
  });
}

function routingPlanFingerprint(
  plan: Omit<RoutingPlan, "planFingerprint"> | RoutingPlan,
): string {
  return fingerprint({
    taskId: plan.taskId,
    tenantId: plan.tenantId,
    taskFingerprint: plan.taskFingerprint,
    policySnapshotId: plan.policySnapshotId,
    policyFingerprint: plan.policyFingerprint,
    registry: plan.registry,
    maximumCostUsd: plan.maximumCostUsd,
    routeFingerprints: [plan.primary, ...plan.fallbacks].map(
      (route) => route.routeFingerprint,
    ),
  });
}

function handoffOutcome(
  input: RouteTaskInput,
  policyFingerprint: string,
  evaluations: readonly ExecutorEvaluation[],
  reason: HumanHandoffReason,
  summary: string,
): RoutingOutcome {
  const handoff: HumanHandoff = Object.freeze({
    action: "human_handoff",
    taskId: input.task.taskId,
    tenantId: input.task.tenantId,
    policySnapshotId: input.policy.snapshotId,
    reason,
    summary,
    requiredRole: "human_reviewer",
    excludedExecutors: Object.freeze([...evaluations]),
  });
  return Object.freeze({
    action: "human_handoff",
    handoff,
    decision: decisionRecord(
      input,
      policyFingerprint,
      evaluations,
      "human_handoff",
      null,
      [],
      reason,
    ),
  });
}

function decisionRecord(
  input: RouteTaskInput,
  policyFingerprint: string,
  evaluations: readonly ExecutorEvaluation[],
  action: RoutingDecisionRecord["action"],
  selectedExecutorId: string | null,
  fallbackExecutorIds: readonly string[],
  handoffReason?: HumanHandoffReason,
): RoutingDecisionRecord {
  const decidedAt = input.decidedAt.toISOString();
  const body = {
    task: routingTaskIdentity(input.task),
    policyFingerprint,
    registry: input.registry.binding(),
    decidedAt,
    remainingBudgetUsd: input.remainingBudgetUsd,
    action,
    selectedExecutorId,
    fallbackExecutorIds,
    evaluations,
    handoffReason,
  };
  return Object.freeze({
    decisionId: `route_${fingerprint(body)}`,
    taskId: input.task.taskId,
    tenantId: input.task.tenantId,
    policySnapshotId: input.policy.snapshotId,
    policyFingerprint,
    registry: input.registry.binding(),
    decidedAt,
    action,
    selectedExecutorId,
    fallbackExecutorIds: Object.freeze([...fallbackExecutorIds]),
    remainingBudgetUsd: input.remainingBudgetUsd,
    evaluations: Object.freeze([...evaluations]),
    handoffReason,
  });
}

function routingTaskIdentity(task: RouterTaskSpec): unknown {
  const { goal, ...routingFields } = task;
  const prehashed = /^sha256:[a-f0-9]{64}$/.test(goal)
    ? goal.slice("sha256:".length)
    : createHash("sha256").update(goal).digest("hex");
  return {
    ...routingFields,
    goalDigest: prehashed,
  };
}

function validateTask(task: RouterTaskSpec): void {
  if (
    !task.taskId?.trim() ||
    !task.tenantId?.trim() ||
    !task.kind?.trim() ||
    !task.goal?.trim() ||
    !task.idempotencyKey?.trim()
  ) {
    throw new Error("Task identity is required");
  }
  if (!(task.privacy.classification in CLASSIFICATION_RANK)) {
    throw new Error("Task privacy classification is invalid");
  }
  if (!(task.risk in RISK_RANK)) throw new Error("Task risk is invalid");
  validateStringList(task.inputArtifactIds, "task artifacts");
  validateStringList(task.requiredCapabilities, "task capabilities");
  // `undefined` is the honest "no tool requirement declared" state and is
  // rejected at evaluation (`tool_requirement_undeclared`), not here; a declared
  // list (including `[]`) must still be a valid, unique string list.
  if (task.allowedTools !== undefined) {
    validateStringList(task.allowedTools, "task tools");
  }
  validateStringList(task.verification.requiredChecks, "task verification checks");
  if (!task.verification.requiredChecks.length || task.verification.requireAll !== true ||
    !["human_handoff", "eligible_fallback"].includes(task.verification.onFailure)) {
    throw new Error("Task verification policy is invalid");
  }
  validatePositiveInteger(task.context.estimatedInputTokens, "task input token limit", true);
  validatePositiveInteger(task.context.maximumOutputTokens, "task output token limit");
  if (
    typeof task.fallbackPolicy.enabled !== "boolean" ||
    !Number.isInteger(task.fallbackPolicy.maxAttempts) ||
    task.fallbackPolicy.maxAttempts < 1 ||
    task.fallbackPolicy.maxAttempts > 10 ||
    !Number.isInteger(task.fallbackPolicy.sameExecutorRetries) ||
    task.fallbackPolicy.sameExecutorRetries < 0 ||
    task.fallbackPolicy.sameExecutorRetries >= task.fallbackPolicy.maxAttempts
  ) {
    throw new Error("Task fallback policy is invalid");
  }
  validateFailureCodes(task.fallbackPolicy.retryableFailures, "task retry failures");
  validateFailureCodes(task.fallbackPolicy.fallbackFailures, "task fallback failures");
  if (task.privacy.requiredRegion !== undefined && !task.privacy.requiredRegion.trim()) {
    throw new Error("Task region is invalid");
  }
  validateScore(task.quality.minimumScore, "task quality");
  validateNonNegative(task.latency.maximumMs, "task latency");
  validateNonNegative(task.budget.maximumUsd, "task budget");
  validateProduct(task.product);
  validateBlastRadius(task.blastRadius);
  validateCoverage(task.coverage);
}

function validateProduct(product: RouterProduct | undefined): void {
  if (product !== undefined && !ROUTER_PRODUCTS.includes(product)) {
    throw new Error("Task product is invalid");
  }
}

function validateBlastRadius(blastRadius: RouterBlastRadius | undefined): void {
  if (blastRadius === undefined) return;
  if (typeof blastRadius !== "object" || blastRadius === null) {
    throw new Error("Task blast radius is invalid");
  }
  validatePositiveInteger(blastRadius.impactedFiles, "task blast radius files", true);
  validatePositiveInteger(
    blastRadius.impactedSurfaces,
    "task blast radius surfaces",
    true,
  );
  validatePositiveInteger(
    blastRadius.repositoryCount,
    "task blast radius repositories",
    true,
  );
}

const COVERAGE_BASES = Object.freeze([
  "analyzed",
  "partial",
  "not_analyzed",
] as const);

function validateCoverage(coverage: ImpactCoverage | undefined): void {
  if (coverage === undefined) return;
  if (
    typeof coverage !== "object" ||
    coverage === null ||
    !COVERAGE_BASES.includes(coverage.basis)
  ) {
    throw new Error("Task coverage is invalid");
  }
}

/**
 * Coverage is "incomplete" when it is explicitly present and its basis is not
 * `analyzed` (i.e. `partial` or `not_analyzed`, the §11.7 "no known impact" vs
 * "complete evidence of no impact" distinction). Absent coverage is NOT treated
 * as incomplete here, so callers that do not supply coverage keep their existing
 * risk-policy escalation behaviour unchanged.
 */
function coverageIsIncomplete(coverage: ImpactCoverage | undefined): boolean {
  return coverage !== undefined && coverage.basis !== "analyzed";
}

function validatePolicy(policy: RouterPolicySnapshot): void {
  if (!policy.snapshotId || !Number.isInteger(policy.version) || policy.version < 1) {
    throw new Error("Policy identity is invalid");
  }
  if (!Number.isFinite(Date.parse(policy.capturedAt))) {
    throw new Error("Policy capture time is invalid");
  }
  if (
    !policy.privacy.allowedClassifications.length ||
    policy.privacy.allowedClassifications.some(
      (classification) => !(classification in CLASSIFICATION_RANK),
    )
  ) {
    throw new Error("Policy privacy classifications are invalid");
  }
  validateStringList(policy.region.allowedExecutionRegions, "policy regions");
  if (
    !(policy.risk.maximumAutonomousRisk in RISK_RANK) ||
    !(policy.risk.humanReviewAtOrAbove in RISK_RANK)
  ) {
    throw new Error("Policy risk is invalid");
  }
  validateScore(policy.quality.minimumScore, "policy quality");
  validateNonNegative(policy.latency.maximumMs, "policy latency");
  validateNonNegative(policy.budget.maximumUsd, "policy budget");
}

function validateExecutor(executor: ExecutorDescriptor): void {
  if (!executor.executorId || !executor.providerId) {
    throw new Error("Executor identity is required");
  }
  if (executor.deployment !== "internal" && executor.deployment !== "external") {
    throw new Error("Executor deployment is invalid");
  }
  if (!(executor.kind in EXECUTOR_KIND_RANK) || !executor.version?.trim()) {
    throw new Error("Executor kind or version is invalid");
  }
  if (!(executor.maximumDataClassification in CLASSIFICATION_RANK)) {
    throw new Error("Executor data classification is invalid");
  }
  if (!(executor.maximumRisk in RISK_RANK)) throw new Error("Executor risk is invalid");
  validateStringList(executor.capabilities, "executor capabilities");
  validateStringList(executor.tools, "executor tools");
  validateStringList(executor.regions, "executor regions");
  if (!executor.price.version?.trim() || !/^[A-Z]{3}$/.test(executor.price.currency) || !Number.isFinite(Date.parse(executor.price.effectiveAt))) {
    throw new Error("Executor price metadata is invalid");
  }
  validatePositiveInteger(executor.limits.maximumInputTokens, "executor input token limit");
  validatePositiveInteger(executor.limits.maximumOutputTokens, "executor output token limit");
  validatePositiveInteger(executor.limits.maximumConcurrentTasks, "executor concurrency limit");
  if (!(["healthy", "degraded", "unavailable"] as const).includes(executor.health.status) ||
    !Number.isFinite(Date.parse(executor.health.checkedAt)) || !executor.health.evidenceRef?.trim()) {
    throw new Error("Executor health metadata is invalid");
  }
  if (!executor.license.id?.trim() || typeof executor.license.commercialUse !== "boolean" ||
    !(["allowed", "restricted", "not_applicable"] as const).includes(executor.license.redistribution)) {
    throw new Error("Executor license metadata is invalid");
  }
  validateScore(executor.qualityScore, "executor quality");
  validateNonNegative(executor.estimatedLatencyMs, "executor latency");
  validateNonNegative(executor.estimatedCostUsd, "executor cost");
}

function validateRegistryContract(contract: ExecutorRegistryContract): void {
  if (
    contract.schemaVersion !== ROUTER_REGISTRY_SCHEMA_VERSION ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(contract.registryId) ||
    !Number.isSafeInteger(contract.version) ||
    contract.version < 1
  ) {
    throw new Error("Executor registry contract is invalid");
  }
}

function validateStringList(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label} are invalid`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contain duplicates`);
}

function validateScore(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} is invalid`);
  }
}

function validateNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
}

function validatePositiveInteger(value: number, label: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} is invalid`);
  }
}

function validateFailureCodes(values: readonly RouterFailureCode[], label: string): void {
  validateStringList(values, label);
  if (values.some((value) => !ROUTER_FAILURE_CODES.includes(value))) {
    throw new Error(`${label} are invalid`);
  }
}

function freezeExecutor(executor: ExecutorDescriptor): ExecutorDescriptor {
  return Object.freeze({
    ...executor,
    capabilities: Object.freeze([...executor.capabilities]),
    tools: Object.freeze([...executor.tools]),
    regions: Object.freeze([...executor.regions]),
    price: Object.freeze({ ...executor.price }),
    limits: Object.freeze({ ...executor.limits }),
    health: Object.freeze({ ...executor.health }),
    license: Object.freeze({ ...executor.license }),
  });
}

const EXECUTOR_KIND_RANK: Record<ExecutorKind, number> = {
  deterministic_recipe: 0,
  adapter: 1,
  local_model: 2,
  open_model: 3,
  frontier_model: 4,
};

const HEALTH_RANK: Record<ExecutorDescriptor["health"]["status"], number> = {
  healthy: 0,
  degraded: 1,
  unavailable: 2,
};

const RISK_RANK: Record<TaskRisk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CLASSIFICATION_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function riskRank(risk: TaskRisk): number {
  return RISK_RANK[risk];
}

function classificationRank(classification: DataClassification): number {
  return CLASSIFICATION_RANK[classification];
}

function validTime(value: Date): number {
  const time = value.getTime();
  if (!Number.isFinite(time)) throw new Error("Invalid routing time");
  return time;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
