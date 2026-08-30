# Mission and Policy Envelope

Persist durable work as tenant scoped Missions whose tasks inherit deterministic repository, model, review, residency, and delivery boundaries.

Status: Internal shared foundation
Availability: Durable Mission and Policy Envelope primitives are active behind product specific interfaces
Last verified: 2026-08-30
Requirements: ME-WAR-005, ME-TRN-003, ME-TRN-007, ME-TRN-009
Public claims: None

## Start here

Create product work through Fettler or Regauge so the product binds the Mission to its exact source and policy context.

1. Create the product request under an authenticated tenant.
2. Inspect the bound repository snapshot, graph projection, and Policy Envelope version.
3. Run or hand off one Mission task under its current lease.
4. Resolve exceptions and inspect the retained decision and artifact lineage.

## What it does

- Durable Missions, tasks, decisions, exceptions, and artifacts
- Versioned Policy Envelope inheritance
- Agent to human to agent handoff
- Restart and lease safe continuation
- Bounded MissionGraphProjection and context references

## When to use it

- Work spans multiple steps, workers, or reviewers.
- A later operator must reconstruct the exact authority and evidence used by a task.

## How it works

1. The product creates one tenant scoped Mission and binds its immutable source identities.
2. Tasks inherit the exact Policy Envelope rather than reconstructing restrictions from a prompt.
3. Workers claim tasks under leases and append idempotent outcomes.
4. Handoffs, exceptions, and superseding decisions preserve lineage without storing hidden reasoning.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| Mission | Artifact | Tenant, product, objective, state, and source bindings. |
| Mission task | Artifact | Lease, inputs, required capabilities, policy, and outcome. |
| Policy Envelope | Artifact | Versioned repository, tool, model, residency, risk, review, delivery, and learning boundaries. |
| Mission transition | Event | Idempotent state transition with actor and evidence lineage. |

## Evidence and verification

- Mission persistence: `packages/db/src/mission.test.ts`
- Mission task lifecycle: `packages/db/src/mission-task.test.ts`
- Policy inheritance: `packages/db/src/policy-envelope.test.ts`
- Handoff continuity: `packages/db/src/mission-handoff.test.ts`

## Contract sources

- `packages/db/src/mission.ts`
- `packages/db/src/mission-task.ts`
- `packages/db/src/policy-envelope.ts`

## Safety model

- Every read and write is tenant scoped.
- A task cannot widen its inherited policy.
- Changed source, policy, graph, or authority makes prior execution eligibility stale.
- Context references record supplied evidence, not chain of thought.

## Limitations

- Product routes expose only the Mission operations needed by that product.
- Mission persistence does not itself authorize repository mutation, delivery, merge, or deployment.

## See also

- [Fettler — the first AI API Engineer](./fettler.md)
- [Regauge — the first AI Legacy Engineer](./regauge.md)
- [Change Graph](./change-graph.md)
- [Audit and compliance evidence](./audit-compliance.md)
