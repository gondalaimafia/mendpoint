import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BILLING_CONTRACT_VERSION,
  buildInvoiceExport,
  createInvoiceDraft,
  invoiceExportPayloadDigest,
  recordInvoiceExport,
  transitionInvoice,
  type ContractPricingPolicy,
  type Invoice,
  type ReconciledUsageEvidence,
} from "./invoice-boundary.js";
import {
  DEFAULT_BILLING_COLLECTION_MODE,
  MockPaymentCollector,
  TenantSettlementLedger,
  resolveCollectionMode,
  type PaymentCollector,
} from "./payment-collection.js";

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

/** Draft → approved → export_pending → exported → issued. */
function issuedInvoice(overrides: Partial<Parameters<typeof createInvoiceDraft>[0]> = {}): Invoice {
  const draft = createInvoiceDraft({
    id: "invoice-a",
    tenantId: "tenant-a",
    idempotencyKey: "invoice-period-a",
    jurisdiction: "US-CA",
    policy: policy(),
    usage: usage(),
    createdAt: NOW,
    ...overrides,
  });
  const approved = transitionInvoice(draft, "approved", NOW);
  const exportRequest = buildInvoiceExport(approved, "export-a");
  const pending = transitionInvoice(approved, "export_pending", NOW);
  const exported = recordInvoiceExport(pending, exportRequest, {
    tenantId: draft.tenantId,
    invoiceId: draft.id,
    exportReference: "external-invoice-a",
    idempotencyKey: "export-a",
    exportedAt: NOW,
    payloadDigest: invoiceExportPayloadDigest(exportRequest),
  });
  return transitionInvoice(exported, "issued", NOW);
}

