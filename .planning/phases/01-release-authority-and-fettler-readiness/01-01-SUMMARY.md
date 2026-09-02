---
phase: 01-release-authority-and-fettler-readiness
plan: 01
subsystem: release-authority
tags: [fettler, performance, mcu, evidence, ga]

requires:
  - phase: 00-fettler-production-planning
    provides: canonical 68-requirement Fettler milestone and operating-contract acceptance criteria
provides:
  - canonical small, medium, and large Fettler performance tiers with fail-closed evidence evaluation
  - tamper-evident migration compute reservation, settlement, adjustment, credit, and invoice reconciliation
  - deterministic Fettler closure artifact enforced by the protected general availability preflight
affects: [01-02-readiness, 05-economics, 06-final-qualification]

actuals:
  tokens: 25292
  tasks: 3
  commits: 40

tech-stack:
  added: []
  patterns: [digest-bound contracts, fail-closed evidence identity, hash-chained ledger, protected preflight self-check]

key-files:
  created:
    - docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json
    - packages/platform/src/mcu.ts
    - scripts/fettler-production-closure.ts
  modified:
    - packages/eval/src/performance-contract.ts
    - packages/eval/src/performance-runner.ts
    - packages/eval/src/index.ts
    - packages/platform/src/index.ts
    - scripts/ga-check.ts

key-decisions:
  - "Canonical output uses small, medium, and large while documented pilot tier identifiers remain input-only compatibility aliases."
  - "Performance evidence is valid only when exact tenant, repository, deployment, fixture, source, correlation, measured concurrency, repository shape, and nonzero run interval bindings agree."
  - "Every observation must be fresh and carry a runtime-validated boolean outcome; reports publish immutably and authenticated probes never follow redirects or use plaintext transport."
  - "Observation freshness is evaluated against the authenticated run window plus the metric freshness allowance, and a fixed evidence budget makes high-throughput overflow explicitly incomplete."
  - "Credits and every negative economic correction require independently verified finance authority bound to tenant, invoice, actor, amount, reason, entry time, approval time, and immutable digest."
  - "Performance runs enforce the declared maximum file size and a one-megabyte response ceiling at the producer boundary while retaining explicit incomplete abort reasons."
  - "The existing protected ga-check executable invokes closure validation so package authority bytes and rotation digests remain unchanged."

patterns-established:
  - "Authority contracts publish canonical definitions separately from measured production evidence."
  - "Ledger entries derive deterministic identifiers and hashes from complete schedule, identity, actor, reason, time, and predecessor bindings."

requirements-completed: [ME-FND-006, ME-FND-007, ME-FND-008]

coverage:
  - id: D1
    description: Canonical tier-specific performance contract and bound evidence evaluator
    requirement: ME-FND-006
    verification:
      - kind: unit
        ref: packages/eval/src/performance-contract.test.ts and performance-runner.test.ts, 41 tests
        status: pass
    human_judgment: false
  - id: D2
    description: Versioned metric dictionary with load-bearing event-source validation and protected closure reachability
    requirement: ME-FND-007
    verification:
      - kind: unit
        ref: packages/eval/src/performance-contract.test.ts, including hostile event-source mismatch coverage
        status: pass
      - kind: integration
        ref: scripts/fettler-production-closure.test.ts plus npm run ga:check
        status: pass
    human_judgment: false
  - id: D3
    description: Reproducible migration compute reservation and settlement lifecycle
    requirement: ME-FND-008
    verification:
      - kind: unit
        ref: packages/platform/src/mcu.test.ts, 20 tests
        status: pass
    human_judgment: false

duration: 3h 20m
completed: 2026-09-01
status: complete
---

# Phase 01 Plan 01: Fettler Operating Contracts Summary

**Canonical performance tiers, exact-bound measurement evidence, a hash-chained migration compute ledger, and a protected reproducible closure gate**

## Performance

- **Duration:** 3 hours 20 minutes including two current-base rebases and full repository verification
- **Started:** 2026-09-01T19:13:00-05:00
- **Completed:** 2026-09-01T22:33:00-05:00
- **Tasks:** 3
- **Files modified:** 14

## Accomplishments

