# ADR-0002: Evidence sequencing for routing and recipe selection

- **Status:** Proposed
- **Date:** 2026-08-17
- **Author:** Claude Code
- **Supersedes:** none
- **Superseded by:** none

## Context

Mendpoint computes its evidence *downstream* of the decisions that need it. This is one architectural fact with four observable consequences, each verified against current `main`.

**The router chooses an executor before impact analysis exists.** Impact is a product of the attempt, not an input to it: `apps/worker/src/warden-pilot-join.ts:120` reads `result.impactReport` off a completed run, and the campaign the router dispatches — `TransformerRunnableCampaign` (`packages/transformer/src/pilot-execution.ts:540-548`) — carries only tenant, repository, snapshot, and artifact identifiers. It has no coverage, risk, or blast-radius field. So §13.7's "escalate when graph coverage is incomplete for high-risk work" has no upstream source at the point escalation must fire. PR #161 (`packages/platform/src/router.ts`) landed the router-side mechanism: optional `product`/`blastRadius`/`coverage` on `RouterTaskSpec` (`router.ts:99,105,113`) and a `graph_coverage_incomplete` escalation reason (`router.ts:369`) that fires only when `coverage` is explicitly present and incomplete (`router.ts:466-483`). The code comments state plainly that no production caller supplies `coverage` yet because the router runs before impact analysis (`router.ts:107-112,470-476`). The mechanism is in place; the source that would drive it is not.

**Recipe selection has the same shape.** At `packages/transformer/src/mission-planner.ts:138-141`, a recipe is chosen when its source/target match and `analyzeRecipe(...)` over `repository.files` returns `applicable`. The only signals available on that path are file text, file digests, CODEOWNERS ownership, and opaque provenance refs (`TransformerMissionPlanningRepository`, `mission-planner.ts:20-34`). `packages/transformer/package.json` declares zero dependency on `@mendpoint/call-graph`, `@mendpoint/graph`, `@mendpoint/graph-learn`, or `@mendpoint/code-impact`. So §14.3's "recipes MUST NOT be applied merely because code text resembles a known pattern" is not met structurally, not by oversight.

**The graph that does exist is the wrong shape for this.** `graph-learn`'s blast-radius query (`packages/pipeline/src/index.ts:662-712`) is a cross-repo API-dependency graph, keyed by `change:${changeId}` (`index.ts:708`) and built from control-plane spec-diff ingest (`ingestControlPlane`/`ingestSpecDiff`, `index.ts:669-699`). It answers "which registered consumers does this provider change reach." It cannot answer "is symbol X genuinely reached inside this repository snapshot."

**The right primitives exist and are unwired.** `@mendpoint/call-graph` exports `buildCallGraph` (`packages/call-graph/src/build.ts:457`), `ReachabilityHit` (`packages/call-graph/src/types.ts:198`), and `ImpactSubgraph`, all re-exported from `packages/call-graph/src/index.ts:18-26`. Nothing on the mission path constructs one from a snapshot.

Today the system fails safe. The mission planner abstains when a recipe is ambiguous or evidence is invalid (`mission-planner.ts:134-148`), and the router escalates rather than guessing when coverage is present and incomplete. So this is not an active-harm situation. It is a capability and conformance ceiling: §13.7's escalation cannot fire from production, and §14.3 is not satisfied. §32 lists "router policy architecture" among the twelve ADR-gated categories, and §11.7 makes graph incompleteness a first-class state, so the sequencing choice is an owner decision recorded here rather than an implementation detail.

## Decision

This ADR does not itself decide. It records the sequencing problem as an owner decision and places four candidate directions before the owner. The decision owed is: **how, and how early, Mendpoint should produce per-snapshot reachability evidence relative to the routing and recipe-selection decisions that would consume it** — or whether to accept the current ceiling and document it.

The four candidates are summarized below and weighed in full under Alternatives considered. Whichever is chosen, the current fail-safe posture (abstain, do not guess) is the floor and must not regress.

