# MendPoint design-partner readiness scorecard (spec §29)

- Generated: 2026-08-18T18:02:44.915Z
- Git commit: `7eaa7b1`
- Readiness policy: precision-first (owner Talal, decided 2026-08-17)
- Overall readiness: **FAIL**

Every field below is populated from the latest run's real records or the versioned readiness evaluation. Fields the analysis-only path cannot measure are marked "not measured (<why>)" rather than left blank or estimated.

## Capability: Fettler — API-change impact analysis

Readiness verdict: **FAIL** (policy precision-first).

| field | value |
| --- | --- |
| Capability | Given a structured OpenAPI v1->v2 change, flag exactly the impacted source files. |
| Supported languages / stacks | node-service-edge; typescript-monorepo; typescript-service-generated |
| Supported repo patterns | allOf, binary, both, edge, encoding, field-rename, flat, generated-code, generated-only, generated-vendored, indirection, looks-generated, nested2, pnpm, ref, ref-blindness, refToRef, restraint, robustness, symlink, third-party, unmeasured-dimension, vendored, vendored-only, verification-honesty, workspace, wrapper-layers |
| Supported providers | provider-agnostic (driven by the OpenAPI diff, not a provider allowlist); exercised only against synthetic providers |
| Known unsupported patterns | recall collapses on: go-service; java-service; node-cjs-service; python-service; typescript-monorepo |
| Scenario count | 33 Fettler scenarios (27 flag_files, 4 abstain, 2 other) |
| Hidden-holdout status | 4 procedurally-generated holdout scenarios, never inspected while fixing; 4/4 passed |
| Precision / recall | precision 98.2%, recall 79.3% (micro-averaged over 27 flag_files scenarios) |
| Patch verification rate | not measured (generation + sandbox verification path not exercised by the analysis-only runner) |
| False-positive rate | 1.8% of confident findings (2/109) |
| Known P0 / P1 | P0: none | P1: fettler-edge-huge-monorepo (SCALE_FAILURE) |
| Latency range | 36ms min, 89ms median, 120081ms max (n=33) |
| Cost range | not measured (LLM off on this path; no model called, so token cost is genuinely zero rather than estimated) |
| Required human review | yes — ambiguous renames and low-confidence notifications are surfaced for human decision, never auto-applied |
| Rollback behaviour | not measured (PR delivery + apply path not exercised; rollback is a delivery-layer property) |
| Security limitations | answer-key isolation is enforced (corpus staged with grading keys stripped, corpus root asserted outside the repo); product-side security limits (secret handling, sandbox escape) are not measured (full pipeline not exercised) |
| Owner | Talal |
| Last-validated commit | `7eaa7b1` |

## Capability: Fettler — restraint (abstention / no-op)

Readiness verdict: **PASS** (policy precision-first).

Fettler restraint: on an ambiguous rename (>=2 plausible successors) or an already-migrated repo, the correct output is NO confident finding. A distinct capability from impact analysis (which is scored on flag_files recall/precision); this is the precision-first 'do not guess' guard, pooled over the abstain + no_op Fettler scenarios the impact gate excludes.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| abstention_correctness | 100.0% (6/6) | >= 100% correct | PASS |
| open_p0 | 0 | <= 0 | PASS |

| field | value |
| --- | --- |
| Scenario count | 6 (abstain 4/4, no_op 2/2; 6/6 correct) |
| Known P0 / P1 | P0: none | P1: none |
| Latency range | 39ms min, 46ms median, 136ms max (n=6) |
| Cost range | not measured (LLM off on this path; no model called) |
| Required human review | yes — an ambiguous rename is surfaced for a human decision, never auto-applied |
| Owner | Talal |
| Last-validated commit | `7eaa7b1` |

## Capability: ReGauge — migration recipe engine (per family)

