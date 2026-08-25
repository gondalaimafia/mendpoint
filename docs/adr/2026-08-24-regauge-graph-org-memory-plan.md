# Consult Change Graph and Organization Memory on the live ReGauge plan path

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §28.3 requires a ReGauge plan to reconstruct topology to a declared coverage level and produce a dependency-aware staged plan. Spec §28.1.0 requires Organization Memory to stay subordinate to hard policy. `planTransformerMission` always wrote `dependsOn: []`, `TransformerMissionService.plan` always stored `bsg.edges: []`, and the live plan path never called `resolveOrganizationDecision`. Empty dependencies would have read as "every unit is independently ready".

## Decision

Consult, then plan.

- `consultRegaugeGraphDependencies` reads Service `DEPENDS_ON` from a supplied tenant graph. No graph → `not_consulted`. Empty relation → `target_absent` and no invented edges. Populated relation → repository-id dependencies passed into the planner.
- `planTransformerMission` applies `dependsOnByRepositoryId` onto units (unknown repos ignored). The mission service writes matching BSG `orders` edges.
- `consultRegaugeOrganizationMemory` runs the existing precedence resolver with the organization-constraint contract as hard policy, so confirmed memory is named as overridden rather than allowed to govern.
- Live API runtime opens `GRAPH_LEARN_DB` only when that file already exists (never `getGraphLearnDb()`, which creates an empty file) and lists tenant Organization Memory heads.

## Alternatives considered

- **Leave dependsOn empty until DEPENDS_ON ingest merges.** Rejected: the consult can already fail closed, and #384 will populate the relation without a second planner change.
- **Let memory win when no mission decision exists.** Rejected: organization constraints are hard policy on this path; memory must not become hidden policy.
- **Open the process-wide graph singleton.** Rejected: `getGraphLearnDb()` creates `data/graph-learn.sqlite` if missing, which is not a production graph.

## Security impact

Tenant graph views are used for file-backed graphs. Organization Memory is listed by the authenticated tenant id only. Memory cannot override the constraint contract.

## Data and compatibility impact

Additive. Blueprints without graph consult still have empty `dependsOn`. Constraint digest and blueprint identity are unchanged; consult results are returned alongside the plan, not folded into the organization digest.

## Migration plan

1. Land planner + consult + live wiring.
2. After DEPENDS_ON ingest (#384) merges, re-ingest manifests so ReGauge plans pick up real edges.
3. Keep failing closed when the graph file is absent.

## Rollback

Revert the commit. Plans return to empty `dependsOn` / empty BSG edges; Organization Memory is again unconsulted on this path.

## Evaluation plan

Success is consult tests covering not_consulted / empty-relation / mapped DEPENDS_ON / policy-beats-memory, planner tests applying repository dependencies, the existing mission plan+launch test still passing with honest `not_consulted`, and `npm test -w @mendpoint/transformer -w @mendpoint/api` plus typecheck green.
