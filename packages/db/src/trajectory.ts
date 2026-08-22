import { createHash } from "node:crypto";
import { redactSourceForModel, type SourceRedactionExclusionReason } from "@mendpoint/shared";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";

// Trajectory capture — the OBSERVATION layer (Intelligence Ownership Phases 4 + 7).
//
// This module records the agent's observable path through a task so that the
// (input -> output) pair (Phase 0 blocker #1) and the tool-call trajectory
// (blocker #4) become recoverable from durable storage. It is deliberately NOT a
// learning-event store, corpus, or pipeline: those are Codex-owned
// (`packages/pipeline/src/learning-*.ts`). Where a step must reference a learning
// event, a router decision, or a model reservation it does so by id/digest ONLY,
// never by copying the referenced record's fields.
//
// Two hard rules the schema enforces structurally:
//   1. NEVER persist hidden chain-of-thought (spec 8.12). Only observable inputs
//      (the assembled context) and observable outputs (completions, tool results)
//      are stored. Callers pass the observable request/response text; there is no
//      column for private reasoning.
//   2. NEVER persist raw unredacted source. Every text payload is passed through
//      `redactSourceForModel` before it is written. That redactor fails closed on
//      high-entropy residue: when it excludes, the content is dropped and only a
//      digest + exclusion reason survive, so a secret can never reach the table.
//
// All three tables are brand-new, so they converge on both a fresh database and a
// pre-change database purely through `CREATE TABLE IF NOT EXISTS` in the static
// DDL (the mission-table precedent, PR #169) with no ALTER and no shape change to
// any existing table. `trajectory_blobs` and `trajectory_steps` are append-only:
// this module exposes no update or delete of a recorded step or blob.

export type TrajectoryProduct = "fettler" | "regauge";

export type TrajectoryStepKind =
  | "model_call"
  | "tool_call"
  | "router_decision"
  | "verification"
  | "retrieval"
  | "review"
  | "edit";

// Precedence class for a signal (Phase 6 seam): tests, compiler output, ground
// truth, and human correction are HARD; a model verifier's opinion is SOFT and
// must never override. Encoded in data so a later change cannot silently promote
// a soft signal by editing consuming code.
export type TrajectorySignalClass = "hard" | "soft";

export type TrajectoryBlobRef = Readonly<{
  contentSha256: string;
  byteLength: number;
  redactionApplied: boolean;
  redactionExcluded: boolean;
  redactionReason: SourceRedactionExclusionReason | null;
  truncated: boolean;
}>;

export type TrajectoryBlob = TrajectoryBlobRef &
  Readonly<{
    tenantId: string;
    /** Redacted content; null only when redaction fell closed (excluded). */
    contentText: string | null;
    createdAt: string;
  }>;

