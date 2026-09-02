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
  - Supported database root export and production GitHub composition over the primary application database.
affects: [01-18, model-runtime-binding, github-delivery-binding, production-readiness]

actuals:
  tokens: 40550
  tasks: 4
  commits: 24

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
    - apps/api/src/dependency-outage-routes.ts
    - apps/api/src/dependency-outage-routes.test.ts
    - apps/api/src/dependency-outage-recovery.test.ts
  modified:
    - packages/agent/src/agent.ts
    - packages/agent/src/agent.test.ts
    - packages/agent/src/attempt-engine.ts
    - packages/agent/src/model-providers.ts
    - packages/agent/src/model-providers.test.ts
    - packages/agent/src/index.ts
    - packages/github/src/app-runtime.ts
    - packages/github/src/app-runtime.test.ts
    - packages/github/src/index.ts
    - packages/ops/src/index.ts
    - packages/pipeline/src/index.ts
    - packages/pipeline/src/index.test.ts
    - packages/pipeline/src/delivery-resolver.test.ts
    - apps/api/src/server.ts
    - apps/worker/src/cli.ts
    - packages/ops/src/disaster-recovery.test.ts

key-decisions:
  - "Use injected structural ports instead of importing ops or db from GitHub, because ops already depends on GitHub and the direct plan link would create a package cycle."
  - "Keep exact provider reconciliation inside the GitHub delivery implementation, where branch, commit identity, complete tree delta, file content, file mode, and draft pull request state can be validated read-only before a repeated write."
  - "Expose the queue through the existing @mendpoint/db root contract, inject the shared ops decision from API and worker composition roots, and keep package-lock.json byte-identical to the protected base."

patterns-established:
  - "Outage authority: tenant, dependency kind, provider, operation identifier, and operation digest form the exact recovery scope."
  - "Recovery: reconcile provider state before every external write and acknowledge completion once behind a lease fence."
  - "Failure transitions: validate the complete versioned decision before mutation, preserve reconciliation and authority recovery ahead of retry exhaustion, and settle queued expiry exactly once."

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
        ref: packages/agent/src/agent.test.ts, apps/worker/src/cli.ts, packages/pipeline/src/index.test.ts, and packages/ops/src/disaster-recovery.test.ts
        status: pass
    human_judgment: true
    rationale: The real checkpointed Fettler model effect and exact-draft GitHub delivery both use the shared durable queue. Worker composition binds tenant, effect request digest, model authority, retry budget, expiry, and lease identity. Queue state can reopen only a proven safe retry; ambiguous, claimed, blocked, failed, or uncheckpointed completed outcomes never repeat automatically.

duration: 1h 20m
completed: 2026-09-02
status: complete
---

# Phase 01 Plan 08: Model and SCM Outage Controls Summary

**The outage policy and durable queue now protect the real API and worker GitHub App delivery path through the primary application database, retain exact authority identity, and survive restart, backup, and restore.**

## Performance

- **Duration:** 1 hour 20 minutes
- **Completed:** 2026-09-02T02:35:54.1100596Z
- **Tasks:** 3 implementation tasks completed, plus exact-head production binding and review repair
- **Files modified:** 14 implementation, composition, package, and test files, plus this summary

## Accomplishments

