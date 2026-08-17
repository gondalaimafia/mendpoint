# ADR-NNNN: <short decision title>

- **Status:** Proposed
- **Date:** YYYY-MM-DD
- **Author:** <Claude Code | OpenAI Codex | human maintainer>
- **Supersedes:** <ADR-NNNN or none>
- **Superseded by:** <ADR-NNNN or none>

## Context

What problem or force requires a decision? Describe the situation, constraints, and any product-specification or compatibility pressure. Link the driving issue and the relevant specification sections.

## Decision

The decision that was made, stated in active voice as a directive ("We will ..."). Be specific enough that an implementer can follow it without re-deriving the reasoning.

## Alternatives considered

The other options that were genuinely weighed, each with why it was not chosen. Include the "do nothing" option when relevant.

## Security impact

Effect on authentication, authorization, tenancy isolation, secret handling, and attack surface. State "none" only after checking. Note any new trust boundary the decision introduces.

## Data and compatibility impact

Effect on persistence contracts, schemas, public APIs, wire formats, and stored historical values. Call out any breaking change to an existing contract and how consumers are affected.

## Migration plan

The ordered steps to move from the current state to the decided state, including any phased rollout, backfill, dual-write window, or feature gate. State whether the change is backward compatible during migration.

## Rollback

How to reverse this decision if it proves wrong, and what makes rollback safe or unsafe (for example, irreversible data changes). Name the point past which rollback is no longer clean.

## Evaluation plan

How success or failure will be measured: tests, synthetic regressions, evaluation suites, metrics, and the observation window. Define the signal that would trigger reconsideration.
