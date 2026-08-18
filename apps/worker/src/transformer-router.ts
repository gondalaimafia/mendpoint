import { createHash } from "node:crypto";
import {
  ExecutorRegistry,
  type DataClassification,
  type ExecutorDescriptor,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
  type TaskRisk,
} from "@mendpoint/platform";
import type { AppDb, RoutingBreakerConfig } from "@mendpoint/db";
import {
  runPolicyRoutedWarden,
  type AgentRunResult,
  type WardenRouterPrepared,
  type WardenRouterRecorded,
} from "@mendpoint/agent";
import type {
  TransformerAttemptRunResult,
  TransformerPendingRoutingSettlement,
} from "@mendpoint/transformer";
import {
  createWardenRoutingRuntime,
  estimateSeedInputTokens,
  riskQualityFloor,
  wardenExecutorDescriptor,
} from "./warden-router.js";

/**
 * Durable policy-routed execution for the production Transformer attempt path.
 *
 * The Transformer pilot lane owns a separate execution store, snapshot loader,
 * and lease coordinator, and its attempt engine returns a Transformer-specific
 * result (`TransformerAttemptRunResult`) rather than the `AgentRunResult` the
 * executor contract requires. This module closes that gap: it registers the
 * Transformer attempt as a router executor (alongside Warden), invokes the
 * Transformer attempt path through the shared executor port, and maps every
 * Transformer status honestly onto the router's outcome contract so decisions
 * and outcomes persist to the same durable routing ledger with the same honest
 * cost/token attribution rule already established for Warden.
 */
export const TRANSFORMER_EXECUTOR_ID = "transformer-attempt";
// A provider distinct from Warden's `mendpoint-internal`. The durable breaker
// opens at both executor and provider scope, and `allows()` blocks any executor
// under an open provider. A shared provider would let a Transformer failure open
// the provider breaker and block Warden; a distinct provider keeps executor
// breaker state genuinely independent between the two executors.
export const TRANSFORMER_PROVIDER_ID = "mendpoint-transformer";
export const TRANSFORMER_ROUTING_REGION = "internal";
export const TRANSFORMER_TASK_KIND = "transformer.attempt";
export const TRANSFORMER_CAPABILITY = "transformer.recipe";

const TRANSFORMER_PRICE_EFFECTIVE_AT = "2026-01-01T00:00:00.000Z";

export type TransformerExternalRoutingProfile = Readonly<{
  provider: string;
  model: string;
  deployment: string;
  executionRegion: string;
  maximumDataClassification: DataClassification;
  maximumCostUsd: number;
}>;

