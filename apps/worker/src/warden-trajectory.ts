/**
 * Warden attempt trajectory persistence (Intelligence Ownership Phases 4 + 7).
 *
 * The attempt engine (`@mendpoint/agent`) cannot import `@mendpoint/db`, so it
 * emits a serializable `WardenAttemptCapture` DTO on `WardenAttemptResult`. This
 * module is the worker-side bridge: it holds the db handle and translates that
 * DTO into durable trajectory rows using the `packages/db/src/trajectory.ts`
 * primitives, which redact and content-address every text payload before it is
 * written.
 *
 * Three invariants:
 *   - Best-effort: a trajectory write failing must NEVER fail the attempt. Every
 *     path here is wrapped and returns a result; it never throws.
 *   - Not silently swallowed: on failure the trajectory row is created (or kept)
 *     and marked `captureStatus: "failed"`, so an EMPTY trajectory (capture
 *     failed) is distinguishable from a task that never ran (no row at all).
 *   - Tenant-scoped from the authenticated principal (`params.tenantId`), never
 *     from any value inside the capture DTO.
 */
import {
  finalizeTrajectory,
  recordModelCall,
  recordToolCall,
  recordTrajectory,
  recordVerificationStep,
  type AppDb,
} from "@mendpoint/db";
import type { WardenAttemptCapture } from "@mendpoint/agent";
import { newId } from "@mendpoint/shared";

export type WardenTrajectoryEmitResult =
  | Readonly<{ ok: true; trajectoryId: string; steps: number }>
  | Readonly<{ ok: false; trajectoryId: string | null; error: string }>;

export type PersistWardenTrajectoryParams = Readonly<{
  /** Authenticated principal. Never sourced from the capture DTO or a request. */
  tenantId: string;
  capture: WardenAttemptCapture;
  jobId: string;
  runId?: string | null;
  missionId?: string | null;
  createdAt: string;
  /** Deterministic id override (tests); a fresh id is minted otherwise. */
  trajectoryId?: string;
}>;

function baseProvenance(capture: WardenAttemptCapture): Record<string, unknown> {
  return {
    captureSchemaVersion: capture.schemaVersion,
    modelId: capture.modelId,
    modelMeasured: capture.modelMeasured,
    modelProvenance: capture.modelProvenance,
  };
}

/**
 * Persist one Warden attempt trajectory. Returns a result describing what landed;
 * it never throws. When `ok` is false the trajectory row (if it could be written)
 * is marked as a capture failure so the empty trajectory is not mistaken for a
 * run that produced nothing.
 */
export function persistWardenTrajectory(
  db: AppDb,
  params: PersistWardenTrajectoryParams,
): WardenTrajectoryEmitResult {
  const { tenantId, capture, jobId, createdAt } = params;
  const trajectoryId = params.trajectoryId ?? newId();
  const runId = capture.runId ?? params.runId ?? null;
  try {
    recordTrajectory(db, {
      id: trajectoryId,
      tenantId,
      product: capture.product,
      taskKind: capture.taskKind,
      taskSummary: capture.taskSummary,
      ...(params.missionId ? { missionId: params.missionId } : {}),
      runId,
      jobId,
      availableTools: capture.availableTools,
      sandboxBackend: capture.sandboxBackend,
      finalOutcome: capture.finalOutcome,
      // Acceptance is decided later at the human approval gate, not at attempt
      // time; record it as pending (null) rather than fabricating a verdict.
      accepted: null,
      costUsd: capture.costUsd,
      costMeasured: capture.costMeasured,
      latencyMs: capture.latencyMs,
      provenance: { ...baseProvenance(capture), captureStatus: "pending" },
      createdAt,
    });

    let stepIndex = 0;
    // Blocker #1: the model-mediated (input -> output) pair, recorded ONLY when a
    // model actually answered (the provider-echoed model). A heuristic-only run
    // has no model-mediated pair, so none is fabricated. `input` is the observable
    // assembled context; `output` is the observable produced change. Both are
    // redacted and content-addressed by the store.
    if (capture.modelId) {
      recordModelCall(db, {
        id: `${trajectoryId}-model-${stepIndex}`,
        tenantId,
        trajectoryId,
        stepIndex: stepIndex++,
        input: capture.assembledContext,
        output: capture.output,
        modelId: capture.modelId,
        createdAt,
      });
    }

    // Blocker #4: every observable tool call, with its arguments and result.
    for (const tool of capture.toolSteps) {
      recordToolCall(db, {
        id: `${trajectoryId}-tool-${stepIndex}`,
        tenantId,
        trajectoryId,
        stepIndex: stepIndex++,
        toolName: tool.toolName,
        args: tool.args,
        result: tool.result,
        ok: tool.ok,
        error: tool.error,
        plannerSource: tool.plannerSource,
        createdAt,
      });
    }

    // Verification: verdict, exit code, command, and the sandbox backend that
    // actually ran. Test / exit-code signals are HARD and can never be promoted
    // from a soft model opinion (the class is stored, not inferred later).
    for (const verification of capture.verifications) {
      recordVerificationStep(db, {
        id: `${trajectoryId}-verify-${stepIndex}`,
        tenantId,
        trajectoryId,
        stepIndex: stepIndex++,
        verification: {
          verifierId: null,
          verifierModelId: null,
          verdict: verification.verdict,
          signalClass: "hard",
          exitCode: verification.exitCode,
          command: verification.command,
          sandboxBackend: verification.sandboxBackend,
          confidence: null,
          rationaleRef: null,
          latencyMs: null,
          costUsd: null,
        },
        createdAt,
      });
    }

    finalizeTrajectory(db, {
      tenantId,
      trajectoryId,
      provenance: {
        ...baseProvenance(capture),
        captureStatus: "complete",
        stepCount: stepIndex,
      },
    });
    return { ok: true, trajectoryId, steps: stepIndex };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Make the failure durable and distinguishable. `recordTrajectory` is
    // idempotent on id, so if the row already exists this is a no-op create; if
    // the original failure was the create itself, this best-effort retry (and
    // its own guard) surfaces the failure through the log only.
    let markedTrajectoryId: string | null = trajectoryId;
    try {
      recordTrajectory(db, {
        id: trajectoryId,
        tenantId,
        product: capture.product,
        taskKind: capture.taskKind,
        taskSummary: capture.taskSummary,
        ...(params.missionId ? { missionId: params.missionId } : {}),
        runId,
        jobId,
        sandboxBackend: capture.sandboxBackend,
        finalOutcome: capture.finalOutcome,
        createdAt,
      });
      finalizeTrajectory(db, {
        tenantId,
        trajectoryId,
        provenance: {
          ...baseProvenance(capture),
          captureStatus: "failed",
          captureError: message.slice(0, 500),
        },
      });
    } catch {
      markedTrajectoryId = null;
    }
    console.error(
      `warden trajectory capture failed job=${jobId} run=${runId ?? "?"}: ${message}`,
    );
    return { ok: false, trajectoryId: markedTrajectoryId, error: message };
  }
}