- Replaced contradictory pilot-sized thresholds with canonical small, medium, and large Fettler tiers, tier-specific objectives, and documented compatibility input aliases.
- Made performance proof fail closed unless producer-observed repository shape, representative tier floors and language distribution, measured concurrency, run interval, metric event source, and all exact execution identities are present and consistent.
- Retained same-tick pre-observation probe failures as nonzero failed samples while preventing them from qualifying a report.
- Prevented settlement beyond released reservation and retained a contiguous, deterministic, tamper-evident ledger through invoice entry identifiers.
- Made the existing append-only `usage_ledger_entries` path the sole production storage authority; the protected closure check now exercises the same reservation, settlement, reconciliation, and invoice data used by the API and invoice export.
- Exported the performance and migration compute authorities and exercised them from the protected general availability preflight without changing protected package authority bytes.

## Task Commits

1. **Performance contract TDD:** `d98f8f60`, `e7cb2f16`, `ebf25381`, `3c377389`, `08bfa9cd`
2. **Migration compute TDD:** `b9065e1b`, `5b8616a7`, `fcc4bd70`, `d9f63901`, `fde7f1dc`
3. **Closure artifact and protected release gate:** `6a779242`, `44216697`, `049e5490`, `00d74874`
4. **Exact-head performance review repair:** `89192456`, `b2a16f55`
5. **Adversarial evidence-boundary repair:** `30ca1a5d`, `7c4f5280`
6. **Long-run availability and evidence-budget repair:** `288d9bc6`, `7049be3a`, `880bb666`
7. **Finance authority, producer limits, and bounded response repair:** `d74df5ae`, `e60f3a90`, `701757be`
8. **Destination and approval replay repair:** `489489c6`, `9274799e`
9. **Live ledger authority repair:** `de16cca7`, `338b308b`

## Files Created or Modified

- `packages/eval/src/performance-contract.ts` and tests: canonical tiers, metric objectives, evidence bindings, and evaluation.
- `packages/eval/src/performance-runner.ts` and tests: measured peak concurrency, repository shape, exact identity propagation, and compatibility tier parsing.
- `packages/platform/src/mcu.ts` and tests: immutable schedule, deterministic entry chain, settlement bounds, reconciliation, and invoice mappings.
- `packages/eval/src/index.ts` and `packages/platform/src/index.ts`: public authority exports.
- `scripts/fettler-production-closure.ts` and tests: byte-reproducible closure artifact and deterministic migration compute self-check.
- `scripts/ga-check.ts`: protected preflight invocation.
- `docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json`: generated authority bytes without a production-observation claim.

## Decisions Made

- Legacy `pilot-small`, `pilot-medium`, and `pilot-large` identifiers are accepted only at the input boundary and always normalize to canonical Fettler tier identifiers.
- A declared revision string is not performance evidence. The evaluator requires the producer to return every execution identity and measured repository shape, while the runner measures concurrency and run duration.
- Metric dictionary event sources and probe implementation sources are separate, validated authorities.
- The migration compute smoke lifecycle is deterministic and synthetic. It proves the authority is executable but deliberately leaves production evidence as `not_observed`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Bound the performance runner, not only the contract evaluator**
- **Found during:** Exact-head review repair
- **Issue:** A correct evaluator remained bypassable if its sole runner emitted unbound or declared-only evidence.
- **Fix:** Added exact identity, measured concurrency, measured repository shape, and legacy tier normalization at the producer.
- **Files modified:** `packages/eval/src/performance-runner.ts`, `packages/eval/src/performance-runner.test.ts`
- **Verification:** Performance contract and runner test matrix passes 16 of 16.
- **Committed in:** `08bfa9cd`

**2. [Rule 1 - Bug] Preserved proposal authority while connecting the closure gate**
- **Found during:** Full repository tests
- **Issue:** Editing the protected package general availability command invalidated proposal authority digests and rotation tests.
- **Fix:** Restored package bytes and invoked closure validation from the already-protected `scripts/ga-check.ts` executable.
- **Files modified:** `scripts/ga-check.ts`, `scripts/fettler-production-closure.test.ts`
- **Verification:** Proposal authority assertions pass 36 of 36, focused closure tests pass, and `npm run ga:check` passes.
- **Committed in:** `049e5490`, `00d74874`

**3. [Rule 2 - Missing Critical] Added a non-test MCU lifecycle caller**
- **Found during:** Evidence reachability verification
- **Issue:** Public exports alone did not prove the reservation and settlement authorities had a production entry path.
- **Fix:** The protected closure gate now creates and reconciles a deterministic bounded lifecycle and records only its self-check identity.
- **Files modified:** `scripts/fettler-production-closure.ts`, `docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json`
- **Verification:** Strict evidence reachability passes and no longer reports the migration compute authorities as dead.
- **Committed in:** `d9f63901`, `fde7f1dc`

