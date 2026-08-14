import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";
import { assertTenantScope } from "./tenant-scope.js";

export type WardenModelReservationStatus =
  | "active"
  | "succeeded"
  | "failed"
  | "over_budget"
  | "unknown";

export type WardenModelReservationRow = Readonly<{
  id: string;
  tenant_id: string;
  job_id: string;
  run_id: string;
  worker_id: string;
  lease_generation: number;
  call_index: number;
  request_digest: string;
  reservation_digest: string;
  settlement_digest: string | null;
  provider: string;
  configured_model: string;
  actual_model: string | null;
  endpoint_host: string;
  body_request_id: string | null;
  header_request_id: string | null;
  status: WardenModelReservationStatus;
  maximum_input_tokens: number;
  maximum_output_tokens: number;
  maximum_total_tokens: number;
  maximum_cost_usd: number;
  job_budget_usd: number;
  reported_input_tokens: number | null;
  reported_output_tokens: number | null;
  reported_total_tokens: number | null;
  reported_cost_usd: number | null;
  charged_input_tokens: number | null;
  charged_output_tokens: number | null;
  charged_total_tokens: number | null;
  charged_cost_usd: number | null;
  error_code: string | null;
  reserved_at: string;
  settled_at: string | null;
}>;

export type WardenModelReservationInput = Readonly<{
  id: string;
  tenantId: string;
  jobId: string;
  runId: string;
  workerId: string;
  leaseGeneration: number;
  callIndex: number;
  requestDigest: string;
  provider: string;
  configuredModel: string;
  endpointHost: string;
  maximumInputTokens: number;
  maximumOutputTokens: number;
  maximumTotalTokens: number;
  maximumCostUsd: number;
  jobBudgetUsd: number;
  observedAt: string;
}>;

export type WardenModelSettlementInput = Readonly<{
  tenantId: string;
  jobId: string;
  reservationId: string;
  workerId: string;
  leaseGeneration: number;
  status: "succeeded" | "failed";
  actualModel?: string | null;
  bodyRequestId?: string | null;
  headerRequestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number | null;
  errorCode?: string;
  observedAt: string;
}>;

type JobFenceRow = Readonly<{
  status: string;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: string | null;
}>;

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex")}`;
}

function requireId(value: string, code: string): string {
  if (!ID.test(value)) throw new Error(code);
  return value;
}

function requireIso(value: string, code: string): string {
  try {
    if (new Date(value).toISOString() !== value) throw new Error(code);
  } catch {
    throw new Error(code);
  }
  return value;
}

function requireInteger(value: number, code: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(code);
  return value;
}

