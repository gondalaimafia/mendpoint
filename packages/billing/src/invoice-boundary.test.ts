import { describe, expect, it } from "vitest";
import {
  BILLING_CONTRACT_VERSION,
  DEFAULT_EXTERNAL_COLLECTION,
  TenantInvoiceRegistry,
  buildInvoiceExport,
  buildRefundRequest,
  createInvoiceDraft,
  invoiceExportPayloadDigest,
  recordInvoiceExport,
  recordPayment,
  recordRefund,
  requestRefund,
  transitionInvoice,
  type ContractPricingPolicy,
  type ReconciledUsageEvidence,
} from "./invoice-boundary.js";

const NOW = "2026-08-02T12:00:00.000Z";

function policy(overrides: Partial<ContractPricingPolicy> = {}): ContractPricingPolicy {
  return {
    schemaVersion: BILLING_CONTRACT_VERSION,
    tenantId: "tenant-a",
    contractReference: "contract-2026-a",
    priceVersion: "mcu-price-v3",
    currency: "USD",
    unitPriceMoneyMicros: 20_000,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    paymentTermsDays: 30,
    dunningDaysAfterDue: [3, 7, 14],
    taxPolicies: [{ reference: "tax-us-ca-2026", jurisdiction: "US-CA", rateBps: 825 }],
    approvedBy: "finance-owner-a",
    approvedAt: "2026-07-31T10:00:00.000Z",
    ...overrides,
  };
}

function usage(overrides: Partial<ReconciledUsageEvidence> = {}): ReconciledUsageEvidence {
  return {
    tenantId: "tenant-a",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-08-02T00:00:00.000Z",
    priceVersion: "mcu-price-v3",
    currency: "USD",
    consumedMcuMicros: 4_000_000,
    ledgerEntryIds: ["settlement-b", "settlement-a"],
    ledgerHeadHash: "a".repeat(64),
    ledgerIntegrityOk: true,
    matchedTaskCount: 2,
    unmatchedTaskIds: [],
    ...overrides,
  };
}

function draft(overrides: Partial<Parameters<typeof createInvoiceDraft>[0]> = {}) {
  return createInvoiceDraft({
    id: "invoice-a",
    tenantId: "tenant-a",
    idempotencyKey: "invoice-period-a",
    jurisdiction: "US-CA",
    policy: policy(),
    usage: usage(),
    credits: [{ kind: "credit", reference: "sla-credit-a", amountMoneyMicros: 10_000, reason: "SLA credit" }],
    createdAt: NOW,
    ...overrides,
  });
}

