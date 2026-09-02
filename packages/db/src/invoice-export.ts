import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { reconcileUsageLedger } from "./usage.js";

export const INVOICE_EXPORT_SCHEMA_VERSION = 1 as const;

export type InvoiceExportState =
  | "issued"
  | "exported"
  | "acknowledged"
  | "overdue"
  | "resolved"
  | "void";

export type InvoiceExportLineKind = "usage" | "adjustment" | "credit" | "refund";

export type InvoiceExportSigner = Readonly<{
  keyId: string;
  authorize(input: Readonly<{
    tenantId: string;
    actorPrincipalId: string;
    currency: string;
    contractReference: string;
    tax: Readonly<{ basisPoints: number; jurisdiction: string; policyVersion: string }>;
  }>): boolean;
  sign(canonicalPayload: string): string;
  verifyForKey(keyId: string, canonicalPayload: string, signature: string): boolean;
  verificationMaterialForKey?(keyId: string): Readonly<{
    algorithm: "ed25519";
    publicKeySpkiBase64: string;
  }> | null;
}>;

export type InvoiceExportLine = Readonly<{
  id: string;
  ordinal: number;
  usageEntryId: string;
  usageEntrySequence: number;
  usageEntryHash: string;
  kind: InvoiceExportLineKind;
  taskId: string;
  campaignId: string | null;
  priceVersionId: string;
  formulaVersion: string;
  contractReference: string;
  currency: string;
  mcuMicros: number;
  moneyMicros: number;
  reason: string;
}>;

export type InvoiceExportStateEvent = Readonly<{
  id: string;
  sequence: number;
  state: InvoiceExportState;
  policyVersion: string;
  reason: string;
  actorPrincipalId: string;
  previousHash: string | null;
  eventHash: string;
  authorityKeyId: string;
  authoritySignature: string;
  occurredAt: string;
}>;

export type InvoiceExport = Readonly<{
  id: string;
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  contractReference: string;
  tax: Readonly<{
    basisPoints: number;
    jurisdiction: string;
    policyVersion: string;
  }>;
  subtotalMoneyMicros: number;
  taxMoneyMicros: number;
  totalMoneyMicros: number;
  canonicalPayload: string;
  payloadDigest: string;
  signingKeyId: string;
  signature: string;
  state: InvoiceExportState;
  issuedAt: string;
  lines: readonly InvoiceExportLine[];
  stateHistory: readonly InvoiceExportStateEvent[];
}>;

export type InvoiceExportReconciliation = Readonly<{
  complete: boolean;
  usageChain: Readonly<{
    ok: boolean;
    checked: number;
    legacyUnverifiedFinanceEntryIds: readonly string[];
  }>;
  sourceLines: Readonly<{ ok: boolean; checked: number }>;
  lineSums: Readonly<{ ok: boolean }>;
  payload: Readonly<{ ok: boolean }>;
  signature: Readonly<{ ok: boolean; keyId: string }>;
  stateEvents: Readonly<{ ok: boolean; checked: number }>;
  issues: readonly string[];
}>;

type ExportRow = {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  period_start: string;
  period_end: string;
  currency: string;
  contract_reference: string;
  tax_basis_points: number;
  tax_jurisdiction: string;
  tax_policy_version: string;
  subtotal_money_micros: number;
  tax_money_micros: number;
  total_money_micros: number;
  canonical_payload: string;
  payload_digest: string;
  signing_key_id: string;
  signature: string;
  initial_state: "issued";
  actor_principal_id: string;
  issued_at: string;
};

type LineRow = {
  id: string;
  invoice_id: string;
  tenant_id: string;
  ordinal: number;
  usage_entry_id: string;
  usage_entry_sequence: number;
  usage_entry_hash: string;
  kind: InvoiceExportLineKind;
  task_id: string;
  campaign_id: string | null;
  price_version_id: string;
  formula_version: string;
  contract_reference: string;
  currency: string;
  mcu_micros: number;
  money_micros: number;
  reason: string;
};

type EventRow = {
  id: string;
  invoice_id: string;
  tenant_id: string;
  idempotency_key: string;
  sequence: number;
  state: InvoiceExportState;
  policy_version: string;
  reason: string;
  actor_principal_id: string;
  prev_hash: string | null;
  event_hash: string;
  authority_key_id: string;
  authority_signature: string;
  occurred_at: string;
};

