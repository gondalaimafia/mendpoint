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
import { MockPaymentCollector, TenantSettlementLedger } from "./payment-collection.js";
import {
  StripePaymentCollector,
  createStripeCollectorFromEnv,
  resolvePaymentCollector,
  type StripeFetch,
} from "./stripe-collection.js";

const NOW = "2026-08-02T12:00:00.000Z";
const TEST_KEY = "sk_test_ABC123secret";

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

/** Draft -> approved -> export_pending -> exported -> issued. */
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

/** A zero-tax issued invoice whose total lands on a whole number of cents. */
function wholeCentInvoice(): Invoice {
  return issuedInvoice({
    policy: policy({
      taxPolicies: [{ reference: "tax-us-ca-2026", jurisdiction: "US-CA", rateBps: 0 }],
    }),
  });
}

type Captured = { url: string; headers: Record<string, string>; body: string };

/** Fake transport: records every request, replies from a scripted handler. */
function recordingFetch(
  handler: (call: Captured) => { ok?: boolean; status?: number; json: unknown },
): { fetch: StripeFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: StripeFetch = async (url, init) => {
    const call = { url, headers: init.headers, body: init.body };
    calls.push(call);
    const reply = handler(call);
    return { ok: reply.ok ?? true, status: reply.status ?? 200, json: reply.json };
  };
  return { fetch, calls };
}

describe("StripePaymentCollector", () => {
  it("settles a succeeded PaymentIntent and returns the Stripe id as reference", async () => {
    const invoice = wholeCentInvoice();
    const { fetch, calls } = recordingFetch(() => ({
      json: { id: "pi_123", status: "succeeded" },
    }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });
    const outcome = await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });

    expect(outcome.status).toBe("settled");
    expect(outcome.reference).toBe("pi_123");
    expect(calls).toHaveLength(1);
    // Exact amount-due (8 cents) and lowercased currency are on the wire.
    const params = new URLSearchParams(calls[0]!.body);
    expect(params.get("amount")).toBe("8");
    expect(params.get("currency")).toBe("usd");
    expect(params.get("confirm")).toBe("true");
    expect(params.get("metadata[invoice_id]")).toBe("invoice-a");
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/payment_intents");
  });

  it("maps a card decline (error envelope) to a failed, retryable outcome", async () => {
    const invoice = wholeCentInvoice();
    const { fetch } = recordingFetch(() => ({
      ok: false,
      status: 402,
      json: { error: { code: "card_declined", decline_code: "insufficient_funds", type: "card_error" } },
    }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });
    const outcome = await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("billing_stripe_charge_declined:insufficient_funds");
    // No Stripe id on this envelope: a deterministic local reference is used.
    expect(outcome.reference).toMatch(/^stripe-unsettled:invoice-a:[a-f0-9]{32}$/);
  });

  it("maps requires_action to pending (retryable, invoice untouched)", async () => {
    const invoice = wholeCentInvoice();
    const { fetch } = recordingFetch(() => ({
      json: { id: "pi_needs_action", status: "requires_action" },
    }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });
    const outcome = await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });

    expect(outcome.status).toBe("pending");
    expect(outcome.reference).toBe("pi_needs_action");
  });

  it("sends an Idempotency-Key and a retry under the same settlement key reuses it", async () => {
    const invoice = wholeCentInvoice();
    const { fetch, calls } = recordingFetch(() => ({ json: { id: "pi_123", status: "succeeded" } }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });

    await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });
    await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });
    await collector.attemptCollection(invoice, { idempotencyKey: "collect-b" });

    const keyA1 = calls[0]!.headers["Idempotency-Key"];
    const keyA2 = calls[1]!.headers["Idempotency-Key"];
    const keyB = calls[2]!.headers["Idempotency-Key"];
    expect(keyA1).toMatch(/^mp-settle-[a-f0-9]{64}$/);
    // Same settlement key -> identical Stripe idempotency key (no double-charge).
    expect(keyA2).toBe(keyA1);
    // A different settlement key -> a different Stripe idempotency key.
    expect(keyB).not.toBe(keyA1);
  });

  it("fails closed when a non-representable (sub-cent) amount is due", async () => {
    // Default policy tax makes the total 8.66 cents: not a whole minor unit.
    const invoice = issuedInvoice();
    const { fetch, calls } = recordingFetch(() => ({ json: { id: "pi_x", status: "succeeded" } }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });
    const outcome = await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe("billing_stripe_amount_not_representable");
    // Never contacted Stripe with an amount it could not charge.
    expect(calls).toHaveLength(0);
  });

  it("throws a key-free error when the secret key is missing (fail closed)", () => {
    expect(() => new StripePaymentCollector({ secretKey: "" })).toThrow(
      "billing_stripe_secret_key_missing",
    );
    expect(() => createStripeCollectorFromEnv({})).toThrow("billing_stripe_secret_key_missing");
    expect(() => createStripeCollectorFromEnv({ STRIPE_SECRET_KEY: "   " })).toThrow(
      "billing_stripe_secret_key_missing",
    );
  });

  it("rejects an unrecognizable key shape rather than putting it on the wire", () => {
    expect(() => new StripePaymentCollector({ secretKey: "not_a_stripe_key" })).toThrow(
      "billing_stripe_secret_key_invalid",
    );
  });

  it("requires an explicit opt-in before a live key can charge", () => {
    const liveKey = "sk_live_DANGERsecret";
    // Without the opt-in: throws, and the key never appears in the error.
    try {
      new StripePaymentCollector({ secretKey: liveKey });
      throw new Error("expected constructor to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("billing_stripe_live_key_forbidden");
      expect(message).not.toContain(liveKey);
      expect(message).not.toContain("DANGERsecret");
    }
    // Via env: same rail.
    expect(() => createStripeCollectorFromEnv({ STRIPE_SECRET_KEY: liveKey })).toThrow(
      "billing_stripe_live_key_forbidden",
    );
    // With the opt-in: constructs.
    expect(
      () => new StripePaymentCollector({ secretKey: liveKey, allowLive: true }),
    ).not.toThrow();
    expect(() =>
      createStripeCollectorFromEnv({
        STRIPE_SECRET_KEY: liveKey,
        MENDPOINT_BILLING_ALLOW_LIVE: "1",
      }),
    ).not.toThrow();
  });

  it("never leaks the secret key into an error surface or serialization", async () => {
    const invoice = wholeCentInvoice();
    // A hostile response that echoes the key back in a decline code.
    const { fetch } = recordingFetch(() => ({
      ok: false,
      status: 402,
      json: { error: { code: "card_declined", decline_code: TEST_KEY, type: "card_error" } },
    }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });
    const outcome = await collector.attemptCollection(invoice, { idempotencyKey: "collect-a" });

    expect(outcome.error).not.toContain(TEST_KEY);
    expect(outcome.error).toContain("[REDACTED]");
    // The private field does not serialize.
    expect(JSON.stringify(collector)).not.toContain(TEST_KEY);
  });

  it("drives an issued invoice to paid through the settlement ledger", async () => {
    const invoice = wholeCentInvoice();
    const { fetch, calls } = recordingFetch(() => ({ json: { id: "pi_abc", status: "succeeded" } }));
    const collector = new StripePaymentCollector({ secretKey: TEST_KEY, fetch });
    const ledger = new TenantSettlementLedger({ mode: "stripe", collector });

    const result = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    expect(result.outcome.status).toBe("settled");
    expect(result.invoice.state).toBe("paid");
    expect(result.invoice.paymentReference).toBe("pi_abc");
    expect(result.entry.collectorReference).toBe("pi_abc");
    expect(ledger.verifyChain()).toBe(true);

    // The ledger's replay guard prevents a second Stripe call on re-collection.
    const replay = await ledger.settle(invoice, { idempotencyKey: "collect-a", attemptedAt: NOW });
    expect(replay.replayed).toBe(true);
    expect(calls).toHaveLength(1);
    // The single call carried a settlement-derived Stripe idempotency key.
    expect(calls[0]!.headers["Idempotency-Key"]).toMatch(/^mp-settle-[a-f0-9]{64}$/);
  });
});

