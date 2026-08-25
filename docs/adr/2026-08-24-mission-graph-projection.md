# Name the MissionGraphProjection compiled from Fettler impact

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §8.16 requires a bounded, versioned, evidence-bearing Change Graph view
compiled for one Mission or task (`MissionGraphProjection`). The repository
already has `queryFettlerEndpointImpact` and `compileFettlerImpactContext`
(the bounded JSON projector). The Mission Context Compiler called the
projector directly and assembled an anonymous projection object. There was no
named type a later task could hold or pass.

## Decision

Add `MissionGraphProjection` and `compileMissionGraphProjection` in
`packages/graph-learn/src/software-intelligence.ts`. The compiler is a thin
named wrapper around `compileFettlerImpactContext` — one projector, not a
second graph dump. The Mission Context Compiler's graph section now calls the
named compiler.

The projection carries mission identity (nullable), graph version/digests,
impact/coverage, and the bounded compiled content. It does not embed raw graph
ids or `props_json`.

## Alternatives considered

- **A second projector with a different JSON shape.** Rejected: spec and
  ADR-0005 require one bounded graph projector.
- **Leave the compiler on the anonymous call.** Rejected: §8.16 names the
  object; without a type, every caller re-derives the fields.

## Security impact

None. Same tenant-scoped query result and the same bounded projector. No new
read of the tenant graph.

## Data and compatibility impact

No persistence or wire-format change. The compiler's emitted envelope section
shape is unchanged (it still projects the same fields). Additive TypeScript
export.

## Migration plan

1. Add the type and wrapper.
2. Point `buildGraphSection` at it.
3. Cover naming, digest equality with the existing projector, and no graph dump.

## Rollback

Revert the commit. The compiler returns to calling `compileFettlerImpactContext`
directly.

## Evaluation plan

Success is the software-intelligence and mission-context-compiler suites
passing, with the named projection equal to the existing projector output.
Reconsideration is a ReGauge planner that needs additional topology fields —
extend this type, do not add a second projector.