type UsageSourceRow = {
  id: string;
  entry_type: "settlement" | "adjustment" | "credit";
  task_id: string;
  campaign_id: string | null;
  price_version: string;
  consumed_mcu_micros_delta: number;
  reason: string;
  entry_sequence: number;
  entry_hash: string;
  currency: string | null;
  price_per_mcu_money_micros: number | null;
  formula_version: string | null;
  price_contract_reference: string | null;
  entitlement_contract_reference: string | null;
};

type TaxInput = Readonly<{
  basisPoints: number;
  jurisdiction: string;
  policyVersion: string;
}>;

type Draft = Readonly<{
  lines: readonly InvoiceExportLine[];
  subtotalMoneyMicros: number;
  taxMoneyMicros: number;
  totalMoneyMicros: number;
  canonicalPayload: string;
  payloadDigest: string;
}>;

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function text(name: string, value: unknown): string {
  if (typeof value !== "string") throw new Error(`${name}_invalid`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name}_invalid`);
  return normalized;
}

function utcTime(name: string, value: unknown): string {
  const normalized = text(name, value);
  if (
    !normalized.endsWith("Z") ||
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(normalized).toISOString() !== normalized
  ) {
    throw new Error(`${name}_invalid`);
  }
  return normalized;
}

function safeInteger(name: string, value: unknown, minimum = Number.MIN_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${name}_invalid`);
  }
  return value as number;
}

