---
phase: 01-release-authority-and-fettler-readiness
plan: "08"
subsystem: reliability
tags: [dependency-outage, circuit-breaker, durable-queue, fencing, reconciliation]

requires: []
provides:
  - Versioned product-neutral dependency outage decision contract.
  - Tenant-scoped SQLite outage queue with fenced claims and immutable hash-chained history.
  - Injected model and GitHub outage recovery ports with provider-specific failure classification.
affects: [01-18, model-runtime-binding, github-delivery-binding, production-readiness]

actuals:
  tokens: 37942
  tasks: 3
  commits: 9

tech-stack:
  added: []
  patterns:
    - Dependency-inverted outage ports prevent package dependency cycles.
    - Reconcile-before-execute protects completed external effects from replay.
    - Fenced durable claims and operation digests fail closed under restart and contention.
    - Circuit snapshots are persisted as state, opening time, cooldown, and consecutive failure count.

key-files:
  created:
    - packages/ops/src/dependency-outage.ts
    - packages/ops/src/dependency-outage.test.ts
    - packages/db/src/dependency-outage-queue.ts
    - packages/db/src/dependency-outage-queue.test.ts
  modified:
    - packages/agent/src/model-providers.ts
    - packages/agent/src/model-providers.test.ts
    - packages/agent/src/index.ts
    - packages/github/src/app-runtime.ts
    - packages/github/src/app-runtime.test.ts
    - packages/github/src/index.ts
    - packages/ops/src/index.ts

key-decisions:
  - "Use injected structural ports instead of importing ops or db from GitHub, because ops already depends on GitHub and the direct plan link would create a package cycle."
  - "Keep exact provider reconciliation inside the GitHub delivery implementation, where branch, commit identity, complete tree delta, file content, file mode, and draft pull request state can be validated read-only before a repeated write."
  - "Do not fabricate production reachability: live caller construction and the database barrel binding remain explicit follow-up work."

patterns-established:
  - "Outage authority: tenant, dependency kind, provider, operation identifier, and operation digest form the exact recovery scope."
  - "Recovery: reconcile provider state before every external write and acknowledge completion once behind a lease fence."

requirements-completed: []

coverage:
  - id: D1
    description: Versioned retry, circuit, expiry, authority, and degraded-state decisions.
    requirement: ME-ENT-008
    verification:
      - kind: unit
        ref: packages/ops/src/dependency-outage.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: Durable tenant-scoped recovery queue with restart, fencing, digest, history, and lost-response protections.
    requirement: ME-ENT-008
    verification:
      - kind: integration
        ref: packages/db/src/dependency-outage-queue.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: Model and GitHub adapters classify failures and expose injected recovery operations without creating a package cycle.
    requirement: ME-ENT-008
    verification:
      - kind: unit
        ref: packages/agent/src/model-providers.test.ts and packages/github/src/app-runtime.test.ts
        status: pass
      - kind: other
        ref: packages/ops/src/dependency-outage.test.ts dependency inversion architecture
        status: pass
    human_judgment: false
  - id: D4
    description: Production callers construct the durable queue and inject it into live model and GitHub delivery paths.
    requirement: ME-ENT-008
    verification:
      - kind: integration
        ref: Live binding is outside the plan-owned files and is not present on this branch.
        status: unknown
    human_judgment: true
    rationale: Production reachability cannot be established until the live callers and database package export are bound and tested.

duration: 1h 20m
completed: 2026-09-02
status: halted
---

# Phase 01 Plan 08: Model and SCM Outage Controls Summary

**The outage policy, durable queue, and dependency-inverted model and GitHub seams are implemented and tested, but Plan 01-08 is halted before production reachability because its required direct links conflict with the package graph and its live caller files are outside the plan scope.**

## Performance

- **Duration:** 1 hour 20 minutes
- **Completed:** 2026-09-02T02:35:54.1100596Z
- **Tasks:** 3 implementation tasks completed; production binding remains incomplete
- **Files modified:** 11 implementation and test files, plus this summary

## Accomplishments

- Added deterministic bounded retry, retry-after handling, durable three-failure circuit opening, half-open probing, expiry, authority blocking, and customer-visible degraded standing.
- Added a durable tenant-scoped queue with restart recovery, fenced claims, exact-once completion, operation and completion digest conflict detection, and append-only hash-chained history.
- Added provider-specific model and GitHub classification and injected ports that carry the reconstructed circuit snapshot into every decision.
- Added read-only GitHub reconciliation that verifies the exact branch, commit identity, parent, full tree delta, file content, file mode, and draft pull request before any repeated blob, tree, commit, reference, or pull request write.
- Proved retry, duplicate, exact pull request lost-response, zero-repeat writes, process restart, three-failure trip, half-open recovery, expired authority, tenant isolation, digest substitution, immutable history, and package-cycle behavior with 51 focused tests.

## Task Commits

1. **Task 1 red tests:** `0fc81ed2` (`test`)
2. **Task 1 durable outage contract and queue:** `3f21c059` (`feat`)
3. **Task 2 model recovery seam:** `11bd3c1a` (`feat`)
4. **Task 3 SCM recovery seam:** `dea6a7c8` (`feat`)
5. **Typed result correction:** `0eb85da2` (`fix`)
6. **Authority, hostile tests, identifiers, and barrel exports:** `f78d6a7b` (`fix`)
7. **Durable circuit and read-only GitHub reconciliation repair:** `d4bebdff` (`fix`)

