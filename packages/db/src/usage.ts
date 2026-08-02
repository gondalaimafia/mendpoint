import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";

export type UsagePriceVersion = Readonly<{
  id: string;
  tenantId: string;
  formulaVersion: string;
  currency: string;
  pricePerMcuMoneyMicros: number;
  effectiveAt: string;
  expiresAt: string | null;
  contractReference: string;
  createdAt: string;
}>;

export type UsageEntitlement = Readonly<{
  id: string;
  tenantId: string;
  version: number;
  priceVersionId: string;
  quotaMcuMicros: number;
  features: string[];
  contractReference: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}>;

export type UsageEntryType =
  | "reservation"
  | "settlement"
  | "release"
  | "adjustment"
  | "credit";

export type UsageLedgerEntry = Readonly<{
  id: string;
  tenantId: string;
  entryType: UsageEntryType;
  entitlementId: string;
  idempotencyKey: string;
  taskId: string;
  campaignId: string | null;
  reservationId: string | null;
  priceVersion: string;
  reservedMcuMicrosDelta: number;
  consumedMcuMicrosDelta: number;
  invoiceReference: string | null;
  reason: string;
  actorPrincipalId: string | null;
  entrySequence: number;
  previousHash: string | null;
  entryHash: string;
  createdAt: string;
}>;

export type UsageSummary = Readonly<{
  tenantId: string;
  entitlement: UsageEntitlement | null;
  reservedMcuMicros: number;
  consumedMcuMicros: number;
  creditedMcuMicros: number;
  availableMcuMicros: number | null;
  billableMoneyMicros: number | null;
  currency: string | null;
}>;

type PriceRow = {
  id: string;
  tenant_id: string;
  formula_version: string;
  currency: string;
  price_per_mcu_money_micros: number;
  effective_at: string;
  expires_at: string | null;
  contract_reference: string;
  created_at: string;
};

type EntitlementRow = {
  id: string;
  tenant_id: string;
  version: number;
  price_version_id: string;
  quota_mcu_micros: number;
  features_json: string;
  contract_reference: string;
  period_start: string;
  period_end: string;
  created_at: string;
};

