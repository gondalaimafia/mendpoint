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
  financeAuthorizationId: string | null;
  financeAuthorizationDigest: string | null;
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

export type UsageFinanceAuthorization = Readonly<{
  id: string;
  tenantId: string;
  approvedByPrincipalId: string;
  approvedByRole: "finance_owner";
  actorPrincipalId: string;
  entryType: "adjustment" | "credit";
  invoiceReference: string;
  entryIdempotencyKey: string;
  mcuMicrosDelta: number;
  reason: string;
  intentDigest: string;
  authorizationDigest: string;
  approvedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  consumedEntryId: string | null;
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
  finance_authorization_id: string | null;
  finance_authorization_digest: string | null;
  entry_sequence: number;
  prev_hash: string | null;
  entry_hash: string;
  created_at: string;
};

type FinanceAuthorizationRow = {
  id: string;
  tenant_id: string;
  approved_by_principal_id: string;
  approved_by_role: "finance_owner";
  actor_principal_id: string;
  entry_type: "adjustment" | "credit";
  invoice_reference: string;
  entry_idempotency_key: string;
  mcu_micros_delta: number;
  reason: string;
  intent_digest: string;
  authorization_digest: string;
  approved_at: string;
  expires_at: string;
  consumed_at: string | null;
  consumed_entry_id: string | null;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function required(name: string, value: string): string {
  if (typeof value !== "string") throw new Error(`${name}_invalid`);
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
    financeAuthorizationId: row.finance_authorization_id,
    financeAuthorizationDigest: row.finance_authorization_digest,
    entrySequence: row.entry_sequence,
    previousHash: row.prev_hash,
    entryHash: row.entry_hash,
    createdAt: row.created_at,
  });
}

function financeAuthorizationFromRow(row: FinanceAuthorizationRow): UsageFinanceAuthorization {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    approvedByPrincipalId: row.approved_by_principal_id,
    approvedByRole: row.approved_by_role,
    actorPrincipalId: row.actor_principal_id,
    entryType: row.entry_type,
    invoiceReference: row.invoice_reference,
    entryIdempotencyKey: row.entry_idempotency_key,
    mcuMicrosDelta: row.mcu_micros_delta,
    reason: row.reason,
    intentDigest: row.intent_digest,
    authorizationDigest: row.authorization_digest,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedEntryId: row.consumed_entry_id,
  });
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function usageFinanceIntent(input: Pick<UsageFinanceAuthorization,
  "tenantId" | "actorPrincipalId" | "entryType" | "invoiceReference" |
  "entryIdempotencyKey" | "mcuMicrosDelta" | "reason">) {
  return {
    tenantId: input.tenantId,
    actorPrincipalId: input.actorPrincipalId,
    entryType: input.entryType,
    invoiceReference: input.invoiceReference,
    entryIdempotencyKey: input.entryIdempotencyKey,
    mcuMicrosDelta: input.mcuMicrosDelta,
    reason: input.reason,
  } as const;
}