describe("resolvePaymentCollector", () => {
  it("disabled (default/unset) yields no collector, byte-identical to today", () => {
    expect(resolvePaymentCollector({})).toEqual({ mode: "disabled", collector: null });
    expect(resolvePaymentCollector({ MENDPOINT_BILLING_COLLECTION: "nope" })).toEqual({
      mode: "disabled",
      collector: null,
    });
  });

  it("mock mode yields the shipped MockPaymentCollector", () => {
    const resolved = resolvePaymentCollector({ MENDPOINT_BILLING_COLLECTION: "mock" });
    expect(resolved.mode).toBe("mock");
    expect(resolved.collector).toBeInstanceOf(MockPaymentCollector);
  });

  it("stripe mode yields the Stripe collector when the key is present", () => {
    const resolved = resolvePaymentCollector({
      MENDPOINT_BILLING_COLLECTION: "stripe",
      STRIPE_SECRET_KEY: TEST_KEY,
    });
    expect(resolved.mode).toBe("stripe");
    expect(resolved.collector).toBeInstanceOf(StripePaymentCollector);
  });

  it("stripe mode fails closed (never falls back to mock) when the key is missing", () => {
    expect(() => resolvePaymentCollector({ MENDPOINT_BILLING_COLLECTION: "stripe" })).toThrow(
      "billing_stripe_secret_key_missing",
    );
  });
});
