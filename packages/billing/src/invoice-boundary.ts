import { createHash } from "node:crypto";

export const BILLING_CONTRACT_VERSION = "2026-08-02.v1" as const;
export const DEFAULT_EXTERNAL_COLLECTION = "disabled" as const;
const MAX_MONEY_MICROS = Number.MAX_SAFE_INTEGER;

export type TaxPolicy = Readonly<{
  reference: string;
  jurisdiction: string;
  rateBps: number;
}>;

export type ContractPricingPolicy = Readonly<{
  schemaVersion: typeof BILLING_CONTRACT_VERSION;
  tenantId: string;
  contractReference: string;
  priceVersion: string;
  currency: string;
  unitPriceMoneyMicros: number;
  effectiveAt: string;
  expiresAt: string | null;
  paymentTermsDays: number;
  dunningDaysAfterDue: readonly number[];
  taxPolicies: readonly TaxPolicy[];
  approvedBy: string;
  approvedAt: string;
}>;

export type ReconciledUsageEvidence = Readonly<{
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  priceVersion: string;
  currency: string;
  consumedMcuMicros: number;
  ledgerEntryIds: readonly string[];
  ledgerHeadHash: string;
  ledgerIntegrityOk: boolean;
  matchedTaskCount: number;
  unmatchedTaskIds: readonly string[];
}>;

export type InvoiceState =
  | "draft"
  | "approved"
  | "export_pending"
  | "exported"
  | "issued"
  | "partially_paid"
  | "paid"
  | "past_due"
  | "collection_suspended"
  | "void"
  | "refund_pending"
  | "refunded";

export type InvoiceAdjustment = Readonly<{
  kind: "credit";
  reference: string;
  amountMoneyMicros: number;
  reason: string;
}>;

export type InvoiceReconciliationEvidence = Readonly<{
  contractVersion: typeof BILLING_CONTRACT_VERSION;
  tenantId: string;
  invoiceId: string;
  policyReference: string;
  priceVersion: string;
  taxPolicyReference: string;
  ledgerEntryIds: readonly string[];
  ledgerHeadHash: string;
  usagePeriodStart: string;
  usagePeriodEnd: string;
  digest: string;
}>;

export type Invoice = Readonly<{
  id: string;
  tenantId: string;
  idempotencyKey: string;
  state: InvoiceState;
  currency: string;
  usageMcuMicros: number;
  subtotalMoneyMicros: number;
  creditMoneyMicros: number;
  taxableMoneyMicros: number;
  taxMoneyMicros: number;
  totalMoneyMicros: number;
  amountPaidMoneyMicros: number;
  amountRefundedMoneyMicros: number;
  pendingRefundMoneyMicros: number;
  refundReason: string | null;
  refundReference: string | null;
  issuedAt: string | null;
  dueAt: string;
  dunningAt: readonly string[];
  adjustments: readonly InvoiceAdjustment[];
  evidence: InvoiceReconciliationEvidence;
  exportReference: string | null;
  paymentReference: string | null;
  updatedAt: string;
}>;

export type InvoiceExportRequest = Readonly<{
  contractVersion: typeof BILLING_CONTRACT_VERSION;
  tenantId: string;
  invoiceId: string;
  idempotencyKey: string;
  currency: string;
  totalMoneyMicros: number;
  taxPolicyReference: string;
  reconciliationDigest: string;
}>;

export type InvoiceExportReceipt = Readonly<{
  tenantId: string;
  invoiceId: string;
  exportReference: string;
  idempotencyKey: string;
  exportedAt: string;
  payloadDigest: string;
}>;

export interface InvoiceExportAdapter {
  exportInvoice(request: InvoiceExportRequest): Promise<InvoiceExportReceipt>;
}

export type CollectionRequest = Readonly<{
  tenantId: string;
  invoiceId: string;
  idempotencyKey: string;
  currency: string;
  amountMoneyMicros: number;
  reconciliationDigest: string;
}>;

export type RefundRequest = Readonly<{
  tenantId: string;
  invoiceId: string;
  idempotencyKey: string;
  paymentReference: string;
  currency: string;
  amountMoneyMicros: number;
  reason: string;
}>;

