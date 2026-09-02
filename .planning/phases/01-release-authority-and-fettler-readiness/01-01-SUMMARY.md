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
  tokens: 24071
  tasks: 3
  commits: 20

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
        ref: packages/eval/src/performance-contract.test.ts and performance-runner.test.ts, 22 tests
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
        ref: packages/platform/src/mcu.test.ts, 10 tests
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
- Exported the performance and migration compute authorities and exercised them from the protected general availability preflight without changing protected package authority bytes.

## Task Commits

1. **Performance contract TDD:** `d98f8f60`, `e7cb2f16`, `ebf25381`, `3c377389`, `08bfa9cd`
2. **Migration compute TDD:** `b9065e1b`, `5b8616a7`, `fcc4bd70`, `d9f63901`, `fde7f1dc`
3. **Closure artifact and protected release gate:** `6a779242`, `44216697`, `049e5490`, `00d74874`
4. **Exact-head performance review repair:** `89192456`, `b2a16f55`

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

---

**Total deviations:** 3 auto-fixed, one bug and two missing correctness seams.
**Impact on plan:** All changes are limited to the operating-contract producer, authority, public exports, and protected gate needed to close the six review findings.

## Issues Encountered

- The full workspace package and application suites passed. The root scripts run reported an existing Windows timing failure in `build-public-docs.test.ts` and Vitest worker update timeouts in the long proposal-authority suite. After the protected-package fix, all 36 proposal and closure assertions pass; the remaining worker remote procedure call timeout is test-harness timing rather than an assertion failure.

## Verification

- Focused hostile matrix: 35 of 35 passed.
- Migration compute plus closure rerun: 13 of 13 passed.
- Proposal authority functional assertions: 36 of 36 passed.
- Full workspace typecheck: passed.
- Optimized production build: passed, 64 pages generated.
- Protected `npm run ga:check`: passed.
- Strict evidence reachability: passed; migration compute runtime is reachable.
- `git diff --check`: passed.
- Current base: `origin/main` at `92e6f4268de54e6ce9ef53f2556a140063951b36`.

## TDD Gate Compliance

- RED and GREEN commits exist for the performance, migration compute, protected gate, and live reachability repairs.

## Known Stubs

None.

## User Setup Required

None.

## Next Phase Readiness

- Plan 01-02 can consume canonical tier limits, evidence digests, and migration compute schedule bindings.
- Production measurements remain honestly `not_observed`; live evidence belongs to the authorized performance and billing proof lanes.

## Self-Check: PASSED

- All 14 changed implementation, test, export, gate, and artifact files exist.
- All 20 task commits are present on `codex/601-fettler-operating-contracts` after this repair commit.
- The exact head is based on current `origin/main`, with no uncommitted implementation changes.

---
*Phase: 01-release-authority-and-fettler-readiness*
*Completed: 2026-09-01*