function safeSum(name: string, values: readonly number[]): number {
  let total = 0n;
  for (const value of values) total += BigInt(safeInteger(name, value));
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${name}_overflow`);
  }
  return Number(total);
}

function multiplyDivide(name: string, left: number, right: number, divisor: number): number {
  const result = (BigInt(safeInteger(name, left)) * BigInt(safeInteger(name, right))) /
    BigInt(safeInteger(name, divisor, 1));
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${name}_overflow`);
  }
  return Number(result);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function actorAuthorizedAt(
  db: AppDb,
  tenantId: string,
  actorPrincipalId: string,
  occurredAt: string,
): boolean {
  const actor = one<{
    tenant_id: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>(
    db,
    "SELECT tenant_id, created_at, expires_at, revoked_at FROM principals WHERE id = ?",
    [actorPrincipalId],
  );
  if (!actor || actor.tenant_id !== tenantId) return false;
  const occurredAtMs = Date.parse(occurredAt);
  const createdAtMs = Date.parse(actor.created_at);
  const expiresAtMs = actor.expires_at === null ? null : Date.parse(actor.expires_at);
  const revokedAtMs = actor.revoked_at === null ? null : Date.parse(actor.revoked_at);
  return Number.isFinite(occurredAtMs) &&
    Number.isFinite(createdAtMs) &&
    occurredAtMs >= createdAtMs &&
    (expiresAtMs === null || (Number.isFinite(expiresAtMs) && occurredAtMs < expiresAtMs)) &&
    (revokedAtMs === null || (Number.isFinite(revokedAtMs) && occurredAtMs < revokedAtMs));
}

function sourceRows(
  db: AppDb,
  tenantId: string,
  periodStart: string,
  periodEnd: string,
  currency: string,
  contractReference: string,
): UsageSourceRow[] {
  return many<UsageSourceRow>(
    db,
    `SELECT usage.id, usage.entry_type, usage.task_id, usage.campaign_id,
            usage.price_version, usage.consumed_mcu_micros_delta, usage.reason,
            usage.entry_sequence, usage.entry_hash, price.currency,
            price.price_per_mcu_money_micros, price.formula_version,
            price.contract_reference AS price_contract_reference,
            entitlement.contract_reference AS entitlement_contract_reference
     FROM usage_ledger_entries usage
     LEFT JOIN usage_price_versions price
       ON price.id = usage.price_version AND price.tenant_id = usage.tenant_id
     LEFT JOIN usage_entitlements entitlement
       ON entitlement.id = usage.entitlement_id AND entitlement.tenant_id = usage.tenant_id
     WHERE usage.tenant_id = ?
       AND usage.entry_type IN ('settlement', 'adjustment', 'credit')
       AND usage.created_at >= ? AND usage.created_at < ?
       AND price.currency = ?
       AND price.contract_reference = ?
       AND entitlement.contract_reference = ?
     ORDER BY usage.entry_sequence`,
    [tenantId, periodStart, periodEnd, currency, contractReference, contractReference],
  );
}

function lineFromRow(row: LineRow): InvoiceExportLine {
  return Object.freeze({
    id: row.id,
    ordinal: row.ordinal,
    usageEntryId: row.usage_entry_id,
    usageEntrySequence: row.usage_entry_sequence,
    usageEntryHash: row.usage_entry_hash,
    kind: row.kind,
    taskId: row.task_id,
    campaignId: row.campaign_id,
    priceVersionId: row.price_version_id,
    formulaVersion: row.formula_version,
    contractReference: row.contract_reference,
    currency: row.currency,
    mcuMicros: row.mcu_micros,
    moneyMicros: row.money_micros,
    reason: row.reason,
  });
}

function eventFromRow(row: EventRow): InvoiceExportStateEvent {
  return Object.freeze({
    id: row.id,
    sequence: row.sequence,
    state: row.state,
    policyVersion: row.policy_version,
    reason: row.reason,
    actorPrincipalId: row.actor_principal_id,
    previousHash: row.prev_hash,
    eventHash: row.event_hash,
    authorityKeyId: row.authority_key_id,
    authoritySignature: row.authority_signature,
    occurredAt: row.occurred_at,
  });
}

function payloadFor(
  input: Readonly<{
    id: string;
    tenantId: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    contractReference: string;
    tax: TaxInput;
    issuedAt: string;
  }>,
  lines: readonly InvoiceExportLine[],
  subtotalMoneyMicros: number,
  taxMoneyMicros: number,
  totalMoneyMicros: number,
): string {
  return canonicalJson({
    schemaVersion: INVOICE_EXPORT_SCHEMA_VERSION,
    invoiceId: input.id,
    tenantId: input.tenantId,
    period: { start: input.periodStart, end: input.periodEnd },
    currency: input.currency,
    contractReference: input.contractReference,
    tax: input.tax,
    moneyRounding: "toward_zero_money_micros",
    lines: lines.map(({ id: _id, ...line }) => line),
    subtotalMoneyMicros,
    taxMoneyMicros,
    totalMoneyMicros,
    issuedAt: input.issuedAt,
  });
}

function deriveDraft(
  db: AppDb,
  input: Readonly<{
    id: string;
    tenantId: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    contractReference: string;
    tax: TaxInput;
    issuedAt: string;
  }>,
): Draft {
  const integrity = reconcileUsageLedger(db, input.tenantId);
  if (!integrity.ok) throw new Error("invoice_export_usage_chain_invalid");
  const sources = sourceRows(
    db,
    input.tenantId,
    input.periodStart,
    input.periodEnd,
    input.currency,
    input.contractReference,
  );
  if (sources.length === 0) throw new Error("invoice_export_usage_required");
  const lines = sources.map((source, index): InvoiceExportLine => {
    if (
      source.currency !== input.currency ||
      source.price_contract_reference !== input.contractReference ||
      source.entitlement_contract_reference !== input.contractReference
    ) {
      throw new Error("invoice_export_price_contract_mismatch");
    }
    const price = safeInteger(
      "invoice_export_price_money_micros",
      source.price_per_mcu_money_micros,
      0,
    );
    const mcuMicros = safeInteger("invoice_export_mcu_micros", source.consumed_mcu_micros_delta);
    const kind: InvoiceExportLineKind = source.entry_type === "settlement"
      ? "usage"
      : source.entry_type === "credit"
        ? "credit"
        : mcuMicros < 0 ? "refund" : "adjustment";
    return Object.freeze({
      id: `${input.id}:line:${index + 1}`,
      ordinal: index + 1,
      usageEntryId: text("invoice_export_usage_entry_id", source.id),
      usageEntrySequence: safeInteger("invoice_export_usage_sequence", source.entry_sequence, 1),
      usageEntryHash: text("invoice_export_usage_hash", source.entry_hash),
      kind,
      taskId: text("invoice_export_task_id", source.task_id),
      campaignId: source.campaign_id,
      priceVersionId: text("invoice_export_price_version", source.price_version),
      formulaVersion: text("invoice_export_formula_version", source.formula_version),
      contractReference: input.contractReference,
      currency: input.currency,
      mcuMicros,
      moneyMicros: multiplyDivide("invoice_export_money", mcuMicros, price, 1_000_000),
      reason: text("invoice_export_line_reason", source.reason),
    });
  });
  const subtotalMoneyMicros = safeSum(
    "invoice_export_subtotal_money_micros",
    lines.map((line) => line.moneyMicros),
  );
  const taxMoneyMicros = multiplyDivide(
    "invoice_export_tax_money_micros",
    subtotalMoneyMicros,
    input.tax.basisPoints,
    10_000,
  );
  const totalMoneyMicros = safeSum(
    "invoice_export_total_money_micros",
    [subtotalMoneyMicros, taxMoneyMicros],
  );
  const canonicalPayload = payloadFor(
    input,
    lines,
    subtotalMoneyMicros,
    taxMoneyMicros,
    totalMoneyMicros,
  );
  return Object.freeze({
    lines: Object.freeze(lines),
    subtotalMoneyMicros,
    taxMoneyMicros,
    totalMoneyMicros,
    canonicalPayload,
    payloadDigest: digest(canonicalPayload),
  });
}

function eventHash(input: Readonly<{
  invoiceId: string;
  tenantId: string;
  idempotencyKey: string;
  sequence: number;
  state: InvoiceExportState;
  policyVersion: string;
  reason: string;
  actorPrincipalId: string;
  previousHash: string | null;
  occurredAt: string;
}>): string {
  return digest(canonicalJson({ schemaVersion: 1, ...input }));
}

function exportRow(db: AppDb, tenantId: string, invoiceId: string): ExportRow | undefined {
  return one<ExportRow>(
    db,
    "SELECT * FROM invoice_exports WHERE id = ? AND tenant_id = ?",
    [invoiceId, tenantId],
  );
}

function invoiceFromRow(db: AppDb, row: ExportRow): InvoiceExport {
  const lines = many<LineRow>(
    db,
    "SELECT * FROM invoice_export_lines WHERE invoice_id = ? AND tenant_id = ? ORDER BY ordinal",
    [row.id, row.tenant_id],
  ).map(lineFromRow);
  const stateHistory = many<EventRow>(
    db,
    "SELECT * FROM invoice_export_state_events WHERE invoice_id = ? AND tenant_id = ? ORDER BY sequence",
    [row.id, row.tenant_id],
  ).map(eventFromRow);
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: row.currency,
    contractReference: row.contract_reference,
    tax: Object.freeze({
      basisPoints: row.tax_basis_points,
      jurisdiction: row.tax_jurisdiction,
      policyVersion: row.tax_policy_version,
    }),
    subtotalMoneyMicros: row.subtotal_money_micros,
    taxMoneyMicros: row.tax_money_micros,
    totalMoneyMicros: row.total_money_micros,
    canonicalPayload: row.canonical_payload,
    payloadDigest: row.payload_digest,
    signingKeyId: row.signing_key_id,
    signature: row.signature,
    state: stateHistory.at(-1)?.state ?? row.initial_state,
    issuedAt: row.issued_at,
    lines: Object.freeze(lines),
    stateHistory: Object.freeze(stateHistory),
  });
}