Each recipe family is scored against its own gate in `readiness-gates.json`: correct application on in-scope repos, refusal on partial-migration repos (a residual consumer outside the recipe's allowedPaths), abstention on out-of-scope repos, and zero open P0. Analyze-only fields (apply + verification, cost, rollback) are marked "not measured".

### Family: runtime-upgrade (regauge-runtime-migration) — **PASS**

ReGauge runtime family (node-runtime-18-to-20, node-runtime-20-to-22). The reference standard: this family already detects residual runtime pins (a CI Dockerfile or extra .nvmrc left on the old major), so it is expected to clear its gate. It is gated anyway as a positive control — a family that always passes proves the gate can distinguish a ready family from an unready one.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (3/3) | >= 100% pass | PASS |
| residual_refusal | 100.0% (4/4) | >= 100% refuse | PASS |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 0 | <= 0 | PASS |

| field | value |
| --- | --- |
| Scenario count | 9 (apply 3/3, residual-refusal 4/4, abstention 2/2) |
| Known P0 / P1 | P0: none | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 5ms min, 8ms median, 119ms max (n=9) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `7eaa7b1` |

### Family: sdk-upgrade (regauge-sdk-migration) — **PASS**

ReGauge SDK family (aws-sdk-js-v2-to-v3, stripe-node-v10-to-v11, googleapis-v25-to-v26). These recipes swap or bump a dependency repo-wide while editing only their two allowlisted source files, and their verifiers check only those files. The residual scenarios prove that a third consumer left on the old surface must force a refusal, not a signed evidence record for a repo that no longer installs.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (3/3) | >= 100% pass | PASS |
| residual_refusal | 100.0% (4/4) | >= 100% refuse | PASS |
| out_of_scope_abstention | 100.0% (6/6) | >= 100% abstain | PASS |
| open_p0 | 0 | <= 0 | PASS |

| field | value |
| --- | --- |
| Scenario count | 13 (apply 3/3, residual-refusal 4/4, abstention 6/6) |
| Known P0 / P1 | P0: none | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 4ms min, 75ms median, 91ms max (n=13) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `7eaa7b1` |

### Family: framework-upgrade (regauge-framework-migration) — **PASS**

ReGauge framework family (react-dom-17-to-18). Migrates render/hydrate call sites in the allowlisted entrypoints; a residual entrypoint still calling the legacy ReactDOM.render outside allowedPaths must force a refusal.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (1/1) | >= 100% pass | PASS |
| residual_refusal | 100.0% (1/1) | >= 100% refuse | PASS |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 0 | <= 0 | PASS |

| field | value |
| --- | --- |
| Scenario count | 4 (apply 1/1, residual-refusal 1/1, abstention 2/2) |
| Known P0 / P1 | P0: none | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 10ms min, 40ms median, 80ms max (n=4) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `7eaa7b1` |

### Family: internal-api-rename (regauge-internal-api-migration) — **PASS**

ReGauge internal-API family (internal-api-acme-user-rename and the registry rename recipes). Renames an exported symbol across allowlisted consumers; a residual consumer outside allowedPaths still calling the old name must force a refusal.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (1/1) | >= 100% pass | PASS |
| residual_refusal | 100.0% (2/2) | >= 100% refuse | PASS |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 0 | <= 0 | PASS |

| field | value |
| --- | --- |
| Scenario count | 5 (apply 1/1, residual-refusal 2/2, abstention 2/2) |
| Known P0 / P1 | P0: none | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 5ms min, 8ms median, 86ms max (n=5) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `7eaa7b1` |

| Owner | Talal |

## Capabilities not measured (Phase 2 gate-coverage backlog)

Capabilities the product HAS but the current eval substrate cannot score. Recorded here (not silently omitted) so gate coverage is honest: a capability is either gated on a real measured dimension above, or listed here with the experiment that would make it measurable. NONE of these is gated on an invented threshold. This list is the Phase 2 backlog: each entry names the smallest change that would move it into 'capabilities'. Ownership tags (Claude/Codex/Shared) follow the Phase 0 blocker assignment.

| capability | why not measured | experiment that would measure it | owner |
| --- | --- | --- | --- |
| regauge-apply-verification | Both runners are analyze-only (evals/runners/regauge-runner.ts calls analyzeRecipe and stops; fettler-runner.ts sets useLlm:false and calls analyzeImpact only). Nothing applies a recipe, installs dependencies, compiles, or runs the subject repo's tests, so 'the migration is complete and the repo still installs/compiles' is unobservable. The gated ReGauge families measure the analyze DECISION (refuse vs apply), not a verified applied result. | An apply-and-verify harness that runs applyRecipe/executeRecipeInWorkspace in a fenced sandbox, installs and builds the migrated tree, and grades an independent fail-to-pass/pass-to-pass judge. Gate on post-apply verification pass rate. (Phase 2 blocker #5, Claude.) | Claude |
| fettler-migration-generation-and-delivery | The Fettler runner exercises impact analysis only; migration-patch generation, the agentic repair loop, and GitHub PR delivery are not invoked (they need a seeded DB, a sandbox, and GitHub credentials). Recorded per run as unmeasured_dimensions, never scored. | A seeded-DB + sandbox + delivery integration harness that drives the generation/repair/delivery lane on a synthetic repo and grades patch correctness and delivery honesty. Gate on generated-patch correctness once it exists. | Shared |
| model-routing-cost-and-tokens | Both runners run the deterministic path with the model off (useLlm:false / analyzeRecipe), so model, provider, tokens, and cost are genuinely null (no model was called) rather than measured. There is no routing decision to score because no model path runs. | A live-model eval lane (the one .github/workflows/regauge-production.yml already runs) feeding routing decisions, token counts, and measured cost into the run record. Gate on cost-per-outcome and routing-decision quality once a second executor is genuinely eligible. | Shared |
| retrieval-quality | recall@k for the retrieval layer has a numerator on at most one path and no denominator anywhere; the harness cannot see which files the model was shown, so 'the required file was never retrieved' is undiagnosable. Fine-tuning to compensate for a retrieval defect is the failure mode spec 17.4 warns against, so this must be measured before any training targets it. | A retrieval benchmark that records the candidate set the product examined and scores it against the ground-truth impacted files (recall@k with a real denominator). (Phase 2 blocker #10, Claude.) | Claude |
| change-graph-completeness-and-confidence-calibration | gl_edges.confidence is assigned by fiat at write time and never validated against an outcome; there is no graph-completeness measure and no graph-gated decision in production. The harness scores product findings, not the graph the findings came from. | Wire the already-written, zero-caller runImpactBenchmark and evaluateConfidenceCalibration (packages/graph-learn) into a scored eval so a confidence:0.7 edge can be checked to be right ~70% of the time. Gate on calibration error once it reports. | Codex |
| verification-honesty | In deployed config, production verification refuses with exit 126 for essentially every real repo command, and a refusal is indistinguishable downstream from a genuine test failure; the sandbox backend that ran is recorded nowhere. The analyze-only harness never reaches verification, so 'verified' cannot be validated as a trustworthy label here. | Capture per-check exit codes and the sandbox backend that actually ran, and grade a refusal distinctly from a failure. Gate on verifier-refusal rate and backend provenance once captured. (Phase 2 blocker #7, Shared.) | Shared |
| fettler-scale-latency | completes_within_budget IS measured (the huge-monorepo scenario runs under a hard 120s budget and records a SCALE_FAILURE if it blows it), but n=1: there is exactly one large-repo data point. Gating latency on a single scenario would require inventing a budget threshold that one run cannot justify, so it is measured-but-not-gated rather than gated on a fabricated number. | A scale ladder (several repo sizes across the file-count axis in AnalysisActivity.filesExamined) that plots latency against repo size; set a budget threshold from the measured curve. Gate on p95 latency at a defined repo size. | Claude |