type EntryRow = {
  id: string;
  tenant_id: string;
  entry_type: UsageEntryType;
  entitlement_id: string;
  idempotency_key: string;
  task_id: string;
  campaign_id: string | null;
  reservation_id: string | null;
  price_version: string;
  reserved_mcu_micros_delta: number;
  consumed_mcu_micros_delta: number;
  invoice_reference: string | null;
  reason: string;
  actor_principal_id: string | null;
  entry_sequence: number;
  prev_hash: string | null;
  entry_hash: string;
  created_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name}_invalid`);
  return normalized;
}

function time(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return parsed;
}

function micros(name: string, value: number, allowNegative = false): number {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function priceFromRow(row: PriceRow): UsagePriceVersion {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    formulaVersion: row.formula_version,
    currency: row.currency,
    pricePerMcuMoneyMicros: row.price_per_mcu_money_micros,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    contractReference: row.contract_reference,
    createdAt: row.created_at,
  });
}

function entitlementFromRow(row: EntitlementRow): UsageEntitlement {
  const features = JSON.parse(row.features_json) as unknown;
  if (!Array.isArray(features) || features.some((feature) => typeof feature !== "string")) {
    throw new Error("usage_entitlement_features_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    version: row.version,
    priceVersionId: row.price_version_id,
    quotaMcuMicros: row.quota_mcu_micros,
    features,
    contractReference: row.contract_reference,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdAt: row.created_at,
  });
}

function entryFromRow(row: EntryRow): UsageLedgerEntry {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    entryType: row.entry_type,
    entitlementId: row.entitlement_id,
    idempotencyKey: row.idempotency_key,
    taskId: row.task_id,
    campaignId: row.campaign_id,
    reservationId: row.reservation_id,
    priceVersion: row.price_version,
    reservedMcuMicrosDelta: row.reserved_mcu_micros_delta,
    consumedMcuMicrosDelta: row.consumed_mcu_micros_delta,
    invoiceReference: row.invoice_reference,
    reason: row.reason,
    actorPrincipalId: row.actor_principal_id,
    entrySequence: row.entry_sequence,
    previousHash: row.prev_hash,
    entryHash: row.entry_hash,
    createdAt: row.created_at,
  });
}

export function createUsagePriceVersion(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    formulaVersion: string;
    currency: string;
    pricePerMcuMoneyMicros: number;
    effectiveAt: string;
    expiresAt?: string | null;
    contractReference: string;
    createdAt: string;
  },
): UsagePriceVersion {
  const id = required("usage_price_id", input.id);
  const tenantId = required("tenant_id", input.tenantId);
  const formulaVersion = required("usage_formula_version", input.formulaVersion);
  const currency = required("usage_currency", input.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("usage_currency_invalid");
  const amount = micros("usage_price_per_mcu_money_micros", input.pricePerMcuMoneyMicros);
  const effective = time("usage_price_effective_at", input.effectiveAt);
  const expires = input.expiresAt ? time("usage_price_expires_at", input.expiresAt) : null;
  if (expires !== null && expires <= effective) throw new Error("usage_price_period_invalid");
  time("usage_created_at", input.createdAt);
  const contractReference = required("usage_contract_reference", input.contractReference);
  const existing = one<PriceRow>(db, `SELECT * FROM usage_price_versions WHERE id = ?`, [id]);
  if (existing) {
    const current = priceFromRow(existing);
    const same =
      current.tenantId === tenantId &&
      current.formulaVersion === formulaVersion &&
      current.currency === currency &&
      current.pricePerMcuMoneyMicros === amount &&
      current.effectiveAt === input.effectiveAt &&
      current.expiresAt === (input.expiresAt ?? null) &&
      current.contractReference === contractReference;
    if (!same) throw new Error("usage_price_id_conflict");
    return current;
  }
  db.raw.prepare(
    `INSERT INTO usage_price_versions
     (id, tenant_id, formula_version, currency, price_per_mcu_money_micros,
      effective_at, expires_at, contract_reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tenantId,
    formulaVersion,
    currency,
    amount,
    input.effectiveAt,
    input.expiresAt ?? null,
    contractReference,
    input.createdAt,
  );
  return priceFromRow(one<PriceRow>(db, `SELECT * FROM usage_price_versions WHERE id = ?`, [id])!);
}

export function getUsagePriceVersion(
  db: AppDb,
  tenantId: string,
  id: string,
): UsagePriceVersion | undefined {
  const row = one<PriceRow>(
    db,
    `SELECT * FROM usage_price_versions WHERE tenant_id = ? AND id = ?`,
    [tenantId, id],
  );
  return row ? priceFromRow(row) : undefined;
}

function assertActor(db: AppDb, tenantId: string, actorPrincipalId?: string | null) {
  if (!actorPrincipalId) return;
  const actor = one<{ id: string }>(
    db,
    `SELECT id FROM principals WHERE id = ? AND tenant_id = ?`,
    [actorPrincipalId, tenantId],
  );
  if (!actor) throw new Error("usage_actor_tenant_mismatch");
}

