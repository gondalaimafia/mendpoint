# The Mendpoint Migration Intelligence Benchmark

**A research-quality description of the evaluation substrate: task taxonomy, methodology, current
results, and the boundaries of what it can observe.**

*Phase 33/3 of the Intelligence Ownership program.*

- **Commit under description:** `ae42fb6` (`origin/main`, 2026-08-18).
- **Gates run from the worktree root:** `npm run spec:check` → `PRODUCT CONTRACT PASS: 84 requirements, spec 2.0`. `npm run typecheck` → exit 0.
- **Canonical authority:** `docs/product/mendpoint-product-platform-specification.md` (v2.0), §18 (Synthetic repository evaluation), §29 (Design-partner readiness scorecard), §33.5 (Numeric quality gates).
- **Product ↔ code naming:** Fettler = `warden` in code, ReGauge = `transformer` in code (`docs/agents/OPERATING_PROTOCOL.md:138-145`). Both names appear below; the code paths use the second.

---

## 0. Purpose, and what this document deliberately is not

This is a methodology paper for an internal benchmark. Its job **right now** is to describe the
methodology rigorously and report the real, current, mostly-failing numbers. It is explicitly not a
publication, a results claim, or a marketing artifact.

The program's standing rule is: **do not fabricate publishable claims before the evidence exists.**
Applied here, that means three things.

1. **The headline numbers are reported with the caveat that makes them interpretable, every time.**
   The most important caveat in this document is §8.1: the published precision and recall measure
   the deterministic pipeline **with the model switched off**. That caveat was mis-cited repeatedly
   before it was caught, so it appears in the abstract, in the results section, and in its own
   section.
2. **Unmeasured is stated as unmeasured**, with the experiment that would measure it (§9). The
   harness itself does this — it writes an `unmeasured_dimensions` array per run
   (`evals/runners/types.ts:90`) rather than leaving a blank that reads as a zero.
3. **The overall verdict is FAIL, and that is reported first**, not buried.

A reader who wants the asset-level view of what this benchmark is worth should read
`docs/intelligence/INTELLIGENCE_MOAT.md` §3 alongside this.

### Abstract

The Mendpoint Migration Intelligence Benchmark is an adversarial synthetic-repository corpus with
hidden machine-readable ground truth, four dataset tiers including a never-inspected holdout,
deterministic per-dimension graders, a symptom-to-subsystem failure taxonomy, and owner-versioned
numeric acceptance gates. As of the most recent committed run it contains **59 scenarios** on `main`
and **64** on the in-flight PR #184, across two products and nine repository families.

Current overall readiness: **FAIL**. Fettler impact analysis reports precision 96.4% and recall
79.3% against thresholds of ≥90% and ≥85%, with 2 open P0 false positives. **Those two figures
measure a pipeline with the language model disabled** (`evals/runners/fettler-runner.ts:92` sets
`useLlm: false`); they are a measurement of a parser-and-graph system, not of a model. Both runners
are analyze-only: neither applies a change, installs a dependency, compiles, or runs the subject
repository's tests, so every result in this document describes a *decision*, not a *verified
outcome*.

---

## 1. Design principles

Five commitments define the benchmark and explain most of its structure.

**1. The corpus is built to make the product fail.** The report says so in its own preamble: "This
corpus is built to make MendPoint fail, not to flatter it" (`evals/reports/latest.md:7`). Scenario
selection is adversarial by intent — deliberate distractors, ambiguous renames with multiple
plausible successors, vendored and generated trees that must not be touched, a 30k-file monorepo,
non-UTF-8 and symlinked input.

**2. The product must never be able to read its own answer key.** Spec §18.3 makes this a MUST. It
is enforced twice: the corpus root must resolve strictly outside the repository containing the keys,
asserted by `assertCorpusIsolation` (`evals/runners/isolation.ts`), which throws
`CorpusIsolationError` rather than warning; and each repository is staged into scratch with its
grading key stripped before the product runs (`evals/runners/stage.ts`, invoked at
`evals/runners/fettler-runner.ts:71-73`). The module comment records why the invariant was made
explicit: it previously held only because the corpus happened to live at a developer path outside
the tree — "a default, not an invariant" (`evals/runners/isolation.ts:1-11`).

**3. Grading is deterministic. There is no LLM judge anywhere.** Stated in both grader headers
(`evals/graders/fettler-graders.ts:12` — "No LLM judging";
`evals/graders/regauge-graders.ts:4` — "Deterministic") and reaffirmed in
`evals/graders/DEFERRED.md:47-49`. Two dimensions that would genuinely require semantic judgement —
evidence quality and modernization-plan safety — are left unbuilt with explicit rubrics sketched
(`DEFERRED.md:47-65`), rather than approximated by a model grader whose own reliability nobody has
measured.

**4. Generalization is measured on a split that was never inspected.** Four tiers, not two
(`evals/ground-truth/schema.ts:26-34`): `development` (may be inspected while fixing), `regression`
(added after an observed failure), `validation` (tuning), `holdout` (procedurally generated, never
inspected). The report labels the holdout row as "the honest product-quality signal"
(`evals/reports/latest.md`, Dataset splits).

**5. What cannot be observed is recorded as unobservable, never as a pass.** Every run carries an
`unmeasured_dimensions` array (`evals/runners/types.ts:90`), the report aggregates them into their
own section, and the failure taxonomy has a dedicated `HARNESS_LIMITATION` category at severity P3
(`evals/graders/taxonomy.ts`) so a harness gap is never silently scored as product quality.

---

## 2. Task taxonomy

### 2.1 The two products