**4. [Rule 1 - Bug] Closed four exact-head performance evidence vulnerabilities**
- **Found during:** Independent exact-head review at `dcc854b33704411789fe3ced8cb86da0c4860242`
- **Issue:** One fresh sample could launder stale samples, malformed success values used JavaScript truthiness, report publication replaced earlier evidence, and authenticated probes could use plaintext transport or follow redirects.
- **Fix:** Validate every sample's freshness and boolean outcome, publish reports with exclusive immutable linking plus byte-identical replay, require secure authenticated endpoints, reject embedded credentials, and disable redirects.
- **Files modified:** `packages/eval/src/performance-contract.ts`, `packages/eval/src/performance-contract.test.ts`, `packages/eval/src/performance-runner.ts`, `packages/eval/src/performance-runner.test.ts`
- **Verification:** All ten hostile tests failed before implementation; the repaired evaluator suite passes 33 of 33 and the broader focused matrix passes 46 of 46.
- **Committed in:** `30ca1a5d`, `7c4f5280`

**5. [Rule 1 - Bug] Made canonical long runs executable without unbounded evidence growth**
- **Found during:** Independent complete-chain review after the first adversarial repair
- **Issue:** Fixed five-minute freshness rejected valid early observations in medium and large load runs and every canonical soak, while a fast target could retain observations without a memory or publication bound for up to four hours.
- **Fix:** Evaluate every observation against the authenticated run duration plus its metric freshness allowance, retain the pre-run and cross-run guards, and stop at a fixed 10,000-observation budget with an explicit incomplete `evidence_budget_exceeded` outcome.
- **Files modified:** `packages/eval/src/performance-contract.ts`, `packages/eval/src/performance-contract.test.ts`, `packages/eval/src/performance-runner.ts`, `packages/eval/src/performance-runner.test.ts`
- **Verification:** Four canonical medium and large load and soak regressions plus one high-throughput overflow regression failed before implementation; the repaired evaluator suite passes 38 of 38 and the broader focused matrix passes 51 of 51.
- **Committed in:** `288d9bc6`, `7049be3a`, `880bb666`

**6. [Rule 1 and Rule 2 - Bug and Missing Critical] Closed five exact-head finance and performance-runner authority gaps**
- **Found during:** Independent exact-head review of pull request 610 at `55614d0413cde759b04ee5a58aa6b004707d6546`
- **Issue:** Negative adjustments could reduce consumption without credit classification or finance authority; declared maximum file bytes were neither enforced nor retained; probe responses were buffered without a byte ceiling; internal abort reasons collapsed into null; and operator documentation did not disclose the 10,000-observation incomplete boundary.
- **Fix:** Require verified digest-bound finance authority for credits and adjustments, prohibit negative adjustments, enforce and retain the declared maximum file size, stream and cap response bodies at 1,048,576 bytes before parsing, retain explicit abort reasons, and document the exact observation and invocation ceilings.
- **Files modified:** `packages/platform/src/mcu.ts`, `packages/platform/src/mcu.test.ts`, `packages/platform/src/index.ts`, `packages/eval/src/performance-contract.ts`, `packages/eval/src/performance-contract.test.ts`, `packages/eval/src/performance-runner.ts`, `packages/eval/src/performance-runner.test.ts`, `packages/eval/src/index.ts`, `docs/PERFORMANCE_CONTRACT.md`
- **Verification:** The hostile RED suite exposed every gap. The repaired focused matrix passes 64 of 64, full workspace typecheck and optimized build pass, the protected general availability checks pass, the 19-test revert suite passes serially with a 30-second per-test allowance, and diff integrity passes.
- **Committed in:** `d74df5ae`, `e60f3a90`, `701757be`

**7. [Rule 1 - Bug] Closed embedded-address and finance-approval replay paths**
- **Found during:** Independent exact-head review of pull request 610 at `c469ffa1d70e526eacb70e6270754fdb5992a492`
- **Issue:** IPv4-compatible and translation-prefix IPv6 spellings could reach a credentialed pinned request, and one finance approval could authorize two distinct credit entries.
- **Fix:** Reject embedded IPv4 destinations before credential attachment, bind finance approval to the exact entry idempotency key and entry facts, and enforce one-time approval and authorization-digest consumption across reconciliation.
- **Files modified:** `packages/eval/src/performance-runner.ts`, `packages/eval/src/performance-runner.test.ts`, `packages/platform/src/mcu.ts`, `packages/platform/src/mcu.test.ts`
- **Verification:** The evaluator matrix passes 48 of 48 and the migration-compute matrix passes 22 of 22.
- **Committed in:** `489489c6`, `9274799e`