export function getInvoiceExport(
  db: AppDb,
  tenantId: string,
  invoiceId: string,
): InvoiceExport | null {
  const row = exportRow(
    db,
    text("invoice_export_tenant", tenantId),
    text("invoice_export_id", invoiceId),
  );
  return row ? invoiceFromRow(db, row) : null;
}

export function createInvoiceExport(
  db: AppDb,
  input: Readonly<{
    id: string;
    tenantId: string;
    idempotencyKey: string;
    periodStart: string;
    periodEnd: string;
    currency: string;
    contractReference: string;
    tax: TaxInput;
    actorPrincipalId: string;
    issuedAt: string;
    signer?: InvoiceExportSigner;
  }>,
): InvoiceExport {
  const id = text("invoice_export_id", input.id);
  const tenantId = text("invoice_export_tenant", input.tenantId);
  const idempotencyKey = text("invoice_export_idempotency_key", input.idempotencyKey);
  const actorPrincipalId = text("invoice_export_actor", input.actorPrincipalId);
  const periodStart = utcTime("invoice_export_period_start", input.periodStart);
  const periodEnd = utcTime("invoice_export_period_end", input.periodEnd);
  const periodMs = Date.parse(periodEnd) - Date.parse(periodStart);
  if (periodMs <= 0 || periodMs > 366 * 24 * 60 * 60 * 1_000) {
    throw new Error("invoice_export_period_invalid");
  }
  const issuedAt = utcTime("invoice_export_issued_at", input.issuedAt);
  if (Date.parse(issuedAt) < Date.parse(periodEnd)) {
    throw new Error("invoice_export_period_open");
  }
  const currency = text("invoice_export_currency", input.currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("invoice_export_currency_invalid");
  const contractReference = text("invoice_export_contract", input.contractReference);
  if (!input.tax || typeof input.tax !== "object") throw new Error("invoice_export_tax_required");
  const tax = Object.freeze({
    basisPoints: safeInteger("invoice_export_tax_basis_points", input.tax.basisPoints, 0),
    jurisdiction: text("invoice_export_tax_jurisdiction", input.tax.jurisdiction),
    policyVersion: text("invoice_export_tax_policy_version", input.tax.policyVersion),
  });
  if (tax.basisPoints > 10_000) throw new Error("invoice_export_tax_basis_points_invalid");
  if (!input.signer) throw new Error("invoice_export_signer_required");
  const signingKeyId = text("invoice_export_signing_key", input.signer.keyId);
  if (!input.signer.authorize({
    tenantId,
    actorPrincipalId,
    currency,
    contractReference,
    tax,
  })) {
    throw new Error("invoice_export_signing_not_authorized");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (!actorAuthorizedAt(db, tenantId, actorPrincipalId, issuedAt)) {
      throw new Error("invoice_export_actor_inactive");
    }
    const idOwner = one<{ tenant_id: string; idempotency_key: string }>(
      db,
      "SELECT tenant_id, idempotency_key FROM invoice_exports WHERE id = ?",
      [id],
    );
    if (idOwner && idOwner.tenant_id !== tenantId) {
      throw new Error("invoice_export_id_tenant_mismatch");
    }
    const existing = one<ExportRow>(
      db,
      "SELECT * FROM invoice_exports WHERE tenant_id = ? AND idempotency_key = ?",
      [tenantId, idempotencyKey],
    );
    if (idOwner && idOwner.idempotency_key !== idempotencyKey) {
      throw new Error("invoice_export_idempotency_conflict");
    }
    const draft = deriveDraft(db, {
      id,
      tenantId,
      periodStart,
      periodEnd,
      currency,
      contractReference,
      tax,
      issuedAt: existing?.issued_at ?? issuedAt,
    });
    if (existing) {
      if (existing.id !== id || existing.payload_digest !== draft.payloadDigest) {
        throw new Error("invoice_export_idempotency_conflict");
      }
      const reconciliation = reconcileInvoiceExport(db, tenantId, id, input.signer);
      if (!reconciliation.complete) throw new Error("invoice_export_reconciliation_incomplete");
      const replay = invoiceFromRow(db, existing);
      db.raw.exec("COMMIT");
      return replay;
    }
    const existingSource = db.raw.prepare(
      "SELECT invoice_id FROM invoice_export_lines WHERE tenant_id = ? AND usage_entry_id = ? LIMIT 1",
    );
    for (const line of draft.lines) {
      if (existingSource.get(tenantId, line.usageEntryId)) {
        throw new Error("invoice_export_source_already_invoiced");
      }
    }
    const signature = text(
      "invoice_export_signature",
      input.signer.sign(draft.canonicalPayload),
    );
    if (signature.length > 8_192) throw new Error("invoice_export_signature_invalid");
    if (!input.signer.verifyForKey(signingKeyId, draft.canonicalPayload, signature)) {
      throw new Error("invoice_export_signature_invalid");
    }
    const initialEventId = `${id}:state:1`;
    const initialEventHash = eventHash({
      invoiceId: id,
      tenantId,
      idempotencyKey: `${idempotencyKey}:issued`,
      sequence: 1,
      state: "issued",
      policyVersion: "invoice-export/1",
      reason: "signed invoice issued",
      actorPrincipalId,
      previousHash: null,
      occurredAt: issuedAt,
    });
    const initialAuthoritySignature = text(
      "invoice_export_state_authority_signature",
      input.signer.sign(initialEventHash),
    );
    if (!input.signer.verifyForKey(signingKeyId, initialEventHash, initialAuthoritySignature)) {
      throw new Error("invoice_export_state_signature_invalid");
    }
    db.raw.prepare(
      `INSERT INTO invoice_exports
       (id, tenant_id, idempotency_key, period_start, period_end, currency,
        contract_reference, tax_basis_points, tax_jurisdiction, tax_policy_version,
        subtotal_money_micros, tax_money_micros, total_money_micros,
        canonical_payload, payload_digest, signing_key_id, signature, initial_state,
        actor_principal_id, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`,
    ).run(
      id, tenantId, idempotencyKey, periodStart, periodEnd, currency,
      contractReference, tax.basisPoints, tax.jurisdiction, tax.policyVersion,
      draft.subtotalMoneyMicros, draft.taxMoneyMicros, draft.totalMoneyMicros,
      draft.canonicalPayload, draft.payloadDigest, signingKeyId, signature,
      actorPrincipalId, issuedAt,
    );
    const insertLine = db.raw.prepare(
      `INSERT INTO invoice_export_lines
       (id, invoice_id, tenant_id, ordinal, usage_entry_id, usage_entry_sequence,
        usage_entry_hash, kind, task_id, campaign_id, price_version_id,
        formula_version, contract_reference, currency, mcu_micros, money_micros, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const line of draft.lines) {
      insertLine.run(
        line.id, id, tenantId, line.ordinal, line.usageEntryId,
        line.usageEntrySequence, line.usageEntryHash, line.kind, line.taskId,
        line.campaignId, line.priceVersionId, line.formulaVersion,
        line.contractReference, line.currency, line.mcuMicros, line.moneyMicros,
        line.reason,
      );
    }
    db.raw.prepare(
      `INSERT INTO invoice_export_state_events
       (id, invoice_id, tenant_id, idempotency_key, sequence, state,
        policy_version, reason, actor_principal_id, prev_hash, event_hash,
        authority_key_id, authority_signature, occurred_at)
       VALUES (?, ?, ?, ?, 1, 'issued', 'invoice-export/1', 'signed invoice issued', ?, NULL, ?, ?, ?, ?)`,
    ).run(
      initialEventId, id, tenantId, `${idempotencyKey}:issued`,
      actorPrincipalId, initialEventHash, signingKeyId, initialAuthoritySignature, issuedAt,
    );
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return getInvoiceExport(db, tenantId, id)!;
}

const ALLOWED_STATE_TRANSITIONS = Object.freeze({
  issued: Object.freeze(["exported", "void"]),
  exported: Object.freeze(["acknowledged", "overdue", "void"]),
  acknowledged: Object.freeze(["overdue", "resolved", "void"]),
  overdue: Object.freeze(["resolved", "void"]),
  resolved: Object.freeze([]),
  void: Object.freeze([]),
} satisfies Record<InvoiceExportState, readonly InvoiceExportState[]>);

export function transitionInvoiceExportState(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    invoiceId: string;
    idempotencyKey: string;
    state: InvoiceExportState;
    policyVersion: string;
    reason: string;
    actorPrincipalId: string;
    occurredAt: string;
    authority?: InvoiceExportSigner;
  }>,
): InvoiceExport {
  const tenantId = text("invoice_export_tenant", input.tenantId);
  const invoiceId = text("invoice_export_id", input.invoiceId);
  const idempotencyKey = text("invoice_export_state_idempotency_key", input.idempotencyKey);
  const actorPrincipalId = text("invoice_export_actor", input.actorPrincipalId);
  const occurredAt = utcTime("invoice_export_state_occurred_at", input.occurredAt);
  const policyVersion = text("invoice_export_state_policy_version", input.policyVersion);
  const reason = text("invoice_export_state_reason", input.reason);
  if (!Object.hasOwn(ALLOWED_STATE_TRANSITIONS, input.state)) {
    throw new Error("invoice_export_state_invalid");
  }
  const invoice = exportRow(db, tenantId, invoiceId);
  if (!invoice) throw new Error("invoice_export_not_found");
  if (!input.authority) throw new Error("invoice_export_state_authority_required");
  if (!input.authority.authorize({
    tenantId,
    actorPrincipalId,
    currency: invoice.currency,
    contractReference: invoice.contract_reference,
    tax: {
      basisPoints: invoice.tax_basis_points,
      jurisdiction: invoice.tax_jurisdiction,
      policyVersion: invoice.tax_policy_version,
    },
  })) {
    throw new Error("invoice_export_state_not_authorized");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (!actorAuthorizedAt(db, tenantId, actorPrincipalId, occurredAt)) {
      throw new Error("invoice_export_actor_inactive");
    }
    const reconciliation = reconcileInvoiceExport(db, tenantId, invoiceId, input.authority);
    if (!reconciliation.complete) throw new Error("invoice_export_reconciliation_incomplete");
    const replay = one<EventRow>(
      db,
      `SELECT * FROM invoice_export_state_events
       WHERE tenant_id = ? AND invoice_id = ? AND idempotency_key = ?`,
      [tenantId, invoiceId, idempotencyKey],
    );
    if (replay) {
      if (
        replay.state !== input.state ||
        replay.policy_version !== policyVersion ||
        replay.reason !== reason ||
        replay.actor_principal_id !== actorPrincipalId
      ) {
        throw new Error("invoice_export_state_idempotency_conflict");
      }
      const result = getInvoiceExport(db, tenantId, invoiceId)!;
      db.raw.exec("COMMIT");
      return result;
    }
    const previous = one<EventRow>(
      db,
      `SELECT * FROM invoice_export_state_events
       WHERE tenant_id = ? AND invoice_id = ? ORDER BY sequence DESC LIMIT 1`,
      [tenantId, invoiceId],
    );
    const allowed = previous
      ? ALLOWED_STATE_TRANSITIONS[previous.state] as readonly InvoiceExportState[]
      : [];
    if (!previous || !allowed.includes(input.state)) {
      throw new Error("invoice_export_state_transition_invalid");
    }
    if (Date.parse(occurredAt) < Date.parse(previous.occurred_at)) {
      throw new Error("invoice_export_state_time_invalid");
    }
    const sequence = previous.sequence + 1;
    const previousHash = previous.event_hash;
    const hash = eventHash({
      invoiceId,
      tenantId,
      idempotencyKey,
      sequence,
      state: input.state,
      policyVersion,
      reason,
      actorPrincipalId,
      previousHash,
      occurredAt,
    });
    const authorityKeyId = text("invoice_export_state_authority_key", input.authority.keyId);
    const authoritySignature = text(
      "invoice_export_state_authority_signature",
      input.authority.sign(hash),
    );
    if (!input.authority.verifyForKey(authorityKeyId, hash, authoritySignature)) {
      throw new Error("invoice_export_state_signature_invalid");
    }
    const id = `${invoiceId}:state:${digest(idempotencyKey).slice(0, 24)}`;
    db.raw.prepare(
      `INSERT INTO invoice_export_state_events
       (id, invoice_id, tenant_id, idempotency_key, sequence, state,
        policy_version, reason, actor_principal_id, prev_hash, event_hash,
        authority_key_id, authority_signature, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, invoiceId, tenantId, idempotencyKey, sequence, input.state,
      policyVersion, reason, actorPrincipalId, previousHash, hash,
      authorityKeyId, authoritySignature, occurredAt,
    );
    const result = getInvoiceExport(db, tenantId, invoiceId)!;
    db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function reconcileInvoiceExport(
  db: AppDb,
  tenantIdInput: string,
  invoiceIdInput: string,
  signer?: InvoiceExportSigner,
): InvoiceExportReconciliation {
  const tenantId = text("invoice_export_tenant", tenantIdInput);
  const invoiceId = text("invoice_export_id", invoiceIdInput);
  const row = exportRow(db, tenantId, invoiceId);
  if (!row) throw new Error("invoice_export_not_found");
  const invoice = invoiceFromRow(db, row);
  const issues: string[] = [];
  const usage = reconcileUsageLedger(db, tenantId);
  if (!usage.ok) issues.push("invoice_usage_chain_invalid");

  let sourceLinesOk = true;
  try {
    const current = deriveDraft(db, {
      id: row.id,
      tenantId,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      currency: row.currency,
      contractReference: row.contract_reference,
      tax: invoice.tax,
      issuedAt: row.issued_at,
    });
    sourceLinesOk = current.lines.length === invoice.lines.length && current.lines.every(
      (line, index) =>
        line.usageEntryId === invoice.lines[index]?.usageEntryId &&
        line.usageEntryHash === invoice.lines[index]?.usageEntryHash,
    );
  } catch {
    sourceLinesOk = false;
  }
  if (!sourceLinesOk) issues.push("invoice_usage_changed_after_issue");

  let lineSumsOk = false;
  try {
    const subtotal = safeSum(
      "invoice_export_reconciliation_subtotal",
      invoice.lines.map((line) => line.moneyMicros),
    );
    const tax = multiplyDivide(
      "invoice_export_reconciliation_tax",
      subtotal,
      invoice.tax.basisPoints,
      10_000,
    );
    lineSumsOk = subtotal === row.subtotal_money_micros &&
      tax === row.tax_money_micros &&
      safeSum("invoice_export_reconciliation_total", [subtotal, tax]) ===
        row.total_money_micros;
  } catch {
    lineSumsOk = false;
  }
  if (!lineSumsOk) issues.push("invoice_line_sum_mismatch");

  const rebuiltPayload = payloadFor(
    {
      id: row.id,
      tenantId,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      currency: row.currency,
      contractReference: row.contract_reference,
      tax: invoice.tax,
      issuedAt: row.issued_at,
    },
    invoice.lines,
    row.subtotal_money_micros,
    row.tax_money_micros,
    row.total_money_micros,
  );
  const payloadOk = rebuiltPayload === row.canonical_payload &&
    digest(row.canonical_payload) === row.payload_digest &&
    digest(rebuiltPayload) === row.payload_digest;
  if (!payloadOk) issues.push("invoice_payload_digest_mismatch");

  let signatureOk = false;
  if (!signer) {
    issues.push("invoice_signature_authority_unavailable");
  } else {
    try {
      signatureOk = actorAuthorizedAt(db, tenantId, row.actor_principal_id, row.issued_at) &&
        signer.verifyForKey(row.signing_key_id, row.canonical_payload, row.signature);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) issues.push("invoice_signature_invalid");
  }

  let previousHash: string | null = null;
  const rawEvents = many<EventRow>(
    db,
    `SELECT * FROM invoice_export_state_events
     WHERE tenant_id = ? AND invoice_id = ? ORDER BY sequence`,
    [tenantId, invoiceId],
  );
  let stateEventsOk = rawEvents.length > 0;
  let previousEvent: EventRow | null = null;
  for (let index = 0; index < rawEvents.length; index += 1) {
    const event = rawEvents[index]!;
    const expected = eventHash({
      invoiceId,
      tenantId,
      idempotencyKey: event.idempotency_key,
      sequence: index + 1,
      state: event.state,
      policyVersion: event.policy_version,
      reason: event.reason,
      actorPrincipalId: event.actor_principal_id,
      previousHash,
      occurredAt: event.occurred_at,
    });
    const initial = index === 0;
    const initialValid = !initial || (
      event.state === "issued" &&
      event.policy_version === "invoice-export/1" &&
      event.reason === "signed invoice issued" &&
      event.actor_principal_id === row.actor_principal_id &&
      event.idempotency_key === `${row.idempotency_key}:issued` &&
      event.occurred_at === row.issued_at &&
      event.prev_hash === null
    );
    const transitionValid = initial || (
      previousEvent !== null &&
      (ALLOWED_STATE_TRANSITIONS[previousEvent.state] as readonly InvoiceExportState[])
        .includes(event.state) &&
      Date.parse(event.occurred_at) >= Date.parse(previousEvent.occurred_at)
    );
    const actorValid = actorAuthorizedAt(
      db,
      tenantId,
      event.actor_principal_id,
      event.occurred_at,
    );
    const authorityValid = signer !== undefined &&
      signer.verifyForKey(event.authority_key_id, expected, event.authority_signature);
    if (
      event.sequence !== index + 1 ||
      event.prev_hash !== previousHash ||
      event.event_hash !== expected ||
      !initialValid ||
      !transitionValid ||
      !actorValid ||
      !authorityValid
    ) {
      stateEventsOk = false;
      break;
    }
    previousHash = event.event_hash;
    previousEvent = event;
  }
  if (!stateEventsOk) issues.push("invoice_state_event_chain_invalid");

  return Object.freeze({
    complete: issues.length === 0,
    usageChain: Object.freeze({
      ok: usage.ok,
      checked: usage.checked,
      legacyUnverifiedFinanceEntryIds: Object.freeze(
        usage.ok ? [...(usage.legacyUnverifiedFinanceEntryIds ?? [])] : [],
      ),
    }),
    sourceLines: Object.freeze({ ok: sourceLinesOk, checked: invoice.lines.length }),
    lineSums: Object.freeze({ ok: lineSumsOk }),
    payload: Object.freeze({ ok: payloadOk }),
    signature: Object.freeze({ ok: signatureOk, keyId: row.signing_key_id }),
    stateEvents: Object.freeze({ ok: stateEventsOk, checked: rawEvents.length }),
    issues: Object.freeze(issues),
  });
}