- **A — Pre-routing coverage estimate.** Compute a cheap coverage/blast-radius summary before routing and attach it to `RouterTaskSpec.coverage`.
- **B — Two-phase routing.** Route provisionally, run impact analysis, then re-evaluate and escalate on the real evidence.
- **C — Per-snapshot graph at load time.** Build a call/import graph over the repository snapshot when it is loaded, and make it available to both routing and recipe selection.
- **D — Accept the limitation and document it.** Keep decisions text- and heuristic-based, state in-product that recipe applicability is not graph-confirmed, and rely on abstention plus verification.

## Alternatives considered

**A — Pre-routing coverage estimate.** A cheap analysis pass produces a coverage basis and blast-radius summary before the routing decision, feeding the `coverage`/`blastRadius` fields PR #161 already defined. *Closes:* the router-source gap — §13.7's `graph_coverage_incomplete` escalation gains a production trigger — and it exercises `@mendpoint/call-graph` (the fourth finding). *Leaves open:* §14.3, unless the same estimate is also threaded into `mission-planner.ts:138-141`; and the graph-shape gap, since an estimate is not the per-snapshot reachability graph. *Costs:* added latency on every routed task; the estimate is least reliable in exactly the ambiguous, high-risk cases where escalation matters most, risking either false escalation or false confidence; and it introduces a new cross-package dependency into the routing path.

**B — Two-phase routing.** Route provisionally, run impact analysis, then re-evaluate and escalate if the real `impactReport` warrants it — using evidence that already exists downstream (`warden-pilot-join.ts:120`) rather than estimating it upfront. *Closes:* the router-source gap with real rather than estimated evidence. *Leaves open:* §14.3, because recipe selection still runs before impact exists; and it does not by itself build the per-snapshot graph. *Costs:* routing today is a pure, replayable function with a deterministic fingerprint (`router.ts:299-314` policy-bound route, `router.ts:787` task identity, `router.ts:993-1010` canonical-JSON fingerprint); a second, post-impact decision means two decisions per task to audit and replay, and the decision ledger and replay model must represent both without breaking determinism. A task can also be dispatched to a weak executor before the escalation fires, so the first-phase route must stay conservative.

**C — Per-snapshot graph at load time.** Construct a call/import graph over the repository snapshot when it is loaded, using `@mendpoint/call-graph`, and make reachability available to both routing and recipe selection. *Closes:* the most findings — §14.3 (selection can require graph/context evidence), the router-source gap (coverage becomes real and available pre-routing), the unwired-primitive finding, and it builds evidence of the right shape rather than the cross-repo API graph. *Leaves open:* nothing structural, though it does not retroactively change how `graph-learn` is used elsewhere. *Costs:* expensive at the snapshot ceiling (up to 10k files / 50MB per the sandbox limits); a new cross-package dependency into `packages/transformer`, which today has none on the graph packages; it needs an evidence-kind vocabulary so coverage bases are named consistently across routing and selection; and it is the largest change of the four.

**D — Accept the limitation and document it.** Keep routing and selection text- and heuristic-based, state explicitly in the product that recipe applicability is not graph-confirmed, and rely on the existing abstention and verification behavior to catch errors. *Closes:* nothing; it makes the ceiling honest rather than removing it. *Leaves open:* §14.3 remains a documented `MUST` that is not met, and the `coverage` channel added in PR #161 stays partly ornamental at the decision layer. *Costs:* the conformance gap persists and is now on record as accepted; any design partner who reads §14.3 will see the divergence. The upside is zero added latency, zero new dependencies, and no change to the replay model.

**Do nothing (leave undecided).** Rejected as a resting state: §32 gates this decision, and PR #161 deliberately shipped the mechanism without a source, which only makes sense if the source question is decided next rather than left open indefinitely.

## Security impact