| Product | Task | Product invocation exercised |
| --- | --- | --- |
| **Fettler** (`warden`) | Given a structured OpenAPI v1→v2 change, flag exactly the impacted source files. | `change-intel.normalizeChange` → `code-impact.analyzeImpact` (`evals/runners/fettler-runner.ts:49`) |
| **ReGauge** (`transformer`) | Given a repository, decide which shipped migration recipe applies, refuse if the migration would be partial, abstain if none applies. | `transformer.analyzeRecipe` over the shipped recipe registry (`evals/runners/regauge-runner.ts`, invocation string at `:157-158`) |

### 2.2 Correct-behavior classes (the ground-truth label space)

Every scenario declares one expected behavior, and the graders dispatch on it.

| `correct_behavior` | Meaning | Failure to comply |
| --- | --- | --- |
| `flag_files` | A specific set of files is impacted and must be flagged. | `FALSE_NEGATIVE` (P1/P2) or `FALSE_POSITIVE` (P0 on a trap, P2 otherwise) |
| `abstain` | The correct output is *nothing* — the change is ambiguous (≥2 plausible successors). | `ABSTENTION_FAILURE` (P0) |
| `no_op` | The correct output is *nothing* — the repository is already migrated. | `ABSTENTION_FAILURE` (P0) |
| `apply_recipe` | A shipped recipe must recognize the repository and cover the expected root files. | Graded on recipe match + path coverage |
| `refuse_partial` | The recipe recognizes the repository but a residual consumer sits **outside** its `allowedPaths`; the only safe outcome is `status = "incomplete"`. | `ABSTENTION_FAILURE` (P0) — applying anyway ships a repository that no longer installs |
| `coverage_gap` | No shipped recipe covers this family; abstention-by-absence is correct shipped behaviour. | Recorded as `COVERAGE_GAP`, does **not** flip pass/fail |

`refuse_partial` is the newest class, added in PR #179 (`80bf1d2`) after the OSS validation showed it
was the failure mode that mattered most and the one the harness could not express.

### 2.3 Fettler repository families

Observed in the most recent run (`evals/reports/latest.md`, "By repository family"), with pass rates
from the PR #184 run:

| Family | Scenarios | Passed | Notes |
| --- | --- | --- | --- |
| `typescript-service-generated` | 18 | 16 (89%) | Generated/vendored discrimination; the two failures are the open P0s |
| `node-service-edge` | 7 | 7 (100%) | Edge cases: binary/encoding, deep indirection, pnpm workspace, symlink, no-test-command |
| `typescript-monorepo` | 2 | 1 (50%) | |
| `typescript-service` | 1 | 0 (0%) | Precision failure on a test file |
| `python-service` | 1 | 0 (0%) | Recall 73%; misses JSON fixtures |
| `go-service` | 1 | 0 (0%) | Recall 71%; misses testdata JSON |
| `java-service` | 1 | 0 (0%) | Recall 62% |
| `node-cjs-service` | 1 | 0 (0%) | Recall 14% |
| `typescript-monorepo-scale` | 1 | 0 (0%) | 30k-file repository; exceeds the 120s budget |

The shape of this table is the single most useful product finding in the benchmark: **recall fails by
language.** Four language families score 0% pass, and the missed files are systematically JSON
fixtures and testdata. That is an indexer and parser defect, not a reasoning defect — which matters
for the ownership program, because spec §17.4 forbids fine-tuning to compensate for deterministic
engineering defects.

### 2.4 ReGauge migration families

`MigrationLabelFamily` declares five values — `sdk`, `framework`, `runtime`, `internal_api`,
`warden-provider` (`packages/transformer/src/recipe.ts:3224-3229`). `classifyRecipeContract`
(`:3256-3283`) can return only the first four; no shipped recipe classifies as `warden-provider`.
Four families are gated in `evals/readiness-gates.json`:

