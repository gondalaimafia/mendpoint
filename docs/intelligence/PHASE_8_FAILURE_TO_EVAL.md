# Phase 8 (failure → eval) and Phase 2 (gate coverage)

**Status:** implemented. Descriptive of what the code does, with `path:line` for every
load-bearing claim.
**Commit under test:** `80bf1d2` (`origin/main`) — post-#174 (residual detection in all
repo-global recipe families) and post-#179 (per-family ReGauge readiness gates).
**Scope of this change:** `evals/` and this file only. Trajectory capture, the learning
landing zone, and the research docs are owned elsewhere.

This document covers two things the intelligence-ownership program needs before any
post-training: a way to turn a validated failure into a permanent regression eval
(Phase 8), and honest gate coverage across capabilities (Phase 2, blocker #6).

---

## 1. The failure → eval path (Phase 8)

A validated failure becomes a regression eval through one pipeline, implemented under
`evals/regression/`:

```
failure  →  redaction / governance  →  reproducible task  →  grader  →  new evaluation  →  regression suite
```

| Step | Where |
| --- | --- |
| failure (auditable provenance) | `evals/regression/cases.ts` (`RegressionCase.provenance`) |
| redaction / governance gate | `evals/regression/governance.ts` (`assertAdmissible`) |
| reproducible task (in-memory repo + machine-readable answer key) | `evals/regression/cases.ts` (`RegressionCase.build`) |
| grader (existing deterministic graders) | `evals/graders/*` |
| new evaluation (regression split) | `evals/regression/build.ts` (`regressionScenarios`) |
| regression suite (runs every eval) | `evals/generators/families.ts` (`generateAllScenarios`) |

Design notes:

- **Governance is enforced, not decorative.** A case may enter the committed suite only
  if its data provenance is certified (`synthetic`, or `redacted-from-customer` **with** a
  redaction reference) and it carries no customer data; the gate throws otherwise
  (`governance.ts`). This is the seam where a failure found on a real customer repo would
  be reduced to a synthetic reproduction before it could ever be committed.
- **Answer-key isolation is preserved end to end.** The governance gate refuses a
  reproducing repo that contains a grading-key file (`governance.ts`, using
  `runners/stage.ts:isAnswerKeyFile`), and every scenario is still staged through
  `runners/stage.ts` before the product sees it. A generated regression eval can never leak
  its key to the product under test.
- **The `regression` split already exists** in the ground-truth schema
  (`evals/ground-truth/schema.ts` `DatasetSplit`, spec §18.9); this change makes it
  fully functional. `evals/datasets/schema.ts:122` still rejected `regression` when the
  ground-truth schema accepted it — a latent inconsistency that would have failed any
  dataset build seeded from a regression scenario; this change fixes it.
- **The suite self-checks the catalog.** Each case records what the *current* engine does
  with it (`fixed` / `open`). `evals/regression/regression.test.ts` runs the real analyze
  path for every ReGauge case and asserts reality matches the record, so a stale catalog
  fails the test suite. This is the "re-check, don't assume" rule encoded as a test.

### Honest limitation (do not over-read a regression pass)

Both runners are **analyze-only**: `evals/runners/regauge-runner.ts` calls `analyzeRecipe`
and stops; `evals/runners/fettler-runner.ts` calls `analyzeImpact` with `useLlm: false`.
Neither applies a migration, installs dependencies, compiles, or runs a subject repo's
tests. A regression eval here proves the engine's **decision** (refuse vs. apply), **not**
that an applied migration compiles or that a subject repo still installs. "Would refuse"
is not "did apply and verified." Closing that is Phase 2 blocker #5 (an apply-and-verify
sandbox harness), recorded in the not-measured backlog below.

---

## 2. Which real failures were converted, and the re-check of the 12 OSS cases

