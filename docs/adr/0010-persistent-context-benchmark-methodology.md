# ADR-0010: Persistent-context benchmark measures a mechanism deterministically

- **Status:** Proposed
- **Date:** 2026-08-21
- **Author:** Claude Opus (opus-coder)
- **Supersedes:** none
- **Superseded by:** none

## Context

The Mission Spaces programme rests on one claim: that giving an agent a compiled
persistent context (prior mission decisions, exceptions, reviewer corrections,
verification results, organization memory, policy envelope) makes it stop
repeating mistakes the organization has already resolved. That claim needed a
benchmark whose integrity matters more than its result.

Two facts constrained the design:

1. **The live envelope is gated off and not fully bound.** When this benchmark
   was designed (main @ `bd37545`) there was no Context Compiler at all. The
   Mission Context Compiler has since merged (ADR-0009,
   `packages/pipeline/src/mission-context-compiler.ts`,
   `docs/missions/CONTEXT_COMPILER.md`), and the injection seam exists in
   `packages/agent/src/agent.ts`. But it is gated behind
   `MENDPOINT_INHERITED_CONTEXT` (default off), and on the live Fettler dispatch a
   job is not bound to a mission, so the mission-scoped sections report
   `no_mission_bound` and only organization memory can reach the prompt. So the
   benchmark still cannot measure the mission-bound product end to end today; it
   measures the mechanism, and Section "Reconciliation" of the research doc maps
   the modeled envelope onto the real one, section by section.

2. **This repository's benchmarks have flattered themselves before.** The
   Graphify benchmark's headline advantage was entirely a label leak (a predictor
   closing over the sealed key and re-deriving a hidden attribute from case-id
   parity); an anti-overfitting gate could not mathematically fail; metrics
   returned flattering values on empty denominators. See
   `docs/reviews/2026-08-19-claude-review-response.md`.

A live-model A/B test was therefore neither available nor, on its own,
trustworthy without the same anti-leak machinery.

## Decision

The benchmark (`evals/context-benchmark/`) is **deterministic and models a
mechanism**, not a live product measurement.

1. **Two arms, one variable.** A fixed cohort of migration tasks is run twice.
   The task, the agent model, and the grader are identical. The only difference
   is inherited context: the stateless arm sees the immediate instruction and
   current files; the persistent arm additionally sees the compiled envelope,
   expressed as `KnowledgeItem`s in a "persistent" bucket. The agent is a pure
   function of `(public hazard, reachable items)` with no arm parameter and no
   access to the sealed answer key, so any measured difference is attributable to
   inherited context and to nothing else.

2. **Perfect-attention agent model, stated as a ceiling.** The synthetic agent
   applies reachable knowledge whenever it is present and falls to a naive
   default otherwise, resolving competing items through the real product
   precedence resolver (`resolveOrganizationDecision`). This makes the measured
   advantage a **ceiling** on what persistent context can buy, not a claim that a
   live model realizes any of it. Time to completion, model tokens, and cost
   require a live model and are reported as an explicit not-measured, never zero.

3. **Leak-proofing is structural.** The stateless arm's reachable set is the
   immediate bucket by construction; its choices are provably independent of
   whether a persistent bucket even exists. Case identifiers carry no signal (the
   report is invariant under id renaming and reordering). The sealed key is held
   apart from the cohort and reaches only the grader.

4. **Not-measured is a first-class failure.** Every rate over a zero denominator
   returns an explicit not-measured with a reason, never 1 and never 0, and every
   gate treats not-measured as FAIL.

5. **The cohort is deliberately mixed.** It includes scenarios where persistent
   context helps (prior resolutions genuinely live in mission history), one where
   it is pure bloat (neutral outcome, inflated tokens), and one where a
   confirmed-but-wrong memory makes the persistent arm worse. Arms, thresholds,
   scenarios, and fixtures were not tuned to produce a positive delta; the delta
   is a consequence of where the resolving knowledge is placed.

## Consequences

- The benchmark exists and runs with no live model and no network. A null or
  negative result is reportable and was made reachable by construction.
- No number it produces is a Mendpoint product claim under spec v3 §36.1. The
  research doc states plainly what is measured deterministically and what would
  require a live model.
- The natural successor is a live-model lane that reuses this cohort and sealed
  key unchanged and measures realized (not ceiling) repeat avoidance, plus real
  time and cost. That lane was out of scope for this decision and is not a
  precondition for this benchmark existing.
  **Update (2026-08-21):** that lane has since landed and run, in commit
  `0f66bde` (PR #276, "Pin the live host out-of-band, and measure the compiler
  against a real model"): `evals/context-benchmark/live-arm.ts` reuses the same
  `COHORT`, `SEALED_KEY`, and grader (`live-arm.ts:5,13,102`) and is driven by
  `evals/context-benchmark/run-live.ts`.
- The frozen acceptance gates (`docs/PRODUCT_REQUIREMENTS.json`,
  `evals/readiness-gates.json`) are untouched; this benchmark defines its own
  gates in its own module.