| Gated family | Recipes | Scenarios (PR #184 run) |
| --- | --- | --- |
| `runtime-upgrade` | `node-runtime-18-to-20` (v1, v2), `node-runtime-20-to-22` | 9 (apply 3, residual-refusal 4, abstention 2) |
| `sdk-upgrade` | `aws-sdk-js-v2-to-v3`, `stripe-node-v10-to-v11`, `googleapis-v25-to-v26` | 13 (apply 3, residual-refusal 4, abstention 6) |
| `framework-upgrade` | `react-dom-17-to-18` | 4 (apply 1, residual-refusal 1, abstention 2) |
| `internal-api-rename` | `internal-api-acme-user-rename` plus five registry-only rename recipes | 5 (apply 1, residual-refusal 2, abstention 2) |

The runner deliberately evaluates the full shipped registry against every snapshot, including
registry-only internal-API variants resolved best-effort, "so the abstention-by-absence claim is
defensible" (`evals/runners/regauge-runner.ts:102-104`).

### 2.5 Difficulty tiers

The spec's ladder (§18.5) is L1 obvious, L2 realistic, L3 cross-cutting, L4 ambiguous,
L5 adversarial. The schema enforces an integer 1–5 plus a required written
`difficulty_rationale` (`evals/ground-truth/schema.ts:118-121,192-200`).

Observed distribution in the most recent run:

| Product | L2 | L3 | L4 | L5 |
| --- | --- | --- | --- | --- |
| Fettler | — | 11 (45% pass) | 17 (88% pass) | 5 (80% pass) |
| ReGauge | present (runtime apply cases) | present | present | present (all residual and ambiguity cases) |

Two observations a skeptical reader should make, and which the benchmark does not hide:

- **There are no L1 scenarios.** Spec §18.5 says the corpus SHOULD NOT be dominated by easy tests;
  this corpus has none at all at the easiest tier, which is a defensible choice but means the
  benchmark cannot report a "trivially correct" baseline.
- **The L3 pass rate (45%) is far worse than L4 (88%) and L5 (80%).** That inversion is not a
  paradox: L3 is where the cross-language rename scenarios live, and language support — not
  reasoning difficulty — is what fails. The difficulty ladder is measuring the wrong axis for this
  product's actual failure mode, and that is worth saying out loud rather than presenting the L4/L5
  numbers as evidence of adversarial robustness.

---

## 3. Corpus construction

### 3.1 Two sources

**Hand-authored corpus repositories (21).** Real directory trees on disk under
`MENDPOINT_CORPUS_ROOT` (default `C:/Users/Talal/dev`, `evals/scenarios/index.ts:18-20`), registered
in `evals/scenarios/index.ts` with only run configuration — which repository, which product, which
spec pair, which provider slug hint. The answer key is deliberately kept in a *different* file
(`evals/ground-truth/*.json`) loaded only by the grader, after the product has run
(`evals/scenarios/index.ts:1-12`).

**Seeded mutations (38 on the `main` run; 21 + 38 = 59).** Generated by mutating a healthy repository rather than
hand-copying (`evals/generators/families.ts:6`), with the seed embedded in each scenario's `notes`
field (e.g. `Auto-generated (seed=${seed})`, `families.ts:115`). Families include ref-blindness
variants (`flat`, `ref`, `nested2`, `allOf`, `refToRef`), counterfactuals, ambiguity variants (two
successors, three successors, two-with-decoy), and generated/vendored discrimination cases.

**Regression cases (PR #184, in flight).** A third source: `evals/regression/cases.ts` seeds a
catalog from the OSS validation and the readiness run, built in memory from committed consumer
fixtures plus a hand-authored residual file — never the shared corpus, never a copied answer key.

### 3.2 Splits and holdouts

Four tiers (`evals/ground-truth/schema.ts:26-34`, validated at `:209-211`). Distribution in the most
recent run (PR #184):

| Split | Scenarios | Passed | Pass rate |
| --- | --- | --- | --- |
| development | 45 | 37 | 82% |
| validation | 9 | 7 | 78% |
| regression | 6 | 5 | 83% |
| holdout | 4 | 4 | 100% |

The four holdouts are `gen-fettler-ref-flat-holdout-0`, `gen-fettler-ref-ref-holdout-1`,
`gen-fettler-ref-nested2-holdout-2`, `gen-fettler-ref-allOf-holdout-3` — all Fettler,
all ref-rename family, L3–L4.

**This is a weak holdout and should be described as one.** Four scenarios of a single family, on
one product, is not enough to support a generalization claim at any useful confidence, and ReGauge
has no holdout at all (`evals/reports/readiness-scorecard.md`, Hidden-holdout row for the ReGauge
families is absent; the Fettler row records 4). The gate's holdout criterion currently reads
`+33.3pp vs dev`, i.e. the holdout scores *better* than development by 33 percentage points — which
passes a "within 10pp" threshold as written, but is a signal that the holdout is easier than the
development set, not that the product generalizes.

### 3.3 Governance on what may enter the suite (PR #184)

`evals/regression/governance.ts` is an enforced gate, not a checklist. A case may enter the committed
suite only if its data provenance is certified — `synthetic`, or `redacted-from-customer` with a
redaction reference — and it carries no customer data; and no reproducing repository may contain an
answer-key file. It throws rather than warning.

`evals/regression/regression.test.ts` then self-checks the catalog: it runs the real analyze path and
asserts each case's recorded `fixed` / `open` status matches reality, so a case cannot silently rot
into a false claim.

---

## 4. Grader methodology

### 4.1 Determinism

Every grader is a pure function of (product output, ground truth). No model is invoked at grading
time anywhere in the suite. This is a deliberate design commitment, not a limitation of effort — see
§1(3) and `evals/graders/DEFERRED.md:47-65`, which sketches the two rubrics that would be needed
before any semantic grader could be trusted.

### 4.2 Fettler graders

Four dimensions (`evals/graders/fettler-graders.ts`):

| Dimension | Computation |
| --- | --- |
| `expected_findings_recall` | \|flagged ∩ expected\| / \|expected\| (`:127`) |
| `precision` | expected hits / (expected + traps + extras) (`:166`) |
| `false_positive_traps` | Binary: did the product flag any declared distractor? (`:148`) |
| `abstention_correctness` / `no_op_correctness` | Binary: did the product produce *nothing* on an `abstain` or `no_op` scenario? (`:95,107`) |

A trailing `/` in an acceptable or trap entry marks a directory prefix, used for `generated/`,
`vendor/`, `node_modules/` trees.

Reported precision and recall are **micro-averaged over the 27 `flag_files` scenarios** — the
scorecard states the averaging explicitly (`evals/reports/readiness-scorecard.md`, Precision/recall
row). `abstain` and `no_op` scenarios are excluded from that pool and graded by a separate
capability, so restraint cannot be traded off against recall.

### 4.3 ReGauge graders

Graded on the analyze **decision** (`evals/graders/regauge-graders.ts`), across dimensions
`recipe_match`, `recipe_path_coverage`, `recipe_residual`, `required_abstention`,
`abstention_by_absence`, `family_coverage`, `coverage_safety`, `oracle_coverage`,
`no_op_correctness`, `residual_refusal`, `behaviour`.

Two grader defects were closed in PR #179 and are worth recording because they are the kind of defect
that silently inflates a score:

- `recipe_path_coverage` computed a score and pushed a `grader_result` but never pushed a `failure`,
  so a matched recipe that skipped an expected root file scored 0.5 *inside a passing scenario*. It
  now records a `FALSE_NEGATIVE`.
- `residual_refusal` did not exist as a graded behaviour at all until #179, which is why the OSS
  validation could find twelve product-wrong-eval-green cases (§8.6).

### 4.4 The pass rule, and its self-referential edge

A ReGauge scenario passes when every recorded failure is a `COVERAGE_GAP` or a `HARNESS_LIMITATION`
(`evals/graders/regauge-graders.ts:293-295`). The header states the intent plainly: "`passed` = the
engine did the SAFE, expected thing for the **current shipped engine**" (`:4-20`).

**This should be read carefully.** It means the suite grades against *what the product is supposed to
do today*, not against *what a customer needs*. A migration family that is entirely unimplemented
scores as a pass, because correct shipped behaviour is abstention-by-absence. Six such coverage gaps
are recorded in the most recent run. A reader converting the 83% headline pass rate into a
capability claim would be reading it wrong: some of those passes are the product correctly declining
to do anything.

### 4.5 Failure taxonomy and severity

Thirty categories (`evals/graders/taxonomy.ts`), being the spec §18.7 list plus five extensions the
corpus forced: `ABSTENTION_FAILURE`, `SCALE_FAILURE`, `ROBUSTNESS_FAILURE`, `COVERAGE_GAP`,
`HARNESS_LIMITATION`. Categories are defined by **root-cause location**, not symptom.

`classifyOutcome` (`evals/graders/taxonomy.ts`) is a documented, total mapping from a grader outcome
to a (category, severity, written rationale) triple. The severity assignments encode the
precision-first policy:

| Outcome | Category | Severity |
| --- | --- | --- |
| `flagged_trap` | `FALSE_POSITIVE` | **P0** — corrupting unrelated code is materially incorrect advice |
| `acted_when_should_abstain` | `ABSTENTION_FAILURE` | **P0** — "the most dangerous class: confidently-wrong advice" |
| `missed_all_findings` | `FALSE_NEGATIVE` | P1 |
| `missed_some_findings` | `FALSE_NEGATIVE` | P2 |
| `flagged_extra` | `FALSE_POSITIVE` | P2 |
| `scan_aborted` | `SCALE_FAILURE` | P1 |
| `scan_crashed` | `ROBUSTNESS_FAILURE` | P1 |
| `no_shipped_capability` | `COVERAGE_GAP` | P1 (a gap, not a defect) |
| `dimension_unobservable` | `HARNESS_LIMITATION` | P3 |

A crash is itself a graded outcome rather than a broken script — the runner catches and classifies it
(`evals/runners/fettler-runner.ts:128-145`).

### 4.6 Readiness gates

Thresholds live in one versioned file (`evals/readiness-gates.json`, `schema_version: 1`, policy
`precision-first`, owner Talal, decided 2026-08-17) rather than as literals scattered across graders.
Two capability shapes exist: `fettler-impact` (precision/recall on `flag_files`) and
`regauge-family` (pass rates on apply / residual-refusal / abstention, plus open-P0).

The gate file states its own small-n caveat: "the scenario set is small and hand/procedurally
authored, so a single failure fails the gate (that is the intended precision-first behaviour, not an
accident of small n)".

---

## 5. Current results

Two runs are relevant, and they disagree. **The newer one is correct, and it is not the one committed
to `main`.**

| | Committed on `origin/main` | Regenerated on PR #184 (in flight) |
| --- | --- | --- |
| Report commit | `1d3ae5a` | `80bf1d2` |
| Total scenarios | 59 | 64 |
| Passed | 45 (76%) | 53 (83%) |
| P0 failures | 7 | 4 |
| Overall readiness | **FAIL** | **FAIL** |

The `main` artifact was generated **before** PR #174 (`428d9fa`) landed residual detection for the
SDK, framework and internal-API families. PR #179 (`80bf1d2`) merged six minutes after #174 from a
branch cut before it and carried the pre-fix scorecard forward unchanged. **A reader who reads
`evals/reports/readiness-scorecard.md` on `main` today is reading a measurement of a product state
that no longer exists.** The tables below use the PR #184 run and say so.

### 5.1 Capability gates (PR #184 run, at `80bf1d2`)

| Capability | Criterion | Measured | Threshold | Verdict |
| --- | --- | --- | --- | --- |
| **fettler-impact-analysis** | impact_precision | 96.4% | ≥ 90.0% | PASS |
| | impact_recall | **79.3%** | ≥ 85.0% | **FAIL** |
| | open_p0 | **2** | ≤ 0 | **FAIL** |
| | holdout_within_dev | +33.3pp vs dev | within 10pp | PASS |
| **fettler-abstention** | abstention_correctness | 100.0% (6/6) | ≥ 100% | PASS |
| | open_p0 | 0 | ≤ 0 | PASS |
| **regauge-runtime-migration** | apply / residual / abstention / P0 | 3/3, 4/4, 2/2, 0 | 100/100/100/0 | **PASS** |
| **regauge-sdk-migration** | apply / residual / abstention / P0 | 3/3, 4/4, 6/6, 0 | 100/100/100/0 | **PASS** |
| **regauge-framework-migration** | apply / residual / abstention / P0 | 1/1, 1/1, 2/2, 0 | 100/100/100/0 | **PASS** |
| **regauge-internal-api-migration** | apply / residual / abstention / P0 | 1/1, **0/2**, 2/2, **2** | 100/100/100/0 | **FAIL** |

**Overall readiness: FAIL.**

For contrast, the same four ReGauge gates on the `main` artifact read runtime PASS, sdk **FAIL**
(residual 0/3, 3 P0), framework **FAIL** (0/1, 1 P0), internal-api **FAIL** (0/1, 1 P0).

### 5.2 The four open P0s (PR #184 run)

| Severity | Category | Scenario | Detail |
| --- | --- | --- | --- |
| P0 | `FALSE_POSITIVE` | `gen-fettler-genvendor-vendored-only` | flagged distractor `vendor/provider-sdk/index.ts` |
| P0 | `FALSE_POSITIVE` | `gen-fettler-genvendor-both` | flagged distractor `vendor/provider-sdk/index.ts` |
| P0 | `ABSTENTION_FAILURE` | `gen-regauge-acme-user-residual` | `status=applicable; residualPaths=none` — internal-API residual not detected |
| P0 | `ABSTENTION_FAILURE` | `reg-regauge-internal-api-acme-residual` | same defect, guarded by the new regression case |

Plus one P1 (`SCALE_FAILURE`, `fettler-edge-huge-monorepo`, did not finish within the 120,000 ms
budget) and P2 recall failures on Python (8/11 flagged; three JSON fixtures missed) and Go (12/17;
five testdata JSON files missed).

### 5.3 Latency

Wall-clock of the analysis path only, measured around the product call and not the staging copy
(`evals/runners/fettler-runner.ts:73-74`).

| Product | n | min | median | p90 | max |
| --- | --- | --- | --- | --- | --- |
| Fettler | 33 | 18 ms | 56 ms | 729 ms | 120,037 ms |
| ReGauge | 31 | 3 ms | 20 ms | 42 ms | 57 ms |

The 120,037 ms maximum is the hard budget ceiling on the scale scenario, not a completed analysis;
the report states this explicitly.

### 5.4 Cost and model economics

**Not measured, and genuinely zero rather than unmeasured-and-hidden.** The report's own words: the
deterministic analysis path makes no model calls, so "model utilization, token use, cost per
evaluation, and escalation rate are genuinely zero/null for these runs rather than fabricated"
(`evals/runners/report.ts:211`). Every committed run record carries `"estimated_cost_usd": null`.

---

## 6. Reported capability boundaries

The scorecard (spec §29) answers §18.10's design-partner questions per capability. Reported verbatim
from the PR #184 run:

**What we can accept today.** Fettler impact analysis on repositories where the change is an OpenAPI
field rename in a supported language and the impacted sites are reachable through imports. ReGauge's
runtime family (Node major version bump) where it matches.

**What we should not yet accept.** Repositories in languages where recall collapsed —
`go-service`, `java-service`, `node-cjs-service`, `python-service`, `typescript-monorepo`. Any
repository whose correct answer is a judgement call (ambiguous renames) without a human in the loop.

**Supported providers.** "provider-agnostic (driven by the OpenAPI diff, not a provider allowlist);
exercised only against synthetic providers."

**Required human review.** Yes, in every capability. Ambiguous renames and low-confidence
notifications are surfaced for a human decision and never auto-applied; recipe application produces
a draft PR and nothing auto-merges.

---

## 7. What the benchmark measures well

Stated so the caveats that follow are read as calibration and not as dismissal.

- **Restraint.** The abstention capability is gated separately and passes 6/6. Touching a distractor
  is a P0 and acting when abstention is required is a P0. A product that stays silent when it should
  is scored correctly, which most impact-analysis benchmarks do not do.
- **Partial-migration refusal.** `refuse_partial` is the class the OSS validation proved mattered
  most, and it is now graded on eleven scenarios across four families.
- **Answer-key isolation.** Enforced by an assertion that throws, not by convention.
- **Scale as a first-class outcome.** A budget overrun is a recorded `SCALE_FAILURE`, not a hung
  test. Files-scanned is captured per run (`AnalysisActivity.filesExamined`,
  `evals/runners/types.ts:33-41`) as the independent variable to plot latency against.
- **Robustness as a first-class outcome.** A crash is caught and graded (`ROBUSTNESS_FAILURE`, P1).
- **Self-honesty.** The harness publishes the list of things it cannot see, per run and in aggregate.

---

## 8. The caveats that determine how these numbers may be used

### 8.1 The headline numbers measure the pipeline with the model OFF

**This is the most important sentence in this document.**

`evals/runners/fettler-runner.ts:92` sets `useLlm: false` in the options passed to `analyzeImpact`.
The runner's own header says the path "is fully deterministic here (`useLlm: false`)"
(`:15`), the recorded `invocation_path` for every Fettler run is
`"change-intel.normalizeChange -> code-impact.analyzeImpact (useLlm:false, minConfidence:medium)"`
(`:49`), and the report's invocation line reads "deterministic analysis core (Fettler:
change-intel → code-impact, **LLM off**; ReGauge: analyzeRecipe over shipped registry, analyze-only)"
(`evals/reports/latest.md:5`).

Therefore:

- **precision 96.4% and recall 79.3% are a measurement of a parser, an import-graph builder, and a
  set of confirmation heuristics.** They say nothing whatsoever about any model's quality.
- They are **not** a baseline against which a fine-tuned model could be compared, because no model
  arm has ever been run against this corpus.
- There is **no measurement of any model-mediated task anywhere in the product.** The optional LLM
  confirmation path exists and is off by default; the ReGauge adaptive-repair loop exists and is off
  by default.
- Consequently the program's own precondition — *if we cannot measure it, we are not ready to train
  for it* — is currently unmet for every model-mediated task.

These figures were mis-cited as model performance more than once before the `useLlm: false` line was
found. Any restatement of them must carry the qualifier. The recommended phrasing is: *"deterministic
impact-analysis pipeline, model disabled: precision 96.4%, recall 79.3% on 27 synthetic flag-files
scenarios."*

**What would measure the model:** a second graded arm on the Fettler runner with `useLlm: true`, plus
a `fettler-call-site-confirmation` capability authored in `readiness-gates.json`. The corpus, the
graders and the isolation already exist; this is a contained change confined to `evals/`.

### 8.2 Both runners are analyze-only — "would apply" is not "did apply and verified"

- The Fettler runner calls `analyzeImpact` and nothing else; `produced_edit: false`
  (`evals/runners/fettler-runner.ts:122`); its declared unmeasured dimensions are
  `migration_patch_correctness`, `verification_honesty`, `pr_delivery`, `token_cost / model_routing`
  (`:62-67`).
- The ReGauge runner calls `analyzeRecipe` over the registry and nothing else; `produced_edit: false`
  (`evals/runners/regauge-runner.ts:166`); declared unmeasured dimensions are
  `recipe_apply + verification_gate`, `idempotency`, `inverse/rollback`,
  `adaptive_repair token_cost / model_routing` (`:170-175`). Its imports carry no `child_process`,
  no `applyRecipe`, no `executeRecipeInWorkspace`.

Nothing in the suite installs a dependency, compiles a tree, or runs a subject repository's tests.
**"The migration is complete and the repository still installs" is structurally unrepresentable.**
Every ReGauge family gate above — including the three that now read PASS — measures the *analyze
decision* (refuse vs apply), not a verified applied result.

**What would measure it:** an apply-and-verify arm that runs `applyRecipe` /
`executeRecipeInWorkspace` in a fenced scratch copy, installs and builds the migrated tree, and grades
an independent fail-to-pass / pass-to-pass judge. The two graders required — compilation and
subject's-own-tests — are already specified and deliberately deferred
(`evals/graders/DEFERRED.md:8-28`), each noted as deterministic (exit code).

### 8.3 "Passed" is defined against current shipped behaviour

See §4.4. Six coverage gaps in the most recent run are counted as passes because abstention-by-absence
is correct for an unimplemented family. The headline pass rate is therefore not a capability rate.

### 8.4 The gate does not gate CI

`evals/runners/run-all.ts:274-276` exits non-zero only when `--enforce-readiness` is passed, and
`package.json:42` (`eval:synthetic`) passes no such flag. `.github/workflows/ci.yml:44-45` documents
this as deliberate: "The readiness gate is an instrument: it reports PASS/FAIL and does not block CI
(a corpus built to make the product fail cannot gate CI green)." The reasoning is defensible; the
consequence is that the build is green while the committed report reads `Overall readiness: FAIL`.

Also: on a GitHub-hosted runner, only the generated families run. The 21 hand-authored corpus
scenarios — including the scale case and the language-support cases that produce the honest recall
failure — require `MENDPOINT_CORPUS_ROOT` and are cleanly skipped, not failed
(`.github/workflows/ci.yml:36-49`). A nightly job on a runner that has the corpus runs the full set
(`.github/workflows/nightly-synthetic-eval.yml:33-39`).

### 8.5 The committed artifact can be stale relative to HEAD

Demonstrated today: the `main` scorecard reports three ReGauge families as FAIL at a commit that
predates the fix. Nothing in the pipeline forces regeneration on a change to `packages/transformer`
or `packages/code-impact`. Any number quoted from a committed report must be quoted with the report's
own `Git commit` line, which is why every table above carries one.

### 8.6 The corpus is entirely synthetic, and the one look at real repositories was bad

All 59/64 scenarios are synthetic. The single measured look at real repository shapes built 35 cases
from kinked shallow clones of express (`a3714473`), react-tutorial (`ec8d845a`) and next.js
(`6be68703`), and found **12 cases where the product was wrong and the eval was green**
(`C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md:193`). In four of them
`executeRecipeInWorkspace` produced a **signed `transformer.recipe.execution` evidence record with
both verification commands at exit 0** for a repository that no longer installs (`:203-210`).

That report also surfaced a structural finding just by cloning: the SDK and framework recipes
hardcode `allowedPaths` to exact filenames (`src/s3.js`, `src/client.js`, `src/index.tsx`), and no
real repository has those paths — express has 213 files and next.js 31,220, and neither contains one.
For any real consumer the residual case is the default, not an edge case.

PR #184's re-check reports **10 of the 12 fixed by PR #174, 2 still open** (the internal-API
residual, out of #174's scope), with the open case guarded by `reg-regauge-internal-api-acme-residual`
so it fails honestly as a P0 until the fix lands.

**The lesson for the benchmark is the one that matters most:** a suite can be rigorous, adversarial,
isolated, deterministic and self-honest, and still be structurally blind to the failure mode a
customer would hit first — because the blindness was in what the suite *invoked*, not in how it
graded.

### 8.7 The holdout is too small and too narrow to support a generalization claim

Four scenarios, one product, one family. It scores +33.3pp *above* development, which reads as the
holdout being easier rather than the product generalizing. See §3.2.

---

## 9. What is NOT measured

Recorded from the harness's own `unmeasured_dimensions` output and the scorecard's explicit
`not measured` block, with the experiment that would close each. None of these is gated on an
invented threshold.

| Dimension | Why unmeasured | Experiment that would measure it |
| --- | --- | --- |
| **Model quality on any task** | Both runners run the model-off path (`fettler-runner.ts:92`; `analyzeRecipe`) | A `useLlm: true` arm plus a capability in `readiness-gates.json` |
| **Post-apply verification** (ReGauge) | Analyze-only; nothing applies, installs, compiles, or tests | Apply-and-verify harness in a fenced sandbox with an independent fail-to-pass / pass-to-pass judge |
| **Migration-patch generation and PR delivery** (Fettler) | Needs a seeded DB, a sandbox, and GitHub credentials | Integration harness driving generation → repair → delivery on a synthetic repo |
| **Token cost, model routing** | No model is called, so these are genuinely null | A live-model lane feeding routing decisions and measured cost into the run record |
| **Retrieval quality (recall@k)** | The harness cannot see which files the model was shown, so "the required file was never retrieved" is undiagnosable | A retrieval benchmark recording the candidate set the product examined, scored against ground-truth impacted files |
| **Change-graph completeness and confidence calibration** | `gl_edges.confidence` is assigned by fiat and never validated against an outcome | Wire the zero-caller `runImpactBenchmark` and `evaluateConfidenceCalibration` (`packages/graph-learn`) into a scored eval |
| **Verification honesty** | A verifier refusal is indistinguishable downstream from a genuine test failure; the sandbox backend that ran is recorded nowhere (`packages/repair/src/verify-sandbox.ts:73-75`) | Capture per-check exit codes and backend identity; grade a refusal distinctly from a failure |
| **Scale / latency at a defined size** | `completes_within_budget` IS measured, but n = 1 | A scale ladder across the `filesExamined` axis; set a p95 budget from the measured curve |
| **Idempotency; inverse/rollback** | Apply-then-reapply and the inverse path are never run | Follows from the apply-and-verify harness |
| **Expected graph edges** | `analyzeImpact` returns confirmed sites, not the graph it built (`DEFERRED.md:30-37`) | Surface the constructed graph, or call `@mendpoint/call-graph` from the runner |
| **Evidence quality; modernization-plan safety** | Would require semantic judgement; no LLM grader exists by design | Implement the two written rubrics in `DEFERRED.md:47-65`, with inter-rater agreement measured first |
| **ReGauge site-level precision/recall; ReGauge holdout** | Apply path not exercised; holdout generation targets Fettler ref-rename families only | Apply-and-verify arm; extend `evals/generators/families.ts` to ReGauge families |

---

## 10. Reproducibility

Phase 34 requires that a benchmark result be reproducible from its record. Eight fields are named:
git commit, model version, dataset version, eval version, grader version, seed, config, timestamp.
Assessed against `RunRecord` (`evals/runners/types.ts:54-93`) and the run driver
(`evals/runners/run-all.ts`) as they stand at `ae42fb6`:

| Requirement | Recorded? | Where / why not |
| --- | --- | --- |
| **Git commit** | **YES** | `RunRecord.git_commit` (`types.ts:57`), from `git rev-parse --short HEAD` (`run-all.ts:36-41`), falling back to the literal `"unknown"`. Also written into the report and scorecard headers. |
| **Timestamp** | **YES** | `RunRecord.timestamp`, ISO 8601 (`types.ts:56`); report `Generated:` line. |
| **Model version** | **FIELD EXISTS, ALWAYS NULL** | `model` and `model_provider` (`types.ts:65-66`) are `null` on every committed record because no model is called (§8.1). The field is present and honest, but it has never carried a value. |
| **Config** | **PARTIAL** | `invocation_path` records the call chain and its key options as a **prose string** (`types.ts:63`; e.g. `"…analyzeImpact (useLlm:false, minConfidence:medium)"`). It is not a structured, machine-diffable config object, so two runs with different options are distinguishable only by string comparison. `evals/readiness-gates.json` carries `schema_version: 1`, which versions the thresholds but not the run configuration. |
| **Dataset version** | **NO** | There is a per-scenario `scenario_version` (`types.ts:61`, currently the literal `"1"` in both runners) but **no corpus-level dataset version or content digest**. The hand-authored corpus lives outside the repository at `MENDPOINT_CORPUS_ROOT` and is not pinned by hash, so a corpus edit is invisible in the record. |
| **Eval version** | **NO** | `product_version` is `mendpoint@<pkg.version>+<commit>` (`run-all.ts:44-50`) — the *product* version, not the harness version. Because `evals/package.json` declares itself "not a workspace", the harness has no independently meaningful version. In practice the git commit covers harness changes for in-repo runs, but there is no explicit field. |
| **Grader version** | **NO** | No grader version, digest, or schema number is recorded anywhere in the run record. A grader change that alters a score leaves no trace in the artifact other than the commit. |
| **Seed** | **PARTIAL, AND NOT IN THE RECORD** | Generated scenarios embed their seed in the scenario's `notes` prose (`evals/generators/families.ts:115,152,197`), so it is recoverable for generated families. The `RunRecord` has **no `seed` field**, and hand-authored scenarios have no seed at all. There is no top-level run seed. |

**Summary: 2 of 8 fully recorded, 3 partial, 3 absent.** The two that are fully recorded — commit and
timestamp — are the two that are cheapest to record, and the three that are absent — dataset version,
grader version, and a structured seed — are precisely the three that would let a reader detect
whether a score moved because the product changed, because the corpus changed, or because the grader
changed. Today those three causes are indistinguishable from the artifact alone.

**The smallest change that would close this:** add `dataset_digest` (a content hash over the resolved
corpus plus the ground-truth directory), `grader_version`, `harness_version` and `seed` to
`RunRecord`, and promote `invocation_path` from a prose string to a structured `config` object with
the prose retained for readability. All four are additive fields in `evals/runners/types.ts` and the
two runners.

---

## 11. What would have to be true before any of this is published

In order, because each depends on the one before it.

1. **A model arm exists and is graded.** Until then there is no model measurement to publish, only a
   deterministic-pipeline measurement that would be mis-read as one (§8.1).
2. **An apply-and-verify arm exists.** Until then "migration succeeded" cannot appear in any table
   (§8.2).
3. **Reproducibility fields are complete.** Dataset digest, grader version, seed (§10). A benchmark
   whose scores cannot be attributed to a cause is not a benchmark.
4. **The holdout is enlarged and covers both products.** Four scenarios of one family is not a
   generalization claim (§8.7).
5. **The corpus includes real repository shapes.** The one look at real shapes found twelve
   false-greens; a benchmark validated only against its own synthetic distribution has an unknown
   error bar against the distribution customers have (§8.6).
6. **The gate can block a merge, or the report states in its own header that it cannot** (§8.4).
7. **Overall readiness reads PASS on a run whose artifact matches HEAD** (§8.5).

Until all seven hold, the correct external description of this work is: *"an internal adversarial
benchmark with hidden ground truth and deterministic grading; current verdict FAIL; measures the
deterministic pipeline only."*

---

## 12. Source index

Every quantitative claim in this document, with its source.

| Claim | Source |
| --- | --- |
| 64 scenarios / 53 passed (83%) / 4 P0 / splits 45-9-6-4 | `evals/reports/latest.md` on `origin/claude/failure-to-eval` (PR #184), generated at `80bf1d2` |
| 59 scenarios / 45 passed (76%) / 7 P0 | `evals/reports/latest.md:11-15` on `origin/main` (`ae42fb6`), generated at `1d3ae5a` |
| precision 96.4% / recall 79.3% / 2 open P0 / +33.3pp holdout | `fettler-impact-analysis` gate table, both reports |
| Micro-averaged over 27 `flag_files` scenarios; FP rate 3.6% (4/111) | `evals/reports/readiness-scorecard.md`, Precision/recall and False-positive-rate rows |
| Gate thresholds 0.9 / 0.85 / 0 P0 / 10pp | `evals/readiness-gates.json` |
| Per-family ReGauge gate results (both runs) | `evals/reports/readiness-scorecard.md` on `main` and on PR #184 |
| Fettler family and difficulty pass rates | `evals/reports/latest.md`, "By repository family" / "By difficulty" |
| Latency min/median/p90/max | `evals/reports/latest.md`, "Latency" |
| `useLlm: false` | `evals/runners/fettler-runner.ts:92`; header `:15`; `invocation_path` `:49`; report line `evals/reports/latest.md:5`; `evals/runners/report.ts:211` |
| Analyze-only, both runners | `evals/runners/fettler-runner.ts:62-67,122`; `evals/runners/regauge-runner.ts:157-175` |
| Pass rule = safe-for-current-engine | `evals/graders/regauge-graders.ts:4-20,293-295` |
| No LLM judge | `evals/graders/fettler-graders.ts:12`; `evals/graders/regauge-graders.ts:4`; `evals/graders/DEFERRED.md:47-49` |
| Failure taxonomy and severity mapping | `evals/graders/taxonomy.ts` |
| Answer-key isolation | `evals/runners/isolation.ts:1-11`; `evals/runners/stage.ts`; `evals/runners/fettler-runner.ts:71-73` |
| Four dataset tiers | `evals/ground-truth/schema.ts:26-30,209-211` |
| Difficulty 1–5 with required rationale | `evals/ground-truth/schema.ts:118-121,192-200`; spec §18.5 |
| Corpus root outside the repo | `evals/scenarios/index.ts:18-20` |
| Seeds recorded in scenario notes | `evals/generators/families.ts:115,152,197` |
| CI wiring; gate does not block | `.github/workflows/ci.yml:26-27,38-49`; `evals/runners/run-all.ts`; `package.json:42` |
| Nightly full-corpus job | `.github/workflows/nightly-synthetic-eval.yml:33-39` |
| Deferred graders (compilation, subject tests, graph edges, verification honesty, semantic rubrics) | `evals/graders/DEFERRED.md:8-65` |
| 12 of 35 kinked cases product-wrong-eval-green; 4 signed exit-0 records; express 213 / next.js 31,220 files | `C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md:193,203-210`, §1 |
| 10 of 12 fixed by #174, 2 open | PR #184 description; corroborated by the regenerated family gates |
| Five declared migration families, four classifier-reachable | `packages/transformer/src/recipe.ts:3224-3229,3256-3283` |
| PR #174 = `428d9fa`, PR #179 = `80bf1d2`, PR #177 = `d90c571` | `git log origin/main` at `ae42fb6` |
| `npm run spec:check` → 84 requirements, spec 2.0; `npm run typecheck` → exit 0 | Run from this worktree at `ae42fb6` |

**Quantitative claims in this document that could not be sourced:** none. Every figure above is read
from a committed artifact, a cited source file, or a command run against this worktree. Three
*qualitative* facts are carried from the program's own record rather than proven here — that no
customer repository has been connected, that no production migration has run, and that the
production row counts for the outcome and routing tables are therefore zero. They are labelled as
owner-stated in `docs/intelligence/INTELLIGENCE_MOAT.md` §0 and do not affect any number reported
above, all of which come from the synthetic suite.

---

*Phase 33/3 analysis by Claude Code. Companion: `docs/intelligence/INTELLIGENCE_MOAT.md` (Phase 36).*