describe("tenant invoice boundary", () => {
  it("creates deterministic tenant-scoped totals and immutable reconciliation evidence", () => {
    const invoice = draft();
    expect(invoice).toMatchObject({
      tenantId: "tenant-a",
      state: "draft",
      subtotalMoneyMicros: 80_000,
      creditMoneyMicros: 10_000,
      taxableMoneyMicros: 70_000,
      taxMoneyMicros: 5_775,
      totalMoneyMicros: 75_775,
      dueAt: "2026-09-01T12:00:00.000Z",
      dunningAt: [
        "2026-09-04T12:00:00.000Z",
        "2026-09-08T12:00:00.000Z",
        "2026-09-15T12:00:00.000Z",
      ],
    });
    expect(invoice.evidence.ledgerEntryIds).toEqual(["settlement-a", "settlement-b"]);
    expect(invoice.evidence.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(invoice)).toBe(true);
    expect(Object.isFrozen(invoice.evidence)).toBe(true);
    expect(DEFAULT_EXTERNAL_COLLECTION).toBe("disabled");
  });

  it("fails closed without approved active policy or one exact tax policy", () => {
    expect(() => draft({ policy: undefined as never })).toThrow("billing_finance_policy_required");
    expect(() => draft({ policy: policy({ expiresAt: NOW }) })).toThrow("billing_finance_policy_inactive");
    expect(() => draft({ jurisdiction: "US-NY" })).toThrow("billing_tax_policy_ambiguous");
    expect(() => draft({ policy: policy({ taxPolicies: [
      { reference: "tax-a", jurisdiction: "US-CA", rateBps: 800 },
      { reference: "tax-b", jurisdiction: "US-CA", rateBps: 825 },
    ] }) })).toThrow("billing_tax_policy_ambiguous");
  });

  it("rejects cross-tenant, mismatched price, broken, and unmatched usage", () => {
    expect(() => draft({ tenantId: "tenant-b" })).toThrow("billing_policy_tenant_mismatch");
    expect(() => draft({ usage: usage({ priceVersion: "wrong" }) })).toThrow("billing_usage_price_mismatch");
    expect(() => draft({ usage: usage({ ledgerIntegrityOk: false }) })).toThrow("billing_usage_unmatched");
    expect(() => draft({ usage: usage({ unmatchedTaskIds: ["task-missing"] }) })).toThrow("billing_usage_unmatched");
    expect(() => draft({ usage: usage({ periodStart: "2026-07-31T00:00:00.000Z" }) })).toThrow("billing_usage_outside_policy");
  });

  it("rejects negative values, overflow, excessive credits, and duplicate ledger evidence", () => {
    expect(() => draft({ usage: usage({ consumedMcuMicros: -1 }) })).toThrow("billing_usage_mcu_invalid");
    expect(() => draft({ policy: policy({ unitPriceMoneyMicros: Number.MAX_SAFE_INTEGER }), usage: usage({ consumedMcuMicros: Number.MAX_SAFE_INTEGER }) })).toThrow("billing_subtotal_overflow");
    expect(() => draft({ credits: [{ kind: "credit", reference: "too-much", amountMoneyMicros: 80_001, reason: "credit" }] })).toThrow("billing_credit_exceeds_subtotal");
    expect(() => draft({ usage: usage({ ledgerEntryIds: ["same", "same"] }) })).toThrow("billing_usage_entry_duplicate");
  });

  it("enforces legal invoice, payment, and refund transitions", () => {
    const invoice = draft();
    expect(() => transitionInvoice(invoice, "paid", NOW)).toThrow("billing_state_transition_illegal");
    const approved = transitionInvoice(invoice, "approved", NOW);
    const pending = transitionInvoice(approved, "export_pending", NOW);
    expect(() => transitionInvoice(pending, "exported", NOW)).toThrow("billing_state_transition_illegal");
    const exportRequest = buildInvoiceExport(approved, "export-state-a");
    const exported = recordInvoiceExport(pending, exportRequest, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      exportReference: "external-state-a",
      idempotencyKey: "export-state-a",
      exportedAt: NOW,
      payloadDigest: invoiceExportPayloadDigest(exportRequest),
    });
    const issued = transitionInvoice(exported, "issued", NOW);
    const partial = recordPayment(issued, { amountMoneyMicros: 10_000, paymentReference: "payment-a", paidAt: NOW });
    expect(partial.state).toBe("partially_paid");
    const paid = recordPayment(partial, { amountMoneyMicros: 65_775, paymentReference: "payment-a", paidAt: NOW });
    expect(paid.state).toBe("paid");
    expect(() => recordPayment(paid, { amountMoneyMicros: 1, paymentReference: "payment-a", paidAt: NOW })).toThrow("billing_payment_state_invalid");
    const pendingRefund = requestRefund(paid, { amountMoneyMicros: 25_000, reason: "customer refund", requestedAt: NOW });
    expect(pendingRefund).toMatchObject({ state: "refund_pending", amountRefundedMoneyMicros: 0, pendingRefundMoneyMicros: 25_000 });
    const refundRequest = buildRefundRequest(pendingRefund, "refund-a");
    const refunded = recordRefund(pendingRefund, refundRequest, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      refundReference: "external-refund-a",
      idempotencyKey: "refund-a",
      acceptedAt: NOW,
    });
    expect(refunded).toMatchObject({ state: "refunded", amountRefundedMoneyMicros: 25_000, refundReference: "external-refund-a" });
    expect(() => recordRefund(refunded, refundRequest, {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      refundReference: "external-refund-a",
      idempotencyKey: "refund-a",
      acceptedAt: NOW,
    })).toThrow("billing_refund_duplicate");
    expect(() => requestRefund(paid, { amountMoneyMicros: 80_000, reason: "too much", requestedAt: NOW })).toThrow("billing_refund_amount_invalid");
  });

  it("binds export receipts and rejects duplicate or mismatched export", () => {
    const approved = transitionInvoice(draft(), "approved", NOW);
    const request = buildInvoiceExport(approved, "export-a");
    const pending = transitionInvoice(approved, "export_pending", NOW);
    const receipt = {
      tenantId: "tenant-a",
      invoiceId: "invoice-a",
      exportReference: "external-invoice-a",
      idempotencyKey: "export-a",
      exportedAt: NOW,
      payloadDigest: invoiceExportPayloadDigest(request),
    };
    const exported = recordInvoiceExport(pending, request, receipt);
    expect(exported).toMatchObject({ state: "exported", exportReference: "external-invoice-a" });
    expect(() => recordInvoiceExport(exported, request, receipt)).toThrow("billing_export_duplicate");
    expect(() => recordInvoiceExport(pending, request, { ...receipt, tenantId: "tenant-b" })).toThrow("billing_export_receipt_mismatch");
  });

  it("replays identical invoice creation and rejects changed idempotent input", () => {
    const registry = new TenantInvoiceRegistry();
    const input = {
      id: "invoice-a",
      tenantId: "tenant-a",
      idempotencyKey: "invoice-period-a",
      jurisdiction: "US-CA",
      policy: policy(),
      usage: usage(),
      createdAt: NOW,
    } as const;
    expect(registry.create(input)).toBe(registry.create(input));
    expect(() => registry.create({ ...input, usage: usage({ consumedMcuMicros: 5_000_000 }) })).toThrow("billing_idempotency_conflict");
  });
});