- Added deterministic bounded retry, retry-after handling, durable three-failure circuit opening, half-open probing, expiry, authority blocking, and customer-visible degraded standing.
- Added a durable tenant-scoped queue with restart recovery, fenced claims, exact-once completion, operation and completion digest conflict detection, and append-only hash-chained history.
- Added provider-specific model and GitHub classification and injected ports that carry the reconstructed circuit snapshot into every decision.
- Added read-only GitHub reconciliation that verifies the exact branch, commit identity, parent, full tree delta, file content, file mode, and draft pull request before any repeated blob, tree, commit, reference, or pull request write.
- Made authority identity mandatory for model and GitHub operations, proved an authentication block can resume only after exact authority rotation, and bound GitHub delivery to an installation and credential digest.
- Added the supported database root export, API and worker policy injection, production pipeline composition, and restart plus encrypted backup and restore proof over the primary database.
- Routed the live checkpointed Fettler model effect through the worker-supplied tenant queue while retaining the checkpoint ledger as completion authority and preserving its unknown-outcome no-repeat rule.
- Added a bounded authenticated `/dependency-outages` health projection with digest-only operation identity, standing, provider, retry, expiry, circuit, authority-block reason, last transition, stale state, and strict tenant isolation.
- Closed the failure-decision contract over exact keys, enums, action-to-failure mappings, standings, circuits, and action timestamps before any queue mutation.
- Preserved completed-effect reconciliation and authentication or permission recovery at the final attempt while limiting retry-budget terminalization to retry-producing actions.
- Settled expired queued operations transactionally with one immutable terminal history event and stable terminal replay across later runner invocations.
- Preserved model transport dispatch evidence so refused connections, transient DNS failures, unreachable networks, and connect timeouts remain retryable while uncertain post-dispatch loss remains reconciliation-blocked.
- Resumed an exact commit-ready GitHub draft at pull request creation without recreating blobs, trees, commits, or references.
- Removed the legacy branch, commit, and pull-request write sequence from the real pipeline so every customer draft passes through `deliverExactDraft` and durable reconciliation.
- Enforced exact authority equality before queued, claimed, or expired-lease work can execute, while preserving explicit blocked-operation reactivation after a validated authority rotation.
- Classified GitHub primary and secondary rate-limit `403` responses as throttling before the generic permission rule, while true permission failures remain permanent.
- Added `attemptsRemaining` to the exact versioned decision contract and reject decisions that disagree with the durable queue budget.
- Made reconciliation-blocked and expired lease-recovered claims replayable without consuming another external attempt, and terminalize an expired claim only after one final read-only reconciliation.
- Retained the queue's original expiry through model and GitHub classification so an adapter cannot extend durable authority near the deadline.
- Proved retry, duplicate, exact pull request lost-response, zero-repeat writes, process restart, three-failure trip, half-open recovery, expired authority, tenant isolation, digest substitution, invalid-response classification, internal-error redaction, immutable history, and caller reachability.

## Task Commits

1. **Task 1 red tests:** `3284bab7` (`test`)
2. **Task 1 durable outage contract and queue:** `7645beb3` (`feat`)
3. **Task 2 model recovery seam:** `748aea91` (`feat`)
4. **Task 3 SCM recovery seam:** `27123c67` (`feat`)
5. **Typed result correction:** `fd51cdc6` (`fix`)
6. **Authority, hostile tests, identifiers, and barrel exports:** `dbc632ac` (`fix`)
7. **Durable circuit and read-only GitHub reconciliation repair:** `de0f4a34` (`fix`)
8. **Current rebased evidence series:** `e73e1f03`, `64ed119a`, `1275ba67`, `939de04c`, `39c372e7`, `295b6fe4`, `6209a222`, `a472e346`, `02b81eb5`, `7dda371e`, `33bb3808`
9. **Independent review RED tests:** `ad811437`
10. **Exact-head outage delivery repair:** `a0862179`
11. **Review RED tests for live model reachability and health:** `66407249`
12. **Live model queue binding and bounded tenant health:** `4bb1af43`
13. **Failure classification and health redaction:** `4ac0c0d8`
14. **Exact-head state-machine review repair:** `bb9d4c2c`
15. **Round-two recovery-chain RED tests:** `a07ec7aa`
16. **Round-two durable reconciliation repair:** `08c4f304`

