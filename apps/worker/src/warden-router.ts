import {
  ExecutorRegistry,
  routeTask,
  type ExecutorDescriptor,
  type DataClassification,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
  type TaskRisk,
} from "@mendpoint/platform";
import {
  buildRoutingPolicySnapshot,
  buildRoutingTaskSpec,
  digest,
} from "./routing-envelope.js";
import {
  DEFAULT_ROUTING_BREAKER,
  loadRoutingAvailability,
  recordRoutingDecision,
  recordRoutingOutcomeExactlyOnce,
  type AppDb,
  type RoutingBreakerFeedback,
  type RoutingBreakerConfig,
} from "@mendpoint/db";
import type {
  AgentRunResult,
  AgentTaskMode,
  WardenAttemptResult,
  WardenRouterPrepared,
  WardenRouterRecorded,
  WardenRoutingRuntimePort,
} from "@mendpoint/agent";
import { nowIso } from "@mendpoint/shared";

const WARDEN_NO_ACTION_CODE = "warden_attempt_baseline_target_green";

const WARDEN_BREAKER_FAILURE_CODES = new Set([
  "executor_unavailable",
  "provider_unavailable",
  "timeout",
  "request_timeout",
  "http_error",
  "transport_error",
  "network_error",
  "connection_error",
  "rate_limited",
  "transient_dependency",
  "model_unavailable",
  "model_request_timeout",
  "model_http_error",
  "model_rate_limited",
]);

function breakerFeedbackForOutcome(
  outcome: WardenRoutingOutcomeInput,
): RoutingBreakerFeedback {
  if (outcome.outcome === "succeeded") return "success";
  return outcome.errorCode && WARDEN_BREAKER_FAILURE_CODES.has(outcome.errorCode)
    ? "availability_failure"
    : "none";
}

/**
 * Durable policy-routed execution for the production Warden attempt path.
 *
 * The Warden attempt is the single real executor today, so it is registered as
 * a deterministic recipe. The runtime uses the shared platform router
 * (`routeTask`) to make every decision — privacy, region, risk, quality,
 * latency, budget filters plus the durable circuit breaker — then persists the
 * decision, feeds outcomes back into the breaker, and records cost attribution.
 * The Transformer pilot runs in its own lane (a separate execution store and
 * snapshot loader that never produces an `AgentRunResult` for an `agent.run`
 * job), so it cannot register as a Warden executor without a dedicated adapter.
 */
export const WARDEN_EXECUTOR_ID = "warden-attempt";
export const WARDEN_PROVIDER_ID = "mendpoint-internal";
export const WARDEN_ROUTING_REGION = "internal";
export const WARDEN_TASK_KIND = "warden.attempt";

export type WardenRoutingSafetyCode =
  | "routing_breaker_state_unavailable"
  | "routing_decision_persistence_failed"
  | "routing_outcome_persistence_failed"
  | "routing_outcome_idempotency_conflict";

export class WardenRoutingSafetyError extends Error {
  readonly code: WardenRoutingSafetyCode;
  readonly cause: unknown;

  constructor(code: WardenRoutingSafetyCode, cause: unknown) {
    super(code);
    this.name = "WardenRoutingSafetyError";
    this.code = code;
    this.cause = cause;
  }
}

const WARDEN_PRICE_EFFECTIVE_AT = "2026-01-01T00:00:00.000Z";

export type WardenModelRoutingProfile = Readonly<{
  provider: string;
  model: string;
  endpoint: string;
  policyDigest: string;
  region: string;
  maximumDataClassification: DataClassification;
  estimatedCostUsd: number;
}>;

function validateModelRoutingProfile(profile: WardenModelRoutingProfile): void {
  if (
    !profile.provider.trim() ||
    !profile.model.trim() ||
    !profile.region.trim() ||
    !/^sha256:[a-f0-9]{64}$/.test(profile.policyDigest) ||
    !Number.isFinite(profile.estimatedCostUsd) ||
    profile.estimatedCostUsd < 0
  ) {
    throw new Error("warden_model_routing_profile_invalid");
  }
  try {
    const endpoint = new URL(profile.endpoint);
    if (endpoint.protocol !== "https:") throw new Error("https_required");
  } catch {
    throw new Error("warden_model_routing_profile_invalid");
  }
}

function modelDeploymentIdentity(profile: WardenModelRoutingProfile): string {
  return digest({
    provider: profile.provider,
    model: profile.model,
    endpoint: profile.endpoint,
  });
}