export function createUsageEntitlement(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    priceVersionId: string;
    quotaMcuMicros: number;
    features: string[];
    contractReference: string;
    periodStart: string;
    periodEnd: string;
    createdAt: string;
  },
): UsageEntitlement {
  const id = required("usage_entitlement_id", input.id);
  const tenantId = required("tenant_id", input.tenantId);
  const contractReference = required("usage_contract_reference", input.contractReference);
  const priceVersion = getUsagePriceVersion(db, tenantId, input.priceVersionId);
  if (!priceVersion) throw new Error("usage_price_version_required");
  const quota = micros("usage_quota_mcu_micros", input.quotaMcuMicros);
  const periodStart = time("usage_period_start", input.periodStart);
  const periodEnd = time("usage_period_end", input.periodEnd);
  time("usage_created_at", input.createdAt);
  if (periodEnd <= periodStart) throw new Error("usage_period_invalid");
  if (priceVersion.contractReference !== contractReference) {
    throw new Error("usage_contract_reference_mismatch");
  }
  if (
    time("usage_price_effective_at", priceVersion.effectiveAt) > periodStart ||
    (priceVersion.expiresAt && time("usage_price_expires_at", priceVersion.expiresAt) < periodEnd)
  ) {
    throw new Error("usage_price_does_not_cover_entitlement");
  }
  if (
    !Array.isArray(input.features) ||
    input.features.some((feature) => typeof feature !== "string" || !feature.trim())
  ) {
    throw new Error("usage_features_invalid");
  }
  const features = [...new Set(input.features.map((feature) => feature.trim()))].sort();
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<EntitlementRow>(
      db,
      `SELECT * FROM usage_entitlements WHERE id = ?`,
      [id],
    );
    if (existing) {
      const current = entitlementFromRow(existing);
      const same =
        current.tenantId === tenantId &&
        current.priceVersionId === priceVersion.id &&
        current.quotaMcuMicros === quota &&
        JSON.stringify(current.features) === JSON.stringify(features) &&
        current.contractReference === contractReference &&
        current.periodStart === input.periodStart &&
        current.periodEnd === input.periodEnd;
      if (!same) throw new Error("usage_entitlement_id_conflict");
      db.raw.exec("COMMIT");
      return current;
    }
    const latest = one<{ version: number }>(
      db,
      `SELECT version FROM usage_entitlements
       WHERE tenant_id = ? ORDER BY version DESC LIMIT 1`,
      [tenantId],
    );
    const version = (latest?.version ?? 0) + 1;
    db.raw.prepare(
      `INSERT INTO usage_entitlements
       (id, tenant_id, version, price_version_id, quota_mcu_micros, features_json, contract_reference,
        period_start, period_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      tenantId,
      version,
      priceVersion.id,
      quota,
      JSON.stringify(features),
      contractReference,
      input.periodStart,
      input.periodEnd,
      input.createdAt,
    );
    const inserted = one<EntitlementRow>(db, `SELECT * FROM usage_entitlements WHERE id = ?`, [id]);
    if (!inserted) throw new Error("usage_entitlement_insert_failed");
    db.raw.exec("COMMIT");
    return entitlementFromRow(inserted);
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function getActiveUsageEntitlement(
  db: AppDb,
  tenantId: string,
  at: string,
): UsageEntitlement | undefined {
  time("usage_at", at);
  const row = one<EntitlementRow>(
    db,
    `SELECT * FROM usage_entitlements
     WHERE tenant_id = ? AND period_start <= ? AND period_end > ?
     ORDER BY version DESC LIMIT 1`,
    [tenantId, at, at],
  );
  return row ? entitlementFromRow(row) : undefined;
}

export function listUsageLedger(
  db: AppDb,
  tenantId: string,
  limit = 200,
): UsageLedgerEntry[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 1_000));
  return many<EntryRow>(
    db,
    `SELECT * FROM usage_ledger_entries
     WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [tenantId, bounded],
  ).map(entryFromRow);
}

function currentTotals(db: AppDb, tenantId: string, entitlementId: string) {
  return one<{
    reserved: number;
    consumed: number;
    credited: number;
  }>(
    db,
    `SELECT
       COALESCE(SUM(reserved_mcu_micros_delta), 0) AS reserved,
       COALESCE(SUM(consumed_mcu_micros_delta), 0) AS consumed,
       COALESCE(SUM(CASE WHEN entry_type = 'credit' THEN -consumed_mcu_micros_delta ELSE 0 END), 0) AS credited
     FROM usage_ledger_entries WHERE tenant_id = ? AND entitlement_id = ?`,
    [tenantId, entitlementId],
  )!;
}

