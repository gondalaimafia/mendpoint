import type { AgentRunResult, AgentTask } from "./types.js";

export type WardenRouterPrepared = Readonly<{
  envelopeId: string;
  action: "execute" | "retry" | "fallback" | "completed" | "human_handoff";
  selectedExecutorId: string | null;
  dispatch?: Readonly<{
    executorId: string;
    providerId: string;
    notBefore?: string;
  }>;
  reason?: string;
}>;

export type WardenRouterRecorded = Readonly<{
  envelopeId: string;
  action: "execute" | "retry" | "fallback" | "completed" | "human_handoff";
  selectedExecutorId: string | null;
  reason?: string;
}>;

/** Structural port implemented by the platform policy router runtime. */
export interface WardenRoutingRuntimePort<Request> {
  prepare(request: Request): WardenRouterPrepared;
  recordOutcome(
    envelopeId: string,
    outcome: Readonly<{
      idempotencyKey: string;
      executorId: string;
      providerId: string;
      outcome: "succeeded" | "failed" | "cancelled";
      startedAt: string;
      completedAt: string;
      actualLatencyMs: number;
      actualCostUsd: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      totalTokens?: number | null;
      errorCode?: string;
      verification: Readonly<{
        verdict: "passed" | "failed" | "unknown";
        evidenceArtifactIds: readonly string[];
        verifierId: string;
        verifierVersion?: string;
      }>;
    }>,
  ): WardenRouterRecorded;
}

export type RoutedWardenResult = Readonly<{
  routing: WardenRouterPrepared | WardenRouterRecorded;
  run: AgentRunResult | null;
}>;

export type RoutedWardenTelemetry = Readonly<{
  actualCostUsd: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  evidenceArtifactIds?: readonly string[];
  verifierId?: string;
  verifierVersion?: string;
}>;

export type WardenExecutorPort = Readonly<{
  executorId: string;
  providerId: string;
  run(
    task: AgentTask,
    dispatch: NonNullable<WardenRouterPrepared["dispatch"]>,
  ): Promise<AgentRunResult>;
}>;

/**
 * Policy-gated Warden entrypoint. It never activates an executor by itself:
 * the supplied runtime selects only previously registered executor descriptors.
 */
export async function runPolicyRoutedWarden<Request>(input: Readonly<{
  task: AgentTask;
  routingRequest: Request;
  runtime: WardenRoutingRuntimePort<Request>;
  outcomeIdempotencyKey: string;
  telemetry: (result: AgentRunResult) => RoutedWardenTelemetry;
  executor?: WardenExecutorPort;
  now?: () => Date;
}>): Promise<RoutedWardenResult> {
  if (!input.outcomeIdempotencyKey.trim()) {
    throw new Error("Warden routing outcome idempotency key is required");
  }
  const prepared = input.runtime.prepare(input.routingRequest);
  if (
    prepared.action === "human_handoff" ||
    prepared.action === "completed"
  ) {
    return Object.freeze({ routing: prepared, run: null });
  }
  if (!prepared.dispatch) {
    throw new Error("Warden routing decision is missing its dispatch evidence");
  }
  if (prepared.selectedExecutorId !== prepared.dispatch.executorId) {
    throw new Error("Warden routing decision has inconsistent executor identity");
  }
  if (!input.executor) {
    throw new Error("Warden routing execution port is required");
  }
  if (
    input.executor.executorId !== prepared.dispatch.executorId ||
    input.executor.providerId !== prepared.dispatch.providerId
  ) {
    throw new Error("Warden executor identity does not match the selected dispatch");
  }
  const boundExecutorId = input.executor.executorId;
  const boundProviderId = input.executor.providerId;

  const now = input.now ?? (() => new Date());
  if (
    prepared.dispatch.notBefore &&
    now().getTime() < Date.parse(prepared.dispatch.notBefore)
  ) {
    return Object.freeze({ routing: prepared, run: null });
  }
  const startedAt = now();
  if (!Number.isFinite(startedAt.getTime())) {
    throw new Error("Warden routing start time is invalid");
  }
  let result: AgentRunResult;
  try {
    result = await input.executor.run(input.task, prepared.dispatch);
  } catch (error) {
    const completedAt = now();
    if (!Number.isFinite(completedAt.getTime()) || completedAt < startedAt) {
      throw new Error("Warden routing completion time is invalid");
    }
    const rawCode = error instanceof Error ? error.message : "executor_unavailable";
    const errorCode = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(rawCode)
      ? rawCode
      : "executor_unavailable";
    input.runtime.recordOutcome(prepared.envelopeId, {
      idempotencyKey: input.outcomeIdempotencyKey,
      executorId: prepared.dispatch.executorId,
      providerId: prepared.dispatch.providerId,
      outcome: "failed",
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      actualLatencyMs: completedAt.getTime() - startedAt.getTime(),
      actualCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      errorCode,
      verification: {
        verdict: "unknown",
        evidenceArtifactIds: Object.freeze([]),
        verifierId: "warden-verifier",
      },
    });
    throw error;
  }
  if (
    input.executor.executorId !== boundExecutorId ||
    input.executor.providerId !== boundProviderId
  ) {
    throw new Error("Warden executor identity changed during execution");
  }
  const completedAt = now();
  if (!Number.isFinite(completedAt.getTime()) || completedAt < startedAt) {
    throw new Error("Warden routing completion time is invalid");
  }
  const telemetry = input.telemetry(result);
  if (
    telemetry.actualCostUsd !== null &&
    (!Number.isFinite(telemetry.actualCostUsd) || telemetry.actualCostUsd < 0)
  ) {
    throw new Error("Warden routing actual cost is invalid");
  }
  const verdict = result.verifier.status === "passed"
    ? "passed"
    : result.verifier.status === "failed" || result.verifier.status === "invalid"
      ? "failed"
      : "unknown";
  const routing = input.runtime.recordOutcome(prepared.envelopeId, {
    idempotencyKey: input.outcomeIdempotencyKey,
    executorId: prepared.dispatch.executorId,
    providerId: prepared.dispatch.providerId,
    outcome: result.ok ? "succeeded" : "failed",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    actualLatencyMs: completedAt.getTime() - startedAt.getTime(),
    actualCostUsd: telemetry.actualCostUsd,
    inputTokens: telemetry.inputTokens ?? null,
    outputTokens: telemetry.outputTokens ?? null,
    totalTokens: telemetry.totalTokens ?? null,
    errorCode: result.ok ? undefined : result.stoppedReason,
    verification: {
      verdict,
      evidenceArtifactIds: Object.freeze([...(telemetry.evidenceArtifactIds ?? [])]),
      verifierId: telemetry.verifierId ?? "warden-verifier",
      verifierVersion: telemetry.verifierVersion,
    },
  });
  return Object.freeze({ routing, run: result });
}
