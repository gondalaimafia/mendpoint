# Graphify benchmark

## Harness implemented

`@mendpoint/structural-graph` contains a label-free staging and sealed-key grading contract for exactly three zero-model arms:

- A: current Mendpoint extraction plus current semantic resolution;
- B: Graphify normalization, with semantic fields explicitly `not_measured`;
- C: Graphify normalization plus Mendpoint provider/entity resolution and immutable Change Graph traversal.

The contract requires 18 cases: six development, six validation, six holdout, with at least three indirect cases in every split. Family digests cannot cross splits. The canonical cohort digest binds every case ID, input digest, family, language, split, and indirect classification. The protected key repeats those bindings and grading revalidates the complete staged artifact after reload. Predictors receive no labels. The key is supplied only after all predictions are staged. Model calls, tokens, and cost are fixed at zero. The deeply frozen report binds the cohort digest plus canonical staged-prediction and sealed-key digests before it is content addressed.

Unit tests prove the staging, sealed-key, and scoring contract. This version deliberately cannot emit an adoption result because it does not yet measure exact-path accuracy, trap correctness, incremental equivalence, network denial, or an executed external holdout. Those fields require a successor benchmark schema after the pinned process exists.

## Required real cohort

The real cohort must include direct Stripe use, alias import, wrapper, wrapper of wrapper, barrel/re-export, cross-module service, relevant test, generated client, decoy/no-impact traps, and neutral holdout variants. At least nine of 18 cases must require indirect relationships. Holdout labels must live outside the repository and become available only to a protected grader after prediction artifacts are committed.

## Metrics

Structural metrics: canonical node and relation-specific edge precision/recall, cross-file calls, alias/re-export recall, false-edge and ambiguity rates, provenance/location completeness, unsupported coverage, and digest determinism.

Fettler metrics: SDK-to-endpoint precision/recall, semantic relationship precision/recall, exact path accuracy, impacted-file precision/recall, direct and indirect recall, test recall, trap correctness, and honest coverage.

Operational metrics: full extraction, incremental extraction, normalization, promotion, publication, and query p50/p95; peak RSS/CPU; graph/output/storage bytes; compute seconds; and cost per repository/change. Small, medium, large, and monorepo tiers require isolated child processes, warmups, and repeated measurements.

## Blind spots

Results must classify `STRUCTURAL_STATIC_GAP`, `SEMANTIC_RESOLUTION_REQUIRED`, or `RUNTIME_EVIDENCE_REQUIRED` for reflection, dynamic import, dependency injection, ORM indirection, generated code, macros, stored procedures, shell/cron, plugin loading, feature flags, queues, and shared databases.

## Gates

Hard failures include label leakage, tenant/snapshot mismatch, path escape, any code-only network/model use, malformed provenance, nondeterminism, stale incremental facts, trap hits, or fallback regression.

For a language to qualify, structural edge precision must be at least 0.90 and recall 0.85. Arm C impact precision must be at least 0.95, impact recall 0.90, indirect recall 0.85, and full-path accuracy 0.80. C must improve validation/holdout indirect recall over A by at least ten points and two successes without direct/trap regression, or hold quality within two points while improving p95 performance at least 20 percent. Full extraction may be at most 1.5 times A, peak RSS at most twice A, and incremental at most 1.25 times A.

## Recorded run status

A real pinned Graphify child process completed the two-file Linux pull-request smoke at revision `557b3e4c47726f4858ab52c0764bbc61bfc5758f`. The retained artifact records four nodes, five edges, 220.901 ms elapsed time, 33,460,224 peak RSS bytes, and normalized content digest `sha256:326a57f02b48bbf3ce0a7ee8c5f80cb585068a91178c663d14b5f63391779a6b`. This is process compatibility evidence only, not a quality or performance benchmark. No sealed external holdout or four-tier performance run was completed. Upstream's benchmark artifacts are not reproducible from release `0.9.46`. The repository unit cohort validates the scoring contract only. Therefore no quality, economics, or adoption claim is supported, and the decision remains **KEEP AS INTERNAL TOOL ONLY**. Exact evidence is retained in [`evidence/2026-08-22-graphify-process-smoke.json`](evidence/2026-08-22-graphify-process-smoke.json).
