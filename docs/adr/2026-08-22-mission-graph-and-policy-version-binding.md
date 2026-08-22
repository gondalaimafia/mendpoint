# Bind the Change Graph and Policy Envelope version onto the Mission row

- **Status:** Accepted
- **Date:** 2026-08-22
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The v4.0 specification requires a Mission to carry the explicit versions of the state it reasons over:

- §11.10 — "A running mission SHOULD reference explicit graph and repository/provider versions. A graph update MUST NOT silently change the semantics of an in-flight mission."
- §6.7 — "A long-running Mission MUST retain the policy version under which a decision was made. Policy upgrades during an active Mission MUST be explicit and auditable."

The `mission` row (`packages/db/src/mission.ts`) already pins repository and immutable snapshot scope (`bindMissionScope`) with set-once optimistic concurrency, but it had **no** column for the Change Graph version or the Policy Envelope version. The gap-closure evaluation recorded `ME-MSN-001`/`ME-MSN-003` (v4-platform register) as `partial` partly for this reason. This ADR adds the persistence primitive; wiring live Fettler/ReGauge runs to call it is tracked separately.

## Decision

Add two nullable columns to the `mission` table and two set-once binders that mirror the existing `bindMissionScope` contract exactly.

- Schema: `graph_version_id TEXT` and `policy_envelope_version TEXT`, both nullable, added to the `CREATE TABLE IF NOT EXISTS mission` DDL (fresh databases) and to the idempotent `additiveColumns` migration in `packages/db/src/index.ts` (existing databases). No index, view, constraint, or trigger references them, so a pre-change database that has not run the migration never touches them in the static DDL, and a fresh and a migrated database converge byte-for-byte (asserted by the existing mission-convergence test).
- Model: `Mission.graphVersionId` and `Mission.policyEnvelopeVersion` on the read type, mapped in the row mapper. `createMission` leaves them NULL.
- Binders: `bindMissionGraphVersion` and `bindMissionPolicyEnvelopeVersion`, both **set-once**. A re-bind to the same value is idempotent; a re-bind to a different value fails closed (`mission_graph_version_conflict` / `mission_policy_envelope_version_conflict`); the first bind bumps the mission revision and emits a hash-chained domain event (`mission.graph_version_bound` / `mission.policy_envelope_bound`) so a concurrent transition cannot silently race it (§20.7.1).

Set-once matches how snapshot scope is already pinned. Advancing the graph version across accepted stages (§35.3) is deliberately **out of scope**: an advancement path must be explicit and audited, not a silent overwrite, and it is larger than this primitive.

## Alternatives considered

- **Allow free re-binding of the graph version.** Rejected: it would let a graph update silently change an in-flight mission's semantics, which §11.10 forbids. Advancement, when built, must be an explicit audited transition.
- **Store the versions in a side table.** Rejected: the version a mission reasons over is intrinsic mission state, read on every context compilation; a column is simpler and keeps the optimistic-concurrency revision on one row.
- **Wire the binders into the live pipeline in the same change.** Deferred: making live Fettler runs mission-bound touches the delivery path and is tracked with the campaign-orchestration work. This change is the safe, self-contained persistence primitive those call sites need.

## Security impact

None. Two nullable columns and two tenant-scoped, principal-checked set-once writers on an existing tenant-isolated table. No authentication, authorization, cross-tenant, secret, or external attack surface changes. The binders re-use the mission's existing `assertPrincipal` tenant check and revision fence; a cross-tenant bind fails closed with `mission_not_found`.

## Data and compatibility impact

Additive, backward-compatible schema change. Existing mission rows read `NULL` for both columns. The migration is idempotent (guarded by `PRAGMA table_info`), and fresh/migrated databases converge (existing test `mission` convergence assertion). No wire-format or public-API break; the `Mission` read type gains two nullable fields.

## Migration plan

1. Add the columns to the DDL and the `additiveColumns` migration.
2. Extend the `Mission` type, row type, and mapper.
3. Add the two set-once binders and re-export them from `@mendpoint/db`.
4. Add tests (bind, idempotent re-bind, conflict, revision bump, cross-tenant isolation).
5. Run the db package tests, the mission-convergence test, and `typecheck`.

## Rollback

Revert the commit. SQLite `ALTER TABLE ADD COLUMN` is not auto-dropped on downgrade, but the columns are nullable and unreferenced, so an older build simply ignores them; no data is transformed or lost.

## Evaluation plan

Success is the db package tests and mission-convergence test passing with the new binders covered, and `typecheck` green. The signal to revisit is a requirement to advance the graph version across mission stages, which will need its own explicit, audited advancement transition rather than relaxing the set-once guard.
