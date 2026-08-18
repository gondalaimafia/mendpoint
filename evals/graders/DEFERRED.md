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

## Expected-graph-edges / relationship-path grader — SHIPPED (was: product does not expose the graph)

- Status: implemented in `import-chain-graders.ts` (`gradeImportChain`). The
  blocker recorded here is gone.
- What unblocked it: PR #200 added `GraphPath` to `ImpactFindingSchema` /
  `ConfirmedImpactSchema` (`@mendpoint/shared`) — the provider->code path
  (`nodes` anchor-first, `terminal` ∈ anchor|cycle|max_hops, `coverage`
  complete|partial) behind each material finding. `analyzeImpact` populates it
  (`buildProviderReachability` -> `anchorPathTo`), so the path IS in the report
  now. The eval runner previously mapped `report.sites` down to file paths and
  discarded the path; it now persists it on `RunRecord.findingGraphPaths`.
- The other half of the blocker (not previously recorded): the prose
  `blast_radius_truth.importChain` was never a gradable key. It is deliberately
  prose of inconsistent granularity (directories, basenames, class names, whole
  sentences) and inconsistent orientation, read only for its hop COUNT by
  `task-family.ts`. Parsing file identities out of it would contradict that
  module's deliberate choice. So a NEW structured key was added alongside it —
  `blast_radius_truth.importChainPaths` (anchor-first full posix paths,
  hand-derived from fixture source, never from product output) — and the grader
  compares emitted `GraphPath.nodes` to it.
- What it grades: does the emitted path reach the expected ANCHOR; are the
  intermediate hops correct and IN ORDER (right file by the wrong route is not a
  correct explanation); is a path emitted at all where the key expects one.
- Honest absence / bounded: a finding with NO `graphPath` is `absent`
  ("not computed"), never graded as wrong; a `cycle`/`max_hops` path is graded
  against the suffix its bound permits, never treated as a false result.
- Non-gating: disagreements are classified into the existing taxonomy
  (`GRAPH_CONSTRUCTION_FAILURE`, never P0) but kept out of the gating
  `passed`/`failures` channels, so readiness gates and existing verdicts are
  unaffected. It is a measurement channel, reported in `reports/latest.md`.
- Coverage today: only 5 of 21 scenarios carry a structured key (the multi-file
  rename fixtures); `node-cjs` is intentionally unkeyed because its cross-file
  relationship is runtime dependency injection, not a static import chain, so no
  linear import path exists to grade. A small denominator by design.
- Deterministic: yes.

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