/** Register the Warden attempt executor descriptor for a routing pass. */
export function buildWardenExecutorRegistry(
  checkedAt: string = nowIso(),
  modelSource?: WardenModelRoutingProfile,
  taskMode: AgentTaskMode = "repair",
): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(wardenExecutorDescriptor(checkedAt, modelSource, taskMode));
  return registry;
}

export function wardenExecutorDescriptor(
  checkedAt: string = nowIso(),
  modelSource?: WardenModelRoutingProfile,
  taskMode: AgentTaskMode = "repair",
): ExecutorDescriptor {
  const capabilities = taskMode === "feature"
    ? ["warden.repair", "warden.feature"]
    : ["warden.repair"];
  if (modelSource) {
    validateModelRoutingProfile(modelSource);
    const deploymentIdentity = modelDeploymentIdentity(modelSource);
    return {
      executorId: `warden-model-${deploymentIdentity.slice("sha256:".length)}`,
      providerId: modelSource.provider,
      kind: "frontier_model",
      version: `${modelSource.model}@${deploymentIdentity}`,
      deployment: "external",
      capabilities,
      tools: ["read_file", "write_file", "run_command"],
      regions: [modelSource.region],
      price: {
        version: `model-price-${deploymentIdentity}`,
        currency: "USD",
        effectiveAt: WARDEN_PRICE_EFFECTIVE_AT,
      },
      limits: {
        maximumInputTokens: 4_000_000,
        maximumOutputTokens: 1_000_000,
        maximumConcurrentTasks: 8,
      },
      health: {
        status: "healthy",
        checkedAt,
        evidenceRef: modelSource.policyDigest,
      },
      license: {
        id: modelSource.provider,
        commercialUse: true,
        redistribution: "not_applicable",
      },
      maximumDataClassification: modelSource.maximumDataClassification,
      maximumRisk: "high",
      qualityScore: 0.9,
      estimatedLatencyMs: 60_000,
      estimatedCostUsd: modelSource.estimatedCostUsd,
    };
  }
  return {
    executorId: WARDEN_EXECUTOR_ID,
    providerId: WARDEN_PROVIDER_ID,
    kind: "deterministic_recipe",
    version: "warden-attempt-1",
    deployment: "internal",
    capabilities,
    tools: ["read_file", "write_file", "run_command"],
    regions: [WARDEN_ROUTING_REGION],
    price: {
      version: "warden-attempt-price-1",
      currency: "USD",
      effectiveAt: WARDEN_PRICE_EFFECTIVE_AT,
    },
    limits: {
      maximumInputTokens: 4_000_000,
      maximumOutputTokens: 1_000_000,
      maximumConcurrentTasks: 8,
    },
    health: {
      status: "healthy",
      checkedAt,
      evidenceRef: "warden-attempt-engine",
    },
    license: {
      id: "mendpoint-internal",
      commercialUse: true,
      redistribution: "not_applicable",
    },
    maximumDataClassification: "restricted",
    maximumRisk: "high",
    qualityScore: 0.9,
    estimatedLatencyMs: 60_000,
    estimatedCostUsd: 0,
  };
}

export type WardenRoutingRequestInput = Readonly<{
  taskMode?: AgentTaskMode;
  taskId: string;
  tenantId: string;
  goal: string;
  idempotencyKey: string;
  verifyCommand: string;
  sourceArtifactId?: string;
  /** Legacy source-reference name. It is never used as the router policy ID. */
  policySnapshotId?: string;
  modelSource?: WardenModelRoutingProfile;
  externalProcessingAllowed?: boolean;
  maxOutputTokens?: number;
  /** Optional caller-supplied token estimate. Defaults to a seed estimate. */
  estimatedInputTokens?: number;
  risk?: TaskRisk;
  classification?: DataClassification;
  budgetUsd?: number;
  maximumLatencyMs?: number;
  decidedAt?: Date;
}>;

export type WardenRoutingRequest = Readonly<{
  task: RouterTaskSpec;
  policy: RouterPolicySnapshot;
  remainingBudgetUsd: number;
  decidedAt: Date;
}>;

