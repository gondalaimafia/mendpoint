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
  scenarios/       run config: scenario_id -> product, repo path, spec, slug
  ground-truth/    machine-readable answer keys (JSON) + schema + loader
  runners/         per-product runners (Phase 4) + report generator + driver
  graders/         deterministic graders (Phase 5) + failure taxonomy (Phase 6)
  datasets/        structured model-learning dataset seed (Phase 10 scaffold)
  generators/      procedural scenario generators (Phase 8 scaffold)
  mutations/       controlled-defect mutation engine (Phase 2 scaffold)
  reports/         generated: latest.md, latest-runs.json
  FAILURES.md      generated failure backlog
```

## Running

```
# full suite (writes evals/reports/latest.md, evals/FAILURES.md, latest-runs.json)
npx tsx evals/runners/run-all.ts

# one scenario, or one product
npx tsx evals/runners/run-all.ts --only fettler-ts-payments-rename
npx tsx evals/runners/run-all.ts --product regauge

# grader unit tests
npx vitest run evals/graders/graders.test.ts

# typecheck just the eval sources
npx tsc -p evals/tsconfig.json
```

The corpus repositories live OUTSIDE this git repo (default `C:/Users/Talal/dev`;
override with `MENDPOINT_CORPUS_ROOT`). This keeps the answer key unreachable from
the repo under test.

## Answer-key isolation (do not break this)

Ground truth lives only in `evals/ground-truth/*.json` and is loaded only by the
graders, after the product has produced its output. It is never copied into a
repo under test and never fed to the product as context. `evals/scenarios/` holds
run config (paths, slugs) but no expected findings.

Caveat about the prose keys: each corpus repo also carries a human-readable
`EXPECTED.md` (or `SYNTHETIC_REPO_NOTES.md`) grading key **inside** the repo.
Those pre-date this harness and the brief forbids modifying the corpus. The
deterministic path here does not consult them (verified: no `.md` answer-key file
appears in any product finding, and Fettler runs with `useLlm:false`). A future
LLM-on runner MUST exclude these files from what the product sees — copy the repo
to scratch minus the answer key — or an LLM could read the answer off the prose
key. This is the one isolation gap to close before enabling LLM runs.

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
