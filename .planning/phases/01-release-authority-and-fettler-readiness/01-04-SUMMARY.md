---
phase: 01-release-authority-and-fettler-readiness
plan: 01-04
subsystem: database tenant isolation
status: implemented
tags:
  - tenant-isolation
  - legacy-migration
  - hostile-tests
dependency_graph:
  requires:
    - stacked base 036b010666d7de2fb10251abca90c662cc98246a
    - reviewed predecessor d96bdecd1f93f2ca5b11ff01e7f4ede93269e7c2
  provides:
    - invalid legacy tenant ownership remains unclaimable
    - trim-aware tenant ownership enforcement for future writes
  affects:
    - packages/db/src/index.ts
    - packages/db/src/warden-transformer-rename.test.ts
tech_stack:
  added: []
  patterns:
    - versioned SQLite validation triggers
    - tenant quarantine in claim predicates
key_files:
  created:
    - .planning/phases/01-release-authority-and-fettler-readiness/01-04-SUMMARY.md
  modified:
    - packages/db/src/index.ts
    - packages/db/src/warden-transformer-rename.test.ts
decisions:
  - Preserve legacy tenant values byte for byte and quarantine invalid ownership at claim time.
  - Add versioned nonblank triggers so previously installed trigger definitions cannot mask the hardening.
  - Validate trimmed ownership without rewriting valid tenant identifiers.
metrics:
  tasks: 2
  commits: 3
  completed: 2026-09-02
---

# Phase 01 Plan 04: Tenant Ownership Quarantine Repair Summary

Legacy null, empty, missing, and whitespace-only tenant ownership now remains unattributable and unclaimable, while future invalid ownership writes fail closed.

## Outcome

- Global and tenant-scoped job claiming excludes null, empty, missing, and whitespace-only tenant ownership.
- `enqueueJob` rejects whitespace-only ownership before persistence.
- Insert and update triggers enforce trim-aware nonempty ownership across jobs, repair sessions, agent runs, audit events, and suppressed patterns.
- Legacy ownership is not normalized, rewritten, or assigned `tenant_default`.
- Valid tenant identifiers survive migration and remain claimable.

## Test-Driven Evidence

### RED

Commit `9b6693b0055e2ffc1628a8c8d735fc431411afda` added hostile coverage and failed in the three expected seams:

1. A legacy null-tenant job was claimed globally.
2. An aged empty-tenant job was claimed before the valid tenant job.
3. Whitespace-only tenant ownership was accepted by future-write paths.

### GREEN

Commit `2b27e05b8c2f301293c75f0966b9cc7b2199fb3a` added the minimum production repair:

- Both job claim modes require `tenant_id IS NOT NULL` and `trim(tenant_id) <> ''`.
- `enqueueJob` rejects non-string and trim-empty tenant identifiers without rewriting accepted identifiers.
- New versioned insert and update triggers reject null or trim-empty tenant identifiers on all migration-touched tables.

## Verification

- Focused hostile and database regression suite: 71 of 71 tests passed.
- Full database suite: 531 of 531 tests passed across 60 files.
- Database TypeScript typecheck passed.
- `git diff --check` against stacked base `036b010666d7de2fb10251abca90c662cc98246a` passed.

## Compatibility and Safety

- Historical invalid ownership stays byte-identical and quarantined.
- Existing valid tenant identifiers are preserved exactly.
- The repair does not infer ownership and does not launder any row into `tenant_default`.
- Previously assigned `tenant_default` rows cannot be distinguished from legitimate rows without external provenance; this patch deliberately makes no inference about them.

## Deviations from Plan

None. The repair is isolated from the original pull request branch and contains separate RED, GREEN, and evidence commits.

## Known Stubs

None.

## Self-Check: PASSED

- Source and hostile test files exist.
- RED and GREEN commits are present in branch history.
- The original owner branch was not modified, pushed, commented on, approved, merged, or deployed.
