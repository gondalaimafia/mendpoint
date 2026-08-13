import { createHash } from "node:crypto";
import {
  BILLING_CONTRACT_VERSION,
  recordPayment,
  type Invoice,
} from "./invoice-boundary.js";

/**
 * Settlement collection is default-disabled. With the flag unset (or set to any
 * value that is neither "mock" nor "stripe") the collection pipeline refuses to
 * run, so nothing ever auto-charges and the invoice-boundary behavior stays
 * byte-identical.
 *
 * Two collectors ship behind the same {@link PaymentCollector} port:
 * {@link MockPaymentCollector} (moves no real money) and the real
 * `StripePaymentCollector` (see `stripe-collection.ts`), the latter being
 * credential-gated and off by default — see docs/BILLING_SETTLEMENT.md.
 */
export const BILLING_COLLECTION_ENV = "MENDPOINT_BILLING_COLLECTION" as const;
export const DEFAULT_BILLING_COLLECTION_MODE = "disabled" as const;

export type BillingCollectionMode = "disabled" | "mock" | "stripe";

const GENESIS_HASH = "0".repeat(64);
const MAX_MONEY_MICROS = Number.MAX_SAFE_INTEGER;

export type CollectionOutcomeStatus = "settled" | "failed" | "pending";

export type CollectionOutcome = Readonly<{
  status: CollectionOutcomeStatus;
  reference: string;
  error?: string;
}>;

/**
 * Per-attempt context the coordinator hands to a collector. The
 * `idempotencyKey` is the settlement idempotency key for this attempt; a real
 * processor derives its own request idempotency token from it so a retry with
 * the same key can never double-charge. The mock collector ignores it.
 */
export type CollectionContext = Readonly<{
  idempotencyKey: string;
}>;

/**
 * The pluggable settlement port. `attemptCollection` inspects an issued invoice
 * and reports whether the collector settled it, failed (retryable), or is still
 * pending. Implementations must be side-effect free with respect to the invoice;
 * only the coordinator mutates invoice/ledger state. The optional `context`
 * carries the settlement idempotency key for processors that need it.
 */
export interface PaymentCollector {
  attemptCollection(
    invoice: Invoice,
    context?: CollectionContext,
  ): CollectionOutcome | Promise<CollectionOutcome>;
}

/**
 * Deterministic, config-driven mock collector. Default behavior is always-settle.
 * Supply `failInvoiceIds` for deterministic fail-on-flag failures (retryable).
 * References are derived from the invoice reconciliation digest so a retry of the
 * same invoice yields a stable reference. This collector moves no real funds.
 */
export type MockPaymentCollectorConfig = Readonly<{
  failInvoiceIds?: readonly string[];
  failureError?: string;
  referencePrefix?: string;
}>;

export class MockPaymentCollector implements PaymentCollector {
  readonly #failInvoiceIds: ReadonlySet<string>;
  readonly #failureError: string;
  readonly #referencePrefix: string;

  constructor(config: MockPaymentCollectorConfig = {}) {
    this.#failInvoiceIds = new Set(config.failInvoiceIds ?? []);
    this.#failureError = config.failureError ?? "billing_mock_collector_declined";
    this.#referencePrefix = config.referencePrefix ?? "mock-collector";
  }

