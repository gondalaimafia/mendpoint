# Lesson Classification (Phase 9)

Route every validated failure to the **lightest** intervention that fixes it, and
make it *structurally impossible* to train a model around a deterministic bug.

## Input

A `ValidatedFailure` (see `classify.ts`): a diagnosed root-cause `FailureCategory`
(from `../graders/taxonomy.ts`, the canonical eval taxonomy — not reinvented here)
plus its `FailureEvidence`. The failure originates from the failure→eval path
(`evals/regression/`) and the graders; we link to the source record by id
(`RegressionCase` `reg-...` / `FAILURES.md` `FAIL-...`) and never embed the
separately-owned regression schema.

## Output

A `LessonClassification` (discriminated on `route`):

| route | meaning |
| --- | --- |
| `deterministic_fix` | an engineering fix (parser/graph/retrieval/tool/recipe/product logic). Never alters weights. |
| `non_training_fix` | a weight-eligible destination resolved with the lighter, non-weight fix (routing, calibration, prompt). |
| `model_training` | the only route that alters model weights. Emitted only when prerequisites are proven. |
| `no_action` | e.g. cosmetic reviewer edits — not preference data, so no training. |
| `unknown` | the evidence does not settle a destination. Names the missing evidence; asks for a human. Never a guess. |

## The eleven destinations

`MISSING_FACT · CONTEXT_FAILURE · HARNESS_FAILURE · TOOL_FAILURE · GRAPH_FAILURE`
are deterministic (weight training is not permitted). `OUTPUT_BEHAVIOR ·
PREFERENCE · SPECIALIZED_REASONING · LATENCY_COST · MODEL_LIMIT` are
weight-eligible (training is *possible*, always gated). `DETERMINISTIC_PATTERN`
routes to a recipe/rule, never a model.

## Why the critical rule is structural, not a comment

1. The intervention vocabulary is the canonical §17.4 `LearningDestination`
   (`@mendpoint/pipeline`). `NonTrainingIntervention = Exclude<…, "model_weight">`.
2. `model_weight` appears in exactly one result variant, `ModelTraining`, whose
   `destination` is a `WeightEligibleDestination`. A `DeterministicDestination`
   therefore *cannot be spelled* as a training route — it is a compile error.
3. `resolvePrerequisites` forces `notADeterministicDefect` to `false` whenever the
   evidence suspects a deterministic defect, so a model-shaped category (e.g.
   `MODEL_CAPABILITY_FAILURE`) that is really a parser bug is refused training even
   if the caller asserted every prerequisite.
4. `assertClassificationSound` is the runtime backstop against `as any` / JSON
   round-trips: it throws on a training route that targets a deterministic defect
   or skips its prerequisites.

## The real failures today (`real-failures.ts`)

- recall **79.3%** (< 85% gate) → parser/language-support defect → `TOOL_FAILURE`
  / `parser`. Not training.
- the same class **undiagnosed** (raw `FALSE_NEGATIVE`) → `unknown`, not a guess.
- vendored false positives (`FAIL-001/002`) → deterministic restraint fix
  (`DETERMINISTIC_PATTERN`). Not training.
- internal-API coverage gap (`FAIL-019`) → author a recipe. Not training.
- residual refusal (`FAIL-003..007`) → deterministic completeness fix. Not training.
- a *genuine* model limit with a stable eval, trustworthy reward, governed data,
  and no capable alternative model → `model_training`. The guard is discriminating,
  not blanket.

## Run

```
npm run eval:synthetic:check    # tsc -p evals/tsconfig.json --noEmit && vitest run evals
```