Issue and authority: [#605](https://github.com/gondalaimafia/mendpoint/issues/605), open, issue body read back with exact `Owner: Codex` claim.

## Files Created and Modified

- `packages/ops/src/dependency-outage.ts` - Pure version 1 outage and circuit decision contract.
- `packages/ops/src/dependency-outage.test.ts` - Policy and dependency graph tests.
- `packages/db/src/dependency-outage-queue.ts` - Durable SQLite recovery queue and authenticated history.
- `packages/db/src/dependency-outage-queue.test.ts` - Restart, fencing, lost-response, authority, tamper, and tenant tests.
- `packages/agent/src/model-providers.ts` - Model failure evidence mapping and injected recovery operation.
- `packages/agent/src/model-providers.test.ts` - Model classification and completed-request reconciliation tests.
- `packages/github/src/app-runtime.ts` - GitHub failure evidence mapping and injected exact-draft recovery operation.
- `packages/github/src/app-runtime.test.ts` - GitHub outage scope, classification, and bounded operation identifier tests.
- `packages/agent/src/index.ts`, `packages/github/src/index.ts`, `packages/ops/src/index.ts` - Minimal public exports for the new seams.

## Decisions Made

- The plan's proposed GitHub to database link was not implemented because `@mendpoint/ops` already depends on `@mendpoint/github`; importing ops or database into GitHub would create a package cycle. Structural injected ports preserve ownership direction and are covered by an architecture test.
- A lost GitHub response is classified as requiring provider reconciliation. The outage adapter performs an exact read-only observation before execution; a fully delivered draft completes from provider state, while an exact committed branch without a pull request resumes at pull request creation without repeating Git object writes.
- Operation identifiers are digest-bounded so maximum provider path lengths cannot overflow durable queue limits.

## Deviations from Plan

### Auto-fixed Issues

**1. Package-cycle defect in the planned key links**
- **Found during:** pre-edit dependency inventory
- **Issue:** Direct `packages/github/src/app-runtime.ts` imports from ops or db would create a GitHub and ops cycle. The agent package also has no ops dependency.
- **Fix:** Added dependency-inverted structural ports and an architecture test that rejects the cycle.
- **Files modified:** model provider, GitHub runtime, ops test, and three clean package barrels
- **Verification:** 47 focused tests and four affected package type checks pass.
- **Committed in:** `11bd3c1a`, `dea6a7c8`, `f78d6a7b`

**2. Active database barrel overlap**
- **Found during:** open pull request and branch ownership inventory
- **Issue:** Open pull request #587 actively modified `packages/db/src/index.ts` while this plan executed.
- **Fix:** Preserved the other owner's file and did not export the queue from the database barrel on this branch.
- **Verification:** Current-base rebase incorporated #587 without modifying or reverting its database barrel work.
- **Committed in:** no database barrel commit by design

**3. Independent review found non-durable circuit snapshots and write-before-reconcile behavior**
- **Found during:** exact-head independent review of pull request #606
- **Issue:** The queue stored only the circuit state label, so consecutive failures and cooldown history reset between calls; the GitHub outage reconcile callback always returned `missing`, causing completed Git object writes to be repeated after a lost response.
- **Fix:** Persisted and reconstructed the complete circuit snapshot, transitioned a due open circuit to a fenced half-open claim, threaded the snapshot through both model and GitHub decision inputs, and added exact read-only GitHub state inspection before every write.
- **Files modified:** outage policy, durable queue, model port, GitHub runtime, their tests, and two public type barrels
- **Verification:** 51 focused tests, four affected package type checks, the full 179-test ops suite, and the full 195-test GitHub suite pass.
- **Committed in:** `d4bebdff`

---

**Total deviations:** 3: one architectural correction, one ownership-preserving deferral, and one independently reviewed reliability repair.
**Impact on plan:** The core behavior is complete and tested. The final production link and therefore ME-ENT-008 qualification are not complete.

## Issues Encountered

- The system Node runtime is version 24 while the repository declares Node 22. Exact workspace tests passed, and the same suites also passed with provisioned Node 22.23.2.
- The first append-only hostile test used the wrong column name. The test was corrected to mutate `event_kind`, then proved both update and delete triggers fail closed.

## Verification

- Exact plan commands plus hostile review regressions: all four workspaces passed, 51 focused tests total.
- Full package regressions: ops passed 179 tests; GitHub passed 195 tests.
- TypeScript: ops, database, agent, and GitHub package checks passed with no errors.
- Diff integrity: `git diff --check` passed before the repair commit.
- Current base before the final rebase: `24590c4df96c61da377161b12a5dfdcd7fd08250`.

## User Setup Required

None for the core contract. Production activation requires code binding, not a secret or dashboard action.

## Next Phase Readiness

The following exact work remains before this plan can be marked complete or ME-ENT-008 can be promoted:

1. Export `DependencyOutageQueue` from the database package after the #587 ownership overlap is clear.
2. Construct the queue in a live runtime composition root and inject it into model operations and `GitHubAppDelivery`.
3. Bind the shared `classifyDependencyOutage` decision into those live ports.
4. Add live degraded-state readback and an integration test proving model and GitHub callers reach the durable queue.
5. Re-run production startup, outage recovery, and exact-revision evidence before any availability or public-claim promotion.

---
*Phase: 01-release-authority-and-fettler-readiness*
*Plan: 08*
*Status: halted at production binding*
