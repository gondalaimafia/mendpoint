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
  - Supported database subpath and production GitHub composition over the primary application database.
affects: [01-18, model-runtime-binding, github-delivery-binding, production-readiness]

actuals:
  tokens: 37942
  tasks: 3
  commits: 10

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
    - packages/db/src/dependency-outage-export.test.ts
  modified:
    - packages/agent/src/model-providers.ts
    - packages/agent/src/model-providers.test.ts
    - packages/agent/src/index.ts
    - packages/github/src/app-runtime.ts
    - packages/github/src/app-runtime.test.ts
    - packages/github/src/index.ts
    - packages/ops/src/index.ts
    - packages/db/package.json
    - packages/pipeline/src/index.ts
    - packages/pipeline/src/index.test.ts
    - packages/ops/src/disaster-recovery.test.ts

key-decisions:
  - "Use injected structural ports instead of importing ops or db from GitHub, because ops already depends on GitHub and the direct plan link would create a package cycle."
  - "Keep exact provider reconciliation inside the GitHub delivery implementation, where branch, commit identity, complete tree delta, file content, file mode, and draft pull request state can be validated read-only before a repeated write."
  - "Expose the queue through the ownership-safe @mendpoint/db/dependency-outage subpath and compose the real GitHub App delivery path over AppDb.raw so the mandatory database backup includes outage state."

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
        ref: packages/pipeline/src/index.test.ts and packages/ops/src/disaster-recovery.test.ts
        status: pass
    human_judgment: true
    rationale: The real GitHub App delivery consumer is bound and backup recovery is proven. The generic model port remains available for the first production model caller because no non-test model invocation exists in the repository.

duration: 1h 20m
completed: 2026-09-02
status: complete
---

# Phase 01 Plan 08: Model and SCM Outage Controls Summary

**The outage policy and durable queue now protect the real GitHub App delivery path through the primary application database, retain exact authority identity, and survive restart, backup, and restore.**

## Performance

- **Duration:** 1 hour 20 minutes
- **Completed:** 2026-09-02T02:35:54.1100596Z
- **Tasks:** 3 implementation tasks completed, plus exact-head production binding repair
- **Files modified:** 11 implementation and test files, plus this summary

## Accomplishments

- Added deterministic bounded retry, retry-after handling, durable three-failure circuit opening, half-open probing, expiry, authority blocking, and customer-visible degraded standing.
- Added a durable tenant-scoped queue with restart recovery, fenced claims, exact-once completion, operation and completion digest conflict detection, and append-only hash-chained history.
- Added provider-specific model and GitHub classification and injected ports that carry the reconstructed circuit snapshot into every decision.
- Added read-only GitHub reconciliation that verifies the exact branch, commit identity, parent, full tree delta, file content, file mode, and draft pull request before any repeated blob, tree, commit, reference, or pull request write.
- Made authority identity mandatory for model and GitHub operations, proved an authentication block can resume only after exact authority rotation, and bound GitHub delivery to an installation and credential digest.
- Added the supported database subpath, production pipeline composition, and restart plus encrypted backup and restore proof over the primary database.
- Proved retry, duplicate, exact pull request lost-response, zero-repeat writes, process restart, three-failure trip, half-open recovery, expired authority, tenant isolation, digest substitution, immutable history, and package-cycle behavior with 51 focused tests.

## Task Commits

1. **Task 1 red tests:** `3284bab7` (`test`)
2. **Task 1 durable outage contract and queue:** `7645beb3` (`feat`)
3. **Task 2 model recovery seam:** `748aea91` (`feat`)
4. **Task 3 SCM recovery seam:** `27123c67` (`feat`)
5. **Typed result correction:** `fd51cdc6` (`fix`)
6. **Authority, hostile tests, identifiers, and barrel exports:** `dbc632ac` (`fix`)
7. **Durable circuit and read-only GitHub reconciliation repair:** `de0f4a34` (`fix`)
8. **Current rebased evidence series:** `2e82ac20`, `10dc7f67`, `84a91091`, `cac1bf6b`, `5baa6dbe`, `456118de`, `9049b340`, `130e3e44`, `4fe36fff`, `f3170f70`

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

- The GitHub package retains an injected port to avoid a package cycle. The production pipeline owns composition and imports the durable queue through `@mendpoint/db/dependency-outage` plus the shared decision policy from ops.
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
- **Committed in:** `748aea91`, `27123c67`, `dbc632ac`

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
- **Committed in:** `de0f4a34`

---

**Total deviations:** 3: one architectural correction, one ownership-preserving deferral, and one independently reviewed reliability repair.
**Impact on plan:** The engineering behavior and real GitHub production link are complete and tested. Requirement promotion still needs exact deployed-revision outage proof.

## Issues Encountered

- The system Node runtime is version 24 while the repository declares Node 22. Exact workspace tests passed, and the same suites also passed with provisioned Node 22.23.2.
- The first append-only hostile test used the wrong column name. The test was corrected to mutate `event_kind`, then proved both update and delete triggers fail closed.

## Verification

- Exact plan commands plus hostile review regressions cover database, agent, GitHub, pipeline, ops, authority rotation, package resolution, and backup recovery.
- Full package regressions: ops passed 179 tests; GitHub passed 195 tests.
- TypeScript: ops, database, agent, and GitHub package checks passed with no errors.
- Diff integrity: `git diff --check` passed before the repair commit.
- Current base: `b21503356259fb0b4e5f7f6599a2f45d0bbd1cfb`.

## User Setup Required

None for the core contract. Production activation requires code binding, not a secret or dashboard action.

## Next Phase Readiness

Before ME-ENT-008 promotion, deploy the exact revision and capture live GitHub failure, degraded-state, authority-rotation, recovery, and rollback evidence. Bind the already typed model port when the repository gains its first production model invocation; no non-test model caller exists on this base.

---
*Phase: 01-release-authority-and-fettler-readiness*
*Plan: 08*
*Status: engineering complete, deployment proof pending*