  attemptCollection(invoice: Invoice): CollectionOutcome {
    const digest = createHash("sha256")
      .update(`${invoice.tenantId}\n${invoice.id}\n${invoice.evidence.digest}`)
      .digest("hex")
      .slice(0, 32);
    const reference = `${this.#referencePrefix}:${invoice.id}:${digest}`;
    if (this.#failInvoiceIds.has(invoice.id)) {
      return Object.freeze({ status: "failed" as const, reference, error: this.#failureError });
    }
    return Object.freeze({ status: "settled" as const, reference });
  }
}

/**
 * Resolves the collection mode from the environment. Fails safe: only the exact
 * values "mock" or "stripe" enable collection; everything else (including unset)
 * is disabled. Selecting "stripe" only chooses the adapter — the Stripe
 * collector still fails closed at construction if its credential is missing, so
 * this never charges by itself.
 */
export function resolveCollectionMode(
  env: NodeJS.ProcessEnv = process.env,
): BillingCollectionMode {
  const value = env[BILLING_COLLECTION_ENV];
  if (value === "mock") return "mock";
  if (value === "stripe") return "stripe";
  return DEFAULT_BILLING_COLLECTION_MODE;
}

export type SettlementLedgerEntry = Readonly<{
  contractVersion: typeof BILLING_CONTRACT_VERSION;
  sequence: number;
  tenantId: string;
  invoiceId: string;
  idempotencyKey: string;
  status: CollectionOutcomeStatus;
  collectorReference: string;
  amountMoneyMicros: number;
  reconciliationDigest: string;
  attemptedAt: string;
  previousHash: string;
  entryHash: string;
}>;

export type SettlementResult = Readonly<{
  invoice: Invoice;
  outcome: CollectionOutcome;
  entry: SettlementLedgerEntry;
  replayed: boolean;
}>;

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${name}_invalid`);
  return normalized;
}

function instant(name: string, value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return new Date(parsed).toISOString();
}

function settlementEntryHash(entry: Omit<SettlementLedgerEntry, "entryHash">): string {
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/**
 * Tenant-scoped, append-only settlement ledger with hash-chained integrity.
 *
 * Each collection attempt appends one entry whose `entryHash` covers the prior
 * head, so the chain is tamper-evident. Settled attempts move the issued invoice
 * to `paid` through the existing {@link recordPayment} guard (preserving
 * `billing_payment_exceeds_total`) and are cached by idempotency key so a replay
 * never double-charges. Failed/pending attempts leave the invoice untouched and
 * are retryable.
 */
export class TenantSettlementLedger {
  readonly #mode: BillingCollectionMode;
  readonly #collector: PaymentCollector;
  readonly #entries: SettlementLedgerEntry[] = [];
  readonly #settled = new Map<string, SettlementResult>();

  constructor(input: Readonly<{ mode: BillingCollectionMode; collector: PaymentCollector }>) {
    this.#mode = input.mode;
    this.#collector = input.collector;
  }

  get mode(): BillingCollectionMode {
    return this.#mode;
  }

  entries(): readonly SettlementLedgerEntry[] {
    return Object.freeze([...this.#entries]);
  }

  head(): string {
    return this.#entries.at(-1)?.entryHash ?? GENESIS_HASH;
  }

  verifyChain(): boolean {
    let previousHash = GENESIS_HASH;
    for (const entry of this.#entries) {
      if (entry.previousHash !== previousHash) return false;
      const { entryHash, ...rest } = entry;
      if (settlementEntryHash(rest) !== entryHash) return false;
      previousHash = entryHash;
    }
    return true;
  }

  async settle(
    invoice: Invoice,
    input: Readonly<{ idempotencyKey: string; attemptedAt: string }>,
  ): Promise<SettlementResult> {
    if (this.#mode === "disabled") throw new Error("billing_collection_disabled");
    const idempotencyKey = required("billing_collection_idempotency_key", input.idempotencyKey);
    const attemptedAt = instant("billing_collection_attempted_at", input.attemptedAt);
    const scope = `${invoice.tenantId}\n${invoice.id}\n${idempotencyKey}`;

    const cached = this.#settled.get(scope);
    if (cached) return Object.freeze({ ...cached, replayed: true });

    if (!["issued", "partially_paid", "past_due"].includes(invoice.state)) {
      throw new Error("billing_collection_state_invalid");
    }
    const amountDue = invoice.totalMoneyMicros - invoice.amountPaidMoneyMicros;
    if (!Number.isSafeInteger(amountDue) || amountDue < 1 || amountDue > MAX_MONEY_MICROS) {
      throw new Error("billing_collection_nothing_due");
    }

    const outcome = await Promise.resolve(
      this.#collector.attemptCollection(invoice, { idempotencyKey }),
    );
    const status = outcome.status;
    if (status !== "settled" && status !== "failed" && status !== "pending") {
      throw new Error("billing_collection_outcome_invalid");
    }
    const collectorReference = required("billing_collector_reference", outcome.reference);

    const base = {
      contractVersion: BILLING_CONTRACT_VERSION,
      sequence: this.#entries.length,
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      idempotencyKey,
      status,
      collectorReference,
      amountMoneyMicros: amountDue,
      reconciliationDigest: invoice.evidence.digest,
      attemptedAt,
      previousHash: this.head(),
    } as const;
    const entry: SettlementLedgerEntry = Object.freeze({
      ...base,
      entryHash: settlementEntryHash(base),
    });
    this.#entries.push(entry);

    if (status !== "settled") {
      // Failed/pending attempts are retryable: the invoice is left unchanged and
      // the outcome is not cached, so a later attempt can still settle it.
      return Object.freeze({ invoice, outcome, entry, replayed: false });
    }

    const settled = recordPayment(invoice, {
      amountMoneyMicros: amountDue,
      paymentReference: collectorReference,
      paidAt: attemptedAt,
    });
    const result: SettlementResult = Object.freeze({ invoice: settled, outcome, entry, replayed: false });
    this.#settled.set(scope, result);
    return result;
  }
}
