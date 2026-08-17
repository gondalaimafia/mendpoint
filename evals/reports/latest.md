# MendPoint synthetic-repo evaluation — latest run

- Generated: 2026-08-15T04:14:55.140Z
- Git commit: `a5ddda8`
- Invocation: deterministic analysis core (Fettler: change-intel -> code-impact, LLM off; ReGauge: analyzeRecipe over shipped registry, analyze-only)

This corpus is built to make MendPoint fail, not to flatter it. "Pass" means the product did the SAFE, correct thing for the CURRENT shipped engine (found the impacted files without touching a distractor, or correctly abstained). Coverage gaps and dimensions the harness cannot yet observe are listed separately and do NOT count as passes.

## Overall

- Total scenarios: 21
- Passed (safe + correct for shipped engine): 13 (62%)
- Unsafe/incorrect failures: 9
- Coverage gaps recorded: 5
- P0 failures (dangerous / materially incorrect): 2

## Fettler

Scenarios: 15, passed 7 (47%)

### By repository family
| family | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| go-service | 1 | 0 | 0% |
| java-service | 1 | 0 | 0% |
| node-cjs-service | 1 | 0 | 0% |
| node-service-edge | 7 | 6 | 86% |
| python-service | 1 | 0 | 0% |
| typescript-monorepo | 2 | 1 | 50% |
| typescript-monorepo-scale | 1 | 0 | 0% |
| typescript-service | 1 | 0 | 0% |

### By difficulty
| difficulty | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| L3 | 7 | 1 | 14% |
| L4 | 6 | 5 | 83% |
| L5 | 2 | 1 | 50% |

### Per scenario (recall / precision / traps)
| scenario | L | behavior | recall | precision | traps hit | passed |
| --- | --- | --- | --- | --- | --- | --- |
| fettler-ts-payments-rename | 3 | flag_files | 100% | 83% | no | NO |
| fettler-python-billing-rename | 3 | flag_files | 18% | 100% | no | NO |
| fettler-go-ledger-rename | 3 | flag_files | 6% | 100% | no | NO |
| fettler-java-settlement-rename | 3 | flag_files | 8% | 100% | no | NO |
| fettler-node-cjs-rename | 3 | flag_files | 14% | 50% | YES | NO |
| fettler-ts-monorepo-rename | 3 | flag_files | 63% | 100% | no | NO |
| fettler-edge-already-migrated | 4 | no_op | (abstain) | - | no | yes |
| fettler-edge-ambiguous | 5 | abstain | (abstain) | - | no | yes |
| fettler-edge-binary-encoding | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-deep-indirection | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-generated-code | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-huge-monorepo | 5 | flag_files | CRASH | - | - | NO |
| fettler-edge-no-test-command | 3 | flag_files | 100% | 100% | no | yes |
| fettler-edge-pnpm-workspace | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-vendored-sdk | 4 | flag_files | 100% | 50% | YES | NO |

## ReGauge

Scenarios: 6, passed 6 (100%)

### By migration family
| family | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| framework-upgrade | 1 | 1 | 100% |
| internal-api-rename | 1 | 1 | 100% |
| runtime-upgrade | 1 | 1 | 100% |
| sdk-upgrade | 3 | 3 | 100% |

### Per scenario (engine decision)
| scenario | L | expected | matched recipes | passed | note |
| --- | --- | --- | --- | --- | --- |
| regauge-runtime-upgrade | 2 | apply_recipe | node-runtime-18-to-20@2(incomplete) | yes | coverage gap |
| regauge-sdk-upgrade | 4 | coverage_gap | none | yes | coverage gap |
| regauge-framework-upgrade | 4 | coverage_gap | none | yes | coverage gap |
| regauge-internal-api-rename | 5 | coverage_gap | none | yes | coverage gap |
| regauge-partial-campaign | 5 | coverage_gap | none | yes | coverage gap |
| regauge-should-abstain | 5 | abstain | none | yes |  |

## Model economics

Not measured in this slice. The deterministic analysis path the runner exercises makes no model calls (Fettler runs with `useLlm:false`; the ReGauge recipe engine is pure AST/regex/JSON transforms). Therefore model utilization, token use, cost per evaluation, and escalation rate are genuinely zero/null for these runs rather than fabricated. Measuring routing and cost requires exercising the optional LLM confirmation/repair path (Fettler) and the adaptive-repair loop (ReGauge), which is future work.

## Top remaining risks