**8. [Rule 2 - Missing Critical] Removed the duplicate production MCU ledger authority**
- **Found during:** Independent exact-head review of pull request 610 at `c469ffa1d70e526eacb70e6270754fdb5992a492`
- **Issue:** The protected closure check exercised an in-memory lifecycle while the API, invoice export, and gross-margin paths used the append-only database ledger, leaving two selectable authorities for the same economic events.
- **Fix:** Run the protected closure self-check through `createDb`, `reserveUsage`, `settleUsageReservation`, `reconcileUsageLedger`, and `listUsageLedger`; publish the durable table and ledger-head identity; and remove the in-memory lifecycle from the public platform barrel.
- **Files modified:** `scripts/fettler-production-closure.ts`, `scripts/fettler-production-closure.test.ts`, `packages/platform/src/index.ts`, `packages/platform/src/mcu.ts`, `docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json`
- **Verification:** The RED test proved the synthetic lifecycle was still selected. The repaired closure suite passes 3 of 3, the complete platform suite passes 271 of 271, and platform, database, and scripts typechecks pass.
- **Committed in:** `de16cca7`, `338b308b`

**9. [Rule 1 and Rule 2 - Bug and Missing Critical] Bound performance and finance evidence to durable authority**
- **Found during:** Independent exact-head review of pull request 610 at `8f8b5dd5a7471859105525447403659646998534`
- **Issue:** A replayed producer response could satisfy a later performance run without proving which invocation emitted it; the durable usage ledger accepted adjustment and credit mutations without the public schedule authority; invoice-local allocation and sign invariants were incomplete; and the protected closure self-check never exercised a finance-authorized mutation.
- **Fix:** Bind every producer observation to a fresh invocation identifier, nonce, sequence, timestamp, and event source; remove the caller-asserted schedule helper from the public Platform surface; require a live tenant owner to issue a short-lived, digest-bound, single-use finance authorization; persist its identifier and digest in the usage-entry hash, consume it atomically with the exact invoice-local adjustment or credit, and revalidate the complete authorization during reconciliation; reject inactive owners and actors at consumption; and run the closure self-check through reserve, settle, authorized credit, and reconciliation.
- **Files modified:** `packages/eval/src/performance-contract.ts`, `packages/eval/src/performance-runner.ts`, `packages/eval/src/performance-runner.test.ts`, `packages/platform/src/index.ts`, `packages/db/src/index.ts`, `packages/db/src/usage.ts`, `packages/db/src/usage.test.ts`, `packages/db/src/invoice-export.test.ts`, `packages/db/src/gross-margin.test.ts`, `apps/api/src/server.ts`, `scripts/fettler-production-closure.ts`, `scripts/fettler-production-closure.test.ts`, `docs/FETTLER_PRODUCTION_REQUIREMENT_CLOSURE.json`
- **Verification:** The focused finance and upgrade matrix passes 21 of 21; the complete database suite passes 492 of 492; the earlier complete workspace and root test runner exited successfully with 633 root-script tests; full workspace typecheck passed and the final database and API typechecks pass; the optimized production build generated 64 routes; protected GA preflight passed; the final closure suite passes 3 of 3; and diff integrity passes.
- **Committed in:** `e94acec8`, `f947166e`, `475dbebd`, `aecc9eda`, `4b75196f`, `ed68a592`, `d9ffaaab`, `cf9a2c14`, `0d7deb30`

---

**Total deviations:** 9 auto-fixed across nine repair rounds.
**Impact on plan:** All changes are limited to the operating-contract producer, authority, public exports, operator contract, and protected gate needed to close the review findings.

## Issues Encountered

- The full workspace package and application suites passed. The root scripts run reported an existing Windows timing failure in `build-public-docs.test.ts` and Vitest worker update timeouts in the long proposal-authority suite. After the protected-package fix, all 36 proposal and closure assertions pass; the remaining worker remote procedure call timeout is test-harness timing rather than an assertion failure.
- An earlier standard five-second revert-obligation run timed out in six Windows synthetic-repository cases while its assertions and current-tree checks remained sound. After the final current-main rebase, the unchanged standard protected command passed all 19 tests, the direct revert checker, and the general availability preflight without a timeout override.

## Verification

