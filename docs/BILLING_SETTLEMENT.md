# Billing Settlement (MCU)

This document describes the operational settlement pipeline that turns the
metered MCU usage ledger into a collected invoice. It covers the lifecycle, the
pluggable collector port, the shipped mock collector, the enable flag, and how a
real payment processor would plug in.

> Two collectors ship behind the same port: a deterministic **mock** that moves
> no money, and a real **Stripe** collector that is credential-gated and off by
> default. With the flag unset, nothing auto-charges and behavior is
> byte-identical to before. The Stripe collector cannot charge real money unless
> a live key AND an explicit live opt-in are both present (see the live-key
> rail below); a test key charges only Stripe test balances.

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
  attemptCollection(
    invoice: Invoice,
    context?: { idempotencyKey: string },
  ): CollectionOutcome | Promise<CollectionOutcome>;
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
| `stripe` | `stripe` | The Stripe collector runs. Requires `STRIPE_SECRET_KEY`; missing key fails closed (`billing_stripe_secret_key_missing`). A live key also requires `MENDPOINT_BILLING_ALLOW_LIVE=1`. |
| any other value | `disabled` | Fails safe to disabled. |

`resolveCollectionMode(env)` reads the flag. Only the exact strings `mock` and
`stripe` enable collection. `resolvePaymentCollector(env)` is the single wiring
point that maps the mode to a collector (or `null` when disabled), failing
closed when the Stripe credential is missing.

## The Stripe collector

`StripePaymentCollector` (`packages/billing/src/stripe-collection.ts`) implements
the same `PaymentCollector` port against Stripe's PaymentIntents API.

- **Call shape:** `POST https://api.stripe.com/v1/payment_intents` with
  `amount` (the invoice's exact amount-due, converted to Stripe's smallest
  currency unit), `currency`, `confirm=true`, invoice/tenant metadata, and (when
  a charge target is resolved) `customer` + `payment_method` + `off_session`.
  The transport is an injectable `fetch` seam, so tests drive it with no network
  and no real charge.
- **Result mapping:** PaymentIntent `succeeded` -> `settled` (Stripe id becomes
  the collector `reference`); `requires_action` / `requires_confirmation` /
  `processing` -> `pending`; `requires_payment_method` / `canceled` and any error
  envelope (card declines, auth/rate-limit errors, transport failure) ->
  `failed` (retryable). The collector never throws for an operational Stripe
  result; it returns an outcome, so the ledger stays in control of state.
- **Idempotency (two layers):** the adapter sends a Stripe `Idempotency-Key`
  derived from `sha256(tenant, invoice, reconciliation digest, amount-due,
  currency, settlement idempotency key)`. A retry under the same settlement key
  reuses the same Stripe key, so Stripe replays the same PaymentIntent instead of
  double-charging. The ledger's own replay cache is the second layer.

### Env vars

| Var | Purpose |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret key. Required in `stripe` mode; never logged or stored. |
| `MENDPOINT_BILLING_ALLOW_LIVE` | Set to `1` to permit a live key (`sk_live_` / `rk_live_`). |

### Live-key safety rail

The default posture makes it impossible to charge real money by accident:

- A **test** key (`sk_test_` / `rk_test_`) works without any opt-in and charges
  only Stripe test balances.
- A **live** key (`sk_live_` / `rk_live_`) throws
  `billing_stripe_live_key_forbidden` at construction unless
  `MENDPOINT_BILLING_ALLOW_LIVE=1` is also set.
- Any **unrecognized** key shape throws `billing_stripe_secret_key_invalid`
  rather than being put on the wire.

The secret is held as a redacting `SecretMaterial` (from
`packages/platform/src/credentials.ts`), revealed only to build the
`Authorization` header. Every error string the collector surfaces is passed
through a redactor, so the key can never reach a ledger entry, a thrown error,
or a log. The error codes above are catalogued in
`packages/shared/src/error-guidance.ts` (with a `billing_stripe_` family for the
operational outcomes) so `/diagnostics` explains them.

### Not implemented in this slice

The Stripe collector is the settlement call only. Deliberately out of scope:

- **Webhooks / async confirmation.** `pending` outcomes (e.g.
  `requires_action`, `processing`) are recorded and left retryable; there is no
  webhook listener to advance them when Stripe later settles. A future slice
  reconciles PaymentIntent webhooks back into the ledger.
- **Refunds / disputes / chargebacks.** No refund or dispute handling; the
  lower-level refund seam remains `PaymentProcessorAdapter` in
  `invoice-boundary.ts`.
- **Dunning.** The pricing policy carries `dunningDaysAfterDue`, but no dunning
  scheduler drives repeated Stripe attempts.
- **Tenant -> Stripe customer mapping.** The charge target
  (`customer` / `payment_method`) is a pluggable resolver; a real mapping from
  tenant to a saved Stripe customer with an off-session payment method is not
  wired. Without it Stripe returns `requires_payment_method` (a safe `failed`).
- **Three-decimal currencies** (BHD, JOD, KWD, OMR, TND) are not charged; a due
  amount in one of these, or any sub-minor-unit amount, fails closed with
  `billing_stripe_amount_not_representable`.

## Plugging in another processor

Stripe is the first real collector; Adyen, an internal treasury service, or any
other processor plugs in behind the **same** `PaymentCollector` port the same
way:

1. Implement `attemptCollection(invoice, context?)` against the processor's API,
   mapping the processor result to `{ status, reference, error? }`. Keep it
   side-effect free with respect to the invoice — return an outcome, do not
   mutate state. Derive the processor's idempotency token from
   `context.idempotencyKey` so retries never double-charge.
2. Add a new mode value to `BillingCollectionMode` / `resolveCollectionMode`, and
   select the adapter in `resolvePaymentCollector`. Fail closed if its
   credential is missing.
3. Leave `TenantSettlementLedger` untouched: it already owns idempotency, state
   transitions, the boundary guards, and the hash-chained ledger.

The existing `PaymentProcessorAdapter` interface in `invoice-boundary.ts`
remains the lower-level export/refund seam; a settlement adapter can wrap it.
