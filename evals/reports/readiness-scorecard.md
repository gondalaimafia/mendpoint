# MendPoint design-partner readiness scorecard (spec §29)

- Generated: 2026-08-17T22:52:06.881Z
- Git commit: `ae8e17f`
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
| Latency range | 21ms min, 63ms median, 120032ms max (n=33) |
| Cost range | not measured (LLM off on this path; no model called, so token cost is genuinely zero rather than estimated) |
| Required human review | yes — ambiguous renames and low-confidence notifications are surfaced for human decision, never auto-applied |
| Rollback behaviour | not measured (PR delivery + apply path not exercised; rollback is a delivery-layer property) |
| Security limitations | answer-key isolation is enforced (corpus staged with grading keys stripped, corpus root asserted outside the repo); product-side security limits (secret handling, sandbox escape) are not measured (full pipeline not exercised) |
| Owner | Talal |
| Last-validated commit | `ae8e17f` |

## Capability: ReGauge — migration recipe engine

Readiness verdict: **not gated** (the owner's precision/recall bar is authored for Fettler impact; ReGauge readiness is reported as coverage, not scored against a precision gate yet).

| field | value |
| --- | --- |
| Capability | Recognize a migration family and (would) apply a deterministic recipe; abstain by absence when no shipped recipe matches. |
| Supported languages / stacks | Node / JavaScript / TypeScript (the shipped recipe families) |
| Supported repo patterns | families with a shipped recipe: runtime-upgrade |
| Supported providers | recipe-scoped (runtime bumps, SDK/framework/internal-API renames); driven by the shipped recipe registry |
| Known unsupported patterns | coverage gaps (correct abstention today): framework-upgrade; internal-api-rename; runtime-upgrade; sdk-upgrade |
| Scenario count | 10 ReGauge scenarios (6 coverage-gap) |
| Hidden-holdout status | not measured (holdout generation currently targets Fettler ref-rename families only) |
| Precision / recall | 10/10 scenarios correct (engine decision: match or abstain-by-absence); site-level precision/recall not measured (apply path not exercised) |
| Patch verification rate | not measured (recipe apply + verification gate not exercised (analyze-only)) |
| False-positive rate | 0 unsafe recipe matches on non-matching repos in this run |
| Known P0 / P1 | P0: none | P1: none |
| Latency range | 5ms min, 134ms median, 189ms max (n=10) |
| Cost range | not measured (deterministic recipe engine; no model called) |
| Required human review | yes — recipe application produces a draft PR for human review; nothing auto-merges |
| Rollback behaviour | not measured (inverse/rollback path not exercised) |
| Security limitations | not measured (apply + sandbox path not exercised) |
| Owner | Talal |
| Last-validated commit | `ae8e17f` |