function transformerExternalDeploymentIdentity(
  profile: TransformerExternalRoutingProfile,
): string {
  const canonical = JSON.stringify({
    deployment: profile.deployment,
    executionRegion: profile.executionRegion,
    model: profile.model,
    provider: profile.provider,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** Register the Transformer attempt executor descriptor for a routing pass. */
export function transformerExecutorDescriptor(
  checkedAt: string,
  external?: TransformerExternalRoutingProfile,
  executorIdOverride?: string,
): ExecutorDescriptor {
  const deploymentIdentity = external
    ? transformerExternalDeploymentIdentity(external)
    : undefined;
  return {
    executorId: executorIdOverride ?? (deploymentIdentity
      ? `transformer-model-${deploymentIdentity.slice("sha256:".length)}`
      : TRANSFORMER_EXECUTOR_ID),
    providerId: external?.provider ?? TRANSFORMER_PROVIDER_ID,
    kind: external ? "frontier_model" : "deterministic_recipe",
    version: external && deploymentIdentity
      ? `${external.model}@${external.deployment}@${deploymentIdentity}`
      : "transformer-attempt-1",
    deployment: external ? "external" : "internal",
    capabilities: [TRANSFORMER_CAPABILITY],
    tools: ["read_file", "write_file", "run_command"],
    regions: [external?.executionRegion ?? TRANSFORMER_ROUTING_REGION],
    price: {
      version: deploymentIdentity
        ? `transformer-model-price-${deploymentIdentity}`
        : "transformer-attempt-price-1",
      currency: "USD",
      effectiveAt: TRANSFORMER_PRICE_EFFECTIVE_AT,
    },
    limits: {
      maximumInputTokens: 4_000_000,
      maximumOutputTokens: 1_000_000,
      maximumConcurrentTasks: 8,
    },
    health: {
      status: "healthy",
      checkedAt,
      evidenceRef: "transformer-attempt-engine",
    },
    license: {
      id: "mendpoint-internal",
      commercialUse: true,
      redistribution: "not_applicable",
    },
    maximumDataClassification: external?.maximumDataClassification ?? "restricted",
    maximumRisk: "high",
    qualityScore: 0.9,
    estimatedLatencyMs: 60_000,
    estimatedCostUsd: external?.maximumCostUsd ?? 0,
  };
}

/**
 * Registry holding both real executors so the router genuinely selects between
 * them under the existing filters. A Warden task (requires `warden.repair`)
 * routes to Warden; a Transformer task (requires `transformer.recipe`) routes
 * to Transformer; the other executor is eliminated by capability. Breaker state
 * is keyed per executor, so a Transformer failure never contaminates Warden.
 */
export function buildRoutedExecutorRegistry(
  checkedAt: string,
  external?: TransformerExternalRoutingProfile,
  executorIdOverride?: string,
): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(wardenExecutorDescriptor(checkedAt));
  registry.register(transformerExecutorDescriptor(checkedAt, external, executorIdOverride));
  return registry;
}

export type TransformerRoutingRequestInput = Readonly<{
  taskId: string;
  tenantId: string;
  campaignId: string;
  idempotencyKey: string;
  /** Legacy caller field. Router policy identity is computed from policy content. */
  policySnapshotId?: string;
  sourceArtifactIds: readonly string[];
  goal?: string;
  verifyCommand?: string;
  maxOutputTokens?: number;
  /** Optional caller-supplied token estimate. Defaults to a seed estimate. */
  estimatedInputTokens?: number;
  risk?: TaskRisk;
  classification?: DataClassification;
  budgetUsd?: number;
  maximumLatencyMs?: number;
  externalProcessingAllowed?: boolean;
  allowedExecutionRegion?: string;
  decidedAt?: Date;
}>;

export type TransformerRoutingRequest = Readonly<{
  task: RouterTaskSpec;
  policy: RouterPolicySnapshot;
  remainingBudgetUsd: number;
  decidedAt: Date;
}>;

function buildTaskSpec(input: TransformerRoutingRequestInput): RouterTaskSpec {
  const budgetUsd = input.budgetUsd ?? 25;
  const goal = input.goal ?? `Regauge recipe migration for ${input.campaignId}`;
  // No honest change-risk signal exists at this call site: the runnable campaign
  // carries no blast radius or impact coverage (both are produced by the attempt,
  // after routing). Risk stays caller-supplied or the medium default — a
  // deliberate under-claim, not a fabricated derivation.
  const risk: TaskRisk = input.risk ?? "medium";
  return {
    taskId: input.taskId,
    tenantId: input.tenantId,
    kind: TRANSFORMER_TASK_KIND,
    goal,
    idempotencyKey: input.idempotencyKey,
    inputArtifactIds: [...input.sourceArtifactIds],
    requiredCapabilities: [TRANSFORMER_CAPABILITY],
    allowedTools: [],
    context: {
      estimatedInputTokens:
        input.estimatedInputTokens ??
        estimateSeedInputTokens([
          goal,
          input.verifyCommand,
          ...input.sourceArtifactIds,
        ]),
      maximumOutputTokens: input.maxOutputTokens ?? 8_192,
    },
    verification: {
      requiredChecks: [input.verifyCommand ?? "transformer.recipe.verify"],
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
    risk,
    quality: { minimumScore: riskQualityFloor(risk) },
    latency: { maximumMs: input.maximumLatencyMs ?? 3_600_000 },
    budget: { maximumUsd: budgetUsd },
  };
}

function buildPolicySnapshot(
  input: TransformerRoutingRequestInput,
): RouterPolicySnapshot {
  const body: Omit<RouterPolicySnapshot, "snapshotId" | "capturedAt"> = {
    version: 1,
    privacy: {
      allowedClassifications: [
        "public",
        "internal",
        "confidential",
        "restricted",
      ],
      externalProcessingAllowed: input.externalProcessingAllowed ?? false,
    },
    region: {
      allowedExecutionRegions: [input.allowedExecutionRegion ?? TRANSFORMER_ROUTING_REGION],
    },
    risk: { maximumAutonomousRisk: "medium", humanReviewAtOrAbove: "high" },
    // Baseline policy quality floor (§13.4). The effective minimum is the max of
    // this and the risk-adjusted task floor, so no executor below the baseline is
    // ever eligible and the `quality_below_minimum` gate can fire.
    quality: { minimumScore: 0.6 },
    latency: { maximumMs: input.maximumLatencyMs ?? 3_600_000 },
    budget: { maximumUsd: input.budgetUsd ?? 25 },
  };
  return {
    snapshotId: `sha256:${createHash("sha256")
      .update(JSON.stringify(body), "utf8")
      .digest("hex")}`,
    ...body,
    capturedAt: (input.decidedAt ?? new Date()).toISOString(),
  };
}

/** Build the routing request passed to `runRoutedTransformerAttempt`. */
export function transformerRoutingRequest(
  input: TransformerRoutingRequestInput,
): TransformerRoutingRequest {
  const decidedAt = input.decidedAt ?? new Date();
  return Object.freeze({
    task: buildTaskSpec(input),
    policy: buildPolicySnapshot(input),
    remainingBudgetUsd: input.budgetUsd ?? 25,
    decidedAt,
  });
}

/** Honest cost + token attribution derived from a Transformer attempt result. */
export type TransformerRoutingOutcomeAttribution = Readonly<{
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

const NULL_ATTRIBUTION: TransformerRoutingOutcomeAttribution = Object.freeze({
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
});

/**
 * Structural view of a measured-usage summary the Transformer attempt result
 * may expose. The Transformer attempt engine is deterministic today and does
 * not report model usage; a concurrent change is adding an additive adaptive
 * summary that may carry one. It is read defensively (optional, index-based)
 * so this module compiles and behaves correctly whether or not the field is
 * present yet, and never fabricates a measured value when none exists.
 */
type TransformerUsageLike = Readonly<{
  measured?: boolean;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}>;

function readTransformerUsage(
  result: TransformerAttemptRunResult,
): TransformerUsageLike | null {
  const record = result as unknown as Record<string, unknown>;
  const adaptive = record.adaptive as { usage?: unknown } | null | undefined;
  const raw =
    (adaptive && typeof adaptive === "object" ? adaptive.usage : undefined) ??
    record.usage;
  return raw && typeof raw === "object" ? (raw as TransformerUsageLike) : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Whether a usage summary reflects a real, measured model call. The Transformer
 * usage shape reports `number | null` fields (null when nothing was measured)
 * and may or may not carry an explicit `measured` flag. Honest-null rule: an
 * explicit `measured === false`, or a summary whose every field is null/absent,
 * is unmeasured; a summary carrying any finite numeric field is measured. A
 * deterministic recipe run makes no model call, so it stays unmeasured and its
 * ledger cost/tokens are null rather than a fabricated zero.
 */
function usageIsMeasured(usage: TransformerUsageLike): boolean {
  if (usage.measured === false) return false;
  if (usage.measured === true) return true;
  return (
    finiteOrNull(usage.costUsd) !== null ||
    finiteOrNull(usage.inputTokens ?? usage.promptTokens) !== null ||
    finiteOrNull(usage.outputTokens ?? usage.completionTokens) !== null ||
    finiteOrNull(usage.totalTokens) !== null
  );
}

/**
 * Cost + token attribution for a Transformer attempt, taken only from a
 * measured usage summary. A deterministic recipe run makes no model call, so
 * nothing is measured and every field is null rather than a fabricated zero
 * presented as a measured cost.
 */
export function transformerRoutingOutcomeAttribution(
  result: TransformerAttemptRunResult,
): TransformerRoutingOutcomeAttribution {
  const usage = readTransformerUsage(result);
  if (!usage || !usageIsMeasured(usage)) {
    return NULL_ATTRIBUTION;
  }
  return Object.freeze({
    costUsd: finiteOrNull(usage.costUsd),
    inputTokens: finiteOrNull(usage.inputTokens ?? usage.promptTokens),
    outputTokens: finiteOrNull(usage.outputTokens ?? usage.completionTokens),
    totalTokens: finiteOrNull(usage.totalTokens),
  });
}

/**
 * Adapt a Transformer attempt result into the `AgentRunResult` the router
 * records outcomes against. The status maps honestly:
 *   completed → ok (verification passed);
 *   failed    → not ok, carrying the real error / recovery code;
 *   stale     → not ok, fence-stale (the void, lease-lost outcome);
 *   idle      → not ok, nothing was eligible to execute.
 * The `AgentRunResult` model shape is non-nullable, so an unmeasured
 * deterministic run collapses to zero here; the honest null distinction is
 * preserved for the ledger by `transformerRoutingOutcomeAttribution`.
 */
export function synthesizeTransformerRun(
  result: TransformerAttemptRunResult,
  sessionId: string,
  goal: string,
): AgentRunResult {
  const ok = result.status === "completed";
  const usage = readTransformerUsage(result);
  const measured = usage ? usageIsMeasured(usage) : false;
  const stoppedReason = ok
    ? "verify_passed"
    : result.status === "stale"
      ? "transformer_attempt_fence_stale"
      : result.status === "idle"
        ? "transformer_attempt_idle"
        : result.errorCode ?? result.recoveryCode ?? "transformer_attempt_failed";
  return {
    sessionId,
    ok,
    goal,
    steps: [],
    filesChanged: [],
    verifier: {
      command: undefined,
      source: "provided",
      status: ok ? "passed" : "failed",
      output: result.summary,
    },
    rollback: {
      performed: result.rollback?.attempted ?? false,
      restoredFiles: [],
      failedFiles: [],
    },
    reportMarkdown: result.summary,
    stoppedReason,
    missionPlan: null,
    metrics: {
      durationMs: 0,
      toolCalls: 0,
      verifierCalls: 0,
      model: {
        calls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        timeouts: 0,
        invalidResponses: 0,
        responseBytes: 0,
        promptTokens: measured
          ? finiteOrZero(usage?.promptTokens ?? usage?.inputTokens)
          : 0,
        completionTokens: measured
          ? finiteOrZero(usage?.completionTokens ?? usage?.outputTokens)
          : 0,
        totalTokens: measured ? finiteOrZero(usage?.totalTokens) : 0,
        costUsd: measured ? finiteOrZero(usage?.costUsd) : 0,
        provenance: [],
      },
      sourceContext: {
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

/** Terminal disposition of a routed Transformer attempt. */
export type RoutedTransformerStatus =
  | "completed"
  | "failed"
  | "stale"
  | "idle"
  | "handoff";

export type RoutedTransformerAttempt = Readonly<{
  status: RoutedTransformerStatus;
  result: TransformerAttemptRunResult | null;
  routing: WardenRouterPrepared | WardenRouterRecorded | null;
  errorCode?: string;
}>;

/**
 * A stale fence and an idle poll are not merit outcomes: neither should feed
 * the executor breaker nor record a fabricated success/failure. They are
 * signalled out of the executor port (mirroring the Warden lease-lost throw)
 * so the router never records an outcome for them; the routing decision itself
 * is still persisted by the prepare step.
 */
class TransformerFenceStaleSignal extends Error {
  constructor() {
    super("transformer_attempt_fence_stale");
    this.name = "TransformerFenceStaleSignal";
  }
}

class TransformerIdleSignal extends Error {
  constructor() {
    super("transformer_attempt_idle");
    this.name = "TransformerIdleSignal";
  }
}

export type RunRoutedTransformerAttemptInput = Readonly<{
  db: AppDb;
  registry: ExecutorRegistry;
  tenantId: string;
  jobId: string;
  runId: string;
  routingRequest: TransformerRoutingRequest;
  outcomeIdempotencyKey: string;
  goal: string;
  sessionId: string;
  providerId?: string;
  executorId?: string;
  runAttempt: () => Promise<TransformerAttemptRunResult>;
  onPrepared?: (prepared: WardenRouterPrepared) => void;
  deferOutcomePersistence?: boolean;
  breakerConfig?: RoutingBreakerConfig;
  now?: () => Date;
}>;

/**
 * Route one Transformer attempt through the shared policy router. The router is
 * the dispatcher: it decides (execute vs mandatory human handoff), selects the
 * Transformer executor over Warden under the existing filters and breakers, and
 * persists the decision to the durable routing ledger. On execute, the
 * Transformer attempt path runs through the shared executor port; its result is
 * mapped honestly onto the router outcome contract with honest cost/token
 * attribution. Handoff blocks autonomous execution (the attempt never runs).
 */
export async function runRoutedTransformerAttempt(
  input: RunRoutedTransformerAttemptInput,
): Promise<RoutedTransformerAttempt> {
  const baseRuntime = createWardenRoutingRuntime({
    db: input.db,
    tenantId: input.tenantId,
    jobId: input.jobId,
    runId: input.runId,
    registry: input.registry,
    ...(input.breakerConfig ? { breakerConfig: input.breakerConfig } : {}),
    ...(input.deferOutcomePersistence ? { deferOutcomePersistence: true } : {}),
  });
  const runtime = input.onPrepared
    ? {
        prepare: (request: TransformerRoutingRequest) => {
          const prepared = baseRuntime.prepare(request);
          input.onPrepared!(prepared);
          return prepared;
        },
        recordOutcome: baseRuntime.recordOutcome,
      }
    : baseRuntime;
  let captured: TransformerAttemptRunResult | null = null;
  try {
    const routed = await runPolicyRoutedWarden<TransformerRoutingRequest>({
      task: { goal: input.goal, repoRoot: ".", tenantId: input.tenantId },
      routingRequest: input.routingRequest,
      runtime,
      outcomeIdempotencyKey: input.outcomeIdempotencyKey,
      ...(input.now ? { now: input.now } : {}),
      telemetry: () => {
        const attribution = captured
          ? transformerRoutingOutcomeAttribution(captured)
          : NULL_ATTRIBUTION;
        return {
          actualCostUsd: attribution.costUsd,
          inputTokens: attribution.inputTokens,
          outputTokens: attribution.outputTokens,
          totalTokens: attribution.totalTokens,
          verifierId: "transformer-attempt-verifier",
        };
      },
      executor: {
        executorId: input.executorId ?? TRANSFORMER_EXECUTOR_ID,
        providerId: input.providerId ?? TRANSFORMER_PROVIDER_ID,
        run: async () => {
          const result = await input.runAttempt();
          captured = result;
          if (result.status === "idle") throw new TransformerIdleSignal();
          if (result.status === "stale") throw new TransformerFenceStaleSignal();
          return synthesizeTransformerRun(result, input.sessionId, input.goal);
        },
      },
    });
    if (!routed.run) {
      return Object.freeze({
        status: "handoff",
        result: null,
        routing: routed.routing,
      });
    }
    const result = captured!;
    const errorCode =
      result.status === "completed"
        ? undefined
        : result.errorCode ?? result.recoveryCode;
    return Object.freeze({
      status: result.status === "completed" ? "completed" : "failed",
      result,
      routing: routed.routing,
      ...(errorCode ? { errorCode } : {}),
    });
  } catch (error) {
    if (error instanceof TransformerIdleSignal) {
      return Object.freeze({ status: "idle", result: captured, routing: null });
    }
    if (error instanceof TransformerFenceStaleSignal) {
      return Object.freeze({ status: "stale", result: captured, routing: null });
    }
    throw error;
  }
}

export function settleTransformerRoutingOutcome(input: Readonly<{
  db: AppDb;
  settlement: TransformerPendingRoutingSettlement;
  breakerConfig?: RoutingBreakerConfig;
}>): WardenRouterRecorded {
  const runtime = createWardenRoutingRuntime({
    db: input.db,
    tenantId: input.settlement.tenantId,
    jobId: input.settlement.campaignId,
    runId: input.settlement.runId,
    registry: buildRoutedExecutorRegistry(
      input.settlement.outcome.completedAt,
      input.settlement.outcome.providerId === TRANSFORMER_PROVIDER_ID
        ? undefined
        : {
            provider: input.settlement.outcome.providerId,
            model: "settled-external-model",
            deployment: "settled-external-deployment",
            executionRegion: TRANSFORMER_ROUTING_REGION,
            maximumDataClassification: "restricted",
            maximumCostUsd: input.settlement.outcome.actualCostUsd ?? 0,
          },
      input.settlement.outcome.executorId,
    ),
    ...(input.breakerConfig ? { breakerConfig: input.breakerConfig } : {}),
  });
  return runtime.recordOutcome(
    input.settlement.envelopeId,
    input.settlement.outcome,
  );
}