export type RefundReceipt = Readonly<{
  tenantId: string;
  invoiceId: string;
  refundReference: string;
  idempotencyKey: string;
  acceptedAt: string;
}>;

export interface PaymentProcessorAdapter {
  collect(request: CollectionRequest): Promise<Readonly<{
    tenantId: string;
    invoiceId: string;
    paymentReference: string;
    acceptedAt: string;
  }>>;
  refund(request: RefundRequest): Promise<RefundReceipt>;
}

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name}_invalid`);
  return normalized;
}

function instant(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return parsed;
}

function nonnegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name}_invalid`);
  return value;
}

function moneyFromBigInt(name: string, value: bigint): number {
  if (value < 0n || value > BigInt(MAX_MONEY_MICROS)) throw new Error(`${name}_overflow`);
  return Number(value);
}

function addDays(iso: string, days: number): string {
  const value = instant("billing_date", iso) + days * 86_400_000;
  if (!Number.isSafeInteger(value)) throw new Error("billing_date_overflow");
  return new Date(value).toISOString();
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function immutable<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function validatePolicy(policy: ContractPricingPolicy, at: string): void {
  if (!policy || policy.schemaVersion !== BILLING_CONTRACT_VERSION) {
    throw new Error("billing_finance_policy_required");
  }
  required("billing_tenant_id", policy.tenantId);
  required("billing_contract_reference", policy.contractReference);
  required("billing_price_version", policy.priceVersion);
  required("billing_policy_approver", policy.approvedBy);
  instant("billing_policy_approved_at", policy.approvedAt);
  const currency = required("billing_currency", policy.currency);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("billing_currency_invalid");
  nonnegativeInteger("billing_unit_price", policy.unitPriceMoneyMicros);
  const effective = instant("billing_policy_effective_at", policy.effectiveAt);
  const current = instant("billing_invoice_at", at);
  const expires = policy.expiresAt === null ? null : instant("billing_policy_expires_at", policy.expiresAt);
  if (current < effective || (expires !== null && current >= expires)) {
    throw new Error("billing_finance_policy_inactive");
  }
  if (!Number.isSafeInteger(policy.paymentTermsDays) || policy.paymentTermsDays < 0 || policy.paymentTermsDays > 365) {
    throw new Error("billing_payment_terms_invalid");
  }
  let previous = 0;
  for (const day of policy.dunningDaysAfterDue) {
    if (!Number.isSafeInteger(day) || day <= previous || day > 365) {
      throw new Error("billing_dunning_schedule_invalid");
    }
    previous = day;
  }
}

function selectTaxPolicy(policy: ContractPricingPolicy, jurisdiction: string): TaxPolicy {
  const requested = required("billing_tax_jurisdiction", jurisdiction).toUpperCase();
  const matches = policy.taxPolicies.filter((candidate) => candidate.jurisdiction.toUpperCase() === requested);
  if (matches.length !== 1) throw new Error("billing_tax_policy_ambiguous");
  const selected = matches[0]!;
  required("billing_tax_policy_reference", selected.reference);
  if (!Number.isSafeInteger(selected.rateBps) || selected.rateBps < 0 || selected.rateBps > 10_000) {
    throw new Error("billing_tax_rate_invalid");
  }
  return selected;
}

function validateUsage(policy: ContractPricingPolicy, usage: ReconciledUsageEvidence, invoiceAt: string): void {
  if (usage.tenantId !== policy.tenantId) throw new Error("billing_usage_tenant_mismatch");
  if (usage.priceVersion !== policy.priceVersion) throw new Error("billing_usage_price_mismatch");
  if (usage.currency !== policy.currency) throw new Error("billing_usage_currency_mismatch");
  if (!usage.ledgerIntegrityOk || usage.unmatchedTaskIds.length > 0 || usage.matchedTaskCount < 1) {
    throw new Error("billing_usage_unmatched");
  }
  nonnegativeInteger("billing_usage_mcu", usage.consumedMcuMicros);
  const start = instant("billing_usage_period_start", usage.periodStart);
  const end = instant("billing_usage_period_end", usage.periodEnd);
  if (end <= start) throw new Error("billing_usage_period_invalid");
  const effective = instant("billing_policy_effective_at", policy.effectiveAt);
  const expires = policy.expiresAt === null ? null : instant("billing_policy_expires_at", policy.expiresAt);
  if (start < effective || end > instant("billing_invoice_at", invoiceAt) || (expires !== null && end > expires)) {
    throw new Error("billing_usage_outside_policy");
  }
  required("billing_ledger_head_hash", usage.ledgerHeadHash);
  if (!/^[a-f0-9]{64}$/.test(usage.ledgerHeadHash)) throw new Error("billing_ledger_head_hash_invalid");
  if (usage.ledgerEntryIds.length < 1) throw new Error("billing_usage_entries_required");
  const ids = usage.ledgerEntryIds.map((id) => required("billing_ledger_entry_id", id));
  if (new Set(ids).size !== ids.length) throw new Error("billing_usage_entry_duplicate");
}

export function createInvoiceDraft(input: Readonly<{
  id: string;
  tenantId: string;
  idempotencyKey: string;
  jurisdiction: string;
  policy: ContractPricingPolicy;
  usage: ReconciledUsageEvidence;
  credits?: readonly InvoiceAdjustment[];
  createdAt: string;
}>): Invoice {
  const id = required("billing_invoice_id", input.id);
  const tenantId = required("billing_tenant_id", input.tenantId);
  const idempotencyKey = required("billing_idempotency_key", input.idempotencyKey);
  validatePolicy(input.policy, input.createdAt);
  if (tenantId !== input.policy.tenantId) throw new Error("billing_policy_tenant_mismatch");
  validateUsage(input.policy, input.usage, input.createdAt);
  const taxPolicy = selectTaxPolicy(input.policy, input.jurisdiction);
  const credits = (input.credits ?? []).map((credit) => immutable({
    kind: "credit" as const,
    reference: required("billing_credit_reference", credit.reference),
    amountMoneyMicros: nonnegativeInteger("billing_credit_amount", credit.amountMoneyMicros),
    reason: required("billing_credit_reason", credit.reason),
  }));
  if (new Set(credits.map((credit) => credit.reference)).size !== credits.length) {
    throw new Error("billing_credit_duplicate");
  }
  const subtotal = moneyFromBigInt(
    "billing_subtotal",
    BigInt(input.usage.consumedMcuMicros) * BigInt(input.policy.unitPriceMoneyMicros) / 1_000_000n,
  );
  const creditTotal = credits.reduce((sum, credit) => sum + BigInt(credit.amountMoneyMicros), 0n);
  if (creditTotal > BigInt(subtotal)) throw new Error("billing_credit_exceeds_subtotal");
  const taxable = moneyFromBigInt("billing_taxable", BigInt(subtotal) - creditTotal);
  const tax = moneyFromBigInt(
    "billing_tax",
    (BigInt(taxable) * BigInt(taxPolicy.rateBps) + 5_000n) / 10_000n,
  );
  const total = moneyFromBigInt("billing_total", BigInt(taxable) + BigInt(tax));
  const issuedAt = instant("billing_created_at", input.createdAt);
  const dueAt = addDays(new Date(issuedAt).toISOString(), input.policy.paymentTermsDays);
  const ledgerEntryIds = Object.freeze([...input.usage.ledgerEntryIds].sort());
  const evidenceBase = {
    contractVersion: BILLING_CONTRACT_VERSION,
    tenantId,
    invoiceId: id,
    policyReference: input.policy.contractReference,
    priceVersion: input.policy.priceVersion,
    taxPolicyReference: taxPolicy.reference,
    ledgerEntryIds,
    ledgerHeadHash: input.usage.ledgerHeadHash,
    usagePeriodStart: input.usage.periodStart,
    usagePeriodEnd: input.usage.periodEnd,
  };
  const evidence = immutable({ ...evidenceBase, digest: canonicalDigest(evidenceBase) });
  return immutable({
    id,
    tenantId,
    idempotencyKey,
    state: "draft" as const,
    currency: input.policy.currency,
    usageMcuMicros: input.usage.consumedMcuMicros,
    subtotalMoneyMicros: subtotal,
    creditMoneyMicros: Number(creditTotal),
    taxableMoneyMicros: taxable,
    taxMoneyMicros: tax,
    totalMoneyMicros: total,
    amountPaidMoneyMicros: 0,
    amountRefundedMoneyMicros: 0,
    pendingRefundMoneyMicros: 0,
    refundReason: null,
    refundReference: null,
    issuedAt: null,
    dueAt,
    dunningAt: Object.freeze(input.policy.dunningDaysAfterDue.map((day) => addDays(dueAt, day))),
    adjustments: Object.freeze(credits),
    evidence,
    exportReference: null,
    paymentReference: null,
    updatedAt: input.createdAt,
  });
}

const TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = Object.freeze({
  draft: ["approved", "void"],
  approved: ["export_pending", "void"],
  export_pending: ["void"],
  exported: ["issued", "void"],
  issued: ["past_due", "void"],
  partially_paid: ["past_due"],
  paid: [],
  past_due: ["collection_suspended", "void"],
  collection_suspended: ["void"],
  void: [],
  refund_pending: ["paid"],
  refunded: [],
});

export function transitionInvoice(invoice: Invoice, state: InvoiceState, at: string): Invoice {
  instant("billing_transition_at", at);
  if (!TRANSITIONS[invoice.state].includes(state)) throw new Error("billing_state_transition_illegal");
  return immutable({ ...invoice, state, issuedAt: state === "issued" ? at : invoice.issuedAt, updatedAt: at });
}

export function recordPayment(invoice: Invoice, input: Readonly<{
  amountMoneyMicros: number;
  paymentReference: string;
  paidAt: string;
}>): Invoice {
  if (!["issued", "partially_paid", "past_due", "collection_suspended"].includes(invoice.state)) {
    throw new Error("billing_payment_state_invalid");
  }
  const amount = nonnegativeInteger("billing_payment_amount", input.amountMoneyMicros);
  if (amount === 0) throw new Error("billing_payment_amount_invalid");
  const nextPaid = BigInt(invoice.amountPaidMoneyMicros) + BigInt(amount);
  if (nextPaid > BigInt(invoice.totalMoneyMicros)) throw new Error("billing_payment_exceeds_total");
  const state: InvoiceState = nextPaid === BigInt(invoice.totalMoneyMicros) ? "paid" : "partially_paid";
  return immutable({
    ...invoice,
    state,
    amountPaidMoneyMicros: Number(nextPaid),
    paymentReference: required("billing_payment_reference", input.paymentReference),
    updatedAt: new Date(instant("billing_paid_at", input.paidAt)).toISOString(),
  });
}

export function requestRefund(invoice: Invoice, input: Readonly<{
  amountMoneyMicros: number;
  reason: string;
  requestedAt: string;
}>): Invoice {
  if (invoice.state !== "paid" || !invoice.paymentReference) throw new Error("billing_refund_state_invalid");
  const amount = nonnegativeInteger("billing_refund_amount", input.amountMoneyMicros);
  if (amount === 0 || BigInt(invoice.amountRefundedMoneyMicros) + BigInt(amount) > BigInt(invoice.amountPaidMoneyMicros)) {
    throw new Error("billing_refund_amount_invalid");
  }
  required("billing_refund_reason", input.reason);
  return immutable({
    ...invoice,
    state: "refund_pending" as const,
    pendingRefundMoneyMicros: amount,
    refundReason: required("billing_refund_reason", input.reason),
    updatedAt: new Date(instant("billing_refund_requested_at", input.requestedAt)).toISOString(),
  });
}

export function buildRefundRequest(invoice: Invoice, idempotencyKey: string): RefundRequest {
  if (
    invoice.state !== "refund_pending" ||
    !invoice.paymentReference ||
    invoice.pendingRefundMoneyMicros < 1 ||
    !invoice.refundReason
  ) {
    throw new Error("billing_refund_state_invalid");
  }
  return immutable({
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    idempotencyKey: required("billing_refund_idempotency_key", idempotencyKey),
    paymentReference: invoice.paymentReference,
    currency: invoice.currency,
    amountMoneyMicros: invoice.pendingRefundMoneyMicros,
    reason: invoice.refundReason,
  });
}

export function recordRefund(
  invoice: Invoice,
  request: RefundRequest,
  receipt: RefundReceipt,
): Invoice {
  if (invoice.refundReference || invoice.state !== "refund_pending") {
    throw new Error("billing_refund_duplicate");
  }
  if (
    request.tenantId !== invoice.tenantId ||
    request.invoiceId !== invoice.id ||
    request.amountMoneyMicros !== invoice.pendingRefundMoneyMicros ||
    request.paymentReference !== invoice.paymentReference ||
    receipt.tenantId !== invoice.tenantId ||
    receipt.invoiceId !== invoice.id ||
    receipt.idempotencyKey !== request.idempotencyKey
  ) {
    throw new Error("billing_refund_receipt_mismatch");
  }
  return immutable({
    ...invoice,
    state: "refunded" as const,
    amountRefundedMoneyMicros: invoice.amountRefundedMoneyMicros + invoice.pendingRefundMoneyMicros,
    pendingRefundMoneyMicros: 0,
    refundReference: required("billing_refund_reference", receipt.refundReference),
    updatedAt: new Date(instant("billing_refund_accepted_at", receipt.acceptedAt)).toISOString(),
  });
}

export function buildInvoiceExport(invoice: Invoice, idempotencyKey: string): InvoiceExportRequest {
  if (invoice.state !== "approved") throw new Error("billing_export_state_invalid");
  return immutable({
    contractVersion: BILLING_CONTRACT_VERSION,
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    idempotencyKey: required("billing_export_idempotency_key", idempotencyKey),
    currency: invoice.currency,
    totalMoneyMicros: invoice.totalMoneyMicros,
    taxPolicyReference: invoice.evidence.taxPolicyReference,
    reconciliationDigest: invoice.evidence.digest,
  });
}

export function recordInvoiceExport(
  invoice: Invoice,
  request: InvoiceExportRequest,
  receipt: InvoiceExportReceipt,
): Invoice {
  if (invoice.exportReference || invoice.state !== "export_pending") throw new Error("billing_export_duplicate");
  if (
    request.tenantId !== invoice.tenantId ||
    request.invoiceId !== invoice.id ||
    request.reconciliationDigest !== invoice.evidence.digest ||
    receipt.tenantId !== invoice.tenantId ||
    receipt.invoiceId !== invoice.id ||
    receipt.idempotencyKey !== request.idempotencyKey ||
    receipt.payloadDigest !== canonicalDigest(request)
  ) {
    throw new Error("billing_export_receipt_mismatch");
  }
  const exportedAt = new Date(instant("billing_exported_at", receipt.exportedAt)).toISOString();
  return immutable({
    ...invoice,
    state: "exported" as const,
    exportReference: required("billing_export_reference", receipt.exportReference),
    updatedAt: exportedAt,
  });
}

export function invoiceExportPayloadDigest(request: InvoiceExportRequest): string {
  return canonicalDigest(request);
}

export class TenantInvoiceRegistry {
  readonly #byIdempotency = new Map<string, Invoice>();
  readonly #byInvoice = new Map<string, Invoice>();

  create(input: Parameters<typeof createInvoiceDraft>[0]): Invoice {
    const scope = `${input.tenantId}\n${input.idempotencyKey}`;
    const existing = this.#byIdempotency.get(scope);
    const candidate = createInvoiceDraft(input);
    if (existing) {
      if (canonicalDigest(existing) !== canonicalDigest(candidate)) throw new Error("billing_idempotency_conflict");
      return existing;
    }
    const invoiceScope = `${input.tenantId}\n${input.id}`;
    if (this.#byInvoice.has(invoiceScope)) throw new Error("billing_invoice_id_conflict");
    this.#byIdempotency.set(scope, candidate);
    this.#byInvoice.set(invoiceScope, candidate);
    return candidate;
  }
}