function usageFinanceAuthorizationDigest(input: Omit<UsageFinanceAuthorization,
  "authorizationDigest" | "consumedAt" | "consumedEntryId">): string {
  return sha256({
    id: input.id,
    tenantId: input.tenantId,
    approvedByPrincipalId: input.approvedByPrincipalId,
    approvedByRole: input.approvedByRole,
    actorPrincipalId: input.actorPrincipalId,
    entryType: input.entryType,
    invoiceReference: input.invoiceReference,
    entryIdempotencyKey: input.entryIdempotencyKey,
    mcuMicrosDelta: input.mcuMicrosDelta,
    reason: input.reason,
    intentDigest: input.intentDigest,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
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

function assertActiveActorAt(
  db: AppDb,
  tenantId: string,
  actorPrincipalId: string,
  observedAt: string,
) {
  const actor = one<{ id: string }>(
    db,
    `SELECT id FROM principals
     WHERE id = ? AND tenant_id = ? AND created_at <= ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
    [actorPrincipalId, tenantId, observedAt, observedAt],
  );
  if (!actor) throw new Error("usage_finance_actor_inactive");
}

function assertFinanceOwnerAt(
  db: AppDb,
  tenantId: string,
  principalId: string,
  observedAt: string,
) {
  const owner = one<{ id: string }>(
    db,
    `SELECT p.id
     FROM principals p
     JOIN tenant_memberships m
       ON m.tenant_id = p.tenant_id
      AND p.kind = 'human'
      AND p.audience = m.issuer
      AND p.subject = m.issuer || '|' || m.subject
     WHERE p.id = ? AND p.tenant_id = ?
       AND p.created_at <= ? AND p.revoked_at IS NULL
       AND (p.expires_at IS NULL OR p.expires_at > ?)
       AND m.role = 'owner' AND m.status = 'active' AND m.updated_at <= ?`,
    [principalId, tenantId, observedAt, observedAt, observedAt],
  );
  if (!owner) {
    const principal = one<{ id: string }>(
      db,
      `SELECT id FROM principals
       WHERE id = ? AND tenant_id = ? AND created_at <= ?
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      [principalId, tenantId, observedAt, observedAt],
    );
    throw new Error(principal ? "usage_finance_owner_required" : "usage_finance_owner_inactive");
  }
}

export function createUsageFinanceAuthorization(
  db: AppDb,
  input: Readonly<{
    id: string;
    tenantId: string;
    approvedByPrincipalId: string;
    actorPrincipalId: string;
    entryType: "adjustment" | "credit";
    invoiceReference: string;
    entryIdempotencyKey: string;
    mcuMicrosDelta: number;
    reason: string;
    approvedAt: string;
    expiresAt: string;
  }>,
): UsageFinanceAuthorization {
  if (input.entryType !== "adjustment" && input.entryType !== "credit") {
    throw new Error("usage_finance_entry_type_invalid");
  }
  const id = required("usage_finance_authorization_id", input.id);
  const tenantId = required("tenant_id", input.tenantId);
  const approvedByPrincipalId = required(
    "usage_finance_approved_by_principal_id",
    input.approvedByPrincipalId,
  );
  const actorPrincipalId = required("usage_finance_actor_principal_id", input.actorPrincipalId);
  const invoiceReference = required("usage_invoice_reference", input.invoiceReference);
  const entryIdempotencyKey = required(
    "usage_idempotency_key",
    input.entryIdempotencyKey,
  );
  const reason = required("usage_reason", input.reason);
  const delta = micros("usage_adjustment_mcu_micros", input.mcuMicrosDelta, true);
  if (
    (input.entryType === "adjustment" && delta <= 0) ||
    (input.entryType === "credit" && delta >= 0)
  ) {
    throw new Error(input.entryType === "adjustment"
      ? "usage_adjustment_invalid"
      : "usage_credit_invalid");
  }
  const approvedAtMs = time("usage_finance_approved_at", input.approvedAt);
  const expiresAtMs = time("usage_finance_expires_at", input.expiresAt);
  if (expiresAtMs <= approvedAtMs) throw new Error("usage_finance_authorization_window_invalid");
  const intent = usageFinanceIntent({
    tenantId,
    actorPrincipalId,
    entryType: input.entryType,
    invoiceReference,
    entryIdempotencyKey,
    mcuMicrosDelta: delta,
    reason,
  });
  const intentDigest = sha256(intent);
  const existing = one<FinanceAuthorizationRow>(
    db,
    `SELECT * FROM usage_finance_authorizations
     WHERE tenant_id = ? AND (id = ? OR entry_idempotency_key = ?)`,
    [tenantId, id, entryIdempotencyKey],
  );
  if (existing) {
    const authorization = financeAuthorizationFromRow(existing);
    if (
      authorization.tenantId !== tenantId ||
      authorization.approvedByPrincipalId !== approvedByPrincipalId ||
      authorization.actorPrincipalId !== actorPrincipalId ||
      authorization.entryType !== input.entryType ||
      authorization.invoiceReference !== invoiceReference ||
      authorization.entryIdempotencyKey !== entryIdempotencyKey ||
      authorization.mcuMicrosDelta !== delta ||
      authorization.reason !== reason ||
      authorization.intentDigest !== intentDigest
    ) {
      throw new Error("usage_finance_authorization_conflict");
    }
    return authorization;
  }
  assertFinanceOwnerAt(db, tenantId, approvedByPrincipalId, input.approvedAt);
  assertActiveActorAt(db, tenantId, actorPrincipalId, input.approvedAt);
  const content = {
    id,
    tenantId,
    approvedByPrincipalId,
    approvedByRole: "finance_owner" as const,
    actorPrincipalId,
    entryType: input.entryType,
    invoiceReference,
    entryIdempotencyKey,
    mcuMicrosDelta: delta,
    reason,
    intentDigest,
    approvedAt: input.approvedAt,
    expiresAt: input.expiresAt,
  };
  const authorizationDigest = usageFinanceAuthorizationDigest(content);
  db.raw.prepare(
    `INSERT INTO usage_finance_authorizations
     (id, tenant_id, approved_by_principal_id, approved_by_role, actor_principal_id,
      entry_type, invoice_reference, entry_idempotency_key, mcu_micros_delta, reason,
      intent_digest, authorization_digest, approved_at, expires_at)
     VALUES (?, ?, ?, 'finance_owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tenantId,
    approvedByPrincipalId,
    actorPrincipalId,
    input.entryType,
    invoiceReference,
    entryIdempotencyKey,
    delta,
    reason,
    intentDigest,
    authorizationDigest,
    input.approvedAt,
    input.expiresAt,
  );
  return financeAuthorizationFromRow(one<FinanceAuthorizationRow>(
    db,
    "SELECT * FROM usage_finance_authorizations WHERE id = ? AND tenant_id = ?",
    [id, tenantId],
  )!);
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
  financeAuthorizationId?: string | null;
  financeAuthorizationDigest?: string | null;
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
  financeAuthorizationId?: string | null;
  financeAuthorizationDigest?: string | null;
  previousHash: string | null;
  createdAt: string;
}) {
  const content = input.financeAuthorizationId === null ||
    input.financeAuthorizationId === undefined
    ? {
        id: input.id,
        tenantId: input.tenantId,
        entrySequence: input.entrySequence,
        entryType: input.entryType,
        entitlementId: input.entitlementId,
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId,
        campaignId: input.campaignId,
        reservationId: input.reservationId,
        priceVersion: input.priceVersion,
        reservedDelta: input.reservedDelta,
        consumedDelta: input.consumedDelta,
        invoiceReference: input.invoiceReference,
        reason: input.reason,
        actorPrincipalId: input.actorPrincipalId,
        previousHash: input.previousHash,
        createdAt: input.createdAt,
      }
    : input;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
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
      row.actorPrincipalId === (input.actorPrincipalId ?? null) &&
      row.financeAuthorizationId === (input.financeAuthorizationId ?? null) &&
      row.financeAuthorizationDigest === (input.financeAuthorizationDigest ?? null);
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
    financeAuthorizationId: input.financeAuthorizationId ?? null,
    financeAuthorizationDigest: input.financeAuthorizationDigest ?? null,
    previousHash,
    createdAt: input.createdAt,
  });
  db.raw.prepare(
    `INSERT INTO usage_ledger_entries
     (id, tenant_id, entry_type, entitlement_id, idempotency_key, task_id, campaign_id, reservation_id,
      price_version, reserved_mcu_micros_delta, consumed_mcu_micros_delta,
      invoice_reference, reason, actor_principal_id, finance_authorization_id,
      finance_authorization_digest, entry_sequence, prev_hash, entry_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    input.financeAuthorizationId ?? null,
    input.financeAuthorizationDigest ?? null,
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
  if (input.financeAuthorizationId) {
    required("usage_finance_authorization_id", input.financeAuthorizationId);
  }
  if (input.financeAuthorizationDigest) {
    required("usage_finance_authorization_digest", input.financeAuthorizationDigest);
  }
  if (Boolean(input.financeAuthorizationId) !== Boolean(input.financeAuthorizationDigest)) {
    throw new Error("usage_finance_authorization_binding_invalid");
  }
  time("usage_created_at", input.createdAt);
  micros("usage_reserved_delta", input.reservedDelta, true);
  micros("usage_consumed_delta", input.consumedDelta, true);
  assertActor(db, input.tenantId, input.actorPrincipalId);
}

type InvoiceAllocation = Readonly<{
  entitlement_id: string;
  price_version: string;
  allocated: number;
  first_sequence: number;
}>;

function invoiceAllocationsFor(
  db: AppDb,
  tenantId: string,
  invoiceReference: string,
  beforeSequence?: number,
): InvoiceAllocation[] {
  const sequenceClause = beforeSequence === undefined ? "" : " AND entry_sequence < ?";
  const params: SQLInputValue[] = [tenantId, invoiceReference];
  if (beforeSequence !== undefined) params.push(beforeSequence);
  return many<InvoiceAllocation>(
    db,
    `SELECT entitlement_id, price_version,
            SUM(consumed_mcu_micros_delta) AS allocated,
            MIN(entry_sequence) AS first_sequence
     FROM usage_ledger_entries
     WHERE tenant_id = ? AND invoice_reference = ?${sequenceClause}
     GROUP BY entitlement_id, price_version
     HAVING allocated > 0
     ORDER BY first_sequence, entitlement_id, price_version`,
    params,
  );
}

function allocateCreditAcrossInvoice(
  allocations: readonly InvoiceAllocation[],
  creditMcuMicros: number,
) {
  let remaining = creditMcuMicros;
  const portions: Array<InvoiceAllocation & { credited: number }> = [];
  for (const allocation of allocations) {
    if (remaining === 0) break;
    const credited = Math.min(remaining, allocation.allocated);
    if (credited > 0) portions.push({ ...allocation, credited });
    remaining -= credited;
  }
  if (remaining !== 0 || portions.length === 0) {
    throw new Error("usage_credit_exceeds_invoice_allocation");
  }
  return portions;
}

function creditAllocationIdentity(
  financeAuthorizationId: string,
  rootIdempotencyKey: string,
  ordinal: number,
  role: "offset" | "portion",
) {
  return `credit-allocation:${sha256(JSON.stringify({
    version: "usage-credit-allocation/1",
    financeAuthorizationId,
    rootIdempotencyKey,
    ordinal,
    role,
  }))}`;
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
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
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
    if (owns) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK");
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
    financeAuthorizationId?: string;
    financeAuthorizationDigest?: string;
  },
  entryType: "adjustment" | "credit",
) {
  const delta = micros("usage_adjustment_mcu_micros", input.mcuMicrosDelta, true);
  if (entryType === "adjustment" && delta <= 0) {
    throw new Error("usage_adjustment_invalid");
  }
  if (entryType === "credit" && delta >= 0) {
    throw new Error("usage_credit_invalid");
  }
  const invoiceReference = input.invoiceReference?.trim();
  if (!invoiceReference) throw new Error("usage_invoice_reference_required");
  const financeAuthorizationId = required(
    "usage_finance_authorization_id",
    input.financeAuthorizationId ?? "",
  );
  const financeAuthorizationDigest = required(
    "usage_finance_authorization_digest",
    input.financeAuthorizationDigest ?? "",
  );
  const actorPrincipalId = required(
    "usage_finance_actor_principal_id",
    input.actorPrincipalId ?? "",
  );
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<EntryRow>(
      db,
      `SELECT * FROM usage_ledger_entries WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    const authorization = one<FinanceAuthorizationRow>(
      db,
      `SELECT * FROM usage_finance_authorizations WHERE id = ? AND tenant_id = ?`,
      [financeAuthorizationId, input.tenantId],
    );
    if (!authorization) throw new Error("usage_finance_authorization_required");
    const finance = financeAuthorizationFromRow(authorization);
    const expectedIntent = usageFinanceIntent({
      tenantId: input.tenantId,
      actorPrincipalId,
      entryType,
      invoiceReference,
      entryIdempotencyKey: input.idempotencyKey,
      mcuMicrosDelta: delta,
      reason: input.reason,
    });
    if (
      finance.approvedByRole !== "finance_owner" ||
      finance.intentDigest !== sha256(expectedIntent) ||
      finance.authorizationDigest !== financeAuthorizationDigest ||
      finance.authorizationDigest !== usageFinanceAuthorizationDigest({
        id: finance.id,
        tenantId: finance.tenantId,
        approvedByPrincipalId: finance.approvedByPrincipalId,
        approvedByRole: finance.approvedByRole,
        actorPrincipalId: finance.actorPrincipalId,
        entryType: finance.entryType,
        invoiceReference: finance.invoiceReference,
        entryIdempotencyKey: finance.entryIdempotencyKey,
        mcuMicrosDelta: finance.mcuMicrosDelta,
        reason: finance.reason,
        intentDigest: finance.intentDigest,
        approvedAt: finance.approvedAt,
        expiresAt: finance.expiresAt,
      })
    ) {
      throw new Error("usage_finance_authorization_binding_invalid");
    }
    if (existing) {
      const committed = entryFromRow(existing);
      const exactReplay =
        committed.entryType === entryType &&
        committed.taskId === input.taskId &&
        committed.campaignId === (input.campaignId ?? null) &&
        committed.reservationId === null &&
        committed.reservedMcuMicrosDelta === 0 &&
        committed.consumedMcuMicrosDelta === delta &&
        committed.invoiceReference === invoiceReference &&
        committed.reason === input.reason &&
        committed.actorPrincipalId === actorPrincipalId &&
        committed.financeAuthorizationId === financeAuthorizationId &&
        committed.financeAuthorizationDigest === financeAuthorizationDigest &&
        finance.consumedEntryId === committed.id &&
        financeAuthorizationMatchesEntry(db, committed);
      if (!exactReplay) throw new Error("usage_idempotency_conflict");
      db.raw.exec("COMMIT");
      return committed;
    }
    const occurredAtMs = time("usage_created_at", input.createdAt);
    if (
      occurredAtMs < time("usage_finance_approved_at", finance.approvedAt) ||
      occurredAtMs >= time("usage_finance_expires_at", finance.expiresAt)
    ) {
      throw new Error("usage_finance_authorization_expired");
    }
    assertFinanceOwnerAt(db, input.tenantId, finance.approvedByPrincipalId, input.createdAt);
    assertActiveActorAt(db, input.tenantId, actorPrincipalId, input.createdAt);
    if (finance.consumedEntryId !== null) {
      throw new Error("usage_finance_authorization_consumed");
    }
    const invoiceAllocations = invoiceAllocationsFor(db, input.tenantId, invoiceReference);
    const invoiceAllocation = invoiceAllocations.reduce(
      (total, allocation) => total + allocation.allocated,
      0,
    );
    if (invoiceAllocation <= 0) throw new Error("usage_invoice_allocation_not_found");
    if (entryType === "credit" && invoiceAllocation + delta < 0) {
      throw new Error("usage_credit_exceeds_invoice_allocation");
    }
    const activeEntitlement = getActiveUsageEntitlement(db, input.tenantId, input.createdAt);
    const creditAllocations = entryType === "credit"
      ? allocateCreditAcrossInvoice(invoiceAllocations, -delta)
      : [];
    const creditAllocation = creditAllocations[0] ?? null;
    const entitlement = creditAllocation
      ? one<EntitlementRow>(db, "SELECT * FROM usage_entitlements WHERE id = ? AND tenant_id = ?", [
          creditAllocation.entitlement_id,
          input.tenantId,
        ])
      : activeEntitlement
        ? one<EntitlementRow>(db, "SELECT * FROM usage_entitlements WHERE id = ? AND tenant_id = ?", [
            activeEntitlement.id,
            input.tenantId,
          ])
        : undefined;
    if (!entitlement) throw new Error(entryType === "credit"
      ? "usage_credit_exceeds_consumption"
      : "usage_entitlement_required");
    const selectedEntitlement = entitlementFromRow(entitlement);
    const totals = currentTotals(db, input.tenantId, selectedEntitlement.id);
    const firstCreditDelta = creditAllocation ? -creditAllocation.credited : delta;
    const nextConsumed = totals.consumed + firstCreditDelta;
    if (nextConsumed < 0) throw new Error("usage_credit_exceeds_consumption");
    if (
      delta > 0 &&
      totals.reserved + nextConsumed > selectedEntitlement.quotaMcuMicros
    ) {
      throw new Error("usage_quota_exceeded");
    }
    const entry: EntryInput = {
      ...input,
      entryType,
      entitlementId: selectedEntitlement.id,
      priceVersion: selectedEntitlement.priceVersionId,
      reservedDelta: 0,
      consumedDelta: delta,
      financeAuthorizationId,
      financeAuthorizationDigest,
    };
    prepareEntry(db, entry);
    const result = insertEntry(db, entry);
    if (entryType === "credit" && creditAllocations.length > 1) {
      const offset = -delta - creditAllocations[0]!.credited;
      const offsetIdentity = creditAllocationIdentity(
        financeAuthorizationId,
        input.idempotencyKey,
        0,
        "offset",
      );
      const derivedEntries: EntryInput[] = [{
        ...input,
        id: offsetIdentity,
        idempotencyKey: offsetIdentity,
        entryType: "credit",
        entitlementId: selectedEntitlement.id,
        priceVersion: selectedEntitlement.priceVersionId,
        reservedDelta: 0,
        consumedDelta: offset,
        financeAuthorizationId,
        financeAuthorizationDigest,
      }];
      for (let index = 1; index < creditAllocations.length; index += 1) {
        const allocation = creditAllocations[index]!;
        const allocationEntitlement = one<EntitlementRow>(
          db,
          "SELECT * FROM usage_entitlements WHERE id = ? AND tenant_id = ?",
          [allocation.entitlement_id, input.tenantId],
        );
        if (!allocationEntitlement) throw new Error("usage_credit_allocation_entitlement_missing");
        const resolved = entitlementFromRow(allocationEntitlement);
        const allocationTotals = currentTotals(db, input.tenantId, resolved.id);
        if (allocationTotals.consumed - allocation.credited < 0) {
          throw new Error("usage_credit_exceeds_consumption");
        }
        const identity = creditAllocationIdentity(
          financeAuthorizationId,
          input.idempotencyKey,
          index,
          "portion",
        );
        derivedEntries.push({
          ...input,
          id: identity,
          idempotencyKey: identity,
          entryType: "credit",
          entitlementId: resolved.id,
          priceVersion: resolved.priceVersionId,
          reservedDelta: 0,
          consumedDelta: -allocation.credited,
          financeAuthorizationId,
          financeAuthorizationDigest,
        });
      }
      for (const derivedEntry of derivedEntries) {
        prepareEntry(db, derivedEntry);
        insertEntry(db, derivedEntry);
      }
    }
    if (finance.consumedEntryId === null) {
      const consumed = db.raw.prepare(
        `UPDATE usage_finance_authorizations
         SET consumed_at = ?, consumed_entry_id = ?
         WHERE id = ? AND tenant_id = ? AND consumed_at IS NULL AND consumed_entry_id IS NULL`,
      ).run(input.createdAt, result.id, finance.id, input.tenantId);
      if (consumed.changes !== 1) throw new Error("usage_finance_authorization_consumed");
    }
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

function financeAuthorizationMatchesEntry(db: AppDb, entry: UsageLedgerEntry): boolean {
  if (entry.entryType !== "adjustment" && entry.entryType !== "credit") {
    return entry.financeAuthorizationId === null && entry.financeAuthorizationDigest === null;
  }
  if (
    !entry.financeAuthorizationId ||
    !entry.financeAuthorizationDigest ||
    !entry.invoiceReference ||
    !entry.actorPrincipalId
  ) {
    return false;
  }
  const row = one<FinanceAuthorizationRow>(
    db,
    `SELECT * FROM usage_finance_authorizations WHERE tenant_id = ? AND id = ?`,
    [entry.tenantId, entry.financeAuthorizationId],
  );
  if (!row) return false;
  const finance = financeAuthorizationFromRow(row);
  const expectedAuthorizationDigest = usageFinanceAuthorizationDigest({
    id: finance.id,
    tenantId: finance.tenantId,
    approvedByPrincipalId: finance.approvedByPrincipalId,
    approvedByRole: finance.approvedByRole,
    actorPrincipalId: finance.actorPrincipalId,
    entryType: finance.entryType,
    invoiceReference: finance.invoiceReference,
    entryIdempotencyKey: finance.entryIdempotencyKey,
    mcuMicrosDelta: finance.mcuMicrosDelta,
    reason: finance.reason,
    intentDigest: finance.intentDigest,
    approvedAt: finance.approvedAt,
    expiresAt: finance.expiresAt,
  });
  if (finance.authorizationDigest !== expectedAuthorizationDigest) return false;
  if (finance.entryType === "adjustment") {
    const expectedIntentDigest = sha256(usageFinanceIntent({
      tenantId: entry.tenantId,
      actorPrincipalId: entry.actorPrincipalId,
      entryType: entry.entryType,
      invoiceReference: entry.invoiceReference,
      entryIdempotencyKey: entry.idempotencyKey,
      mcuMicrosDelta: entry.consumedMcuMicrosDelta,
      reason: entry.reason,
    }));
    return entry.entryType === "adjustment" &&
      finance.intentDigest === expectedIntentDigest &&
      finance.authorizationDigest === entry.financeAuthorizationDigest &&
      finance.consumedEntryId === entry.id &&
      finance.consumedAt === entry.createdAt;
  }
  if (!finance.consumedEntryId) return false;
  const rootRow = one<EntryRow>(
    db,
    "SELECT * FROM usage_ledger_entries WHERE tenant_id = ? AND id = ?",
    [finance.tenantId, finance.consumedEntryId],
  );
  if (!rootRow) return false;
  const root = entryFromRow(rootRow);
  const expectedIntentDigest = sha256(usageFinanceIntent({
    tenantId: root.tenantId,
    actorPrincipalId: root.actorPrincipalId!,
    entryType: root.entryType as "credit",
    invoiceReference: root.invoiceReference!,
    entryIdempotencyKey: root.idempotencyKey,
    mcuMicrosDelta: root.consumedMcuMicrosDelta,
    reason: root.reason,
  }));
  if (
    root.entryType !== "credit" ||
    root.idempotencyKey !== finance.entryIdempotencyKey ||
    root.consumedMcuMicrosDelta !== finance.mcuMicrosDelta ||
    root.invoiceReference !== finance.invoiceReference ||
    root.actorPrincipalId !== finance.actorPrincipalId ||
    root.financeAuthorizationDigest !== finance.authorizationDigest ||
    root.reason !== finance.reason ||
    finance.intentDigest !== expectedIntentDigest ||
    finance.consumedAt !== root.createdAt
  ) {
    return false;
  }
  let portions: ReturnType<typeof allocateCreditAcrossInvoice>;
  try {
    portions = allocateCreditAcrossInvoice(
      invoiceAllocationsFor(db, finance.tenantId, finance.invoiceReference, root.entrySequence),
      -finance.mcuMicrosDelta,
    );
  } catch {
    return false;
  }
  const expected = [{
    id: root.id,
    idempotencyKey: finance.entryIdempotencyKey,
    entitlementId: portions[0]!.entitlement_id,
    priceVersion: portions[0]!.price_version,
    consumedDelta: finance.mcuMicrosDelta,
  }];
  if (portions.length > 1) {
    const offsetIdentity = creditAllocationIdentity(finance.id, finance.entryIdempotencyKey, 0, "offset");
    expected.push({
      id: offsetIdentity,
      idempotencyKey: offsetIdentity,
      entitlementId: portions[0]!.entitlement_id,
      priceVersion: portions[0]!.price_version,
      consumedDelta: -finance.mcuMicrosDelta - portions[0]!.credited,
    });
    for (let index = 1; index < portions.length; index += 1) {
      const portion = portions[index]!;
      const identity = creditAllocationIdentity(finance.id, finance.entryIdempotencyKey, index, "portion");
      expected.push({
        id: identity,
        idempotencyKey: identity,
        entitlementId: portion.entitlement_id,
        priceVersion: portion.price_version,
        consumedDelta: -portion.credited,
      });
    }
  }
  const actual = many<EntryRow>(
    db,
    `SELECT * FROM usage_ledger_entries
     WHERE tenant_id = ? AND finance_authorization_id = ? ORDER BY entry_sequence`,
    [finance.tenantId, finance.id],
  ).map(entryFromRow);
  if (actual.length !== expected.length) return false;
  return actual.every((candidate, index) => {
    const wanted = expected[index]!;
    return candidate.id === wanted.id &&
      candidate.idempotencyKey === wanted.idempotencyKey &&
      candidate.entryType === "credit" &&
      candidate.entitlementId === wanted.entitlementId &&
      candidate.priceVersion === wanted.priceVersion &&
      candidate.reservedMcuMicrosDelta === 0 &&
      candidate.consumedMcuMicrosDelta === wanted.consumedDelta &&
      candidate.taskId === root.taskId &&
      candidate.campaignId === root.campaignId &&
      candidate.reservationId === null &&
      candidate.invoiceReference === finance.invoiceReference &&
      candidate.reason === finance.reason &&
      candidate.actorPrincipalId === finance.actorPrincipalId &&
      candidate.financeAuthorizationDigest === finance.authorizationDigest &&
      candidate.createdAt === root.createdAt;
  });
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
      financeAuthorizationId: entry.financeAuthorizationId,
      financeAuthorizationDigest: entry.financeAuthorizationDigest,
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
    if (!financeAuthorizationMatchesEntry(db, entry)) {
      return {
        ok: false,
        checked: index,
        error: `usage_finance_authorization_invalid:${entry.id}`,
      };
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
      if (invoices[entry.invoiceReference]! < 0) {
        return { ok: false, checked: index, error: `usage_invoice_negative:${entry.id}` };
      }
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
