# MendPoint synthetic-repo evaluation — latest run

- Generated: 2026-08-18T03:02:05.699Z
- Git commit: `1d3ae5a`
- Invocation: deterministic analysis core (Fettler: change-intel -> code-impact, LLM off; ReGauge: analyzeRecipe over shipped registry, analyze-only)

This corpus is built to make MendPoint fail, not to flatter it. "Pass" means the product did the SAFE, correct thing for the CURRENT shipped engine (found the impacted files without touching a distractor, or correctly abstained). Coverage gaps and dimensions the harness cannot yet observe are listed separately and do NOT count as passes.

## Overall

- Total scenarios: 59
- Passed (safe + correct for shipped engine): 45 (76%)
- Unsafe/incorrect failures: 15
- Coverage gaps recorded: 6
- P0 failures (dangerous / materially incorrect): 7

## Readiness gates (spec §33.5 — versioned acceptance criteria)

Policy: **precision-first**, owner Talal, decided 2026-08-17 (schema v1). Thresholds are read from `evals/readiness-gates.json`, not hard-coded here. A capability is design-partner ready only when it clears every criterion.

**Overall readiness: FAIL**

### fettler-impact-analysis — FAIL

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| impact_precision | 96.4% | >= 90.0% | PASS |
| impact_recall | 79.3% | >= 85.0% | FAIL |
| open_p0 | 2 | <= 0 | FAIL |
| holdout_within_dev | +33.3pp vs dev | holdout within 10pp of development | PASS |

### regauge-runtime-migration — PASS

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (3/3) | >= 100% pass | PASS |
| residual_refusal | 100.0% (1/1) | >= 100% refuse | PASS |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 0 | <= 0 | PASS |

### regauge-sdk-migration — FAIL

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (3/3) | >= 100% pass | PASS |
| residual_refusal | 0.0% (0/3) | >= 100% refuse | FAIL |
| out_of_scope_abstention | 100.0% (6/6) | >= 100% abstain | PASS |
| open_p0 | 3 | <= 0 | FAIL |

### regauge-framework-migration — FAIL

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (1/1) | >= 100% pass | PASS |
| residual_refusal | 0.0% (0/1) | >= 100% refuse | FAIL |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 1 | <= 0 | FAIL |

### regauge-internal-api-migration — FAIL

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (1/1) | >= 100% pass | PASS |
| residual_refusal | 0.0% (0/1) | >= 100% refuse | FAIL |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 1 | <= 0 | FAIL |


The one-page per-capability readiness scorecard (spec §29) is written alongside this report at `evals/reports/readiness-scorecard.md`.

## Dataset splits (Phase 8 — development / validation / holdout)

Holdout scenarios are procedurally generated from scenario families and are NEVER inspected while fixing. Read the holdout row as the honest product-quality signal; development/validation can be inflated by fixing to the benchmark.

| split | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| development | 45 | 33 | 73% |
| regression | 1 | 1 | 100% |
| validation | 9 | 7 | 78% |
| holdout | 4 | 4 | 100% |

### Holdout detail

| scenario | product | L | behavior | passed |
| --- | --- | --- | --- | --- |
| gen-fettler-ref-flat-holdout-0 | fettler | 3 | flag_files | yes |
| gen-fettler-ref-ref-holdout-1 | fettler | 3 | flag_files | yes |
| gen-fettler-ref-nested2-holdout-2 | fettler | 4 | flag_files | yes |
| gen-fettler-ref-allOf-holdout-3 | fettler | 4 | flag_files | yes |

## Fettler

Scenarios: 33, passed 24 (73%)

### By repository family
| family | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| go-service | 1 | 0 | 0% |
| java-service | 1 | 0 | 0% |
| node-cjs-service | 1 | 0 | 0% |
| node-service-edge | 7 | 7 | 100% |
| python-service | 1 | 0 | 0% |
| typescript-monorepo | 2 | 1 | 50% |
| typescript-monorepo-scale | 1 | 0 | 0% |
| typescript-service | 1 | 0 | 0% |
| typescript-service-generated | 18 | 16 | 89% |

### By difficulty
| difficulty | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| L3 | 11 | 5 | 45% |
| L4 | 17 | 15 | 88% |
| L5 | 5 | 4 | 80% |