function requireMoney(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function transaction<T>(db: AppDb, operation: () => T): T {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (owns) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function getRow(
  db: AppDb,
  tenantId: string,
  reservationId: string,
): WardenModelReservationRow | undefined {
  return db.raw.prepare(
    "SELECT * FROM fettler_model_reservations WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, reservationId) as WardenModelReservationRow | undefined;
}

function assertLease(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    jobId: string;
    workerId: string;
    leaseGeneration: number;
    observedAt: string;
  }>,
): void {
  const job = db.raw.prepare(
    `SELECT status, lease_owner, lease_generation, lease_expires_at
     FROM jobs WHERE id = ? AND tenant_id = ?`,
  ).get(input.jobId, input.tenantId) as JobFenceRow | undefined;
  if (
    !job ||
    job.status !== "running" ||
    job.lease_owner !== input.workerId ||
    job.lease_generation !== input.leaseGeneration ||
    !job.lease_expires_at ||
    job.lease_expires_at <= input.observedAt
  ) {
    throw new Error("warden_model_job_lease_stale");
  }
}

function reservationFingerprint(input: WardenModelReservationInput): string {
  const { observedAt: _observedAt, ...identity } = input;
  return digest(identity);
}

function settlementFingerprint(input: WardenModelSettlementInput): string {
  const { observedAt: _observedAt, ...evidence } = input;
  return digest(evidence);
}

export function getWardenModelReservation(
  db: AppDb,
  tenantId: string,
  reservationId: string,
): WardenModelReservationRow | undefined {
  requireId(tenantId, "warden_model_tenant_invalid");
  requireId(reservationId, "warden_model_reservation_id_invalid");
  return getRow(db, tenantId, reservationId);
}

export function reserveWardenModelCall(
  db: AppDb,
  input: WardenModelReservationInput,
): WardenModelReservationRow {
  requireId(input.id, "warden_model_reservation_id_invalid");
  requireId(input.tenantId, "warden_model_tenant_invalid");
  requireId(input.jobId, "warden_model_job_invalid");
  requireId(input.runId, "warden_model_run_invalid");
  requireId(input.workerId, "warden_model_worker_invalid");
  requireInteger(input.leaseGeneration, "warden_model_lease_generation_invalid");
  requireInteger(input.callIndex, "warden_model_call_index_invalid");
  if (!DIGEST.test(input.requestDigest)) throw new Error("warden_model_request_digest_invalid");
  requireId(input.provider, "warden_model_provider_invalid");
  requireId(input.configuredModel, "warden_model_configured_model_invalid");
  if (!input.endpointHost.trim() || input.endpointHost.length > 255 || /[\s/@]/.test(input.endpointHost)) {
    throw new Error("warden_model_endpoint_host_invalid");
  }
  requireInteger(input.maximumInputTokens, "warden_model_maximum_input_tokens_invalid", true);
  requireInteger(input.maximumOutputTokens, "warden_model_maximum_output_tokens_invalid");
  requireInteger(input.maximumTotalTokens, "warden_model_maximum_total_tokens_invalid");
  if (input.maximumTotalTokens !== input.maximumInputTokens + input.maximumOutputTokens) {
    throw new Error("warden_model_maximum_total_tokens_invalid");
  }
  requireMoney(input.maximumCostUsd, "warden_model_maximum_cost_invalid");
  requireMoney(input.jobBudgetUsd, "warden_model_job_budget_invalid");
  requireIso(input.observedAt, "warden_model_observed_at_invalid");
  const reservationDigest = reservationFingerprint(input);

  return transaction(db, () => {
    assertLease(db, input);
    const existing = getRow(db, input.tenantId, input.id);
    if (existing) {
      if (existing.reservation_digest !== reservationDigest) {
        throw new Error("warden_model_reservation_idempotency_conflict");
      }
      if (existing.status !== "active") throw new Error("warden_model_reservation_not_active");
      return existing;
    }
    const duplicateCall = db.raw.prepare(
      `SELECT id FROM fettler_model_reservations
       WHERE tenant_id = ? AND job_id = ? AND lease_generation = ? AND call_index = ?`,
    ).get(input.tenantId, input.jobId, input.leaseGeneration, input.callIndex) as
      | { id: string }
      | undefined;
    if (duplicateCall) throw new Error("warden_model_call_identity_conflict");
    const totals = db.raw.prepare(
      `SELECT COALESCE(SUM(
         CASE WHEN status = 'active' THEN maximum_cost_usd ELSE charged_cost_usd END
       ), 0) AS committed
       FROM fettler_model_reservations
       WHERE tenant_id = ? AND job_id = ?`,
    ).get(input.tenantId, input.jobId) as { committed: number };
    if (totals.committed + input.maximumCostUsd > input.jobBudgetUsd + 1e-12) {
      throw new Error("warden_model_budget_exhausted");
    }
    db.raw.prepare(
      `INSERT INTO fettler_model_reservations
       (id, tenant_id, job_id, run_id, worker_id, lease_generation, call_index,
        request_digest, reservation_digest, provider, configured_model, endpoint_host,
        status, maximum_input_tokens, maximum_output_tokens, maximum_total_tokens,
        maximum_cost_usd, job_budget_usd, reserved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.tenantId,
      input.jobId,
      input.runId,
      input.workerId,
      input.leaseGeneration,
      input.callIndex,
      input.requestDigest,
      reservationDigest,
      input.provider,
      input.configuredModel,
      input.endpointHost,
      input.maximumInputTokens,
      input.maximumOutputTokens,
      input.maximumTotalTokens,
      input.maximumCostUsd,
      input.jobBudgetUsd,
      input.observedAt,
    );
    return getRow(db, input.tenantId, input.id)!;
  });
}

export function settleWardenModelCall(
  db: AppDb,
  input: WardenModelSettlementInput,
): WardenModelReservationRow {
  requireId(input.tenantId, "warden_model_tenant_invalid");
  requireId(input.jobId, "warden_model_job_invalid");
  requireId(input.reservationId, "warden_model_reservation_id_invalid");
  requireId(input.workerId, "warden_model_worker_invalid");
  requireInteger(input.leaseGeneration, "warden_model_lease_generation_invalid");
  requireIso(input.observedAt, "warden_model_observed_at_invalid");
  const settlementDigest = settlementFingerprint(input);

  return transaction(db, () => {
    const reservation = getRow(db, input.tenantId, input.reservationId);
    if (!reservation || reservation.job_id !== input.jobId) {
      throw new Error("warden_model_reservation_not_found");
    }
    if (reservation.status !== "active") {
      if (reservation.settlement_digest === settlementDigest) return reservation;
      throw new Error("warden_model_settlement_idempotency_conflict");
    }
    assertLease(db, input);
    if (
      reservation.worker_id !== input.workerId ||
      reservation.lease_generation !== input.leaseGeneration
    ) {
      throw new Error("warden_model_job_lease_stale");
    }
    const completeMeasured =
      Number.isSafeInteger(input.inputTokens) && input.inputTokens! > 0 &&
      Number.isSafeInteger(input.outputTokens) && input.outputTokens! > 0 &&
      Number.isSafeInteger(input.totalTokens) && input.totalTokens === input.inputTokens! + input.outputTokens! &&
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd > 0;
    const withinReservation = completeMeasured &&
      input.inputTokens! <= reservation.maximum_input_tokens &&
      input.outputTokens! <= reservation.maximum_output_tokens &&
      input.totalTokens! <= reservation.maximum_total_tokens &&
      input.costUsd! <= reservation.maximum_cost_usd;
    const exact = input.status === "succeeded" && withinReservation;
    const finalStatus: WardenModelReservationStatus = exact
      ? "succeeded"
      : input.status === "succeeded"
        ? "over_budget"
        : "failed";
    const chargedInput = exact ? input.inputTokens! : reservation.maximum_input_tokens;
    const chargedOutput = exact ? input.outputTokens! : reservation.maximum_output_tokens;
    const chargedTotal = exact ? input.totalTokens! : reservation.maximum_total_tokens;
    const chargedCost = exact ? input.costUsd! : reservation.maximum_cost_usd;
    const updated = db.raw.prepare(
      `UPDATE fettler_model_reservations
       SET settlement_digest = ?, actual_model = ?, body_request_id = ?, header_request_id = ?,
           status = ?, reported_input_tokens = ?, reported_output_tokens = ?,
           reported_total_tokens = ?, reported_cost_usd = ?, charged_input_tokens = ?,
           charged_output_tokens = ?, charged_total_tokens = ?, charged_cost_usd = ?,
           error_code = ?, settled_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'active'
         AND worker_id = ? AND lease_generation = ?`,
    ).run(
      settlementDigest,
      input.actualModel?.trim() || null,
      input.bodyRequestId?.trim() || null,
      input.headerRequestId?.trim() || null,
      finalStatus,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
      input.costUsd ?? null,
      chargedInput,
      chargedOutput,
      chargedTotal,
      chargedCost,
      input.errorCode?.trim().slice(0, 128) || (finalStatus === "over_budget" ? "warden_model_budget_exceeded" : null),
      input.observedAt,
      input.reservationId,
      input.tenantId,
      input.workerId,
      input.leaseGeneration,
    );
    if (Number(updated.changes) !== 1) throw new Error("warden_model_job_lease_stale");
    return getRow(db, input.tenantId, input.reservationId)!;
  });
}

export function settleExpiredWardenModelReservations(
  db: AppDb,
  observedAt: string,
  tenantId?: string,
): number {
  requireIso(observedAt, "warden_model_observed_at_invalid");
  assertTenantScope(tenantId);
  if (tenantId) requireId(tenantId, "warden_model_tenant_invalid");
  const settlementDigest = digest({ status: "unknown", errorCode: "warden_model_lease_expired" });
  const updated = db.raw.prepare(
    `UPDATE fettler_model_reservations
     SET status = 'unknown', settlement_digest = ?,
         charged_input_tokens = maximum_input_tokens,
         charged_output_tokens = maximum_output_tokens,
         charged_total_tokens = maximum_total_tokens,
         charged_cost_usd = maximum_cost_usd,
         error_code = 'warden_model_lease_expired', settled_at = ?
     WHERE status = 'active'
       AND ${tenantId ? "tenant_id = ? AND" : ""}
       EXISTS (
         SELECT 1 FROM jobs
         WHERE jobs.id = fettler_model_reservations.job_id
           AND jobs.tenant_id = fettler_model_reservations.tenant_id
           AND jobs.status = 'running'
           AND jobs.lease_owner = fettler_model_reservations.worker_id
           AND jobs.lease_generation = fettler_model_reservations.lease_generation
           AND jobs.lease_expires_at IS NOT NULL
           AND jobs.lease_expires_at <= ?
       )`,
  ).run(settlementDigest, observedAt, ...(tenantId ? [tenantId] : []), observedAt);
  return Number(updated.changes);
}

export function settleActiveWardenModelReservationsForFence(
  db: AppDb,
  input: Readonly<{
    jobId: string;
    workerId: string;
    leaseGeneration: number;
    observedAt: string;
    errorCode: string;
  }>,
): number {
  requireId(input.jobId, "warden_model_job_invalid");
  requireId(input.workerId, "warden_model_worker_invalid");
  requireInteger(input.leaseGeneration, "warden_model_lease_generation_invalid");
  requireIso(input.observedAt, "warden_model_observed_at_invalid");
  const errorCode = requireId(input.errorCode, "warden_model_error_code_invalid");
  const settlementDigest = digest({
    status: "unknown",
    jobId: input.jobId,
    workerId: input.workerId,
    leaseGeneration: input.leaseGeneration,
    errorCode,
  });
  return transaction(db, () => {
    const updated = db.raw.prepare(
      `UPDATE fettler_model_reservations
       SET status = 'unknown', settlement_digest = ?,
           charged_input_tokens = maximum_input_tokens,
           charged_output_tokens = maximum_output_tokens,
           charged_total_tokens = maximum_total_tokens,
           charged_cost_usd = maximum_cost_usd,
           error_code = ?, settled_at = ?
       WHERE status = 'active'
         AND job_id = ? AND worker_id = ? AND lease_generation = ?
         AND EXISTS (
           SELECT 1 FROM jobs
           WHERE jobs.id = fettler_model_reservations.job_id
             AND jobs.tenant_id = fettler_model_reservations.tenant_id
             AND jobs.status = 'running'
             AND jobs.lease_owner = fettler_model_reservations.worker_id
             AND jobs.lease_generation = fettler_model_reservations.lease_generation
             AND jobs.lease_expires_at IS NOT NULL
             AND jobs.lease_expires_at > ?
         )`,
    ).run(
      settlementDigest,
      errorCode,
      input.observedAt,
      input.jobId,
      input.workerId,
      input.leaseGeneration,
      input.observedAt,
    );
    return Number(updated.changes);
  });
}

export function countActiveWardenModelReservations(
  db: AppDb,
  tenantId: string,
  jobId: string,
  workerId: string,
  leaseGeneration: number,
): number {
  const row = db.raw.prepare(
    `SELECT COUNT(*) AS count FROM fettler_model_reservations
     WHERE tenant_id = ? AND job_id = ? AND worker_id = ?
       AND lease_generation = ? AND status = 'active'`,
  ).get(tenantId, jobId, workerId, leaseGeneration) as { count: number };
  return row.count;
}
