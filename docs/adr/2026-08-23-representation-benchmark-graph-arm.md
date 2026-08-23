# Measured deterministic Change Graph arm in the representation benchmark

- **Status:** Accepted
- **Date:** 2026-08-23
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §11.21 / §18.6.1 require a controlled representation experiment that holds task, model, and harness constant and varies only the CONTEXT SOURCE — raw retrieval (arm A) vs a Change Graph projection (arm B), plus an independent verifier (arm C). `evals/runners/run-arms.ts` declared arms A/B/C but reported B and C **not measured**, with arm B's blocker recorded as "the projection is not routed through this runner." No arm actually exercised the Change Graph, so the central v4 thesis — that a graph projection changes impact precision/recall vs raw retrieval — was untested.

The Change Graph projection is available deterministically: `analyzeImpactWithSoftwareGraph` (`packages/code-impact/src/index.ts`) builds an immutable software-graph version from the repository index and answers the Fettler endpoint-impact question by graph traversal, with the model OFF.

## Decision

Add a **measured deterministic** representation arm and route it through the graph path, so the honestly-measurable half of the experiment runs today.

- New arm `B0` (`ARM_B0_GRAPH_ANALYSIS_CORE`): Change Graph projection + analysis core (Muse off). `det` (raw retrieval, Muse off) vs `B0` isolates the representation variable on the deterministic core, holding the model constant at "off".
- `evals/runners/fettler-graph-runner.ts`: `runFettlerWithGraphProjection` routes the same scenario through `analyzeImpactWithSoftwareGraph`, extracts flagged files from the graph traversal, and grades them with the SAME `gradeFettler` grader as the raw arm.
- Honest coverage handling: two PURE, unit-tested functions decide the outcome. `flaggedFilesFromGraphImpact` derives repo files from repository-scoped entity `canonicalKey`s (`filePath::kind::name`), excluding provider entities. `graphImpactMeasured` reports MEASURED only when the changed endpoint resolved and coverage is not `target_absent`; otherwise the arm is **not-measured with a reason** — a missing graph is never averaged in as a fabricated zero.
- Arms B (graph + Muse) and C (graph + Muse + verifier) remain not-measured: they need the live Muse lane / the independent verifier. Arm B's blocker text is updated to state the projection is now routed (as B0) and that arm B is the same projection *with* Muse.

Running the driver on the in-tree generated Fettler scenarios shows `B0` **MEASURED** per scenario (the graph resolves the changed endpoint), producing the deterministic representation comparison. Corpus-absent hand scenarios are skipped as before; scenarios not assigned to a task family aggregate into no family micro-average (this affects `det` identically), so the raw measured per-scenario results live in the payload while family-level aggregation awaits corpus task-family annotation.

## Alternatives considered

- **Measure arm B (graph + Muse) directly.** Deferred: it additionally requires the live Muse lane (same gate as arm A). B0 is the deterministic slice that needs neither the live model nor the verifier, so it is measurable now without faking.
- **Report a graph coverage facet only, without a graded arm.** Rejected: the graph entity `canonicalKey` cleanly yields flagged files, so a real graded arm — comparable to the raw arm through the same grader — is both achievable and more faithful to §11.21 than a bare coverage number.
- **Grade the graph arm even when the endpoint target is absent.** Rejected: that would fabricate an all-miss result and average a no-coverage scenario in as a zero, exactly what the arm framework exists to forbid. Not-measured with a reason is the honest outcome.

## Security impact

None. Evaluation-only code (a runner, two pure functions, an added arm descriptor). No product, persistence, network, or trust-boundary change. The graph is built in an ephemeral in-memory store and closed per scenario. Answer-key isolation is unchanged (the runner stages the repo through the existing `withStagedRepo`).

## Data and compatibility impact

Additive to the evals package. One new arm in `REPRESENTATION_ARMS` (the report renders N arms), a new runner module and its tests. The generated report artifacts (`evals/reports/representation-arms.*`) are regenerable outputs and are not committed.

## Migration plan

1. Add the arm descriptor and the graph runner with its pure, unit-tested extraction/coverage functions.
2. Route arm B0 in `run-arms.ts`; update arm B's blocker text and the summary.
3. Run the graph-runner and arms tests and the evals typecheck; run the driver end to end to confirm B0 measures where the graph resolves.

## Rollback

Revert the commit. Removing arm B0 returns the report to A/B/C-not-measured; nothing else depends on the runner.

## Evaluation plan

Success is the pure extraction/coverage functions and the arms honesty tests passing, the evals typecheck green, and the driver reporting `B0` measured on scenarios where the graph resolves and not-measured (with a reason) elsewhere. The follow-on that would measure arms B and C is the live Muse lane and the independent verifier; task-family annotation of the generated corpus would let the det-vs-B0 comparison aggregate into family micro-averages.
