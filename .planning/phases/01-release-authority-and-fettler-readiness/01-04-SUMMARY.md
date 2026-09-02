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
    - pull request 625 head d73c63ff3875d34dc6e76f55d32da2513e4fd166
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
    - transactionally replaced source immutability triggers
    - rollback-compatible quarantine ledger
key_files:
  created:
    - .planning/phases/01-release-authority-and-fettler-readiness/01-04-SUMMARY.md
  modified:
    - packages/db/src/index.ts
    - packages/db/src/warden-transformer-rename.test.ts
    - tasks/todo.md
decisions:
  - Bind each attested source row to an immutable primary key and tenant from discovery onward.
  - Persist unattributable rows in a sealed ledger whose source triggers remain active under the older binary.
  - Revalidate both sealed ledgers and their current source rows on every startup.
metrics:
  review_blockers_reproduced: 2
  hostile_tests: 34
  database_tests: 513
  completed: 2026-09-02
---

# Phase 01 Plan 04: Tenant Ownership Quarantine Review Repair Summary

Pull request 625 now binds the complete legacy ownership chain: scope membership, operator attestation, source identity, tenant ownership, deletion, identifier reuse, restart validation, rollback, and repair reapplication.

## Outcome

- Every source row in the attested reconciliation scope rejects primary-key changes, tenant changes, and deletion across all five migration-touched tables.
- Source guards are installed in the same immediate transaction that seals discovery, so a failed pre-attestation boot does not leave scoped rows mutable.
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

### Green

The repair adds the smallest shared boundary for both findings:

- a sealed quarantine scope and digest state;
- source guards that are transactionally replaced so older trigger definitions cannot survive an upgrade;
- `UPDATE OF id, tenant_id` and delete protection for every scoped or quarantined source row;
- startup validation for both attested and unattributable source rows.

## Verification

- Focused tenant migration suite: 34 of 34 tests passed.
- Full database suite: 59 files and 513 tests passed.
- Database TypeScript typecheck passed.
- Optimized production build passed with 64 generated pages.
- General-availability preflight passed, including specification, closure, configuration, claims, action pins, architecture, model, naming, architecture decision record, third-state, evidence reachability, revert obligation, and readiness checks.
- Diff integrity passed before commit.

## Compatibility and Rollback

- Existing reconciliation state upgrades additively. The new ledger and triggers remain understandable to SQLite when the prior binary runs because that binary neither drops unknown tables nor removes unknown triggers.
- A literal rollback may fail closed when its heuristic backfill touches a quarantined row. It cannot launder that row into valid default ownership.
- Reapplying the repair preserves the original null ownership, accepts startup, and leaves the job unclaimable globally and by `tenant_default`.

## Remaining Authority

This implementation does not merge or deploy the pull request. The pushed repair head still requires independent exact-head review and every protected check.

## Self-Check

- Both independent review blockers have direct hostile regressions.
- The original pull request branch is updated only after an exact-head guard.
- Pull requests 606 and 610 and Plans 01-05 and 01-06 are untouched.
