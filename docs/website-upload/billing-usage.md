# Billing and usage

Authorize plans and entitlements, reserve bounded spend before work, and settle exact usage with durable evidence.

Status: Internal commercial control
Availability: Usage accounting active in runtimes; public payment collection and standard invoicing are not active
Last verified: 2026-08-14
Publication evidence: not live; no deployed revision or live evidence digest recorded
Requirements: ME-FND-008, ME-COM-001, ME-COM-002, ME-COM-003, ME-COM-004
Public claims: None

## Start here

Assign the tenant an approved plan and entitlement before starting model or migration work.

1. Create or select a versioned price plan.
2. Grant the tenant a bounded entitlement.
3. Reserve model, tool, or campaign usage before dispatch.
4. Settle or release the reservation with exact receipt evidence.

## What it does

- Versioned plans and price definitions
- Tenant entitlements and quotas
- Idempotent usage reservations, settlement, release, and evidence
- Model token, cost, response-byte, and campaign budget accounting
- Gross-margin and execution-cost reporting

## When to use it

- A workflow must fail before exceeding tenant authority.
- A provider call needs exact reserve and settle semantics.
- Operations needs attributable usage and cost evidence.

## How it works

1. Tenant plan and entitlement authority define allowed units and limits.
2. A runtime reserves the maximum bounded amount before an external effect.
3. Completion settles the exact measured amount; cancellation releases the reservation.
4. Idempotency and evidence prevent duplicate charges across response loss or takeover.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| GET /billing/plans | API | List configured product plans. |
| GET /billing/usage | API | Read tenant usage. |
| POST /billing/usage/reservations | API | Reserve bounded usage. |
| POST /billing/usage/reservations/:id/settle | API | Settle exact measured usage. |
| POST /billing/usage/reservations/:id/release | API | Release unused authority. |

## Evidence and verification

- Usage ledger domain: `packages/db/src/usage.test.ts`
- API plan control: `apps/api/src/billing-plan-control.test.ts`
- Model accounting: `apps/worker/src/warden-model-accounting.test.ts`

## Contract sources

- `packages/db/src/usage.ts`
- `apps/api/src/billing-economics.ts`
- `apps/api/src/server.ts`

## Safety model

- No external model spend is authorized without a successful reservation where accounting is required.
- Settlement cannot exceed authority or replay with different bytes.
- Tenant usage and evidence are isolated.

## Limitations

- No public card checkout, subscription charging, or standard invoice flow is active.
- Private pilot commercial terms are agreed case by case.
- Configured prices are internal authority, not a public price list.

## See also

- [Model router](./model-router.md)
- [Fettler — the first AI API Engineer](./fettler.md)
- [ReGauge — the first AI Legacy Engineer](./regauge.md)
- [Security and governance](./security-governance.md)
