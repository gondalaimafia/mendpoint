# Recovery and reliability

Back up authenticated state, restore it under a bounded operator workflow, and prove readiness without repeating completed external work.

Status: Engineering controls active
Availability: Encrypted backup and restore controls exist; cross region production recovery proof remains external
Last verified: 2026-08-30
Requirements: ME-ENT-005, ME-ENT-006, ME-ENT-007, ME-ENT-008, ME-ENT-009, ME-ENT-010
Public claims: None

## Start here

Create an authenticated backup receipt before exercising recovery in an isolated target.

1. Verify current backup authority and create one committed encrypted backup.
2. Load and authenticate its exact recovery receipt.
3. Restore to an isolated target and run current schema convergence.
4. Verify row, ledger, checkpoint, readiness, and rollback identities before cutover.

## What it does

- Encrypted committed backup manifests
- Authenticated recovery receipts
- Atomic restore and backup fencing
- Lease and checkpoint safe restart
- Readiness, recovery summary, and disaster recovery drill primitives

## When to use it

- A deployment must recover from storage or region loss.
- An upgrade must prove rollback and prior schema restore.

## How it works

1. Backup captures the declared durable resources and signs the exact manifest identity.
2. Restore authenticates the receipt and content before replacing target state.
3. Current schema code opens the restored stores and verifies convergence.
4. Canaries prove that completed external effects are adopted rather than repeated.
5. Cutover proceeds only after readiness, recovery, and rollback evidence agree.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| npm run backup:customer | Command | Create a protected customer backup. |
| npm run restore:customer | Command | Restore an authenticated backup under operator authority. |
| npm run dr:drill | Command | Run the deterministic disaster recovery drill. |
| GET /recovery/summary | API | Read bounded recovery state. |
| GET /ready | API | Read dependency readiness. |

## Evidence and verification

- Disaster recovery: `packages/ops/src/disaster-recovery.test.ts`
- Readiness: `packages/ops/src/readiness.test.ts`
- Customer restore: `scripts/customer-backup-workflow.test.ts`

## Contract sources

- `packages/ops/src/readiness.ts`
- `packages/ops/src/disaster-recovery.ts`
- `scripts/customer-restore.ts`

## Safety model

- An expired or mismatched receipt fails closed.
- Restore targets are explicit and cannot escape the declared root.
- Historical authenticated checkpoints and external effects are never rematerialized.
- No old authority is stopped before replacement health and rollback evidence pass.

## Limitations

- Measured cross region RTO and RPO need an approved recovery target.
- Single node profiles do not imply high availability.

## See also

- [Deployment and operations](./deployment-operations.md)
- [Audit and compliance evidence](./audit-compliance.md)
- [Limits, errors, and retries](./limits-errors.md)