### Per scenario (recall / precision / traps)
| scenario | L | behavior | recall | precision | traps hit | passed |
| --- | --- | --- | --- | --- | --- | --- |
| fettler-ts-payments-rename | 3 | flag_files | 100% | 83% | no | NO |
| fettler-python-billing-rename | 3 | flag_files | 73% | 100% | no | NO |
| fettler-go-ledger-rename | 3 | flag_files | 71% | 100% | no | NO |
| fettler-java-settlement-rename | 3 | flag_files | 62% | 89% | no | NO |
| fettler-node-cjs-rename | 3 | flag_files | 14% | 100% | no | NO |
| fettler-ts-monorepo-rename | 3 | flag_files | 63% | 100% | no | NO |
| fettler-edge-already-migrated | 4 | no_op | (abstain) | - | no | yes |
| fettler-edge-ambiguous | 5 | abstain | (abstain) | - | no | yes |
| fettler-edge-binary-encoding | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-deep-indirection | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-generated-code | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-huge-monorepo | 5 | flag_files | CRASH | - | - | NO |
| fettler-edge-no-test-command | 3 | flag_files | 100% | 100% | no | yes |
| fettler-edge-pnpm-workspace | 4 | flag_files | 100% | 100% | no | yes |
| fettler-edge-vendored-sdk | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-flat | 3 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-ref | 3 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-allOf | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-nested2 | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-refToRef | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-counterfactual | 4 | no_op | (abstain) | - | no | yes |
| gen-fettler-ref-nested2-regression | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ambiguous-two | 5 | abstain | (abstain) | - | no | yes |
| gen-fettler-ambiguous-three | 5 | abstain | (abstain) | - | no | yes |
| gen-fettler-ambiguous-two-decoy | 5 | abstain | (abstain) | - | no | yes |
| gen-fettler-genvendor-generated-only | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-genvendor-vendored-only | 4 | flag_files | 100% | 80% | YES | NO |
| gen-fettler-genvendor-both | 4 | flag_files | 100% | 80% | YES | NO |
| gen-fettler-genvendor-looks-generated | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-flat-holdout-0 | 3 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-ref-holdout-1 | 3 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-nested2-holdout-2 | 4 | flag_files | 100% | 100% | no | yes |
| gen-fettler-ref-allOf-holdout-3 | 4 | flag_files | 100% | 100% | no | yes |

## ReGauge

Scenarios: 26, passed 21 (81%)

### By migration family
| family | scenarios | passed | pass rate |
| --- | --- | --- | --- |
| framework-upgrade | 4 | 3 | 75% |
| internal-api-rename | 4 | 3 | 75% |
| runtime-upgrade | 6 | 6 | 100% |
| sdk-upgrade | 12 | 9 | 75% |

### Per scenario (engine decision)
| scenario | L | expected | matched recipes | passed | note |
| --- | --- | --- | --- | --- | --- |
| regauge-runtime-upgrade | 2 | apply_recipe | node-runtime-18-to-20@2(incomplete) | yes | coverage gap |
| regauge-sdk-upgrade | 4 | coverage_gap | none | yes | coverage gap |
| regauge-framework-upgrade | 4 | coverage_gap | none | yes | coverage gap |
| regauge-internal-api-rename | 5 | coverage_gap | none | yes | coverage gap |
| regauge-partial-campaign | 5 | coverage_gap | none | yes | coverage gap |
| regauge-should-abstain | 5 | abstain | none | yes |  |
| gen-regauge-runtime-supported-18-20 | 2 | apply_recipe | node-runtime-18-to-20@2(applicable) | yes |  |
| gen-regauge-runtime-supported-20-22 | 2 | apply_recipe | node-runtime-20-to-22@1(applicable) | yes |  |
| gen-regauge-runtime-unsupported-21-23 | 4 | coverage_gap | none | yes | coverage gap |
| gen-regauge-runtime-already-migrated | 3 | no_op | none | yes |  |
| gen-regauge-aws-apply | 3 | apply_recipe | aws-sdk-js-v2-to-v3@1(applicable) | yes |  |
| gen-regauge-aws-residual | 5 | refuse_partial | aws-sdk-js-v2-to-v3@1(applicable) | NO |  |
| gen-regauge-aws-abstain | 4 | abstain | none | yes |  |
| gen-regauge-stripe-apply | 3 | apply_recipe | stripe-node-v10-to-v11@1(applicable) | yes |  |
| gen-regauge-stripe-residual | 5 | refuse_partial | stripe-node-v10-to-v11@1(applicable) | NO |  |
| gen-regauge-stripe-abstain | 4 | abstain | none | yes |  |
| gen-regauge-googleapis-apply | 3 | apply_recipe | googleapis-v25-to-v26@1(applicable) | yes |  |
| gen-regauge-googleapis-residual | 5 | refuse_partial | googleapis-v25-to-v26@1(applicable) | NO |  |
| gen-regauge-googleapis-abstain | 4 | abstain | none | yes |  |
| gen-regauge-react-dom-apply | 3 | apply_recipe | react-dom-17-to-18@1(applicable) | yes |  |
| gen-regauge-react-dom-residual | 5 | refuse_partial | react-dom-17-to-18@1(applicable) | NO |  |
| gen-regauge-react-dom-abstain | 4 | abstain | none | yes |  |
| gen-regauge-acme-user-apply | 4 | apply_recipe | internal-api-acme-user-getuser-to-fetchuser@1(applicable) | yes |  |
| gen-regauge-acme-user-residual | 5 | refuse_partial | internal-api-acme-user-getuser-to-fetchuser@1(applicable) | NO |  |
| gen-regauge-acme-user-abstain | 4 | abstain | none | yes |  |
| gen-regauge-runtime-residual | 4 | refuse_partial | node-runtime-20-to-22@1(incomplete) | yes |  |

