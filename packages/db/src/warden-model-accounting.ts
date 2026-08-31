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

function versionedDigest(version: number, value: unknown): string {
  return `v${version}:${digest(value)}`;
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

function storedSettlementFingerprint(row: WardenModelReservationRow): string {
  return versionedDigest(2, {
    schemaVersion: "mendpoint.warden-model-settlement/2",
    reservationDigest: row.reservation_digest,
    reservationId: row.id,
    tenantId: row.tenant_id,
    jobId: row.job_id,
    runId: row.run_id,
    workerId: row.worker_id,
    leaseGeneration: row.lease_generation,
    callIndex: row.call_index,
    provider: row.provider,
    configuredModel: row.configured_model,
    actualModel: row.actual_model,
    endpointHost: row.endpoint_host,
    bodyRequestId: row.body_request_id,
    headerRequestId: row.header_request_id,
    status: row.status,
    maximumInputTokens: row.maximum_input_tokens,
    maximumOutputTokens: row.maximum_output_tokens,
    maximumTotalTokens: row.maximum_total_tokens,
    maximumCostUsd: row.maximum_cost_usd,
    jobBudgetUsd: row.job_budget_usd,
    reportedInputTokens: row.reported_input_tokens,
    reportedOutputTokens: row.reported_output_tokens,
    reportedTotalTokens: row.reported_total_tokens,
    reportedCostUsd: row.reported_cost_usd,
    chargedInputTokens: row.charged_input_tokens,
    chargedOutputTokens: row.charged_output_tokens,
    chargedTotalTokens: row.charged_total_tokens,
    chargedCostUsd: row.charged_cost_usd,
    errorCode: row.error_code,
    reservedAt: row.reserved_at,
    settledAt: row.settled_at,
  });
}

function settleUnknownReservation(
  db: AppDb,
  reservation: WardenModelReservationRow,
  observedAt: string,
  errorCode: string,
): void {
  const settled: WardenModelReservationRow = {
    ...reservation,
    status: "unknown",
    charged_input_tokens: reservation.maximum_input_tokens,
    charged_output_tokens: reservation.maximum_output_tokens,
    charged_total_tokens: reservation.maximum_total_tokens,
    charged_cost_usd: reservation.maximum_cost_usd,
    error_code: errorCode,
    settled_at: observedAt,
  };
  const settlementDigest = storedSettlementFingerprint(settled);
  const updated = db.raw.prepare(
    `UPDATE fettler_model_reservations
     SET status = 'unknown', settlement_digest = ?,
         charged_input_tokens = maximum_input_tokens,
         charged_output_tokens = maximum_output_tokens,
         charged_total_tokens = maximum_total_tokens,
         charged_cost_usd = maximum_cost_usd,
         error_code = ?, settled_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'active'
       AND worker_id = ? AND lease_generation = ?`,
  ).run(
    settlementDigest,
    errorCode,
    observedAt,
    reservation.id,
    reservation.tenant_id,
    reservation.worker_id,
    reservation.lease_generation,
  );
  if (Number(updated.changes) !== 1) throw new Error("warden_model_job_lease_stale");
}

export type WardenModelReservationIntegrity = Readonly<{
  ok: boolean;
  reservationDigestVersion: 1;
  settlementDigestVersion: 1 | 2 | null;
  error?: string;
}>;

export function verifyWardenModelReservationIntegrity(
  row: WardenModelReservationRow,
): WardenModelReservationIntegrity {
  const expectedReservation = reservationFingerprint({
    id: row.id,
    tenantId: row.tenant_id,
    jobId: row.job_id,
    runId: row.run_id,
    workerId: row.worker_id,
    leaseGeneration: row.lease_generation,
    callIndex: row.call_index,
    requestDigest: row.request_digest,
    provider: row.provider,
    configuredModel: row.configured_model,
    endpointHost: row.endpoint_host,
    maximumInputTokens: row.maximum_input_tokens,
    maximumOutputTokens: row.maximum_output_tokens,
    maximumTotalTokens: row.maximum_total_tokens,
    maximumCostUsd: row.maximum_cost_usd,
    jobBudgetUsd: row.job_budget_usd,
    observedAt: row.reserved_at,
  });
  if (row.reservation_digest !== expectedReservation) {
    return {
      ok: false,
      reservationDigestVersion: 1,
      settlementDigestVersion: null,
      error: "warden_model_reservation_digest_mismatch",
    };
  }
  if (row.status === "active") {
    return row.settlement_digest === null && row.settled_at === null
      ? { ok: true, reservationDigestVersion: 1, settlementDigestVersion: null }
      : {
          ok: false,
          reservationDigestVersion: 1,
          settlementDigestVersion: null,
          error: "warden_model_settlement_state_invalid",
        };
  }
  if (!row.settlement_digest || !row.settled_at) {
    return {
      ok: false,
      reservationDigestVersion: 1,
      settlementDigestVersion: null,
      error: "warden_model_settlement_state_invalid",
    };
  }
  if (row.settlement_digest.startsWith("v2:")) {
    return row.settlement_digest === storedSettlementFingerprint(row)
      ? { ok: true, reservationDigestVersion: 1, settlementDigestVersion: 2 }
      : {
          ok: false,
          reservationDigestVersion: 1,
          settlementDigestVersion: 2,
          error: "warden_model_settlement_digest_mismatch",
        };
  }
  let expectedSettlement: string;
  if (row.status === "unknown") {
    expectedSettlement = row.error_code === "warden_model_lease_expired"
      ? digest({ status: "unknown", errorCode: row.error_code })
      : digest({
          status: "unknown",
          jobId: row.job_id,
          workerId: row.worker_id,
          leaseGeneration: row.lease_generation,
          errorCode: row.error_code,
        });
    if (
      row.charged_input_tokens !== row.maximum_input_tokens ||
      row.charged_output_tokens !== row.maximum_output_tokens ||
      row.charged_total_tokens !== row.maximum_total_tokens ||
      row.charged_cost_usd !== row.maximum_cost_usd
    ) {
      expectedSettlement = "invalid";
    }
  } else {
    const legacyInput: WardenModelSettlementInput = {
      tenantId: row.tenant_id,
      jobId: row.job_id,
      reservationId: row.id,
      workerId: row.worker_id,
      leaseGeneration: row.lease_generation,
      status: row.status === "failed" ? "failed" : "succeeded",
      ...(row.actual_model !== null ? { actualModel: row.actual_model } : {}),
      ...(row.body_request_id !== null ? { bodyRequestId: row.body_request_id } : {}),
      ...(row.header_request_id !== null ? { headerRequestId: row.header_request_id } : {}),
      ...(row.reported_input_tokens !== null ? { inputTokens: row.reported_input_tokens } : {}),
      ...(row.reported_output_tokens !== null ? { outputTokens: row.reported_output_tokens } : {}),
      ...(row.reported_total_tokens !== null ? { totalTokens: row.reported_total_tokens } : {}),
      ...(row.reported_cost_usd !== null ? { costUsd: row.reported_cost_usd } : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
      observedAt: row.settled_at,
    };
    expectedSettlement = settlementFingerprint(legacyInput);
    const materialized = materializeSettlement(row, legacyInput);
    if (
      materialized.status !== row.status ||
      materialized.actual_model !== row.actual_model ||
      materialized.body_request_id !== row.body_request_id ||
      materialized.header_request_id !== row.header_request_id ||
      materialized.reported_input_tokens !== row.reported_input_tokens ||
      materialized.reported_output_tokens !== row.reported_output_tokens ||
      materialized.reported_total_tokens !== row.reported_total_tokens ||
      materialized.reported_cost_usd !== row.reported_cost_usd ||
      materialized.charged_input_tokens !== row.charged_input_tokens ||
      materialized.charged_output_tokens !== row.charged_output_tokens ||
      materialized.charged_total_tokens !== row.charged_total_tokens ||
      materialized.charged_cost_usd !== row.charged_cost_usd ||
      materialized.error_code !== row.error_code
    ) expectedSettlement = "invalid";
  }
  return row.settlement_digest === expectedSettlement
    ? { ok: true, reservationDigestVersion: 1, settlementDigestVersion: 1 }
    : {
        ok: false,
        reservationDigestVersion: 1,
        settlementDigestVersion: 1,
        error: "warden_model_settlement_digest_mismatch",
      };
}

function materializeSettlement(
  reservation: WardenModelReservationRow,
  input: WardenModelSettlementInput,
): WardenModelReservationRow {
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
    : input.status === "succeeded" ? "over_budget" : "failed";
  return {
    ...reservation,
    settlement_digest: null,
    actual_model: input.actualModel?.trim() || null,
    body_request_id: input.bodyRequestId?.trim() || null,
    header_request_id: input.headerRequestId?.trim() || null,
    status: finalStatus,
    reported_input_tokens: input.inputTokens ?? null,
    reported_output_tokens: input.outputTokens ?? null,
    reported_total_tokens: input.totalTokens ?? null,
    reported_cost_usd: input.costUsd ?? null,
    charged_input_tokens: exact ? input.inputTokens! : reservation.maximum_input_tokens,
    charged_output_tokens: exact ? input.outputTokens! : reservation.maximum_output_tokens,
    charged_total_tokens: exact ? input.totalTokens! : reservation.maximum_total_tokens,
    charged_cost_usd: exact ? input.costUsd! : reservation.maximum_cost_usd,
    error_code: input.errorCode?.trim().slice(0, 128) ||
      (finalStatus === "over_budget" ? "warden_model_budget_exceeded" : null),
    settled_at: input.observedAt,
  };
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
  return transaction(db, () => {
    const reservation = getRow(db, input.tenantId, input.reservationId);
    if (!reservation || reservation.job_id !== input.jobId) {
      throw new Error("warden_model_reservation_not_found");
    }
    if (reservation.status !== "active") {
      const proposed = materializeSettlement(reservation, input);
      if (reservation.settlement_digest === settlementFingerprint(input) ||
          (reservation.settlement_digest?.startsWith("v2:") &&
            reservation.settlement_digest === storedSettlementFingerprint(proposed))) return reservation;
      throw new Error("warden_model_settlement_idempotency_conflict");
    }
    assertLease(db, input);
    if (
      reservation.worker_id !== input.workerId ||
      reservation.lease_generation !== input.leaseGeneration
    ) {
      throw new Error("warden_model_job_lease_stale");
    }
    const settledRow = materializeSettlement(reservation, input);
    const settlementDigest = storedSettlementFingerprint(settledRow);
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
      settledRow.status,
      settledRow.reported_input_tokens,
      settledRow.reported_output_tokens,
      settledRow.reported_total_tokens,
      settledRow.reported_cost_usd,
      settledRow.charged_input_tokens,
      settledRow.charged_output_tokens,
      settledRow.charged_total_tokens,
      settledRow.charged_cost_usd,
      settledRow.error_code,
      settledRow.settled_at,
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
  return transaction(db, () => {
    const reservations = db.raw.prepare(
      `SELECT fettler_model_reservations.* FROM fettler_model_reservations
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
         )
       ORDER BY tenant_id, id`,
    ).all(...(tenantId ? [tenantId] : []), observedAt) as WardenModelReservationRow[];
    for (const reservation of reservations) {
      settleUnknownReservation(db, reservation, observedAt, "warden_model_lease_expired");
    }
    return reservations.length;
  });
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
  return transaction(db, () => {
    const reservations = db.raw.prepare(
      `SELECT fettler_model_reservations.* FROM fettler_model_reservations
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
         )
       ORDER BY tenant_id, id`,
    ).all(
      input.jobId,
      input.workerId,
      input.leaseGeneration,
      input.observedAt,
    ) as WardenModelReservationRow[];
    for (const reservation of reservations) {
      settleUnknownReservation(db, reservation, input.observedAt, errorCode);
    }
    return reservations.length;
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
