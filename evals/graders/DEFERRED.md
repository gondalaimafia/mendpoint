# Deferred graders

The spec's Phase 5 lists several deterministic graders beyond the four this slice
implements (expected-findings recall, precision, false-positive traps,
abstention/no-op correctness, plus the ReGauge recipe-decision graders). The rest
are deferred for a concrete reason, recorded here rather than faked.

## Compilation grader — deferred (no migrated tree yet)

- Why: the runners are analyze-only. They do not apply a migration, so there is
  no post-migration tree to compile. Grading compilation requires the Fettler
  generation path (`@mendpoint/generation`) or ReGauge `applyRecipe`, plus a
  workspace to compile in.
- When to add: alongside a runner that applies the produced patch/recipe in a
  scratch copy of the repo (never the corpus in place) and runs the subject's
  `npm run check` / `tsc` / `go build` / `mvn compile`.
- Deterministic: yes (exit code).

## Subject's-own-tests grader — deferred (needs apply + sandbox)

- Why: same reason — there is no migrated tree, and running arbitrary subject
  test commands needs the fenced verification sandbox
  (`packages/repair/src/verify-sandbox.ts`, fail-closed). Each corpus repo ships
  a baseline-green `npm test` / `node check.mjs`; the grader would apply the
  migration and assert the suite stays green.
- Deterministic: yes (exit code + test counts).
- Note: this is exactly what the `partial-campaign` idempotency check needs
  (apply, assert green, re-apply, assert zero diff).

## Expected-graph-edges grader — deferred (product does not expose the graph)

- Why: `analyzeImpact` returns an `ImpactReport` (confirmed sites), not the raw
  call/import graph it built. `ExpandedContext` carries `graphCallers`/`wrappers`
  internally but is not surfaced in the report. Grading expected edges (from
  `blast_radius_truth.importChain`) requires the product to expose its
  constructed graph, or the runner to call `@mendpoint/call-graph` directly.
- Deterministic: yes, once the edges are observable.

## Verification-honesty grader — deferred (path not exercised)

- Why: the `no-test-command` weakness (fabricating "tests passed" when nothing
  ran) lives in the verification step, which the analyze-only path never reaches.
  Needs the generation+verification pipeline.
- Deterministic: yes (assert the verification report says "cannot verify" when no
  runnable command exists; assert it never prints a green result with zero tests).

## Semantic graders — none used in this slice; rubric sketch for later

No LLM grader is used here; every dimension above is deterministic. Two
dimensions would genuinely need semantic judgment later, and each must ship with
an explicit rubric (never "the answer seems reasonable"):

- **Evidence quality** (Fettler finding rationale). Rubric: score 0/1 on each of
  — cites the specific file+symbol; names the surface it maps to; states the
  import/call path to the provider anchor; distinguishes wire field from
  same-spelling distractor. Pass = 3/4+. Graded from the finding's evidence
  fields, not free prose.
- **Modernization-plan safety** (ReGauge proposed sequencing). Rubric: score
  each proposed step on — preserves behavior (has a stated invariant); ordered
  after its dependencies; names a rollback; touches no declared
  untouched-subsystem. Any step failing "preserves behavior" or "touches
  untouched-subsystem" fails the plan.

Until those are implemented, the corresponding dimensions are reported as
unmeasured in `reports/latest.md`, not scored.
