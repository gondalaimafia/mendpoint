import { createHash } from "node:crypto";

export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export type TaskRisk = "low" | "medium" | "high" | "critical";

export type RouterTaskSpec = Readonly<{
  taskId: string;
  tenantId: string;
  kind: string;
  goal: string;
  idempotencyKey: string;
  inputArtifactIds: readonly string[];
  requiredCapabilities: readonly string[];
  privacy: Readonly<{
    classification: DataClassification;
    requiredRegion?: string;
  }>;
  risk: TaskRisk;
  quality: Readonly<{ minimumScore: number }>;
  latency: Readonly<{ maximumMs: number }>;
  budget: Readonly<{ maximumUsd: number }>;
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
  deployment: "internal" | "external";
  capabilities: readonly string[];
  regions: readonly string[];
  maximumDataClassification: DataClassification;
  maximumRisk: TaskRisk;
  qualityScore: number;
  estimatedLatencyMs: number;
  estimatedCostUsd: number;
}>;

export class ExecutorRegistry {
  readonly #executors = new Map<string, ExecutorDescriptor>();

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

export type RoutingExclusionReason =
  | "capability_missing"
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
  eligible: boolean;
  reasons: readonly RoutingExclusionReason[];
  executionRegion?: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
}>;

const POLICY_BOUND_ROUTE: unique symbol = Symbol("policy-bound-route");

export type PolicyBoundExecutorRoute = Readonly<{
  executorId: string;
  providerId: string;
  executionRegion: string;
  policySnapshotId: string;
  policyFingerprint: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
  [POLICY_BOUND_ROUTE]: true;
}>;

export type RoutingPlan = Readonly<{
  taskId: string;
  policySnapshotId: string;
  policyFingerprint: string;
  maximumCostUsd: number;
  primary: PolicyBoundExecutorRoute;
  fallbacks: readonly PolicyBoundExecutorRoute[];
}>;

export type HumanHandoffReason =
  | "high_risk"
  | "no_eligible_executor"
  | "budget_exhausted"
  | "fallback_exhausted";

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
  circuitBreaker: ExecutorCircuitBreaker;
  remainingBudgetUsd: number;
  decidedAt: Date;
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
    .sort(compareEligible);

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

  const routes = eligible.map((evaluation) =>
    bindRoute(evaluation, input.policy.snapshotId, policyFingerprint),
  );
  const plan: RoutingPlan = Object.freeze({
    taskId: input.task.taskId,
    policySnapshotId: input.policy.snapshotId,
    policyFingerprint,
    maximumCostUsd: effectiveBudget,
    primary: routes[0],
    fallbacks: Object.freeze(routes.slice(1)),
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
  circuitBreaker: ExecutorCircuitBreaker;
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
  const failed = new Set(input.failedExecutorIds);
  const maximumCostUsd = Math.min(
    input.plan.maximumCostUsd,
    input.remainingBudgetUsd,
  );
  const next = input.plan.fallbacks.find(
    (candidate) =>
      candidate.policySnapshotId === input.plan.policySnapshotId &&
      candidate.policyFingerprint === input.plan.policyFingerprint &&
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

  return Object.freeze({
    action: "human_handoff",
    taskId: input.plan.taskId,
    tenantId: input.tenantId,
    policySnapshotId: input.plan.policySnapshotId,
    reason:
      maximumCostUsd <= 0 ? "budget_exhausted" : "fallback_exhausted",
    summary:
      maximumCostUsd <= 0
        ? "No policy budget remains for fallback execution"
        : "No policy compliant fallback executor remains",
    requiredRole: "human_reviewer",
    excludedExecutors: Object.freeze([]),
  });
}

function evaluateExecutor(
  executor: ExecutorDescriptor,
  task: RouterTaskSpec,
  policy: RouterPolicySnapshot,
  breaker: ExecutorCircuitBreaker,
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
    b.expectedQualityScore - a.expectedQualityScore ||
    a.expectedCostUsd - b.expectedCostUsd ||
    a.expectedLatencyMs - b.expectedLatencyMs ||
    compareText(a.executorId, b.executorId)
  );
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
  policySnapshotId: string,
  policyFingerprint: string,
): PolicyBoundExecutorRoute {
  if (!evaluation.eligible || !evaluation.executionRegion) {
    throw new Error("Cannot bind an ineligible executor");
  }
  return Object.freeze({
    executorId: evaluation.executorId,
    providerId: evaluation.providerId,
    executionRegion: evaluation.executionRegion,
    policySnapshotId,
    policyFingerprint,
    expectedQualityScore: evaluation.expectedQualityScore,
    expectedLatencyMs: evaluation.expectedLatencyMs,
    expectedCostUsd: evaluation.expectedCostUsd,
    [POLICY_BOUND_ROUTE]: true as const,
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
    task: input.task,
    policyFingerprint,
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
    decidedAt,
    action,
    selectedExecutorId,
    fallbackExecutorIds: Object.freeze([...fallbackExecutorIds]),
    remainingBudgetUsd: input.remainingBudgetUsd,
    evaluations: Object.freeze([...evaluations]),
    handoffReason,
  });
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
  if (task.privacy.requiredRegion !== undefined && !task.privacy.requiredRegion.trim()) {
    throw new Error("Task region is invalid");
  }
  validateScore(task.quality.minimumScore, "task quality");
  validateNonNegative(task.latency.maximumMs, "task latency");
  validateNonNegative(task.budget.maximumUsd, "task budget");
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
  if (!(executor.maximumDataClassification in CLASSIFICATION_RANK)) {
    throw new Error("Executor data classification is invalid");
  }
  if (!(executor.maximumRisk in RISK_RANK)) throw new Error("Executor risk is invalid");
  validateStringList(executor.capabilities, "executor capabilities");
  validateStringList(executor.regions, "executor regions");
  validateScore(executor.qualityScore, "executor quality");
  validateNonNegative(executor.estimatedLatencyMs, "executor latency");
  validateNonNegative(executor.estimatedCostUsd, "executor cost");
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

function freezeExecutor(executor: ExecutorDescriptor): ExecutorDescriptor {
  return Object.freeze({
    ...executor,
    capabilities: Object.freeze([...executor.capabilities]),
    regions: Object.freeze([...executor.regions]),
  });
}

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