export type Trajectory = Readonly<{
  id: string;
  tenantId: string;
  missionId: string | null;
  product: TrajectoryProduct;
  taskKind: string;
  taskSummary: string;
  runId: string | null;
  jobId: string | null;
  contextRefs: readonly unknown[];
  availableTools: readonly string[];
  sandboxBackend: string | null;
  finalOutcome: string | null;
  accepted: string | null;
  costUsd: number | null;
  costMeasured: boolean;
  latencyMs: number | null;
  provenance: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;

export type TrajectoryVerification = Readonly<{
  verifierId: string | null;
  verifierModelId: string | null;
  verdict: string;
  signalClass: TrajectorySignalClass;
  exitCode: number | null;
  command: string | null;
  sandboxBackend: string | null;
  confidence: number | null;
  rationaleRef: string | null;
  latencyMs: number | null;
  costUsd: number | null;
}>;

export type TrajectoryStep = Readonly<{
  id: string;
  trajectoryId: string;
  tenantId: string;
  stepIndex: number;
  stepKind: TrajectoryStepKind;
  toolName: string | null;
  plannerSource: string | null;
  inputBlobSha256: string | null;
  outputBlobSha256: string | null;
  modelId: string | null;
  reservationRef: string | null;
  routerDecisionRef: string | null;
  learningEventRef: string | null;
  verification: TrajectoryVerification | null;
  ok: boolean | null;
  error: string | null;
  /**
   * Typed reason a tool step carries `ok: false`
   * ("bad_arguments" | "policy_refusal" | "infra_failure" | "target_failure" |
   * "undetermined"), recorded verbatim from the tool result. Null on success and
   * on step kinds that never set it, so null reads as "no failure recorded"
   * rather than a fabricated class.
   */
  failureClass: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}>;

// Default ceiling for an inlined redacted payload. Larger content is stored
// truncated (the `truncated` flag records that) and always referenced by digest,
// so the steps table never inlines an unbounded blob.
export const MAX_TRAJECTORY_BLOB_CHARS = 200_000;

type BlobRow = {
  tenant_id: string;
  content_sha256: string;
  content_text: string | null;
  byte_length: number;
  redaction_applied: number;
  redaction_excluded: number;
  redaction_reason: string | null;
  truncated: number;
  created_at: string;
};

type TrajectoryRow = {
  id: string;
  tenant_id: string;
  mission_id: string | null;
  product: TrajectoryProduct;
  task_kind: string;
  task_summary: string;
  run_id: string | null;
  job_id: string | null;
  context_refs_json: string;
  available_tools_json: string;
  sandbox_backend: string | null;
  final_outcome: string | null;
  accepted: string | null;
  cost_usd: number | null;
  cost_measured: number;
  latency_ms: number | null;
  provenance_json: string;
  created_at: string;
};

type StepRow = {
  id: string;
  trajectory_id: string;
  tenant_id: string;
  step_index: number;
  step_kind: TrajectoryStepKind;
  tool_name: string | null;
  planner_source: string | null;
  input_blob_sha256: string | null;
  output_blob_sha256: string | null;
  model_id: string | null;
  reservation_ref: string | null;
  router_decision_ref: string | null;
  learning_event_ref: string | null;
  verification_json: string | null;
  ok: number | null;
  error: string | null;
  failure_class: string | null;
  cost_usd: number | null;
  latency_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function all<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function required(name: string, value: string): string {
  const result = value.trim();
  if (!result || result.length > 512) throw new Error(`${name}_invalid`);
  return result;
}

function assertTenant(db: AppDb, tenantId: string): void {
  const id = required("trajectory_tenant_id", tenantId);
  if (!one(db, `SELECT id FROM tenants WHERE id = ?`, [id])) {
    throw new Error("trajectory_tenant_not_found");
  }
}

function blobRef(row: BlobRow): TrajectoryBlobRef {
  return Object.freeze({
    contentSha256: row.content_sha256,
    byteLength: row.byte_length,
    redactionApplied: row.redaction_applied === 1,
    redactionExcluded: row.redaction_excluded === 1,
    redactionReason: (row.redaction_reason as SourceRedactionExclusionReason | null) ?? null,
    truncated: row.truncated === 1,
  });
}

function blob(row: BlobRow): TrajectoryBlob {
  return Object.freeze({
    ...blobRef(row),
    tenantId: row.tenant_id,
    contentText: row.content_text,
    createdAt: row.created_at,
  });
}

function trajectory(row: TrajectoryRow): Trajectory {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    product: row.product,
    taskKind: row.task_kind,
    taskSummary: row.task_summary,
    runId: row.run_id,
    jobId: row.job_id,
    contextRefs: Object.freeze(safeJsonArray(row.context_refs_json)),
    availableTools: Object.freeze(safeStringArray(row.available_tools_json)),
    sandboxBackend: row.sandbox_backend,
    finalOutcome: row.final_outcome,
    accepted: row.accepted,
    costUsd: row.cost_usd,
    costMeasured: row.cost_measured === 1,
    latencyMs: row.latency_ms,
    provenance: Object.freeze(safeJsonObject(row.provenance_json)),
    createdAt: row.created_at,
  });
}

function step(row: StepRow): TrajectoryStep {
  return Object.freeze({
    id: row.id,
    trajectoryId: row.trajectory_id,
    tenantId: row.tenant_id,
    stepIndex: row.step_index,
    stepKind: row.step_kind,
    toolName: row.tool_name,
    plannerSource: row.planner_source,
    inputBlobSha256: row.input_blob_sha256,
    outputBlobSha256: row.output_blob_sha256,
    modelId: row.model_id,
    reservationRef: row.reservation_ref,
    routerDecisionRef: row.router_decision_ref,
    learningEventRef: row.learning_event_ref,
    verification: row.verification_json
      ? (JSON.parse(row.verification_json) as TrajectoryVerification)
      : null,
    ok: row.ok === null ? null : row.ok === 1,
    error: row.error,
    failureClass: row.failure_class,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  });
}

function safeJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeStringArray(value: string): string[] {
  return safeJsonArray(value).filter((entry): entry is string => typeof entry === "string");
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Content-address a text payload and store its REDACTED form, keyed by the digest
 * of the ORIGINAL bytes so the address is stable and joinable to existing digests
 * (e.g. `fettler_model_reservations.request_digest`). Deduplicated per tenant: an
 * identical payload is written once. Redaction is always applied; when it falls
 * closed (`excluded`), no content is stored — only the digest, byte length, and
 * the exclusion reason — so raw secret material never reaches the table.
 */
export function putTrajectoryBlob(
  db: AppDb,
  input: {
    tenantId: string;
    content: string;
    maxChars?: number;
    createdAt: string;
  },
): TrajectoryBlobRef {
  assertTenant(db, input.tenantId);
  const content = input.content;
  const contentSha256 = sha256Hex(content);
  const existing = one<BlobRow>(
    db,
    `SELECT * FROM trajectory_blobs WHERE tenant_id = ? AND content_sha256 = ?`,
    [input.tenantId, contentSha256],
  );
  if (existing) return blobRef(existing);

  const byteLength = Buffer.byteLength(content, "utf8");
  const maxChars = Math.min(
    Math.max(1, input.maxChars ?? MAX_TRAJECTORY_BLOB_CHARS),
    1_000_000,
  );
  const redaction = redactSourceForModel(content, maxChars);
  const contentText = redaction.excluded ? null : redaction.text;

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO trajectory_blobs
        (tenant_id, content_sha256, content_text, byte_length, redaction_applied,
         redaction_excluded, redaction_reason, truncated, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      input.tenantId,
      contentSha256,
      contentText,
      byteLength,
      redaction.excluded ? 1 : 0,
      redaction.exclusionReason,
      redaction.truncated ? 1 : 0,
      input.createdAt,
    );

  return blobRef(
    one<BlobRow>(
      db,
      `SELECT * FROM trajectory_blobs WHERE tenant_id = ? AND content_sha256 = ?`,
      [input.tenantId, contentSha256],
    )!,
  );
}

export function readTrajectoryBlob(
  db: AppDb,
  tenantId: string,
  contentSha256: string,
): TrajectoryBlob | undefined {
  const row = one<BlobRow>(
    db,
    `SELECT * FROM trajectory_blobs WHERE tenant_id = ? AND content_sha256 = ?`,
    [tenantId, contentSha256],
  );
  return row ? blob(row) : undefined;
}

/**
 * Open a trajectory. Idempotent on `id`: a repeated create with the same
 * immutable identity fields returns the existing row; a conflicting redefinition
 * throws. Steps are appended separately.
 */
export function recordTrajectory(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    product: TrajectoryProduct;
    taskKind: string;
    taskSummary: string;
    missionId?: string | null;
    runId?: string | null;
    jobId?: string | null;
    contextRefs?: readonly unknown[];
    availableTools?: readonly string[];
    sandboxBackend?: string | null;
    finalOutcome?: string | null;
    accepted?: string | null;
    costUsd?: number | null;
    costMeasured?: boolean;
    latencyMs?: number | null;
    provenance?: Record<string, unknown>;
    createdAt: string;
  },
): Trajectory {
  const id = required("trajectory_id", input.id);
  assertTenant(db, input.tenantId);
  if (input.product !== "fettler" && input.product !== "regauge") {
    throw new Error("trajectory_product_invalid");
  }
  const taskKind = required("trajectory_task_kind", input.taskKind);
  const taskSummary = input.taskSummary.slice(0, 4000);
  const missionId = input.missionId ?? null;
  if (
    missionId &&
    !one(db, `SELECT id FROM mission WHERE id = ? AND tenant_id = ?`, [missionId, input.tenantId])
  ) {
    throw new Error("trajectory_mission_tenant_mismatch");
  }

  const existing = one<TrajectoryRow>(db, `SELECT * FROM trajectories WHERE id = ?`, [id]);
  if (existing) {
    const value = trajectory(existing);
    if (
      value.tenantId !== input.tenantId ||
      value.product !== input.product ||
      value.taskKind !== taskKind ||
      value.missionId !== missionId
    ) {
      throw new Error("trajectory_id_conflict");
    }
    return value;
  }

  db.raw
    .prepare(
      `INSERT INTO trajectories
        (id, tenant_id, mission_id, product, task_kind, task_summary, run_id, job_id,
         context_refs_json, available_tools_json, sandbox_backend, final_outcome, accepted,
         cost_usd, cost_measured, latency_ms, provenance_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.tenantId,
      missionId,
      input.product,
      taskKind,
      taskSummary,
      input.runId ?? null,
      input.jobId ?? null,
      JSON.stringify(input.contextRefs ?? []),
      JSON.stringify(input.availableTools ?? []),
      input.sandboxBackend ?? null,
      input.finalOutcome ?? null,
      input.accepted ?? null,
      input.costUsd ?? null,
      input.costMeasured ? 1 : 0,
      input.latencyMs ?? null,
      JSON.stringify(input.provenance ?? {}),
      input.createdAt,
    );

  return trajectory(one<TrajectoryRow>(db, `SELECT * FROM trajectories WHERE id = ?`, [id])!);
}

/**
 * Update the terminal fields of a trajectory once the run settles. Immutable
 * identity fields (tenant, product, task, mission) are never touched here.
 */
export function finalizeTrajectory(
  db: AppDb,
  input: {
    tenantId: string;
    trajectoryId: string;
    finalOutcome?: string | null;
    accepted?: string | null;
    sandboxBackend?: string | null;
    costUsd?: number | null;
    costMeasured?: boolean;
    latencyMs?: number | null;
    provenance?: Record<string, unknown>;
  },
): Trajectory {
  const current = one<TrajectoryRow>(
    db,
    `SELECT * FROM trajectories WHERE id = ? AND tenant_id = ?`,
    [input.trajectoryId, input.tenantId],
  );
  if (!current) throw new Error("trajectory_not_found");
  db.raw
    .prepare(
      `UPDATE trajectories SET
         final_outcome = COALESCE(?, final_outcome),
         accepted = COALESCE(?, accepted),
         sandbox_backend = COALESCE(?, sandbox_backend),
         cost_usd = COALESCE(?, cost_usd),
         cost_measured = ?,
         latency_ms = COALESCE(?, latency_ms),
         provenance_json = ?
       WHERE id = ? AND tenant_id = ?`,
    )
    .run(
      input.finalOutcome ?? null,
      input.accepted ?? null,
      input.sandboxBackend ?? null,
      input.costUsd ?? null,
      input.costMeasured === undefined ? current.cost_measured : input.costMeasured ? 1 : 0,
      input.latencyMs ?? null,
      input.provenance ? JSON.stringify(input.provenance) : current.provenance_json,
      input.trajectoryId,
      input.tenantId,
    );
  return trajectory(
    one<TrajectoryRow>(db, `SELECT * FROM trajectories WHERE id = ?`, [input.trajectoryId])!,
  );
}

function assertTrajectoryScope(db: AppDb, tenantId: string, trajectoryId: string): void {
  if (
    !one(db, `SELECT id FROM trajectories WHERE id = ? AND tenant_id = ?`, [trajectoryId, tenantId])
  ) {
    throw new Error("trajectory_not_found");
  }
}

type RecordStepBase = {
  id: string;
  tenantId: string;
  trajectoryId: string;
  stepIndex: number;
  plannerSource?: string | null;
  ok?: boolean | null;
  error?: string | null;
  failureClass?: string | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
};

function insertStep(
  db: AppDb,
  base: RecordStepBase,
  fields: {
    stepKind: TrajectoryStepKind;
    toolName?: string | null;
    inputBlobSha256?: string | null;
    outputBlobSha256?: string | null;
    modelId?: string | null;
    reservationRef?: string | null;
    routerDecisionRef?: string | null;
    learningEventRef?: string | null;
    verification?: TrajectoryVerification | null;
  },
): TrajectoryStep {
  const id = required("trajectory_step_id", base.id);
  assertTenant(db, base.tenantId);
  assertTrajectoryScope(db, base.tenantId, base.trajectoryId);
  if (!Number.isInteger(base.stepIndex) || base.stepIndex < 0) {
    throw new Error("trajectory_step_index_invalid");
  }
  db.raw
    .prepare(
      `INSERT INTO trajectory_steps
        (id, trajectory_id, tenant_id, step_index, step_kind, tool_name, planner_source,
         input_blob_sha256, output_blob_sha256, model_id, reservation_ref, router_decision_ref,
         learning_event_ref, verification_json, ok, error, failure_class, cost_usd, latency_ms,
         started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      base.trajectoryId,
      base.tenantId,
      base.stepIndex,
      fields.stepKind,
      fields.toolName ?? null,
      base.plannerSource ?? null,
      fields.inputBlobSha256 ?? null,
      fields.outputBlobSha256 ?? null,
      fields.modelId ?? null,
      fields.reservationRef ?? null,
      fields.routerDecisionRef ?? null,
      fields.learningEventRef ?? null,
      fields.verification ? JSON.stringify(fields.verification) : null,
      base.ok === undefined || base.ok === null ? null : base.ok ? 1 : 0,
      base.error ?? null,
      base.failureClass ?? null,
      base.costUsd ?? null,
      base.latencyMs ?? null,
      base.startedAt ?? null,
      base.endedAt ?? null,
      base.createdAt,
    );
  return step(one<StepRow>(db, `SELECT * FROM trajectory_steps WHERE id = ?`, [id])!);
}

/**
 * Blocker #1: persist a model-mediated (input -> output) pair. The exact assembled
 * context and the exact completion are each content-addressed and redacted, then
 * referenced by digest on the step. `modelId` records whatever the call ACTUALLY
 * used (the provider's echo) — never a hardcoded model name. A learning event, if
 * one was emitted for this call, is linked by id only (`learningEventRef`).
 */
export function recordModelCall(
  db: AppDb,
  input: RecordStepBase & {
    input: string;
    output: string;
    modelId?: string | null;
    reservationRef?: string | null;
    routerDecisionRef?: string | null;
    learningEventRef?: string | null;
    maxChars?: number;
  },
): TrajectoryStep {
  const inputBlob = putTrajectoryBlob(db, {
    tenantId: input.tenantId,
    content: input.input,
    maxChars: input.maxChars,
    createdAt: input.createdAt,
  });
  const outputBlob = putTrajectoryBlob(db, {
    tenantId: input.tenantId,
    content: input.output,
    maxChars: input.maxChars,
    createdAt: input.createdAt,
  });
  return insertStep(db, input, {
    stepKind: "model_call",
    inputBlobSha256: inputBlob.contentSha256,
    outputBlobSha256: outputBlob.contentSha256,
    modelId: input.modelId ?? null,
    reservationRef: input.reservationRef ?? null,
    routerDecisionRef: input.routerDecisionRef ?? null,
    learningEventRef: input.learningEventRef ?? null,
  });
}

/**
 * Blocker #4: persist a tool call. The tool name, its arguments, and its result
 * are recorded; arguments and result are content-addressed and redacted through
 * the same blob store, so a secret in an argument or result never lands raw.
 */
export function recordToolCall(
  db: AppDb,
  input: RecordStepBase & {
    toolName: string;
    args: string;
    result: string;
    maxChars?: number;
  },
): TrajectoryStep {
  const argsBlob = putTrajectoryBlob(db, {
    tenantId: input.tenantId,
    content: input.args,
    maxChars: input.maxChars,
    createdAt: input.createdAt,
  });
  const resultBlob = putTrajectoryBlob(db, {
    tenantId: input.tenantId,
    content: input.result,
    maxChars: input.maxChars,
    createdAt: input.createdAt,
  });
  return insertStep(db, input, {
    stepKind: "tool_call",
    toolName: required("trajectory_tool_name", input.toolName),
    inputBlobSha256: argsBlob.contentSha256,
    outputBlobSha256: resultBlob.contentSha256,
  });
}

/**
 * Record a verification step. Captures the verdict, exit code, command, and the
 * sandbox backend that actually ran (a Phase 4 gap: `configuredSandboxKind()` is
 * recorded nowhere today). `signalClass` is stored so a soft model-verifier verdict
 * can never be promoted to a hard signal by a later code change.
 */
export function recordVerificationStep(
  db: AppDb,
  input: RecordStepBase & {
    verification: TrajectoryVerification;
    outputText?: string | null;
    maxChars?: number;
  },
): TrajectoryStep {
  let outputSha: string | null = null;
  if (input.outputText !== undefined && input.outputText !== null) {
    outputSha = putTrajectoryBlob(db, {
      tenantId: input.tenantId,
      content: input.outputText,
      maxChars: input.maxChars,
      createdAt: input.createdAt,
    }).contentSha256;
  }
  return insertStep(db, input, {
    stepKind: "verification",
    outputBlobSha256: outputSha,
    verification: input.verification,
  });
}

/**
 * Record a router decision by REFERENCE to the router-owned `routing_ledger` row.
 * No routing fields are copied here — only the ledger id/envelope, honoring the
 * ownership boundary.
 */
export function recordRouterDecisionStep(
  db: AppDb,
  input: RecordStepBase & {
    routerDecisionRef: string;
    modelId?: string | null;
  },
): TrajectoryStep {
  return insertStep(db, input, {
    stepKind: "router_decision",
    routerDecisionRef: required("trajectory_router_decision_ref", input.routerDecisionRef),
    modelId: input.modelId ?? null,
  });
}

export function getTrajectory(
  db: AppDb,
  tenantId: string,
  trajectoryId: string,
): Trajectory | undefined {
  const row = one<TrajectoryRow>(
    db,
    `SELECT * FROM trajectories WHERE id = ? AND tenant_id = ?`,
    [trajectoryId, tenantId],
  );
  return row ? trajectory(row) : undefined;
}

/**
 * Resolve the trajectory recorded for one run, tenant-scoped, using the
 * (tenant_id, run_id) index. Read-only. A run may in principle have more than one
 * trajectory row (e.g. a re-attempt); the most recent is returned. Returns
 * undefined when no trajectory was captured for the run — the caller MUST treat
 * that absence as "not recorded", never as "nothing was supplied": the two are
 * different facts and only one is knowable from a missing row.
 */
export function getTrajectoryByRun(
  db: AppDb,
  tenantId: string,
  runId: string,
): Trajectory | undefined {
  const row = one<TrajectoryRow>(
    db,
    `SELECT * FROM trajectories WHERE tenant_id = ? AND run_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, runId],
  );
  return row ? trajectory(row) : undefined;
}

export function listTrajectorySteps(
  db: AppDb,
  tenantId: string,
  trajectoryId: string,
): TrajectoryStep[] {
  return all<StepRow>(
    db,
    `SELECT * FROM trajectory_steps WHERE tenant_id = ? AND trajectory_id = ?
     ORDER BY step_index ASC, created_at ASC`,
    [tenantId, trajectoryId],
  ).map(step);
}

export type TrajectoryStepPair = Readonly<{
  step: TrajectoryStep;
  input: TrajectoryBlob | undefined;
  output: TrajectoryBlob | undefined;
}>;

/**
 * Recover the full (input -> output) pair for one step: the step row plus its two
 * redacted, content-addressed blobs. This is the read side of blocker #1.
 */
export function getTrajectoryStepPair(
  db: AppDb,
  tenantId: string,
  trajectoryId: string,
  stepIndex: number,
): TrajectoryStepPair | undefined {
  const row = one<StepRow>(
    db,
    `SELECT * FROM trajectory_steps WHERE tenant_id = ? AND trajectory_id = ? AND step_index = ?`,
    [tenantId, trajectoryId, stepIndex],
  );
  if (!row) return undefined;
  const value = step(row);
  return Object.freeze({
    step: value,
    input: value.inputBlobSha256
      ? readTrajectoryBlob(db, tenantId, value.inputBlobSha256)
      : undefined,
    output: value.outputBlobSha256
      ? readTrajectoryBlob(db, tenantId, value.outputBlobSha256)
      : undefined,
  });
}

export function listTrajectories(
  db: AppDb,
  tenantId: string,
  options: { missionId?: string; limit?: number } = {},
): Trajectory[] {
  const limit = Math.min(Math.max(1, options.limit ?? 100), 1000);
  if (options.missionId) {
    return all<TrajectoryRow>(
      db,
      `SELECT * FROM trajectories WHERE tenant_id = ? AND mission_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [tenantId, options.missionId, limit],
    ).map(trajectory);
  }
  return all<TrajectoryRow>(
    db,
    `SELECT * FROM trajectories WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
    [tenantId, limit],
  ).map(trajectory);
}