function buildTaskSpec(input: WardenRoutingRequestInput): RouterTaskSpec {
  const sourceArtifactId = input.sourceArtifactId ?? input.policySnapshotId ?? "";
  // No honest change-risk signal exists at this call site: blast radius and
  // impact coverage are produced by the attempt (after routing), and the
  // repository data-classification is a privacy axis (§12.4), not change risk
  // (§12.3). Risk therefore stays caller-supplied or the medium default — a
  // deliberate under-claim, not a fabricated derivation.
  const risk: TaskRisk = input.risk ?? "medium";
  return buildRoutingTaskSpec({
    taskId: input.taskId,
    tenantId: input.tenantId,
    kind: WARDEN_TASK_KIND,
    goal: input.goal,
    idempotencyKey: input.idempotencyKey,
    inputArtifactIds: input.modelSource
      ? [sourceArtifactId, input.modelSource.policyDigest]
      : [sourceArtifactId],
    requiredCapabilities: [
      input.taskMode === "feature" ? "warden.feature" : "warden.repair",
    ],
    classification: input.classification ?? "restricted",
    risk,
    verifyCommand: input.verifyCommand,
    tokenSeedParts: [input.goal, input.verifyCommand, sourceArtifactId],
    estimatedInputTokens: input.estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    maximumLatencyMs: input.maximumLatencyMs,
    budgetUsd: input.budgetUsd,
  });
}

function buildPolicySnapshot(
  input: WardenRoutingRequestInput,
): RouterPolicySnapshot {
  return buildRoutingPolicySnapshot({
    // The classification ceiling is an explicit declaration: an external model
    // source contributes its cleared maximum; otherwise the caller's declared
    // repository classification. An absent declaration narrows to `public` (the
    // shared builder's fail-safe) rather than widening to all four.
    maximumDataClassification:
      input.modelSource?.maximumDataClassification ?? input.classification,
    externalProcessingAllowed: Boolean(
      input.modelSource && input.externalProcessingAllowed === true,
    ),
    allowedExecutionRegions: [input.modelSource?.region ?? WARDEN_ROUTING_REGION],
    maximumLatencyMs: input.maximumLatencyMs,
    budgetUsd: input.budgetUsd,
    decidedAt: input.decidedAt,
  });
}

/** Build the routing request passed to `runPolicyRoutedWarden`. */
export function wardenRoutingRequest(
  input: WardenRoutingRequestInput,
): WardenRoutingRequest {
  const decidedAt = input.decidedAt ?? new Date();
  return Object.freeze({
    task: buildTaskSpec(input),
    policy: buildPolicySnapshot(input),
    remainingBudgetUsd: input.budgetUsd ?? 25,
    decidedAt,
  });
}

/**
 * Outcome payload recorded against a routing decision. Structurally a superset
 * of the platform port's outcome (base call sites still type-check, the extra
 * fields are optional) plus the per-execution token attribution the durable
 * routing ledger persists alongside cost. Tokens are omitted (null) for a
 * heuristic-only run that made no model call.
 */
type WardenRoutingOutcomeInput = Parameters<
  WardenRoutingRuntimePort<WardenRoutingRequest>["recordOutcome"]
>[1] &
  Readonly<{
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
  }>;
type WardenRoutingOutcomeWrite = Parameters<
  typeof recordRoutingOutcomeExactlyOnce
>[1];

/**
 * The concrete Warden routing runtime. It is a `WardenRoutingRuntimePort` (so it
 * still satisfies every base call site, including `runPolicyRoutedWarden`) whose
 * `recordOutcome` additionally accepts the optional per-execution token
 * attribution the durable ledger persists alongside cost.
 */
export interface WardenRoutingRuntime
  extends WardenRoutingRuntimePort<WardenRoutingRequest> {
  recordOutcome(
    envelopeId: string,
    outcome: WardenRoutingOutcomeInput,
  ): WardenRouterRecorded;
  applyPendingOutcome(): WardenRouterRecorded | null;
}

