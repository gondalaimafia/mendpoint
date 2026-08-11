# Usage plans and quota enforcement (Wave C)

This wave connects the metering **ledger** (`packages/db/src/usage.ts`) to the product
path so that a subscription plan becomes a concrete MCU quota and the real run
lifecycle reserves, settles, and releases against it. It makes the "pay-as-you-go
MCUs, 150 MCUs/seat/month, metered billing" claim true for admitted runs.

1 MCU = 1,000,000 micros throughout.

## What this does NOT do

- No payment processor integration. Nothing charges a card, wallet, or bank account.
- No automatic invoicing, dunning, or settlement to payment. Invoice/settlement
  semantics in `packages/billing/src/invoice-boundary.ts` are unchanged.
- No change to security classification, mutation fencing, or the human-review /
  no-auto-merge model.

Those remain roadmap. This wave stops at: provision a plan into an entitlement, and
enforce the entitlement's quota on the run path.

## Plan catalog

Defined in one place: `packages/db/src/usage-plan.ts` (`USAGE_PLAN_CATALOG`). The MCU
allowances and the unit price are **configurable and indicative**, not contractual
figures. No marketing dollar amount is encoded in enforcement logic.

| Plan        | Allowance | MCU / month        | Notes                                  |
| ----------- | --------- | ------------------ | -------------------------------------- |
| Free        | flat      | 15 MCU             | Seats ignored.                         |
| Pro         | per seat  | 150 MCU / seat     | The headline "150 MCUs/seat/month".    |
| Teams       | per seat  | 400 MCU / seat     | Larger per-seat allowance.             |
| Enterprise  | per seat  | 2,000 MCU / seat   | Indicative default; real quota is per contract. |

Unit price for costing settled usage: `USAGE_PLAN_PRICE_PER_MCU_MONEY_MICROS`
(20,000 money-micros = $0.02 / MCU, indicative), currency USD, formula `mcu-v1`.
The price version exists only so settled usage can be costed by the existing
usage-summary / gross-margin math; it is not a quote.

### Provisioning

`provisionEntitlementForPlan(db, { tenantId, plan, periodStart, periodEnd, seats?, now })`
idempotently creates the tenant's active `UsageEntitlement` for a period from its
plan, reusing `createUsagePriceVersion` + `createUsageEntitlement` (no parallel
ledger). Deterministic ids
(`usage-plan-price:<tenant>:<plan>:<periodStart>` and
`usage-plan-entitlement:<tenant>:<plan>:<periodStart>`) mean a re-run for the same
(tenant, plan, period) returns the existing rows instead of double-provisioning.

Any API surface that changes a tenant's plan must pass the existing
`billingPlanChangeDecision(role, env)` gate (owner/admin only, gated on
`MENDPOINT_MANUAL_PLAN_CHANGES_ENABLED === "1"`).

## MCU estimator

A run reserves a **ceiling** before doing work. The estimate is not measured usage:
it is a deterministic, documented, indicative hold. Constants live in one place:
`RUN_MCU_ESTIMATE` in `packages/db/src/usage-run.ts`.

```
estimate = baseMcuMicros + perTargetMcuMicros * clamp(targetCount, 1, maxTargets)
         = 1 MCU        + 1 MCU             * targets
```

For a `pipeline.fanout` run, `targetCount` is the number of consumer repos the
provider fans out to, read deterministically at admission via
`listConsumersForProvider`. There is no randomness and no fabricated value: the same
scope always yields the same estimate.

## Reserve / settle / release lifecycle

Thin, idempotency-keyed wrappers over the ledger, shared by the API and the worker,
live in `packages/db/src/usage-run.ts`: `reserveRunUsage`, `settleRunUsage`,
`releaseRunUsage`. Keys are derived from the run/reservation id
(`run-admission:<runId>`, `run-settle:<reservationId>`, `run-release:<reservationId>`)
so the two processes cannot double-count across restarts.

- **Admission** (`POST /jobs/fanout`, `apps/api/src/server.ts`): compute the estimate,
  then `reserveRunUsage`. On `usage_quota_exceeded` -> **HTTP 402** with
  `{ error: "usage_quota_exceeded", summary }`. On `usage_entitlement_required`
  (tenant has no plan provisioned) -> **HTTP 402** with
  `{ error: "usage_entitlement_required", summary }`. The reservation id and reserved
  amount are stored on the job payload so the worker can resolve the hold.
- **Completion** (worker, `apps/worker/src/cli.ts`): `settleRunUsage`. Fanout has no
  per-run MCU measurement, so it settles to the reserved estimate (documented here)
  rather than fabricating a zero. Where a measured token/cost settlement exists for a
  layer, that measurement is the source; where usage is unmeasured, the reserved
  estimate is the floor.
- **Failure / cancel**: `releaseRunUsage` so a failed or cancelled run burns no quota.

### Failure / release policy (explicit)

- **Terminal failure** (job reaches `dead_letter`, no more retries): release the whole
  hold. An infra/terminal failure costs the tenant nothing.
- **Retryable failure** (job returns to `pending`): keep the hold. The retried run runs
  under the same reservation and settles it on success. This avoids a release +
  re-reserve dance and any double-charge.
- **Cancel** (`POST /jobs/:id/cancel`): release the hold.
- **Manual retry** (`POST /jobs/:id/retry`): no usage change. The in-place retry reuses
  the existing outstanding hold; it settles when the retried run completes.

Worker-side settle/release is **best-effort**: a failure is logged and never breaks job
processing. Because the ledger functions each open their own transaction, settlement
runs after (not inside) job completion; if it fails, the hold simply remains
outstanding (the safe, conservative direction - it never under-counts), and
`reconcileUsageLedger` surfaces the drift.

## Flag: `MENDPOINT_USAGE_ENFORCEMENT` (default OFF)

Enforcement is behind a default-OFF flag, same prove-then-enable discipline used for
no-egress and Transformer.

- **Off** (unset or `0`): the run path is byte-for-byte identical to before. No reserve,
  no settle, no release, no 402. Runs carry no reservation id, so the worker's
  settle/release helpers are no-ops.
- **On** (`1`): admission reserves and can reject with 402; the worker settles on
  success and releases on terminal failure/cancel.

`usageEnforcementEnabled(env)` and `admitRunUsage(...)` in
`apps/api/src/usage-enforcement.ts` own the gate and the 402 shaping. The worker acts
purely on the presence of a reservation id in the job payload, so toggling the flag off
never strands a hold that was created while it was on.

## Scope and known limitations

- Wired for **API-admitted** `pipeline.fanout` runs. Feed-triggered auto-fanouts
  enqueued directly by the worker are not metered by this wave (documented gap, not a
  silent one).
- Fanout settles to the reserved estimate (no per-run MCU measurement exists for that
  layer yet). This is honest by construction: reserve and settle net to the same
  deterministic figure, and no zero is fabricated.

## Tests

- `packages/db/src/usage-plan.test.ts`: provisioning idempotency, per-seat vs flat
  quotas, unknown plan / bad seats.
- `packages/db/src/usage-run.test.ts`: deterministic estimator, reserve -> settle on
  success, reserve -> release on failure, idempotent replays.
- `apps/api/src/usage-enforcement.test.ts`: flag-off no-op (ledger untouched), reserve
  on admission, `usage_quota_exceeded` -> 402, `usage_entitlement_required` -> 402.