The catalog (`evals/regression/cases.ts`) is seeded from the OSS validation
(`C:/Users/Talal/dev/oss-kinked/VALIDATION-REPORT.md`, which found 12 cases where the
product was wrong and the eval was green, all measured on `1d3ae5a` — *before* #174/#179).
This change **re-checks** those against the current engine rather than assuming.

| Regression case | OSS idiom | Result on current engine | Status |
| --- | --- | --- | --- |
| `reg-regauge-runtime-platform-residual` | K3 `FROM --platform=… node:20` residual | analyze → `incomplete` → refuse | **fixed by #174** |
| `reg-regauge-runtime-digest-residual` | K4 `FROM node:20@sha256:…` residual | analyze → `incomplete` → refuse | **fixed by #174** |
| `reg-regauge-runtime-nested-engine-residual` | K5 nested `engines.node: ^20` residual | analyze → `incomplete` → refuse | **fixed by #174** |
| `reg-regauge-aws-vendored-residual` | K7 vendored `require("aws-sdk")` residual | analyze → `incomplete` → refuse | **fixed by #174** |
| `reg-regauge-internal-api-acme-residual` | case 6, un-renamed `getUser` consumer residual | analyze → `applicable` → P0 | **still open** |

### The 12 OSS cases, mapped to their fate under #174

Verified by reading the current engine (`packages/transformer/src/recipe.ts`) and by
running the analyze path (`evals/regression/regression.test.ts`, plus the SDK/framework
residual scenarios in the family suite):

- **Genuinely fixed by #174 (10 of 12).**
  - SDK residuals — cases 1 (aws), 2 (stripe), 3 (googleapis): `isResidualSite` now
    classifies a surviving source-state file for each SDK family
    (`recipe.ts:3640-3649`). Confirmed PASS in the family suite (`regauge-sdk-migration`
    residual_refusal 3/3).
  - Framework residual — case 4 (react-dom): same source-state residual scan
    (`recipe.ts:3650-3652`). Confirmed PASS (`regauge-framework-migration` residual 1/1).
  - Vendored aws — case 5 (K7): `vendor/` is scanned (`isExcludedFromResidualScan` excludes
    only lockfiles/`node_modules`/`.git`, `recipe.ts:3566`) and a surviving `aws-sdk`
    import is residue (`AWS_SDK_MODULE_IMPORT`, `recipe.ts:3557`). Guarded by
    `reg-regauge-aws-vendored-residual`.
  - Runtime idioms — cases 8-10 (nested non-canonical `engines.node`), 11 (`--platform`),
    12 (`@sha256`): the shared Dockerfile parser now tolerates a build flag and a digest
    pin (`dockerNodeMajors`, `recipe.ts:3533-3537`), and the nested-manifest guard matches
    on pinned major rather than exact selector (`recipe.ts:3637-3638`). Guarded by the
    three `reg-regauge-runtime-*-residual` cases.
- **Still open (2 of 12).** Cases 6 and 7 (internal-API residual). `isResidualSite` still
  returns `false` for every `internal_api_*` precondition kind (`recipe.ts:3653`), so an
  extra consumer left on the old name classifies as a clean `applicable`. `#174`'s own
  message scopes it to "aws-sdk, stripe, googleapis and react-dom"; internal-API was out
  of scope. Case 6 is guarded (and fails honestly) by
  `reg-regauge-internal-api-acme-residual`; case 7 (a monorepo variant) is the same root
  cause and is not separately reproduced.

This matches the per-family readiness verdicts exactly: `regauge-sdk-migration` and
`regauge-framework-migration` flipped FAIL→PASS under #174, runtime held PASS, and
`regauge-internal-api-migration` stayed FAIL because its fix was out of #174's scope.

### The Fettler failures (recall 79.3%, 2 open P0)

The two Fettler P0s (`gen-fettler-genvendor-both`, `gen-fettler-genvendor-vendored-only`)
are false-positive failures where impact analysis flags a vendored/generated copy it must
not touch. They are already permanent development-split guards, surfaced in `evals/FAILURES.md`
and in the `fettler-impact-analysis` `open_p0` count. The failure → eval pipeline is
product-agnostic (the schema and converter support Fettler), but those two P0s are
deliberately **not** cloned into the regression split: doing so would double-count an
already-permanent guard and perturb the Fettler micro-averaged precision/recall the
readiness gate reads. The recall gap (79.3% < 85%) is driven by the language corpus
scenarios (go/java/python/node-cjs/ts-monorepo) where recall collapses — a coverage
limitation, not a regression, and it keeps `fettler-impact-analysis` honestly FAIL.

---

## 3. Gate coverage (Phase 2, blocker #6)

Phase 0 found readiness gates covered **1 of 17** capabilities; #179 added the 4 ReGauge
families (5 of 17). This change adds one more genuinely-measured capability and records the
rest honestly.

### Added: `fettler-abstention` — gated on a real measured dimension

A **distinct** capability from `fettler-impact-analysis`: impact analysis is scored on
`flag_files` recall/precision; abstention scores whether the product correctly does
**nothing** on the scenarios where nothing is the right answer — an ambiguous rename
(≥2 plausible successors) or an already-migrated repo. Acting confidently on either is a
P0. It pools the abstain + no_op Fettler scenarios that the impact gate deliberately
excludes (`evals/readiness.ts` `evaluateFettlerAbstention`), gated precision-first
(`abstention_correctness_min: 1.0`, `max_open_p0: 0`). It has real signal today (4 abstain
+ 2 no_op scenarios) and PASSES; it is included so a future regression that makes the
product act on ambiguity fails the gate immediately, and it is kept separate so restraint
can never be traded off against recall.

**Gated capabilities now (6):** `fettler-impact-analysis`, `fettler-abstention`,
`regauge-runtime-migration`, `regauge-sdk-migration`, `regauge-framework-migration`,
`regauge-internal-api-migration`.

### Recorded not-measured, with the experiment (never an invented threshold)

The rest are recorded in `evals/readiness-gates.json` under `not_measured` and rendered in
the scorecard, each with the smallest change that would make it gateable. No capability is
gated on a fabricated number.

| capability | why not measured | experiment | owner |
| --- | --- | --- | --- |
| regauge-apply-verification | runners are analyze-only; no apply/install/build/test | apply-and-verify sandbox harness (blocker #5) | Claude |
| fettler-migration-generation-and-delivery | generation/repair/delivery lane not invoked | seeded-DB + sandbox + delivery integration harness | Shared |
| model-routing-cost-and-tokens | model off on both paths; genuinely null, not measured | live-model eval lane | Shared |
| retrieval-quality | recall@k has no denominator; the shown file-set is unobservable | retrieval benchmark with a real denominator (blocker #10) | Claude |
| change-graph-completeness-and-confidence-calibration | edge confidence assigned by fiat, never validated | wire the zero-caller `runImpactBenchmark`/`evaluateConfidenceCalibration` | Codex |
| verification-honesty | exit-126 refusal indistinguishable from a test failure; backend unrecorded | capture per-check exit codes + sandbox backend | Shared |
| fettler-scale-latency | measured but n=1; a single large repo cannot justify a budget threshold | scale ladder across repo sizes | Claude |

---

## 4. Effect on the suite and the readiness verdict

Adding the 5 regression scenarios grows the suite (4 new PASS guards + 1 honest open FAIL)
and the new `fettler-abstention` gate reports its own verdict. The **overall readiness
verdict stays FAIL** — legitimately — for two independent reasons unchanged by this work:
`fettler-impact-analysis` recall is 79.3% (< 85%) with open false-positive P0s, and
`regauge-internal-api-migration` residual detection is still open. A gate that fails
honestly is the intended deliverable; nothing here was tuned to make anything pass. The
exact per-run numbers are in `evals/reports/latest.md` and
`evals/reports/readiness-scorecard.md`.