/** Honest cost + token attribution derived from a completed Warden attempt. */
export type WardenRoutingOutcomeAttribution = Readonly<{
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

/**
 * Cost + token attribution for a completed Warden attempt, taken from the
 * attempt engine's measured model usage. A deterministic heuristic-only run
 * makes no model call, so nothing is measured and every field is null rather
 * than a fabricated zero presented as a measured cost.
 */
export function wardenRoutingOutcomeAttribution(
  attempt: WardenAttemptResult,
): WardenRoutingOutcomeAttribution {
  const usage = attempt.agent?.usage;
  if (!usage?.measured) {
    return Object.freeze({
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  }
  return Object.freeze({
    costUsd: usage.costUsd,
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  });
}

export type WardenRoutingRuntimeContext = Readonly<{
  db: AppDb;
  tenantId: string;
  jobId: string;
  runId: string;
  registry: ExecutorRegistry;
  breakerConfig?: RoutingBreakerConfig;
  deferOutcomePersistence?: boolean;
}>;

/**
 * Concrete `WardenRoutingRuntimePort` backed by the shared platform router and
 * the durable ledger + circuit-breaker state. Safety state is fail-closed: an
 * unreadable breaker or an unpersisted decision stops dispatch, while outcome
 * and breaker feedback commit exactly once in one transaction.
 */
export function createWardenRoutingRuntime(
  context: WardenRoutingRuntimeContext,
): WardenRoutingRuntime {
  const config = context.breakerConfig ?? DEFAULT_ROUTING_BREAKER;
  let pendingOutcome: Readonly<{
    fingerprint: string;
    write: WardenRoutingOutcomeWrite;
    recorded: WardenRouterRecorded;
  }> | null = null;

  const applyOutcome = (
    write: WardenRoutingOutcomeWrite,
    recorded: WardenRouterRecorded,
  ): WardenRouterRecorded => {
    try {
      recordRoutingOutcomeExactlyOnce(context.db, write);
    } catch (error) {
      const code = error instanceof Error &&
          error.message === "routing_outcome_idempotency_conflict"
        ? "routing_outcome_idempotency_conflict"
        : "routing_outcome_persistence_failed";
      throw new WardenRoutingSafetyError(code, error);
    }
    return recorded;
  };

  return {
    prepare(request: WardenRoutingRequest): WardenRouterPrepared {
      const availability = safeAvailability(
        context,
        request.decidedAt,
        config,
      );
      const outcome = routeTask({
        task: request.task,
        policy: request.policy,
        registry: context.registry,
        circuitBreaker: {
          allows: (executorId, providerId) =>
            availability.allows(executorId, providerId),
        },
        remainingBudgetUsd: request.remainingBudgetUsd,
        decidedAt: request.decidedAt,
      });
      const eliminated = outcome.decision.evaluations
        .filter((evaluation) => !evaluation.eligible)
        .map((evaluation) => ({
          executorId: evaluation.executorId,
          providerId: evaluation.providerId,
          reasons: [...evaluation.reasons],
        }));
      const fallback =
        outcome.action === "execute"
          ? outcome.plan.fallbacks.map((route) => ({
              executorId: route.executorId,
              providerId: route.providerId,
            }))
          : [];
      const selectedExecutorId =
        outcome.action === "execute" ? outcome.plan.primary.executorId : null;
      const providerId =
        outcome.action === "execute" ? outcome.plan.primary.providerId : null;
      const handoffReason =
        outcome.action === "human_handoff"
          ? outcome.handoff.reason
          : undefined;

      try {
        recordRoutingDecision(context.db, {
          tenantId: context.tenantId,
          jobId: context.jobId,
          runId: context.runId,
          taskKind: request.task.kind,
          envelopeId: outcome.decision.decisionId,
          policySnapshotId: request.policy.snapshotId,
          taskSnapshotId: request.task.inputArtifactIds[0]!,
          action: outcome.action,
          selectedExecutorId,
          providerId,
          eliminated,
          fallback,
          breaker: availability.snapshot,
          handoffRequired: outcome.action === "human_handoff",
          handoffReason,
          decision: outcome.decision,
          createdAt: request.decidedAt.toISOString(),
        });
      } catch (error) {
        throw new WardenRoutingSafetyError(
          "routing_decision_persistence_failed",
          error,
        );
      }

      if (outcome.action === "human_handoff") {
        return Object.freeze({
          envelopeId: outcome.decision.decisionId,
          action: "human_handoff",
          selectedExecutorId: null,
          reason: handoffReason,
        });
      }
      return Object.freeze({
        envelopeId: outcome.decision.decisionId,
        action: "execute",
        selectedExecutorId,
        dispatch: {
          executorId: outcome.plan.primary.executorId,
          providerId: outcome.plan.primary.providerId,
        },
      });
    },

    recordOutcome(
      envelopeId: string,
      outcome: WardenRoutingOutcomeInput,
    ): WardenRouterRecorded {
      const success = outcome.outcome === "succeeded";
      const breakerFeedback = breakerFeedbackForOutcome(outcome);
      const write = Object.freeze({
        tenantId: context.tenantId,
        jobId: context.jobId,
        envelopeId,
        idempotencyKey: outcome.idempotencyKey,
        idempotencyPayload: outcome,
        executorId: outcome.executorId,
        providerId: outcome.providerId,
        breakerFeedback,
        action: success ? "completed" : "human_handoff",
        outcome: outcome.outcome,
        errorCode: outcome.errorCode ?? null,
        costUsd: outcome.actualCostUsd,
        inputTokens: outcome.inputTokens ?? null,
        outputTokens: outcome.outputTokens ?? null,
        totalTokens: outcome.totalTokens ?? null,
        startedAt: outcome.startedAt,
        completedAt: outcome.completedAt,
        observedAt: outcome.completedAt,
        config,
      }) satisfies WardenRoutingOutcomeWrite;
      const recorded = Object.freeze({
        envelopeId,
        action: success ? "completed" : "human_handoff",
        selectedExecutorId: null,
      });
      if (!context.deferOutcomePersistence) return applyOutcome(write, recorded);

      const fingerprint = digest({ envelopeId, outcome });
      if (pendingOutcome && pendingOutcome.fingerprint !== fingerprint) {
        throw new WardenRoutingSafetyError(
          "routing_outcome_idempotency_conflict",
          new Error("routing_outcome_idempotency_conflict"),
        );
      }
      pendingOutcome ??= Object.freeze({ fingerprint, write, recorded });
      return pendingOutcome.recorded;
    },

    applyPendingOutcome(): WardenRouterRecorded | null {
      if (!pendingOutcome) return null;
      return applyOutcome(pendingOutcome.write, pendingOutcome.recorded);
    },
  };
}

function safeAvailability(
  context: WardenRoutingRuntimeContext,
  at: Date,
  config: RoutingBreakerConfig,
): { snapshot: readonly unknown[]; allows(executorId: string, providerId: string): boolean } {
  try {
    return loadRoutingAvailability(context.db, context.tenantId, at, config);
  } catch (error) {
    throw new WardenRoutingSafetyError(
      "routing_breaker_state_unavailable",
      error,
    );
  }
}

/**
 * Adapt a Warden attempt result into the `AgentRunResult` shape the shared
 * router dispatcher records outcomes against. A baseline-green rejection is a
 * successful no-op (nothing to fix); any other rejection is a failed outcome
 * that feeds the circuit breaker. The full attempt result is retained by the
 * caller for candidate persistence.
 */
export function synthesizeWardenRun(
  attempt: WardenAttemptResult,
  sessionId: string,
  goal: string,
): AgentRunResult {
  const noAction =
    attempt.status === "rejected" && attempt.code === WARDEN_NO_ACTION_CODE;
  const ok = attempt.status === "succeeded" || noAction;
  const stoppedReason =
    attempt.status === "succeeded"
      ? "verify_passed"
      : noAction
        ? "no_action"
        : attempt.code;
  // Real per-execution model usage measured by the attempt engine. The
  // AgentRunResult model shape is non-nullable, so an unmeasured heuristic-only
  // run (usage null) collapses to zero here; the honest null distinction is
  // preserved on the attempt summary and surfaced by
  // `wardenRoutingOutcomeAttribution` for ledger cost attribution.
  const usage = attempt.agent?.usage;
  return {
    sessionId,
    ok,
    goal,
    steps: [],
    filesChanged: attempt.status === "succeeded" ? [...attempt.changedPaths] : [],
    verifier: {
      command: undefined,
      source: "provided",
      status: ok ? "passed" : "failed",
      output: attempt.summary,
    },
    rollback: { performed: false, restoredFiles: [], failedFiles: [] },
    reportMarkdown: attempt.agent?.reportMarkdown ?? "",
    stoppedReason,
    missionPlan: attempt.agent?.missionPlan ?? null,
    metrics: {
      durationMs: 0,
      toolCalls: attempt.agent?.toolCalls ?? 0,
      verifierCalls: attempt.agent?.verifierCalls ?? 0,
      model: {
        calls: attempt.agent?.modelCalls ?? 0,
        successfulCalls: attempt.agent?.modelSuccessfulCalls ?? 0,
        failedCalls: 0,
        timeouts: 0,
        invalidResponses: 0,
        responseBytes: 0,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        costUsd: usage?.costUsd ?? 0,
        provenance: [],
      },
      sourceContext: attempt.agent?.sourceContext ?? {
        observedFiles: [],
        observedDirectories: [],
        searches: [],
        observedBytes: 0,
        promptEvidenceBytes: 0,
        truncatedObservations: 0,
        groundedMutations: 0,
        blockedMutations: 0,
        evidenceDigests: [],
      },
    },
  };
}
