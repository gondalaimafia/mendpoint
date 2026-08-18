# MendPoint design-partner readiness scorecard (spec §29)

- Generated: 2026-08-18T03:02:05.703Z
- Git commit: `1d3ae5a`
- Readiness policy: precision-first (owner Talal, decided 2026-08-17)
- Overall readiness: **FAIL**

Every field below is populated from the latest run's real records or the versioned readiness evaluation. Fields the analysis-only path cannot measure are marked "not measured (<why>)" rather than left blank or estimated.

## Capability: Fettler — API-change impact analysis

Readiness verdict: **FAIL** (policy precision-first).

| field | value |
| --- | --- |
| Capability | Given a structured OpenAPI v1->v2 change, flag exactly the impacted source files. |
| Supported languages / stacks | node-service-edge; typescript-monorepo; typescript-service-generated |
| Supported repo patterns | allOf, binary, edge, encoding, field-rename, flat, generated-code, generated-only, generated-vendored, indirection, looks-generated, nested2, pnpm, ref, ref-blindness, refToRef, restraint, robustness, symlink, third-party, unmeasured-dimension, vendored, verification-honesty, workspace, wrapper-layers |
| Supported providers | provider-agnostic (driven by the OpenAPI diff, not a provider allowlist); exercised only against synthetic providers |
| Known unsupported patterns | recall collapses on: go-service; java-service; node-cjs-service; python-service; typescript-monorepo |
| Scenario count | 33 Fettler scenarios (27 flag_files, 4 abstain, 2 other) |
| Hidden-holdout status | 4 procedurally-generated holdout scenarios, never inspected while fixing; 4/4 passed |
| Precision / recall | precision 96.4%, recall 79.3% (micro-averaged over 27 flag_files scenarios) |
| Patch verification rate | not measured (generation + sandbox verification path not exercised by the analysis-only runner) |
| False-positive rate | 3.6% of confident findings (4/111) |
| Known P0 / P1 | P0: gen-fettler-genvendor-both (FALSE_POSITIVE); gen-fettler-genvendor-vendored-only (FALSE_POSITIVE) | P1: fettler-edge-huge-monorepo (SCALE_FAILURE) |
| Latency range | 31ms min, 75ms median, 120048ms max (n=33) |
| Cost range | not measured (LLM off on this path; no model called, so token cost is genuinely zero rather than estimated) |
| Required human review | yes — ambiguous renames and low-confidence notifications are surfaced for human decision, never auto-applied |
| Rollback behaviour | not measured (PR delivery + apply path not exercised; rollback is a delivery-layer property) |
| Security limitations | answer-key isolation is enforced (corpus staged with grading keys stripped, corpus root asserted outside the repo); product-side security limits (secret handling, sandbox escape) are not measured (full pipeline not exercised) |
| Owner | Talal |
| Last-validated commit | `1d3ae5a` |

## Capability: ReGauge — migration recipe engine (per family)

Each recipe family is scored against its own gate in `readiness-gates.json`: correct application on in-scope repos, refusal on partial-migration repos (a residual consumer outside the recipe's allowedPaths), abstention on out-of-scope repos, and zero open P0. Analyze-only fields (apply + verification, cost, rollback) are marked "not measured".

### Family: runtime-upgrade (regauge-runtime-migration) — **PASS**

ReGauge runtime family (node-runtime-18-to-20, node-runtime-20-to-22). The reference standard: this family already detects residual runtime pins (a CI Dockerfile or extra .nvmrc left on the old major), so it is expected to clear its gate. It is gated anyway as a positive control — a family that always passes proves the gate can distinguish a ready family from an unready one.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (3/3) | >= 100% pass | PASS |
| residual_refusal | 100.0% (1/1) | >= 100% refuse | PASS |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 0 | <= 0 | PASS |

| field | value |
| --- | --- |
| Scenario count | 6 (apply 3/3, residual-refusal 1/1, abstention 2/2) |
| Known P0 / P1 | P0: none | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 6ms min, 19ms median, 100ms max (n=6) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `1d3ae5a` |

### Family: sdk-upgrade (regauge-sdk-migration) — **FAIL**

ReGauge SDK family (aws-sdk-js-v2-to-v3, stripe-node-v10-to-v11, googleapis-v25-to-v26). These recipes swap or bump a dependency repo-wide while editing only their two allowlisted source files, and their verifiers check only those files. The residual scenarios prove that a third consumer left on the old surface must force a refusal, not a signed evidence record for a repo that no longer installs.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (3/3) | >= 100% pass | PASS |
| residual_refusal | 0.0% (0/3) | >= 100% refuse | FAIL |
| out_of_scope_abstention | 100.0% (6/6) | >= 100% abstain | PASS |
| open_p0 | 3 | <= 0 | FAIL |

| field | value |
| --- | --- |
| Scenario count | 12 (apply 3/3, residual-refusal 0/3, abstention 6/6) |
| Known P0 / P1 | P0: gen-regauge-aws-residual (ABSTENTION_FAILURE); gen-regauge-googleapis-residual (ABSTENTION_FAILURE); gen-regauge-stripe-residual (ABSTENTION_FAILURE) | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 3ms min, 28ms median, 92ms max (n=12) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `1d3ae5a` |

### Family: framework-upgrade (regauge-framework-migration) — **FAIL**

ReGauge framework family (react-dom-17-to-18). Migrates render/hydrate call sites in the allowlisted entrypoints; a residual entrypoint still calling the legacy ReactDOM.render outside allowedPaths must force a refusal.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (1/1) | >= 100% pass | PASS |
| residual_refusal | 0.0% (0/1) | >= 100% refuse | FAIL |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 1 | <= 0 | FAIL |

| field | value |
| --- | --- |
| Scenario count | 4 (apply 1/1, residual-refusal 0/1, abstention 2/2) |
| Known P0 / P1 | P0: gen-regauge-react-dom-residual (ABSTENTION_FAILURE) | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 3ms min, 5ms median, 89ms max (n=4) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `1d3ae5a` |

### Family: internal-api-rename (regauge-internal-api-migration) — **FAIL**

ReGauge internal-API family (internal-api-acme-user-rename and the registry rename recipes). Renames an exported symbol across allowlisted consumers; a residual consumer outside allowedPaths still calling the old name must force a refusal.

| criterion | measured | threshold | verdict |
| --- | --- | --- | --- |
| apply_correctness | 100.0% (1/1) | >= 100% pass | PASS |
| residual_refusal | 0.0% (0/1) | >= 100% refuse | FAIL |
| out_of_scope_abstention | 100.0% (2/2) | >= 100% abstain | PASS |
| open_p0 | 1 | <= 0 | FAIL |

| field | value |
| --- | --- |
| Scenario count | 4 (apply 1/1, residual-refusal 0/1, abstention 2/2) |
| Known P0 / P1 | P0: gen-regauge-acme-user-residual (ABSTENTION_FAILURE) | P1: none |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| Latency range | 4ms min, 7ms median, 82ms max (n=4) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Last-validated commit | `1d3ae5a` |

| Owner | Talal |

