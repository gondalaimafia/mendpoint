---
phase: 01-release-authority-and-fettler-readiness
plan: 01-04
subsystem: database tenant isolation
status: implemented_review_repair
tags:
  - tenant-isolation
  - legacy-migration
  - hostile-tests
dependency_graph:
  requires:
    - pull request 625 rebased review base ddd3954d316d4844e7e715fd04e77d47949ceb45
    - verified omitted-tenant repair head 164b9627a6c8f355b092e66307376eb43448d278
    - issue 624 tenant ownership quarantine contract
  provides:
    - immutable attested source identity and ownership
    - rollback-stable quarantine for unattributable ownership
  affects:
    - packages/db/src/index.ts
    - packages/db/src/warden-transformer-rename.test.ts
tech_stack:
  added: []
  patterns:
    - sealed SQLite reconciliation scopes
    - atomic cross-connection recovery guard publication
    - transactionally replaced source immutability triggers
    - rollback-compatible quarantine ledger
key_files:
  created:
    - .planning/phases/01-release-authority-and-fettler-readiness/01-04-SUMMARY.md
  modified:
    - packages/db/src/index.test.ts
    - packages/db/src/index.ts
    - packages/db/src/warden-transformer-rename.test.ts
    - tasks/todo.md
decisions:
  - Bind each attested source row to an immutable primary key and tenant from discovery onward.
  - Persist unattributable rows in a sealed ledger whose source triggers remain active under the older binary.
  - Revalidate both sealed ledgers and their current source rows on every startup.
  - Hold one immediate write transaction from recovery guard installation through validation and attestation sealing.
metrics:
  review_blockers_reproduced: 4
  hostile_tests: 40
  database_tests: 560
  completed: 2026-09-02
---

# Phase 01 Plan 04: Tenant Ownership Quarantine Review Repair Summary

Pull request 625 now binds the complete legacy ownership chain: scope membership, operator attestation, source identity, tenant ownership, deletion, identifier reuse, restart validation, rollback, and repair reapplication.

## Outcome

- Every source row in the attested reconciliation scope rejects primary-key changes, tenant changes, and deletion across all five migration-touched tables.
- Source guards are installed in the same immediate transaction that seals discovery, so a failed pre-attestation boot does not leave scoped rows mutable.
- Future-write, source-immutability, and ledger append-only guards are installed in that same transaction, so a failed pre-attestation boot cannot admit a late null, empty, or trim-blank ownership row.
- Released-predecessor tables with an inherited `tenant_default` column default reject both omitted and explicit default ownership unless the inserted identity already belongs to the sealed reconciliation scope and has a matching durable attestation.
- Fresh schemas retain normal explicit `tenant_default` writes because they do not carry the inherited synthetic column default.
- An already-sealed state from the vulnerable binary is repaired under one immediate transaction held through ledger, source, and attestation validation and final attestation sealing. No other connection can observe a partial guard family.
- Unattributable null, empty, and whitespace-only ownership is recorded in a separate sealed quarantine ledger.
- The durable source triggers reference both ledgers. The exact base backfill statement therefore aborts instead of converting unknown ownership to `tenant_default`.
- Every startup verifies both ledger digests and checks that each recorded source identifier still exists with the sealed ownership state.

## Test-Driven Evidence

### Red

The hostile suite failed on the reviewed head before production changes:

- The full identifier-reuse reproduction renamed an attested job, reassigned it to `tenant_other`, inserted a `tenant_default` decoy under the old identifier, restarted successfully, and claimed the escaped job across tenants.
- Primary-key updates succeeded for jobs, repair sessions, agent runs, and suppressed patterns.
- The literal base backfill updated a null legacy job to `tenant_default`, so no rollback error was recorded.

The focused red run reported 6 failing tests and 27 passing tests.

The final review regression then failed with 35 tests passing and 1 failing. It
recorded 30 permitted late writes across all five ownership tables and retained
the resulting unattributable rows after the attested restart.

The cross-connection recovery regression failed with 37 tests passing and 1
failing. Immediately after the nonblank-trigger commit, a second connection
observed 22 missing source and ledger guards, reassigned a scoped job to
`tenant_other`, and forced the recovering boot to fail validation.

The omitted-tenant regression then accepted every attempted insert across jobs,
repair sessions, agent runs, audit events, and suppressed patterns under both
the repaired and rollback connections. The atomic recovery regression observed
all five default-attribution guards missing from the published trigger family.

### Green

The repair adds the smallest shared boundary for the review findings:

- a sealed quarantine scope and digest state;
- source guards that are transactionally replaced so older trigger definitions cannot survive an upgrade;
- `UPDATE OF id, tenant_id` and delete protection for every scoped or quarantined source row;
- startup validation for both attested and unattributable source rows.
- one atomic recovery boundary that publishes every guard family only after validation and attestation sealing complete.
- a released-fallback-only insert boundary that requires a preexisting sealed identity and matching durable attestation before `tenant_default` ownership may be materialized.

## Verification

- Current verified repair head: `164b9627a6c8f355b092e66307376eb43448d278`.
- Focused tenant migration suite: 40 of 40 tests passed.
- Full database suite: 60 files and 560 tests passed.
- Database TypeScript typecheck passed.
- Diff integrity passed before commit.

The optimized production build and general-availability preflight belong to the
rebased review base `ddd3954d316d4844e7e715fd04e77d47949ceb45`.
They are inherited base evidence, not current-head proof for the omitted-tenant
repair.

## Compatibility and Rollback

- Existing reconciliation state upgrades additively. The new ledger and triggers remain understandable to SQLite when the prior binary runs because that binary neither drops unknown tables nor removes unknown triggers.
- The default-attribution triggers survive an older-binary rollback and are reinstalled as one atomic family when the repair restarts.
- A literal rollback may fail closed when its heuristic backfill touches a quarantined row. It cannot launder that row into valid default ownership.
- Reapplying the repair preserves the original null ownership, accepts startup, and leaves the job unclaimable globally and by `tenant_default`.

## Remaining Authority

This implementation does not push, merge, or deploy the pull request. The local repair head requires the root-controlled current-main rebase, independent exact-head review, and every protected check.

## Self-Check

- All four independent review blockers have direct hostile regressions.
- No remote branch was changed; the root release lane owns rebase and push after reviewing this evidence commit.
- Pull requests 606 and 610 and Plans 01-05 and 01-06 are untouched.
