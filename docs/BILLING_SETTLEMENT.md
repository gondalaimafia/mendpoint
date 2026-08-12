# Billing Settlement (MCU)

This document describes the operational settlement pipeline that turns the
metered MCU usage ledger into a collected invoice. It covers the lifecycle, the
pluggable collector port, the shipped mock collector, the enable flag, and how a
real payment processor would plug in.

> No real payment processor is wired, and no real funds move. The only shipped
> collector is a deterministic mock that moves no money. Real fund movement is
> infrastructure and is intentionally out of scope for this slice.

## Where the money comes from

Metering is real. Accepted work accrues MCU into a hash-chained usage ledger
(`packages/billing/src/usage-evidence.ts`, over `packages/platform/src/mcu.ts`).
`buildReconciledUsageEvidence` narrows a verified ledger window into immutable
`ReconciledUsageEvidence`, and `createInvoiceDraft`
(`packages/billing/src/invoice-boundary.ts`) prices it into an invoice draft with
its own reconciliation digest. Settlement is the last mile: collecting an issued
invoice and recording the outcome.

## Lifecycle

The invoice-boundary state machine is unchanged. Settlement composes on top of
it and drives an issued invoice to `paid`:

```
draft → approved → export_pending → exported → issued → (collect) → paid
                                                   │
                                                   └── failed/pending attempt: invoice stays issued (retryable)
```

- **settled** == the collection succeeded and the invoice reached the existing
  terminal `paid` state, via the existing `recordPayment` guard. The collector
  reference is written to `invoice.paymentReference` and to the settlement
  ledger entry.
- **failed** == the attempt is recorded in the settlement ledger, the invoice is
  left untouched (still `issued`), and the attempt is **retryable**.
- **pending** == the collector has not resolved yet; treated like `failed` for
  invoice state (unchanged, retryable), but recorded distinctly in the ledger.

The settlement ledger (`TenantSettlementLedger`) is append-only and
hash-chained: each entry's `entryHash` is `sha256` over the entry body including
the prior head (`previousHash`), so the attempt history is tamper-evident.
`verifyChain()` recomputes and validates the whole chain.

## The collector port

`PaymentCollector` is the seam a real processor plugs into:

```ts
interface PaymentCollector {
  attemptCollection(invoice: Invoice): CollectionOutcome | Promise<CollectionOutcome>;
}

type CollectionOutcome = {
  status: "settled" | "failed" | "pending";
  reference: string;
  error?: string;
};
```

The collector is **side-effect free** with respect to the invoice. It only
reports an outcome. All state changes (invoice → `paid`, ledger append,
idempotency caching) are owned by `TenantSettlementLedger.settle`, which:

1. Refuses to run unless the mode is `mock` (default `disabled` throws
   `billing_collection_disabled` — nothing ever auto-charges).
2. Replays a cached settled result for a repeated `(tenant, invoice, idempotencyKey)`
   so a re-collection never double-charges (`replayed: true`).
3. Guards the invoice state (`issued` / `partially_paid` / `past_due` only) and
   the outstanding balance (`billing_collection_nothing_due`).
4. Runs the collector, appends one hash-chained ledger entry, and — only on
   `settled` — routes the exact amount due through `recordPayment`, preserving
   `billing_payment_exceeds_total`.

## The mock collector

`MockPaymentCollector` is deterministic and config-driven — the default and the
only shipped implementation:

- Default: **always settle**.
- `failInvoiceIds`: deterministic **fail-on-flag** for the listed invoice ids
  (retryable failures), with `failureError` as the reported error.
- References are derived from the invoice reconciliation digest, so a retry of
  the same invoice yields a stable reference.

It performs no I/O and moves no real money.

## Enable flag

Collection is **default-disabled**.

| `MENDPOINT_BILLING_COLLECTION` | Mode | Behavior |
| --- | --- | --- |
| unset (default) | `disabled` | `settle` throws `billing_collection_disabled`; invoice-boundary behavior is byte-identical. Nothing auto-charges. |
| `mock` | `mock` | The mock collector runs. Still moves no real money. |
| any other value | `disabled` | Fails safe to disabled. |

`resolveCollectionMode(env)` reads the flag. Only the exact string `mock`
enables collection.

## Plugging in a real collector (future adapter)

A real processor (Stripe, Adyen, an internal treasury service) is a future
adapter behind the **same** `PaymentCollector` port. To add one:

1. Implement `attemptCollection(invoice)` against the processor's API, mapping
   the processor result to `{ status, reference, error? }`. Keep it side-effect
   free with respect to the invoice — return an outcome, do not mutate state.
2. Add a new mode value (e.g. `stripe`) to `BillingCollectionMode` and
   `resolveCollectionMode`, and select the adapter from the mode.
3. Leave `TenantSettlementLedger` untouched: it already owns idempotency,
   state transitions, the boundary guards, and the hash-chained ledger.

The existing `PaymentProcessorAdapter` interface in `invoice-boundary.ts`
remains the lower-level export/refund seam; a settlement adapter can wrap it.

Nothing in this slice contacts an external financial system. Wiring a live
processor and moving real funds is deliberately deferred.
