# Regauge — the first AI Legacy Engineer

Regauge is an experimental planning preview.

Status: Experimental planning preview
Availability: Durable campaign planning and review controls; repository execution and staged pull request campaigns are not customer ready
Last verified: 2026-08-14

## Start here

Evaluate the planning preview against an approved snapshot without authorizing customer repository execution.

1. Connect and snapshot an approved preview repository.
2. Submit a migration objective to POST /transformer/missions.
3. Inspect the derived blueprint, constraints, and rollback plan.
4. Record an independent review decision and retain the planning evidence.

## What it does

- Objective-to-blueprint mission planning with CODEOWNERS and organization constraints
- Signed deterministic recipe selection and compilation
- Durable campaign plans with units, waves, budgets, exceptions, rollback plans, and review evidence
- Independent blueprint review and exact planning evidence
- Internal execution, checkpoint, and draft-delivery primitives behind separate non-customer gates

## When to use it

- A team is evaluating how a larger migration could be staged.
- The repository matches an approved deterministic planning recipe.
- Independent blueprint review and exact rollback planning are required.

## How it works

1. The mission planner re-verifies exact snapshot bytes, topology, owners, and policy before selecting one recipe or abstaining.
2. An independent reviewer evaluates the integrity-bound blueprint.
3. The compiler creates a durable campaign plan with units, dependencies, waves, budgets, and evidence authority.
4. The preview retains the plan and review evidence without granting customer repository execution.
5. Execution and staged draft delivery remain outside the customer-ready preview posture.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| POST /transformer/missions | API | Plan a repository-backed migration mission. |
| POST /transformer/control-plane/campaigns/:campaignId/review | API | Record independent blueprint review. |
| GET /transformer/executions/:campaignId | API | Inspect execution state. |
| npm run eval:transformer:canary | Command | Run the deterministic Regauge canary. |
| MENDPOINT_TRANSFORMER_GATE | Configuration | Tenant, environment, boundary, and production-delivery authority. |

## Evidence and verification

- Mission planning and compilation: `packages/transformer/src/mission-planner.test.ts`
- Pilot execution and checkpoints: `packages/transformer/src/pilot-execution.test.ts`
- Multi-node worker: `apps/worker/src/transformer-multinode-service.test.ts`

## Safety model

- Blueprint planner and approving reviewer must be independent authorized principals.
- Planning cannot widen paths, recipe scope, budgets, or source authority.
- Stale or mismatched source evidence fails closed.
- Preview access does not grant repository mutation or delivery authority.

## Limitations

- Repository execution and staged pull request campaigns are not customer ready
- No dedicated Regauge deployment is claimed live.
- Adaptive model planning and legacy extraction use separate gates and are not implied by the planning preview.

## See also

- [Repository connections](./repository-connections.md)
- [Draft delivery](./draft-delivery.md)
- [Deployment and operations](./deployment-operations.md)
- [Learning system](./learning-system.md)