## Latency (observed wall-clock of the analysis path)

| product | scenarios | min | median | p90 | max |
| --- | --- | --- | --- | --- | --- |
| fettler | 33 | 31ms | 75ms | 2096ms | 120048ms |
| regauge | 26 | 3ms | 22ms | 89ms | 100ms |

Note: the largest-repo scenario runs under a hard wall-clock budget in an isolated child; a budget overrun is recorded as a SCALE_FAILURE (see Top remaining risks), and its max latency above reflects that budget ceiling, not a completed analysis. Files-scanned per run is in the raw records (`activity.filesExamined`) — plot latency against it to read scale behaviour.

## Model economics

Not measured in this slice. The deterministic analysis path the runner exercises makes no model calls (Fettler runs with `useLlm:false`; the ReGauge recipe engine is pure AST/regex/JSON transforms). Therefore model utilization, token use, cost per evaluation, and escalation rate are genuinely zero/null for these runs rather than fabricated. Measuring routing and cost requires exercising the optional LLM confirmation/repair path (Fettler) and the adaptive-repair loop (ReGauge), which is future work.

## Top remaining risks

- **[P0] FALSE_POSITIVE** — gen-fettler-genvendor-vendored-only (false_positive_traps): flagged distractors: vendor/provider-sdk/index.ts
- **[P0] FALSE_POSITIVE** — gen-fettler-genvendor-both (false_positive_traps): flagged distractors: vendor/provider-sdk/index.ts
- **[P0] ABSTENTION_FAILURE** — gen-regauge-aws-residual (residual_refusal): status=applicable; residualPaths=none
- **[P0] ABSTENTION_FAILURE** — gen-regauge-stripe-residual (residual_refusal): status=applicable; residualPaths=none
- **[P0] ABSTENTION_FAILURE** — gen-regauge-googleapis-residual (residual_refusal): status=applicable; residualPaths=none
- **[P0] ABSTENTION_FAILURE** — gen-regauge-react-dom-residual (residual_refusal): status=applicable; residualPaths=none
- **[P0] ABSTENTION_FAILURE** — gen-regauge-acme-user-residual (residual_refusal): status=applicable; residualPaths=none
- **[P1] SCALE_FAILURE** — fettler-edge-huge-monorepo (completes_within_budget): analysis did not finish within the 120000ms budget on this repository

## Coverage gaps (correct abstention today; capability not yet shipped)

- regauge-runtime-upgrade — residual sites left un-migrated: docker/Dockerfile.ci
- regauge-sdk-upgrade — no shipped recipe covers this migration family
- regauge-framework-upgrade — no shipped recipe covers this migration family
- regauge-internal-api-rename — no shipped recipe covers this migration family
- regauge-partial-campaign — no shipped recipe covers this migration family
- gen-regauge-runtime-unsupported-21-23 — no shipped recipe covers this migration family

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

**What remains fragile.** 7 P0 issue(s) where the product acted when it should have abstained or touched a distractor — see Top remaining risks. Verification honesty, large-repo scale limits, and binary/encoding/symlink robustness are only partially observable through the analysis-only path and need the full generation+verification pipeline to grade end to end.