- Focused hostile matrix: 36 of 36 passed.
- Migration compute plus closure rerun: 13 of 13 passed.
- Proposal authority functional assertions: 36 of 36 passed.
- Full workspace typecheck: passed.
- Optimized production build: passed, 64 pages generated.
- Protected `npm run ga:check`: passed.
- Strict evidence reachability: passed; migration compute runtime is reachable.
- `git diff --check`: passed.
- Current base: `origin/main` at `e1d5b7483c057578c9cc8c8b795cfa633f53878f`.
- Release-update tested implementation head: `c27fe751b06796d394579d999537fafb8998d55e`.
- Release-update evaluator matrix: 23 of 23 passed; migration compute and closure matrix: 13 of 13 passed, for 36 of 36 focused tests.
- Release-update affected typechecks: evaluator, platform, and scripts passed.
- Release-update optimized production build: passed, 64 pages generated.
- Release-update protected `npm run ga:check`: passed on the current base.
- Release-update diff integrity: passed across the exact 14 plan-owned files.
- Final adversarial repair RED proof: 10 expected failures covering mixed stale and fresh observations, malformed outcome types, report replacement, plaintext authenticated endpoints, embedded credentials, and redirect behavior.
- Final adversarial repair GREEN proof: evaluator 33 of 33; evaluator, migration compute, and closure matrix 46 of 46; evaluator, platform, and scripts typechecks passed.
- Final adversarial repair optimized production build: passed, 64 pages generated.
- Final adversarial repair protected `npm run ga:check`: passed, including strict evidence reachability and revert obligations.
- Long-run repair RED proof: four canonical full-window load and soak cases failed as stale and the high-throughput run reached the external test guard instead of an internal evidence bound.
- Long-run repair GREEN proof: evaluator 38 of 38; evaluator, migration compute, and closure matrix 51 of 51; evaluator, platform, and scripts typechecks passed.
- Long-run repair optimized production build: passed, 64 pages generated.
- Long-run repair protected `npm run ga:check`: passed, including strict evidence reachability and revert obligations.
- Current-base range diff: all 30 pre-refresh patches are patch-identical after rebasing from `f8d09056f713925baf585d99fc35aca79242108c` to `e1d5b7483c057578c9cc8c8b795cfa633f53878f`.
- Current-base rerun: focused and broader matrix 51 of 51, all three affected typechecks, optimized 64-page build, protected `npm run ga:check`, and diff integrity passed.
- Pull request 610 repair RED proof: hostile regressions exposed untrusted credits and negative adjustments, every finance-binding drift, ignored maximum file size, unbounded fixed and chunked response bodies, missing cancellation, collapsed abort reasons, and incomplete operator guidance.
- Pull request 610 repair GREEN proof: migration compute 20 of 20, evaluator contract and runner 41 of 41, and closure 3 of 3, for 64 of 64 focused tests.
- Pull request 610 repair full workspace typecheck: passed for all packages, applications, and scripts.
- Pull request 610 repair optimized production build: passed, 64 pages generated.
- Pull request 610 repair protected general availability checks: specification, closure, configuration, claims, actions, architecture, model, naming, architecture decision record, third-state, strict evidence reachability, the standard 19-test revert-obligation command, and general availability preflight passed.
- Pull request 610 final authority repair: the complete database suite passes 492 of 492 and the closure suite passes 3 of 3 on implementation head `0d7deb30`; the preceding complete workspace and root test runner, full workspace typecheck, optimized 64-route production build, and protected general availability command all exited 0 before the additive reconciliation seam, whose affected tests and typechecks were rerun.
- Pull request 610 repair current base: `origin/main` at `c246b777bf71d377126bbe33a16cda2160d51ef9`.
- Pull request 610 tested implementation head: `701757be`; the returned exact head adds summary-only evidence updates.

## TDD Gate Compliance

- RED and GREEN commits exist for the performance, migration compute, protected gate, live reachability, finance authority, producer limit, bounded response, abort-reason, and operator-contract repairs.

## Known Stubs

None.

## User Setup Required

None.

## Next Phase Readiness

- Plan 01-02 can consume canonical tier limits, evidence digests, and migration compute schedule bindings.
- Production measurements remain honestly `not_observed`; live evidence belongs to the authorized performance and billing proof lanes.

## Self-Check: PASSED

- All 14 changed implementation, test, export, gate, and artifact files exist.
- All 34 rebased implementation, test, and prior evidence commits are present on `agent-610-review-repair`; this repair adds two summary-only successors rather than amending history.
- The tested implementation head is based on current `origin/main`; the returned release-update head is its summary-only successor.

---
*Phase: 01-release-authority-and-fettler-readiness*
*Completed: 2026-09-01*
