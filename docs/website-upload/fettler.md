# Fettler — the first AI API Engineer

Turn submitted OpenAPI changes into evidence backed migration pull request candidates for supported GitHub repositories.

Status: Limited availability
Availability: Submitted OpenAPI JSON and configured GitHub pilot repositories
Last verified: 2026-08-14

## Start here

Connect one approved repository, materialize an immutable snapshot, and start a bounded Fettler run.

1. Install and authorize the GitHub App for the selected repository.
2. Create an exact repository snapshot and verification profile.
3. Submit a Fettler run or an approved API-change plan.
4. Review the candidate, evidence, spend, and mission history before delivery.

```sh
npm run agent:demo
```

## What it does

- OpenAPI change remediation and impact analysis
- Bounded repository diagnosis, source observation, edits, and verification
- Durable mission plans, checkpoint takeover, verifier-driven replanning, and terminal evidence
- Human candidate approval, draft delivery, CI observation, and bounded same-branch repair
- Current head requested change feedback reentry under inherited cumulative budgets

## When to use it

- A provider API or SDK change affects an approved repository.
- An integration test fails and the repair scope is known.
- A team needs a proposed patch with exact evidence rather than an autonomous merge.

## How it works

1. Fettler binds the task to one tenant, repository snapshot, allowed path set, model policy, and verification profile.
2. It creates an evidence-grounded mission plan and executes only the current authorized step.
3. Repository reads, mutations, model decisions, and verifier results are checkpointed under the active worker lease.
4. The attempt returns a sealed candidate and evidence package for a fresh human decision.
5. Approved candidates can become draft pull requests. Fettler does not merge or deploy.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| POST /agent/runs | API | Create a bounded Fettler run. |
| GET /agent/runs/:id | API | Read run state and evidence. |
| POST /agent/runs/:id/candidate/review | API | Approve, reject, or regenerate a candidate. |
| npm run eval:warden | Command | Run the deterministic Fettler benchmark. |
| Fettler terminal evidence | Artifact | Authenticated checkpoint outcome archived with the agent run. |

## Evidence and verification

- Agent runtime and mission plans: `packages/agent/src/agent.test.ts`
- Attempt and takeover behavior: `packages/agent/src/attempt-engine.test.ts`
- Worker delivery and CI reentry: `apps/worker/src/warden-candidate-update.test.ts`

## Safety model

- Every mutation must match the active plan step and observed source evidence.
- Allowed paths, budgets, verification commands, and model authority are immutable attempt bindings.
- Remote delivery requires fresh human approval and exact-head reconciliation.
- No Fettler path can merge or deploy a pull request.

## Limitations

- Language and migration coverage is bounded and unsupported work can abstain.
- Review feedback reentry requires fully paginated, current head, active GitHub change requests and does not widen the approved path scope.
- Production depth depends on the connected repository and configured verifier.

## See also

- [Change ingestion](./change-ingestion.md)
- [Change Graph](./change-graph.md)
- [Verification and attestations](./verification-attestations.md)
- [Draft delivery](./draft-delivery.md)
