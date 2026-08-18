# FAILURES — MendPoint evaluation backlog

One entry per unresolved failure or coverage gap surfaced by the suite. Never silently discarded. Generated from the latest run; re-run the suite to refresh.

## FAIL-001 — fettler-edge-huge-monorepo (completes_within_budget)

- Scenario: fettler-edge-huge-monorepo
- Product: fettler
- Severity: P1
- Failure category: SCALE_FAILURE
- Observed behavior: analysis did not finish within the 120000ms budget on this repository
- Expected behavior: complete analysis within the budget
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-edge-huge-monorepo) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-002 — fettler-ts-payments-rename (precision)

- Scenario: fettler-ts-payments-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_POSITIVE
- Observed behavior: flagged non-expected files: test/meridianClient.test.ts
- Expected behavior: only expected/acceptable files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-ts-payments-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-003 — fettler-python-billing-rename (expected_findings_recall)

- Scenario: fettler-python-billing-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_NEGATIVE
- Observed behavior: flagged 8/11; missed: tests/fixtures/charge_request.json, tests/fixtures/charge_response.json, tests/fixtures/refund_response.json
- Expected behavior: all 11 expected files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-python-billing-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-004 — fettler-go-ledger-rename (expected_findings_recall)

- Scenario: fettler-go-ledger-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_NEGATIVE
- Observed behavior: flagged 12/17; missed: internal/payments/testdata/charge_request.json, internal/payments/testdata/charge_response.json, internal/ledger/testdata/entry.json, internal/settlement/testdata/settlement.json, internal/worker/testdata/items.json
- Expected behavior: all 17 expected files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-go-ledger-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-005 — fettler-java-settlement-rename (expected_findings_recall)

- Scenario: fettler-java-settlement-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_NEGATIVE
- Observed behavior: flagged 8/13; missed: src/main/java/com/acme/settlement/payments/PaymentsClient.java, src/main/java/com/acme/settlement/charge/Charge.java, src/test/resources/payment-request.json, src/test/resources/payment-response.json, src/test/resources/settlement-batch.json
- Expected behavior: all 13 expected files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-java-settlement-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-006 — fettler-java-settlement-rename (precision)

- Scenario: fettler-java-settlement-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_POSITIVE
- Observed behavior: flagged non-expected files: src/main/java/com/acme/settlement/reporting/RevenueReport.java
- Expected behavior: only expected/acceptable files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-java-settlement-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-007 — fettler-node-cjs-rename (expected_findings_recall)

- Scenario: fettler-node-cjs-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_NEGATIVE
- Observed behavior: flagged 1/7; missed: lib/chargeService.js, lib/refundService.js, lib/tasks/settlementTask.js, test/fixtures/charge.v1.json, test/fixtures/refund.v1.json, test/fixtures/settlement.batch.json
- Expected behavior: all 7 expected files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-node-cjs-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-008 — fettler-ts-monorepo-rename (expected_findings_recall)

- Scenario: fettler-ts-monorepo-rename
- Product: fettler
- Severity: P2
- Failure category: FALSE_NEGATIVE
- Observed behavior: flagged 5/8; missed: packages/payments/src/__fixtures__/charge.json, packages/payments/src/__fixtures__/refund.json, packages/payments/src/__fixtures__/settlementBatch.json
- Expected behavior: all 8 expected files
- Root cause: to be diagnosed (Phase 7); classify from the category above
- Proposed generalized fix: smallest generalizable root-cause fix in the subsystem named by the category
- Status: OPEN
- Regression test: this scenario (fettler-ts-monorepo-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-009 — regauge-runtime-upgrade (recipe_residual)

- Scenario: regauge-runtime-upgrade
- Product: regauge
- Severity: P1
- Failure category: COVERAGE_GAP
- Observed behavior: residual sites left un-migrated: docker/Dockerfile.ci
- Expected behavior: no residual (full migration)
- Root cause: capability not shipped for this migration family (coverage gap, not a defect)
- Proposed generalized fix: author/ship a general recipe for this family; keep abstention-by-absence until then
- Status: OPEN
- Regression test: this scenario (regauge-runtime-upgrade) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-010 — regauge-sdk-upgrade (family_coverage)

- Scenario: regauge-sdk-upgrade
- Product: regauge
- Severity: P1
- Failure category: COVERAGE_GAP
- Observed behavior: no shipped recipe covers this migration family
- Expected behavior: a recipe for family 'sdk-upgrade'
- Root cause: capability not shipped for this migration family (coverage gap, not a defect)
- Proposed generalized fix: author/ship a general recipe for this family; keep abstention-by-absence until then
- Status: OPEN
- Regression test: this scenario (regauge-sdk-upgrade) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-011 — regauge-framework-upgrade (family_coverage)

- Scenario: regauge-framework-upgrade
- Product: regauge
- Severity: P1
- Failure category: COVERAGE_GAP
- Observed behavior: no shipped recipe covers this migration family
- Expected behavior: a recipe for family 'framework-upgrade'
- Root cause: capability not shipped for this migration family (coverage gap, not a defect)
- Proposed generalized fix: author/ship a general recipe for this family; keep abstention-by-absence until then
- Status: OPEN
- Regression test: this scenario (regauge-framework-upgrade) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-012 — regauge-internal-api-rename (family_coverage)

- Scenario: regauge-internal-api-rename
- Product: regauge
- Severity: P1
- Failure category: COVERAGE_GAP
- Observed behavior: no shipped recipe covers this migration family
- Expected behavior: a recipe for family 'internal-api-rename'
- Root cause: capability not shipped for this migration family (coverage gap, not a defect)
- Proposed generalized fix: author/ship a general recipe for this family; keep abstention-by-absence until then
- Status: OPEN
- Regression test: this scenario (regauge-internal-api-rename) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-013 — regauge-partial-campaign (family_coverage)

- Scenario: regauge-partial-campaign
- Product: regauge
- Severity: P1
- Failure category: COVERAGE_GAP
- Observed behavior: no shipped recipe covers this migration family
- Expected behavior: a recipe for family 'sdk-upgrade'
- Root cause: capability not shipped for this migration family (coverage gap, not a defect)
- Proposed generalized fix: author/ship a general recipe for this family; keep abstention-by-absence until then
- Status: OPEN
- Regression test: this scenario (regauge-partial-campaign) becomes the permanent regression once fixed
- Owner: unassigned

## FAIL-014 — gen-regauge-runtime-unsupported-21-23 (family_coverage)

- Scenario: gen-regauge-runtime-unsupported-21-23
- Product: regauge
- Severity: P1
- Failure category: COVERAGE_GAP
- Observed behavior: no shipped recipe covers this migration family
- Expected behavior: a recipe for family 'runtime-upgrade'
- Root cause: capability not shipped for this migration family (coverage gap, not a defect)
- Proposed generalized fix: author/ship a general recipe for this family; keep abstention-by-absence until then
- Status: OPEN
- Regression test: this scenario (gen-regauge-runtime-unsupported-21-23) becomes the permanent regression once fixed
- Owner: unassigned