- **[P0] FALSE_POSITIVE** — fettler-node-cjs-rename (false_positive_traps): flagged distractors: bin/server.js
- **[P0] FALSE_POSITIVE** — fettler-edge-vendored-sdk (false_positive_traps): flagged distractors: vendor/acmepay-sdk/index.js
- **[P1] SCALE_FAILURE** — fettler-edge-huge-monorepo (completes_within_budget): analysis did not finish within the 120000ms budget on this repository
- **[P2] FALSE_POSITIVE** — fettler-ts-payments-rename (precision): flagged non-expected files: test/meridianClient.test.ts
- **[P2] FALSE_NEGATIVE** — fettler-python-billing-rename (expected_findings_recall): flagged 2/11; missed: app/models/payment.py, app/models/charge.py, app/models/refund.py, app/services/charge_service.py, app/services/refund_service.py, app/tasks/settlement_task.py, tests/fixtures/charge_request.json, tests/fixtures/charge_response.json, tests/fixtures/refund_response.json
- **[P2] FALSE_NEGATIVE** — fettler-go-ledger-rename (expected_findings_recall): flagged 1/17; missed: internal/payments/types.go, internal/payments/client_test.go, internal/payments/testdata/charge_request.json, internal/payments/testdata/charge_response.json, internal/ledger/ledger.go, internal/ledger/entry.go, internal/ledger/ledger_test.go, internal/ledger/testdata/entry.json, internal/settlement/settlement.go, internal/settlement/batch.go, internal/settlement/settlement_test.go, internal/settlement/testdata/settlement.json, internal/worker/worker.go, internal/worker/worker_test.go, internal/worker/testdata/items.json, cmd/ledger/main.go
- **[P2] FALSE_NEGATIVE** — fettler-java-settlement-rename (expected_findings_recall): flagged 1/13; missed: src/main/java/com/acme/settlement/payments/PaymentRequest.java, src/main/java/com/acme/settlement/payments/PaymentsClient.java, src/main/java/com/acme/settlement/charge/ChargeService.java, src/main/java/com/acme/settlement/charge/Charge.java, src/main/java/com/acme/settlement/charge/ChargeController.java, src/main/java/com/acme/settlement/settlement/SettlementService.java, src/main/java/com/acme/settlement/settlement/SettlementLine.java, src/main/java/com/acme/settlement/settlement/SettlementController.java, src/main/java/com/acme/settlement/sweep/SettlementSweepJob.java, src/test/resources/payment-request.json, src/test/resources/payment-response.json, src/test/resources/settlement-batch.json
- **[P2] FALSE_NEGATIVE** — fettler-node-cjs-rename (expected_findings_recall): flagged 1/7; missed: lib/chargeService.js, lib/refundService.js, lib/tasks/settlementTask.js, test/fixtures/charge.v1.json, test/fixtures/refund.v1.json, test/fixtures/settlement.batch.json

## Coverage gaps (correct abstention today; capability not yet shipped)

- regauge-runtime-upgrade — residual sites left un-migrated: docker/Dockerfile.ci
- regauge-sdk-upgrade — no shipped recipe covers this migration family
- regauge-framework-upgrade — no shipped recipe covers this migration family
- regauge-internal-api-rename — no shipped recipe covers this migration family
- regauge-partial-campaign — no shipped recipe covers this migration family

## Unmeasured dimensions (harness limitations, recorded not fabricated)

- adaptive_repair token_cost / model_routing (LLM path not exercised)
- idempotency (apply-then-reapply not run)
- impact findings (analysis did not complete within budget)
- inverse/rollback (not run)
- migration_patch_correctness (generation path not exercised)
- pr_delivery (GitHub delivery not exercised)
- recipe_apply + verification_gate (analyze-only)
- token_cost / model_routing (LLM off; no model called)
- verification_honesty (sandbox/verification path not exercised)

## Design-partner readiness

**What we can accept today.** Fettler impact analysis on fettler-edge-deep-indirection: repositories where the change is an OpenAPI field rename in a supported language and the impacted sites are reachable through imports. ReGauge's one shipped, applicable family (Node runtime version bump) is safe to run where it matches.

**What we should NOT yet accept.** Repositories in languages where recall collapsed (python-service, go-service, java-service). Repositories that require any ReGauge migration family other than the Node runtime bump — SDK major upgrades, framework upgrades, and internal-API renames are coverage gaps today (the engine correctly abstains, but delivers no value). Any repository whose correct answer is a judgement call (ambiguous renames) unless a human is in the loop.

**What remains fragile.** 2 P0 issue(s) where the product acted when it should have abstained or touched a distractor — see Top remaining risks. Verification honesty, large-repo scale limits, and binary/encoding/symlink robustness are only partially observable through the analysis-only path and need the full generation+verification pipeline to grade end to end.