export function getUsageSummary(db: AppDb, tenantId: string, at: string): UsageSummary {
  const entitlement = getActiveUsageEntitlement(db, tenantId, at) ?? null;
  const totals = entitlement
    ? currentTotals(db, tenantId, entitlement.id)
    : { reserved: 0, consumed: 0, credited: 0 };
  const price = entitlement
    ? getUsagePriceVersion(db, tenantId, entitlement.priceVersionId) ?? null
    : null;
  const billable = price
    ? (BigInt(totals.consumed) * BigInt(price.pricePerMcuMoneyMicros)) /
      BigInt(1_000_000)
    : null;
  if (billable !== null && billable > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("usage_money_overflow");
  }
  return Object.freeze({
    tenantId,
    entitlement,
    reservedMcuMicros: totals.reserved,
    consumedMcuMicros: totals.consumed,
    creditedMcuMicros: totals.credited,
    availableMcuMicros: entitlement
      ? Math.max(0, entitlement.quotaMcuMicros - totals.reserved - totals.consumed)
      : null,
    billableMoneyMicros: billable === null ? null : Number(billable),
    currency: price?.currency ?? null,
  });
}

type EntryInput = {
  id: string;
  tenantId: string;
  entryType: UsageEntryType;
  entitlementId: string;
  idempotencyKey: string;
  taskId: string;
  campaignId?: string | null;
  reservationId?: string | null;
  priceVersion: string;
  reservedDelta: number;
  consumedDelta: number;
  invoiceReference?: string | null;
  reason: string;
  actorPrincipalId?: string | null;
  createdAt: string;
};

