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
  DEFAULT_ROUTING_BREAKER,
  loadRoutingAvailability,
  recordRoutingDecision,
  recordRoutingExecutorOutcome,
  recordRoutingOutcome,
  type AppDb,
  type RoutingBreakerConfig,
} from "@mendpoint/db";
import type {
  AgentRunResult,
  WardenAttemptResult,
  WardenRouterPrepared,
  WardenRouterRecorded,
  WardenRoutingRuntimePort,
} from "@mendpoint/agent";
import { nowIso } from "@mendpoint/shared";

const WARDEN_NO_ACTION_CODE = "warden_attempt_baseline_target_green";

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

const WARDEN_PRICE_EFFECTIVE_AT = "2026-01-01T00:00:00.000Z";

/** Register the Warden attempt executor descriptor for a routing pass. */
export function buildWardenExecutorRegistry(
  checkedAt: string = nowIso(),
): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(wardenExecutorDescriptor(checkedAt));
  return registry;
}

export function wardenExecutorDescriptor(
  checkedAt: string = nowIso(),
): ExecutorDescriptor {
  return {
    executorId: WARDEN_EXECUTOR_ID,
    providerId: WARDEN_PROVIDER_ID,
    kind: "deterministic_recipe",
    version: "warden-attempt-1",
    deployment: "internal",
    capabilities: ["warden.repair"],
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
  taskId: string;
  tenantId: string;
  goal: string;
  idempotencyKey: string;
  verifyCommand: string;
  policySnapshotId: string;
  maxOutputTokens?: number;
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
  const budgetUsd = input.budgetUsd ?? 25;
  return {
    taskId: input.taskId,
    tenantId: input.tenantId,
    kind: WARDEN_TASK_KIND,
    goal: input.goal,
    idempotencyKey: input.idempotencyKey,
    inputArtifactIds: [],
    requiredCapabilities: ["warden.repair"],
    allowedTools: [],
    context: {
      estimatedInputTokens: 0,
      maximumOutputTokens: input.maxOutputTokens ?? 8_192,
    },
    verification: {
      requiredChecks: [input.verifyCommand],
      requireAll: true,
      onFailure: "human_handoff",
    },
    fallbackPolicy: {
      enabled: true,
      maxAttempts: 3,
      sameExecutorRetries: 1,
      retryableFailures: ["timeout", "rate_limited", "provider_unavailable"],
      fallbackFailures: ["provider_unavailable", "executor_unavailable"],
    },
    privacy: { classification: input.classification ?? "confidential" },
    risk: input.risk ?? "medium",
    quality: { minimumScore: 0 },
    latency: { maximumMs: input.maximumLatencyMs ?? 3_600_000 },
    budget: { maximumUsd: budgetUsd },
  };
}

function buildPolicySnapshot(
  input: WardenRoutingRequestInput,
): RouterPolicySnapshot {
  return {
    snapshotId: input.policySnapshotId,
    version: 1,
    capturedAt: (input.decidedAt ?? new Date()).toISOString(),
    privacy: {
      allowedClassifications: [
        "public",
        "internal",
        "confidential",
        "restricted",
      ],
      externalProcessingAllowed: false,
    },
    region: { allowedExecutionRegions: [WARDEN_ROUTING_REGION] },
    risk: { maximumAutonomousRisk: "medium", humanReviewAtOrAbove: "high" },
    quality: { minimumScore: 0 },
    latency: { maximumMs: input.maximumLatencyMs ?? 3_600_000 },
    budget: { maximumUsd: input.budgetUsd ?? 25 },
  };
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
}>;

/**
 * Concrete `WardenRoutingRuntimePort` backed by the shared platform router and
 * the durable ledger + circuit-breaker state. All persistence is fail-closed:
 * a ledger or breaker write failure is logged and never propagates, so it can
 * never corrupt or block job completion.
 */
export function createWardenRoutingRuntime(
  context: WardenRoutingRuntimeContext,
): WardenRoutingRuntime {
  const config = context.breakerConfig ?? DEFAULT_ROUTING_BREAKER;
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

      persist(() =>
        recordRoutingDecision(context.db, {
          tenantId: context.tenantId,
          jobId: context.jobId,
          runId: context.runId,
          taskKind: request.task.kind,
          envelopeId: outcome.decision.decisionId,
          policySnapshotId: request.policy.snapshotId,
          taskSnapshotId: request.task.idempotencyKey,
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
        }),
      );

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
      // Outcome feedback into the durable breaker. Fail-closed: never throws.
      persist(() =>
        recordRoutingExecutorOutcome(context.db, {
          tenantId: context.tenantId,
          executorId: outcome.executorId,
          providerId: outcome.providerId,
          success,
          observedAt: outcome.completedAt,
          config,
        }),
      );
      persist(() =>
        recordRoutingOutcome(context.db, {
          tenantId: context.tenantId,
          jobId: context.jobId,
          envelopeId,
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
        }),
      );
      return Object.freeze({
        envelopeId,
        action: success ? "completed" : "human_handoff",
        selectedExecutorId: null,
      });
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
    // A breaker read failure must not block production routing: default to
    // allowing every executor (other policy filters still gate the decision).
    console.error(
      `  routing breaker state unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { snapshot: [], allows: () => true };
  }
}

function persist(write: () => unknown): void {
  try {
    write();
  } catch (error) {
    console.error(
      `  routing ledger write deferred: ${
        error instanceof Error ? error.message : String(error)
      }`,
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