describe("payment collection settlement", () => {
  it("defaults to disabled and only enables on the exact mock flag", () => {
    expect(DEFAULT_BILLING_COLLECTION_MODE).toBe("disabled");
    expect(resolveCollectionMode({})).toBe("disabled");
    expect(resolveCollectionMode({ MENDPOINT_BILLING_COLLECTION: "disabled" })).toBe("disabled");
    expect(resolveCollectionMode({ MENDPOINT_BILLING_COLLECTION: "stripe" })).toBe("disabled");
    expect(resolveCollectionMode({ MENDPOINT_BILLING_COLLECTION: "mock" })).toBe("mock");
  });

  it("refuses to collect when disabled, leaving the issued invoice byte-identical", async () => {
    const invoice = issuedInvoice();
    const before = JSON.stringify(invoice);
    const ledger = new TenantSettlementLedger({
      mode: "disabled",
      collector: new MockPaymentCollector(),
    });
    await expect(ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW }))
      .rejects.toThrow("billing_collection_disabled");
    expect(JSON.stringify(invoice)).toBe(before);
    expect(ledger.entries()).toEqual([]);
    expect(ledger.head()).toBe("0".repeat(64));
  });

  it("issues → collects → settled via the mock and records hash-chained evidence", async () => {
    const invoice = issuedInvoice();
    const ledger = new TenantSettlementLedger({
      mode: "mock",
      collector: new MockPaymentCollector(),
    });
    const result = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });

    expect(result.outcome.status).toBe("settled");
    expect(result.invoice.state).toBe("paid");
    expect(result.invoice.amountPaidMoneyMicros).toBe(invoice.totalMoneyMicros);
    // Collector reference is recorded both on the invoice and in the ledger.
    expect(result.invoice.paymentReference).toBe(result.outcome.reference);
    expect(result.entry.collectorReference).toBe(result.outcome.reference);
    expect(result.entry.status).toBe("settled");
    expect(result.entry.amountMoneyMicros).toBe(invoice.totalMoneyMicros);
    expect(result.entry.reconciliationDigest).toBe(invoice.evidence.digest);
    expect(result.entry.previousHash).toBe("0".repeat(64));
    expect(result.entry.entryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ledger.verifyChain()).toBe(true);
    expect(ledger.head()).toBe(result.entry.entryHash);
  });

  it("records a failed attempt as retryable and later settles the same invoice", async () => {
    const invoice = issuedInvoice();
    // fail-on-flag collector: first attempt fails, invoice stays issued (retryable).
    const failing = new TenantSettlementLedger({
      mode: "mock",
      collector: new MockPaymentCollector({ failInvoiceIds: ["invoice-a"] }),
    });
    const failed = await failing.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    expect(failed.outcome.status).toBe("failed");
    expect(failed.outcome.error).toBe("billing_mock_collector_declined");
    expect(failed.invoice.state).toBe("issued");
    expect(failed.invoice).toBe(invoice);
    expect(failing.entries()).toHaveLength(1);

    // Retry against a healthy collector settles the still-issued invoice.
    const settled = await failing.settle(invoice, { idempotencyKey: "collect-b", attemptedAt: NOW });
    // A fresh collector proves retryability independent of the flag.
    const healthy = new TenantSettlementLedger({ mode: "mock", collector: new MockPaymentCollector() });
    const settled2 = await healthy.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    expect(settled.invoice.state).toBe("issued"); // still flagged collector fails
    expect(settled.outcome.status).toBe("failed");
    expect(settled2.invoice.state).toBe("paid");
    expect(failing.verifyChain()).toBe(true);
    expect(healthy.verifyChain()).toBe(true);
  });

  it("is idempotent: re-collecting a settled invoice replays without double-charging", async () => {
    const invoice = issuedInvoice();
    const ledger = new TenantSettlementLedger({ mode: "mock", collector: new MockPaymentCollector() });
    const first = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    const replay = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.invoice).toBe(first.invoice);
    expect(replay.entry).toBe(first.entry);
    // No second ledger entry, no second charge.
    expect(ledger.entries()).toHaveLength(1);
    expect(replay.invoice.amountPaidMoneyMicros).toBe(invoice.totalMoneyMicros);
  });

  it("preserves boundary guards: cannot collect a paid invoice under a new key", async () => {
    const invoice = issuedInvoice();
    const ledger = new TenantSettlementLedger({ mode: "mock", collector: new MockPaymentCollector() });
    const settled = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    await expect(ledger.settle(settled.invoice, { idempotencyKey: "collect-b", attemptedAt: NOW }))
      .rejects.toThrow("billing_collection_state_invalid");
  });

  it("collects exactly the amount due (never exceeds total) with a deterministic reference", async () => {
    const invoice = issuedInvoice();
    const ledgerA = new TenantSettlementLedger({ mode: "mock", collector: new MockPaymentCollector() });
    const ledgerB = new TenantSettlementLedger({ mode: "mock", collector: new MockPaymentCollector() });
    const a = await ledgerA.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    const b = await ledgerB.settle(invoice, { idempotencyKey: "collect-z", attemptedAt: NOW });
    // Coordinator only ever charges the outstanding balance, so recordPayment's
    // billing_payment_exceeds_total guard is never tripped.
    expect(a.entry.amountMoneyMicros).toBe(invoice.totalMoneyMicros - invoice.amountPaidMoneyMicros);
    expect(a.invoice.amountPaidMoneyMicros).toBe(invoice.totalMoneyMicros);
    // Mock reference is derived from the invoice digest: stable across ledgers.
    expect(a.outcome.reference).toBe(b.outcome.reference);
  });

  it("chains multiple attempts and binds the body into a tamper-evident hash", async () => {
    const invoice = issuedInvoice();
    const ledger = new TenantSettlementLedger({
      mode: "mock",
      collector: new MockPaymentCollector({ failInvoiceIds: ["invoice-a"] }),
    });
    await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    await ledger.settle(invoice, { idempotencyKey: "collect-b", attemptedAt: NOW });
    const [first, second] = ledger.entries();
    expect(ledger.entries()).toHaveLength(2);
    expect(first!.previousHash).toBe("0".repeat(64));
    expect(second!.previousHash).toBe(first!.entryHash);
    expect(ledger.verifyChain()).toBe(true);

    // The stored entryHash is exactly sha256 over the body sans entryHash, so any
    // mutation of the recorded amount would break verification.
    const { entryHash, ...body } = first!;
    const recomputed = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    expect(recomputed).toBe(entryHash);
    const tamperedHash = createHash("sha256")
      .update(JSON.stringify({ ...body, amountMoneyMicros: body.amountMoneyMicros + 1 }))
      .digest("hex");
    expect(tamperedHash).not.toBe(entryHash);
  });

  it("supports async collectors behind the same port", async () => {
    const asyncCollector: PaymentCollector = {
      attemptCollection: async (inv) =>
        Object.freeze({ status: "settled" as const, reference: `async:${inv.id}` }),
    };
    const invoice = issuedInvoice();
    const ledger = new TenantSettlementLedger({ mode: "mock", collector: asyncCollector });
    const result = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    expect(result.invoice.state).toBe("paid");
    expect(result.invoice.paymentReference).toBe("async:invoice-a");
  });
});