function usageEntryHash(input: {
  id: string;
  tenantId: string;
  entrySequence: number;
  entryType: UsageEntryType;
  entitlementId: string;
  idempotencyKey: string;
  taskId: string;
  campaignId: string | null;
  reservationId: string | null;
  priceVersion: string;
  reservedDelta: number;
  consumedDelta: number;
  invoiceReference: string | null;
  reason: string;
  actorPrincipalId: string | null;
  previousHash: string | null;
  createdAt: string;
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function insertEntry(db: AppDb, input: EntryInput): UsageLedgerEntry {
  const existing = one<EntryRow>(
    db,
    `SELECT * FROM usage_ledger_entries
     WHERE tenant_id = ? AND idempotency_key = ?`,
    [input.tenantId, input.idempotencyKey],
  );
  if (existing) {
    const row = entryFromRow(existing);
    const same =
      row.entryType === input.entryType &&
      row.entitlementId === input.entitlementId &&
      row.taskId === input.taskId &&
      row.campaignId === (input.campaignId ?? null) &&
      row.reservationId === (input.reservationId ?? null) &&
      row.priceVersion === input.priceVersion &&
      row.reservedMcuMicrosDelta === input.reservedDelta &&
      row.consumedMcuMicrosDelta === input.consumedDelta &&
      row.invoiceReference === (input.invoiceReference ?? null) &&
      row.reason === input.reason &&
      row.actorPrincipalId === (input.actorPrincipalId ?? null);
    if (!same) throw new Error("usage_idempotency_conflict");
    return row;
  }
  const previous = one<{ entry_sequence: number; entry_hash: string }>(
    db,
    `SELECT entry_sequence, entry_hash FROM usage_ledger_entries
     WHERE tenant_id = ? ORDER BY entry_sequence DESC LIMIT 1`,
    [input.tenantId],
  );
  const entrySequence = (previous?.entry_sequence ?? 0) + 1;
  const previousHash = previous?.entry_hash ?? null;
  const entryHash = usageEntryHash({
    id: input.id,
    tenantId: input.tenantId,
    entrySequence,
    entryType: input.entryType,
    entitlementId: input.entitlementId,
    idempotencyKey: input.idempotencyKey,
    taskId: input.taskId,
    campaignId: input.campaignId ?? null,
    reservationId: input.reservationId ?? null,
    priceVersion: input.priceVersion,
    reservedDelta: input.reservedDelta,
    consumedDelta: input.consumedDelta,
    invoiceReference: input.invoiceReference ?? null,
    reason: input.reason,
    actorPrincipalId: input.actorPrincipalId ?? null,
    previousHash,
    createdAt: input.createdAt,
  });
  db.raw.prepare(
    `INSERT INTO usage_ledger_entries
     (id, tenant_id, entry_type, entitlement_id, idempotency_key, task_id, campaign_id, reservation_id,
      price_version, reserved_mcu_micros_delta, consumed_mcu_micros_delta,
      invoice_reference, reason, actor_principal_id, entry_sequence, prev_hash, entry_hash,
      created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.tenantId,
    input.entryType,
    input.entitlementId,
    input.idempotencyKey,
    input.taskId,
    input.campaignId ?? null,
    input.reservationId ?? null,
    input.priceVersion,
    input.reservedDelta,
    input.consumedDelta,
    input.invoiceReference ?? null,
    input.reason,
    input.actorPrincipalId ?? null,
    entrySequence,
    previousHash,
    entryHash,
    input.createdAt,
  );
  return entryFromRow(
    one<EntryRow>(db, `SELECT * FROM usage_ledger_entries WHERE id = ?`, [input.id])!,
  );
}

function prepareEntry(db: AppDb, input: EntryInput) {
  required("usage_entry_id", input.id);
  required("tenant_id", input.tenantId);
  required("usage_entitlement_id", input.entitlementId);
  required("usage_idempotency_key", input.idempotencyKey);
  required("usage_task_id", input.taskId);
  required("usage_price_version", input.priceVersion);
  required("usage_reason", input.reason);
  if (input.campaignId) required("usage_campaign_id", input.campaignId);
  if (input.invoiceReference) required("usage_invoice_reference", input.invoiceReference);
  time("usage_created_at", input.createdAt);
  micros("usage_reserved_delta", input.reservedDelta, true);
  micros("usage_consumed_delta", input.consumedDelta, true);
  assertActor(db, input.tenantId, input.actorPrincipalId);
}

export function reserveUsage(
  db: AppDb,
  input: Omit<EntryInput, "entryType" | "entitlementId" | "reservationId" | "priceVersion" | "reservedDelta" | "consumedDelta"> & {
    mcuMicros: number;
  },
): UsageLedgerEntry {
  const amount = micros("usage_reservation_mcu_micros", input.mcuMicros);
  if (amount === 0) throw new Error("usage_reservation_empty");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const entitlement = getActiveUsageEntitlement(db, input.tenantId, input.createdAt);
    if (!entitlement) throw new Error("usage_entitlement_required");
    const entry: EntryInput = {
      ...input,
      entryType: "reservation",
      entitlementId: entitlement.id,
      priceVersion: entitlement.priceVersionId,
      reservedDelta: amount,
      consumedDelta: 0,
    };
    prepareEntry(db, entry);
    const existing = one<EntryRow>(
      db,
      `SELECT * FROM usage_ledger_entries WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing) {
      const result = insertEntry(db, entry);
      db.raw.exec("COMMIT");
      return result;
    }
    const totals = currentTotals(db, input.tenantId, entitlement.id);
    if (totals.reserved + totals.consumed + amount > entitlement.quotaMcuMicros) {
      throw new Error("usage_quota_exceeded");
    }
    const result = insertEntry(db, entry);
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

function reservationRecord(db: AppDb, tenantId: string, reservationId: string) {
  const reservation = one<EntryRow>(
    db,
    `SELECT * FROM usage_ledger_entries
     WHERE id = ? AND tenant_id = ? AND entry_type = 'reservation'`,
    [reservationId, tenantId],
  );
  if (!reservation) throw new Error("usage_reservation_not_found");
  return entryFromRow(reservation);
}

function outstandingReservation(db: AppDb, tenantId: string, reservationId: string) {
  const reservation = reservationRecord(db, tenantId, reservationId);
  const total = one<{ outstanding: number }>(
    db,
    `SELECT COALESCE(SUM(reserved_mcu_micros_delta), 0) AS outstanding
     FROM usage_ledger_entries
     WHERE tenant_id = ? AND (id = ? OR reservation_id = ?)`,
    [tenantId, reservationId, reservationId],
  )!.outstanding;
  if (total <= 0) throw new Error("usage_reservation_closed");
  return { reservation, outstanding: total };
}

export function settleUsageReservation(
  db: AppDb,
  input: Omit<EntryInput, "entryType" | "entitlementId" | "priceVersion" | "reservedDelta" | "consumedDelta" | "taskId" | "campaignId"> & {
    reservationId: string;
    actualMcuMicros: number;
  },
): UsageLedgerEntry {
  const actual = micros("usage_settlement_mcu_micros", input.actualMcuMicros);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<EntryRow>(
      db,
      `SELECT * FROM usage_ledger_entries WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    const reservation = reservationRecord(db, input.tenantId, input.reservationId);
    const state = existing
      ? { reservation, outstanding: -existing.reserved_mcu_micros_delta }
      : outstandingReservation(db, input.tenantId, input.reservationId);
    if (!existing && actual > state.outstanding) {
      throw new Error("usage_settlement_exceeds_reservation");
    }
    const entry: EntryInput = {
      ...input,
      entryType: "settlement",
      entitlementId: state.reservation.entitlementId,
      taskId: state.reservation.taskId,
      campaignId: state.reservation.campaignId,
      priceVersion: state.reservation.priceVersion,
      reservedDelta: existing ? existing.reserved_mcu_micros_delta : -state.outstanding,
      consumedDelta: actual,
    };
    prepareEntry(db, entry);
    const result = insertEntry(db, entry);
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function releaseUsageReservation(
  db: AppDb,
  input: Omit<EntryInput, "entryType" | "entitlementId" | "priceVersion" | "reservedDelta" | "consumedDelta" | "taskId" | "campaignId"> & {
    reservationId: string;
  },
): UsageLedgerEntry {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<EntryRow>(
      db,
      `SELECT * FROM usage_ledger_entries WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    const reservation = reservationRecord(db, input.tenantId, input.reservationId);
    const state = existing
      ? { reservation, outstanding: -existing.reserved_mcu_micros_delta }
      : outstandingReservation(db, input.tenantId, input.reservationId);
    const entry: EntryInput = {
      ...input,
      entryType: "release",
      entitlementId: state.reservation.entitlementId,
      taskId: state.reservation.taskId,
      campaignId: state.reservation.campaignId,
      priceVersion: state.reservation.priceVersion,
      reservedDelta: existing ? existing.reserved_mcu_micros_delta : -state.outstanding,
      consumedDelta: 0,
    };
    prepareEntry(db, entry);
    const result = insertEntry(db, entry);
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

function signedUsageChange(
  db: AppDb,
  input: Omit<EntryInput, "entryType" | "entitlementId" | "priceVersion" | "reservedDelta" | "consumedDelta" | "reservationId"> & {
    mcuMicrosDelta: number;
  },
  entryType: "adjustment" | "credit",
) {
  const delta = micros("usage_adjustment_mcu_micros", input.mcuMicrosDelta, true);
  if (delta === 0 || (entryType === "credit" && delta > 0)) {
    throw new Error(entryType === "credit" ? "usage_credit_invalid" : "usage_adjustment_empty");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const entitlement = getActiveUsageEntitlement(db, input.tenantId, input.createdAt);
    if (!entitlement) throw new Error("usage_entitlement_required");
    const entry: EntryInput = {
      ...input,
      entryType,
      entitlementId: entitlement.id,
      priceVersion: entitlement.priceVersionId,
      reservedDelta: 0,
      consumedDelta: delta,
    };
    prepareEntry(db, entry);
    const existing = one<EntryRow>(
      db,
      `SELECT * FROM usage_ledger_entries WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    if (!existing) {
      const totals = currentTotals(db, input.tenantId, entitlement.id);
      const nextConsumed = totals.consumed + delta;
      if (nextConsumed < 0) throw new Error("usage_credit_exceeds_consumption");
      if (delta > 0 && totals.reserved + nextConsumed > entitlement.quotaMcuMicros) {
        throw new Error("usage_quota_exceeded");
      }
    }
    const result = insertEntry(db, entry);
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function adjustUsage(
  db: AppDb,
  input: Parameters<typeof signedUsageChange>[1],
): UsageLedgerEntry {
  return signedUsageChange(db, input, "adjustment");
}

export function creditUsage(
  db: AppDb,
  input: Parameters<typeof signedUsageChange>[1],
): UsageLedgerEntry {
  return signedUsageChange(db, input, "credit");
}

export function reconcileUsageLedger(db: AppDb, tenantId: string) {
  const entries = many<EntryRow>(
    db,
    `SELECT * FROM usage_ledger_entries WHERE tenant_id = ? ORDER BY entry_sequence`,
    [tenantId],
  ).map(entryFromRow);
  const reservations = new Map<string, number>();
  let reserved = 0;
  let consumed = 0;
  const invoices: Record<string, number> = {};
  let previousHash: string | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const expectedHash = usageEntryHash({
      id: entry.id,
      tenantId: entry.tenantId,
      entrySequence: entry.entrySequence,
      entryType: entry.entryType,
      entitlementId: entry.entitlementId,
      idempotencyKey: entry.idempotencyKey,
      taskId: entry.taskId,
      campaignId: entry.campaignId,
      reservationId: entry.reservationId,
      priceVersion: entry.priceVersion,
      reservedDelta: entry.reservedMcuMicrosDelta,
      consumedDelta: entry.consumedMcuMicrosDelta,
      invoiceReference: entry.invoiceReference,
      reason: entry.reason,
      actorPrincipalId: entry.actorPrincipalId,
      previousHash,
      createdAt: entry.createdAt,
    });
    if (
      entry.entrySequence !== index + 1 ||
      entry.previousHash !== previousHash ||
      entry.entryHash !== expectedHash
    ) {
      return { ok: false, checked: index, error: `usage_integrity:${entry.id}` };
    }
    reserved += entry.reservedMcuMicrosDelta;
    consumed += entry.consumedMcuMicrosDelta;
    if (entry.entryType === "reservation") {
      reservations.set(entry.id, entry.reservedMcuMicrosDelta);
    } else if (entry.reservationId) {
      if (!reservations.has(entry.reservationId)) {
        return { ok: false, checked: index, error: `usage_reservation_missing:${entry.id}` };
      }
      reservations.set(
        entry.reservationId,
        reservations.get(entry.reservationId)! + entry.reservedMcuMicrosDelta,
      );
      if (reservations.get(entry.reservationId)! < 0) {
        return { ok: false, checked: index, error: `usage_reservation_negative:${entry.id}` };
      }
    }
    if (reserved < 0 || consumed < 0) {
      return { ok: false, checked: index, error: `usage_balance_negative:${entry.id}` };
    }
    if (entry.invoiceReference) {
      invoices[entry.invoiceReference] =
        (invoices[entry.invoiceReference] ?? 0) + entry.consumedMcuMicrosDelta;
    }
    previousHash = entry.entryHash;
  }
  const totals = one<{ reserved: number; consumed: number }>(
    db,
    `SELECT
       COALESCE(SUM(reserved_mcu_micros_delta), 0) AS reserved,
       COALESCE(SUM(consumed_mcu_micros_delta), 0) AS consumed
     FROM usage_ledger_entries WHERE tenant_id = ?`,
    [tenantId],
  )!;
  const ok = reserved === totals.reserved && consumed === totals.consumed;
  return {
    ok,
    checked: entries.length,
    error: ok ? undefined : "usage_totals_mismatch",
    reservedMcuMicros: reserved,
    consumedMcuMicros: consumed,
    invoices,
  };
}