None of the options changes authentication, authorization, tenancy isolation, or secret handling. Two notes on trust boundaries. Option C introduces a new code path that parses repository snapshot content to build a graph; that content is already inside the sandbox trust boundary, but graph construction over untrusted repository code must stay within the same resource and isolation limits as the rest of snapshot handling and must not follow symlinks or execute code. Options A and B change *when* a decision is made but not *who* may make it; the tenant-scoping already enforced on snapshots (`warden-pilot-join.ts:126-139`) and on the graph-learn blast query (`packages/pipeline/src/index.ts:700-712`) must be preserved by any pre-routing or two-phase variant. Any new coverage source must be tenant-scoped at construction.

## Data and compatibility impact

The `RouterTaskSpec` fields that A and B would populate are already optional and already part of the deterministic fingerprint when present (`router.ts:95-113`), so supplying them is backward compatible: routes computed without coverage keep their existing fingerprint, and routes computed with coverage produce a new, honestly different fingerprint. That is the intended behavior, but it means historical routing decisions are not comparable byte-for-byte to post-change ones — replay must key on the inputs that were actually present. Option B additionally requires the decision ledger to represent two decisions per task; that is a schema and audit-trail change to design carefully. Option C adds no persistence contract by itself but does add a cross-package dependency and, if the graph or its coverage summary is persisted, a new stored artifact whose schema must be versioned. Option D changes no data.

## Migration plan

Because this ADR is Proposed and defers the choice, no migration runs until an option is Accepted. The intended sequencing once a choice is made:

1. Record the owner's selection by moving this ADR to Accepted (or writing a superseding ADR if the choice differs materially from A–D).
2. For A or C, add the cross-package dependency and the evidence-kind vocabulary first, behind no behavior change, so the graph/estimate can be computed and logged without yet driving escalation ("prove, then enable").
3. Populate `RouterTaskSpec.coverage` in a shadow mode and compare the escalations it *would* have produced against outcomes, before letting it change routing.
4. Enable the coverage-driven escalation only after the shadow comparison clears the readiness gate below.

Every step is backward compatible: absent coverage preserves current behavior by construction (`router.ts:466-476,956-961`).

## Rollback

For A and B, rollback is stopping the population of `coverage` / the second decision phase; because absent coverage falls through to the existing risk-policy path, the router returns to its current behavior with no data transform. For C, rollback is ceasing to construct the graph; if a graph artifact was persisted, it can be left in place or dropped, since nothing downstream depends on it until selection is wired to it. The point past which rollback is no longer clean is when recipe selection is made to *require* graph evidence (a §14.3-satisfying change): after that, reverting reopens the conformance gap and any recipe that was gated on graph evidence must fall back to the text heuristic explicitly rather than silently. Option D has nothing to roll back.

## Evaluation plan

Success is measured against the versioned, owner-decided gates in `evals/readiness-gates.json` (spec §33.5), which today set `fettler-impact-analysis` to `impact_precision_min: 0.9` and `impact_recall_min: 0.85` under a precision-first policy. The signals that would tell us the chosen option worked:

- **Escalation correctness (A, B, C).** In shadow mode, the `graph_coverage_incomplete` escalations the coverage source produces are compared against known-impact ground truth in `evals/ground-truth`. The option is working when it escalates the genuinely under-covered high-risk tasks without escalating well-covered ones — i.e. precision on the escalation decision does not fall below the precision-first bar, and abstention/no-op scenarios stay correctly classified.
- **Selection correctness (C).** Recipe-selection precision/recall on the `flag_files`-style scenarios must not regress relative to the text-heuristic baseline, and should improve on the cases where text resemblance and true reachability disagree — the exact cases §14.3 targets.
- **Cost of the added phase (A, B).** Latency added per task is tracked so the sequencing change is not bought at a cost that violates the latency thresholds the readiness gates will carry.
- **Reconsideration trigger.** If the chosen option cannot clear the precision-first gate in shadow mode within the observation window — or if it introduces latency that fails a latency gate — that is the signal to revisit the choice, likely by superseding this ADR rather than loosening the gate. For option D, the trigger is any design-partner requirement that recipe applicability be graph-confirmed, which would reopen this decision.
