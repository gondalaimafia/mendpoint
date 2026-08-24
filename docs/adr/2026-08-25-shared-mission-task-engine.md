# Shared Mission Task engine

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §6.8 (and v4 architectural decision #6) require a **MissionTask** — one shared
work primitive that agents and humans operate on, so work moves agent → human →
agent without reconstructing Mission state. The repository had no such primitive:
work lived in `jobs` / `agent_runs`, and handoff was emulated through mission
exceptions + decisions with no explicit task-state machine. This is the "task
engine absent" gap (ME-MTE-001).

## Decision

Add a first-class `MissionTask` (`packages/db/src/mission-task.ts` + two brand-new
tables) with the §6.8 semantics.

- **Status state machine.** `unassigned → agent_assigned → agent_working →
  human_review_required → human_assigned → human_working → agent_resume →
  complete`, with `blocked`, `failed`, `cancelled`, `escalated` as branch/terminal
  states. The legal transition table is explicit; illegal transitions fail closed.
- **Owner + handoff.** `owner_type` (agent/human) is derived from the target
  status; `handoff_reason` records why the last agent↔human boundary was crossed;
  `assigned_principal_id` records the human/agent assignee.
- **Replan history.** `retry_count` increments on a re-entry into `agent_working`
  (from `blocked`/`agent_resume`).
- **Concurrency + idempotency.** Transitions are fenced on `expectedRevision`
  (optimistic concurrency — never silent last-write-wins), a re-transition to the
  same status is an idempotent replay, and every transition appends a hash-chained
  domain event (the audit trail), mirroring the `mission` row.
- **Dependency ordering.** A companion append-only `mission_task_dependencies`
  edge table models the intra-mission DAG; `missionTaskReady` returns true only
  when every prerequisite is `complete`. Self-edges and cycles are rejected.
- **Tenant isolation.** The composite FK `(tenant_id, mission_id) → mission` binds
  every task to a mission of the same tenant; reads are tenant-scoped.

Both tables are brand-new, so they converge on fresh AND pre-change databases
purely through `CREATE TABLE/INDEX IF NOT EXISTS` with no ALTER (proven by a
convergence test that drops the tables on a seeded volume and reboots).

## Alternatives considered

- **Model tasks as append-only rows (like decisions/exceptions).** Rejected: a
  task's identity is stable while its *status* changes many times; append-only
  would force a new row per transition and lose the single-row optimistic-
  concurrency fence §6.8 implies. The hash-chained domain events already provide
  the immutable audit trail.
- **Reuse `jobs`/`agent_runs`.** Rejected as the primitive: those are worker
  execution records without the agent↔human ownership, handoff, and acceptance-
  criteria semantics. A follow-on can bridge a job to a MissionTask without a
  rewrite.

## Security impact

Tenant isolation is structural (composite FK + tenant-scoped reads + principal
tenant checks). No new external surface. Transitions fail closed on stale
revisions and illegal moves.

## Data and compatibility impact

Additive: two brand-new tables, no ALTER, no change to any existing table.
Converges on pre-change volumes.

## Migration plan

1. Add the tables + `mission-task.ts` + tests (this PR).
2. Follow-on (D2): wire the worker loop's handoff/resume (`mission-resume.ts`,
   `mission-handoff.ts`) onto MissionTask transitions so agent→human→agent
   continuation is driven by the task state machine.
3. Follow-on (D3): bridge existing `jobs`/`agent_runs` to a MissionTask (owner =
   agent) so the task graph is the single work primitive without a rewrite.

## Rollback

Revert the commit; the tables are brand-new with no other reader.

## Evaluation plan

Success is the unit tests: create/idempotency/conflict, the full agent→human→agent
→complete path with owner derivation, illegal + stale-revision rejection, replan
counting, dependency readiness, self-edge/cycle/cross-mission rejection, tenant
isolation, and schema convergence on a pre-change volume.
