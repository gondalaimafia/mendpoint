# MendPoint synthetic-repo evaluation suite

A deliberately adversarial evaluation harness for **Fettler** (API change →
impact) and **ReGauge** (legacy migration campaigns). Built to make MendPoint
fail on realistic messy repositories before design partners do — not to make a
demo look good.

See `docs/evals/current-system-map.md` for the product architecture and exactly
where this harness attaches.

## Layout

```
evals/
  scenarios/       run config + resolver (corpus + generated) -> runnable list
  ground-truth/    machine-readable answer keys (JSON) + schema + loader
  runners/         per-product runners (Phase 4) + staging + report + driver
  graders/         deterministic graders (Phase 5) + failure taxonomy (Phase 6)
  datasets/        model-learning dataset schema + builder (Phase 10)
  generators/      procedural scenario generators + families (Phase 8/13/14)
  mutations/       controlled-defect mutation engine (Phase 2/12)
  reports/         generated: latest.md, latest-runs.json
  FAILURES.md      generated failure backlog
```

## Corpus + generated scenarios

The suite runs two kinds of scenarios, unified by `scenarios/resolve.ts`:

- **corpus** — the 21 hand-authored repos under `MENDPOINT_CORPUS_ROOT`, ground
  truth in `ground-truth/*.json`.
- **generated** — procedurally expanded families (`generators/`), materialized to
  scratch per run, ground truth emitted automatically by the mutation engine.

The report presents results by `development` / `validation` / **holdout** split
separately; holdout is the honest product-quality signal (never inspected during
a fix). Build the learning dataset from a run with `tsx evals/datasets/build.ts`.

## Running

```
# full suite (writes evals/reports/latest.md, evals/FAILURES.md, latest-runs.json)
npx tsx evals/runners/run-all.ts

# one scenario, or one product
npx tsx evals/runners/run-all.ts --only fettler-ts-payments-rename
npx tsx evals/runners/run-all.ts --product regauge

# all eval unit tests (graders, staging, mutation engine, generators, dataset)
npx vitest run evals/

# build the learning dataset from the latest run (append-only, versioned)
npx tsx evals/datasets/build.ts

# typecheck just the eval sources (use the repo-local tsc, not npx)
node_modules/.bin/tsc -p evals/tsconfig.json
```

The corpus repositories live OUTSIDE this git repo (default `C:/Users/Talal/dev`;
override with `MENDPOINT_CORPUS_ROOT`). This keeps the answer key unreachable from
the repo under test.

## Answer-key isolation (do not break this)

Ground truth lives only in `evals/ground-truth/*.json` (corpus) or in memory
(generated), and is loaded only by the graders, after the product has produced
its output. It is never copied into a repo under test and never fed to the
product as context. `evals/scenarios/` holds run config (paths, slugs) but no
expected findings.

The prose keys are now handled by **staging** (`evals/runners/stage.ts`). Each
corpus repo also carries a human-readable `EXPECTED.md` (or
`SYNTHETIC_REPO_NOTES.md`) grading key **inside** the repo; those pre-date this
harness and the brief forbids modifying the corpus. So before ANY product sees a
repo, both runners copy it into scratch with the grading keys (and dependency/VCS
trees) excluded, and hand the product the staged copy. This closes the leak that
would otherwise let an LLM-enabled runner read its own answer key. `isAnswerKeyFile`
defines the excluded patterns; `stage.test.ts` asserts no answer-key file reaches
a staged tree (both hermetically and against every real corpus repo). The staged
tree mirrors what a product's own walkers index (it prunes exactly the
directories `classifyDependencyDirectory` prunes), so it never diverges from what
the product would see.

## No benchmark gaming

- No scenario-specific branches anywhere in product code or runners.
- Expected findings are never leaked into the product's input.
- A grader improvement only counts if it reflects a real, general capability.
- If a full run reveals no weaknesses, the corpus is too easy — say so.

## Adding a scenario

1. Create/point to a real, executable repository under `MENDPOINT_CORPUS_ROOT`
   (or copy an existing one to scratch if a run needs to mutate it — never modify
   the corpus in place).
2. Write the prose grading key next to it (`EXPECTED.md`) so a human can audit
   the answer key.
3. Add a machine-readable answer key `evals/ground-truth/<scenario_id>.json`
   conforming to `evals/ground-truth/schema.ts` (`validateGroundTruth` must
   pass; assign difficulty 1–5 with an explicit `difficulty_rationale`).
4. Register run config in `evals/scenarios/index.ts`.
5. Run the suite and confirm the scenario is graded as intended.

## What is and is not measured today

The runners exercise each product's deterministic analysis core (see the system
map). Dimensions that need the full generation/verification/delivery pipeline
(patch correctness, verification honesty, PR delivery), model economics (token
cost, routing — the analysis path makes no model calls), and apply-time
idempotency are recorded as **unmeasured** in `reports/latest.md` rather than
scored with fabricated numbers.