Issue and authority: [#605](https://github.com/gondalaimafia/mendpoint/issues/605), open, issue body read back with exact `Owner: Codex` claim.

## Files Created and Modified

- `packages/ops/src/dependency-outage.ts` - Pure version 1 outage and circuit decision contract.
- `packages/ops/src/dependency-outage.test.ts` - Policy and dependency graph tests.
- `packages/db/src/dependency-outage-queue.ts` - Durable SQLite recovery queue and authenticated history.
- `packages/db/src/dependency-outage-queue.test.ts` - Restart, fencing, lost-response, authority, tamper, and tenant tests.
- `packages/agent/src/model-providers.ts` - Model failure evidence mapping and injected recovery operation.
- `packages/agent/src/model-providers.test.ts` - Model classification and completed-request reconciliation tests.
- `packages/agent/src/agent.ts`, `packages/agent/src/attempt-engine.ts`, `apps/worker/src/cli.ts` - Real checkpointed model effect binding with worker-supplied tenant queue authority.
- `apps/api/src/dependency-outage-routes.ts` - Authenticated bounded tenant health projection without provider payloads or raw operation identifiers.
- `packages/github/src/app-runtime.ts` - GitHub failure evidence mapping and injected exact-draft recovery operation.
- `packages/github/src/app-runtime.test.ts` - GitHub outage scope, classification, and bounded operation identifier tests.
- `packages/agent/src/index.ts`, `packages/github/src/index.ts`, `packages/ops/src/index.ts`, `packages/db/src/index.ts` - Minimal public exports for the new seams.
- `apps/api/src/server.ts`, `apps/worker/src/cli.ts` - Production composition roots that inject the shared outage decision policy.
- `packages/pipeline/src/index.ts` - Exact-draft-only GitHub delivery and fail-closed policy binding.

## Decisions Made

- The GitHub package retains an injected port to avoid a package cycle. The production pipeline imports the queue through the existing `@mendpoint/db` root contract, while the API and worker composition roots inject the shared decision policy they already depend on.
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

**4. Exact-head review found four production reachability and authority defects**
- **Found during:** independent exact-head review of pull request #606 at `3d9dceb6`
- **Issue:** The real pipeline still used legacy unfenced GitHub writes, executable queued work accepted stale authority, rate-limited `403` responses were treated as permission failures, and a new package dependency changed protected lockfile bytes.
- **Fix:** Routed the real pipeline through exact-draft delivery, required matching authority for every executable state and takeover, ordered rate-limit evidence before generic permission handling, root-exported the queue, and injected the shared policy from existing API and worker composition roots.
- **Files modified:** database queue and root, GitHub runtime, pipeline, API and worker composition roots, package metadata, and paired hostile tests
- **Verification:** 106 focused tests, seven affected type checks, full database, GitHub, ops, and pipeline suites, protected authority test, optimized production build, and diff integrity pass.
- **Committed in:** `ad811437`, `a0862179`

**5. Current-main review found the production model seam and degraded-state surface were still unreachable**
- **Found during:** independent exact-head review of pull request #606 at `aacad6dc`
- **Issue:** The production `agent.ts` model call bypassed the durable queue, the operator could not enumerate tenant degraded state, and the summary claimed both links existed.
- **Fix:** Bound the real encrypted checkpoint model effect through a worker-supplied queue using the checkpoint effect and request digests, retained unknown outcomes as non-repeatable, blocked reconciliation-required outcomes from authority reactivation, and added an authenticated digest-only tenant health route.
- **Files modified:** agent runtime and attempt engine, worker composition, durable queue and database barrel, API route and server composition, paired hostile tests, and this summary
- **Verification:** 318 exact-head focused integration tests, six affected typechecks, four complete dependency package suites, the protected-authority suite, and the optimized production build pass.
- **Committed in:** `66407249`, `4bb1af43`, `4ac0c0d8`

**6. Exact-head review found five coupled state-machine and recovery defects**
- **Found during:** independent exact-head review of pull request #606 at `e59cc545`
- **Issue:** Malformed decisions could create retry authority, retry exhaustion erased reconciliation and authority recovery, expired queued work never settled, known pre-dispatch model failures were treated as possibly completed, and commit-ready GitHub delivery repeated Git object writes.
- **Fix:** Validated the exact decision union before mutation, made action precedence explicit, bounded retry timestamps to the live operation window, settled queued expiry once behind the database transaction, carried transport dispatch evidence into classification, and resumed exact-draft delivery from the existing commit.
- **Files modified:** durable queue and tests, agent planner transport classification and tests, GitHub App recovery and tests, and this summary.
- **Verification:** 279 focused tests, all seven affected complete workspace suites, seven scoped type checks, the optimized production build, the complete general availability gate, and diff integrity pass.
- **Committed in:** `bb9d4c2c`

**7. Exact-head review found four producer-to-consumer replay defects**
- **Found during:** independent exact-head review of pull request #606 at `bb9d4c2c`
- **Issue:** The policy emitted `attemptsRemaining` but the real queue rejected that key, reconciliation-blocked rows were unreachable through the runner, expired lease-recovered claims remained claimed without settlement, and GitHub recomputed expiry instead of using the retained queue deadline.
- **Fix:** Aligned and validated the exact decision shape and durable budget, added fenced reconciliation-only claims that do not consume external attempts, reconciled expired recovered claims before terminal settlement, carried the retained expiry into classification, and exposed an explicit commit-ready `resume` observation that skips Git object writes.
- **Files modified:** outage policy and durable queue, model and GitHub outage ports, focused unit tests, and a real policy-to-queue-to-GitHub integration suite.
- **Verification:** 284 focused tests; all seven affected full workspace suites; all seven affected type checks; the optimized 64-page production build; the complete general availability gate; and diff integrity passed. The first parallel API run had one unrelated 15-second repository-materialization timeout; the isolated full rerun passed 709 of 709.
- **Committed in:** `a07ec7aa`, `08c4f304`

---

**Total deviations:** 7: one architectural correction, one ownership-preserving deferral, and five independently reviewed reliability repairs.
**Impact on plan:** The engineering behavior and both live production call paths are implemented and tested. Requirement promotion still needs exact deployed-revision outage and rollback proof.

## Issues Encountered

- The system Node runtime is version 24 while the repository declares Node 22. Exact workspace tests passed, and the same suites also passed with provisioned Node 22.23.2.
- The first append-only hostile test used the wrong column name. The test was corrected to mutate `event_kind`, then proved both update and delete triggers fail closed.
- A parallel full-package run produced one 15-second timeout in an unrelated API repository-materialization test. The isolated full API rerun passed 709 of 709, so the final evidence records the parallel result as host contention rather than a product failure.

## Verification

- Exact plan commands plus hostile review regressions cover database, agent, GitHub, pipeline, ops, authority rotation, package resolution, and backup recovery.
- Focused outage, backup, adapter, caller, and resolver matrix: 106 of 106 tests passed.
- Current exact-head model, visibility, queue, delivery, and worker integration matrix: 318 of 318 tests passed.
- Final exact-head outage snapshot: 279 of 279 tests passed across operations policy, database queue and export, agent planner and provider classification, GitHub exact-draft recovery, API health projection, and pipeline delivery.
- Full package regressions: database passed 504 tests, agent passed 364 tests, GitHub passed 195 tests, operations passed 180 tests, and pipeline passed 272 tests.
- Round-two recovery-chain snapshot: 284 of 284 focused tests passed, including a real adapter integration proving exact policy acceptance, commit-ready pull-request recovery without repeated Git object writes, and retained-expiry classification.
- Final affected workspace regressions: database passed 521 tests, agent passed 372 tests, GitHub passed 196 tests, operations passed 181 tests, pipeline passed 272 tests, API passed 709 tests, and worker passed 745 tests with one intentional skip.
- Protected authority: exact base-interpreted rotation test passed with `package-lock.json` restored to SHA-256 `193181927b3e5813f43471c60c343c0300c6c71540a9b3921968a215cb57cd0d`.
- TypeScript: ops, database, agent, GitHub, pipeline, API, and worker package checks passed with no errors.
- Production build: optimized workspace build passed.
- General availability gate: complete `npm run ga:check` passed, including the product contract, closure structure, configuration, public claims, action pins, architecture, model binding, names, ADR numbering, third-state, evidence reachability, revert obligations, and final GA preflight.
- Diff integrity: `git diff --check` passed before the repair commit.
- Current base: `1ae5e9a2c331f35ffbd95ae8f2fd34ba6436c40c`.
- Current-base rerun: 318 of 318 focused integration tests, all six affected typechecks, 33 of 33 protected-authority tests, database 504 of 504, agent 364 of 364, GitHub 195 of 195, operations 180 of 180, pipeline 272 of 272, optimized 64-page production build, and diff integrity passed.

## User Setup Required

None for the engineering contract. Exact deployed-revision failure, recovery, rollback, and health observations remain release evidence, not missing code.

## Next Phase Readiness

Before ME-ENT-008 promotion, deploy the exact revision and capture live model and GitHub failure, degraded-state, authority-rotation, recovery, no-repeat, and rollback evidence.

## Self-Check: PASSED

- RED commit `a07ec7aa`, GREEN commit `08c4f304`, and this repair summary commit are present in the exact PR branch history.
- Every implementation and test file named by the repair exists at the recorded exact head.
- The implementation commits are ready for final current-main refresh, independent exact-head review, and protected push evidence.

---
*Phase: 01-release-authority-and-fettler-readiness*
*Plan: 08*
*Status: engineering complete, deployment proof pending*
