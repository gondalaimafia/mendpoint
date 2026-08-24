# Bridge claimed jobs onto MissionTask and attribute Fettler MCU

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

#374 added the MissionTask state machine. #383 wired handoff/resume onto it.
Live work still started as a `jobs` / `agent_runs` row with no MissionTask, so
the shared work primitive was unused on the claim path. Fettler settle also
wrote usage-ledger MCU without a `mission_id`: that ledger's hash chain cannot
gain a new field, while `actual_execution_cost_entries.mission_id` already
exists (schema v2) and ReGauge already fills it.

## Decision

1. **Claim bridge.** After `claimNextJob`, if the payload names a bound
   mission (`missionId`, or a Fettler/ReGauge `campaignId` that resolves through
   the existing FK), `ensureMissionTaskForJob` creates a task id derived from
   the job and drives `unassigned → agent_assigned → agent_working` (owner =
   agent). Unbound jobs stay unbound — we do not invent a mission. A claimed
   `missionId` whose row is missing fails closed.
2. **No rewind.** A task already in handoff or a terminal state is left alone.
   A retry of the same job id reuses the same task (idempotent).
3. **MCU rollup.** After a Fettler `agent.run` completion (and after fanout /
   campaign-execute settle), if a mission is bound, call the existing
   `recordExecutionCostFromRoutingLedger` with `missionId`. Do **not** change
   usage-ledger hash formulas. Unbound runs write no cost row here, matching
   the ReGauge "no owner, no attribution" rule.

## Alternatives considered

- **Add `missionId` to the usage ledger.** Rejected: that changes the
  append-only hash payload of existing rows.
- **Always create a mission for every job.** Rejected: Fettler enrollment is
  still a separate gap; fabricating a mission would hide it.
- **Treat `packages/db/src/task-ownership.ts` as the engine.** Rejected: that
  module is a view over `agent_runs`, not MissionTask.

## Security impact

Task creation stays tenant-scoped (mission FK + principal tenant checks). Cost
rows use the mission owner as actor. No new external surface.

## Data and compatibility impact

No schema change. Additive writers on existing MissionTask and execution-cost
tables. Usage-ledger hashes unchanged.

## Migration plan

1. Add `ensureMissionTaskForJob` / `missionTaskIdForJob`.
2. Worker claim + settle hooks.
3. Follow-on: bind `missionId` onto Fettler `agent.run` enqueue once enrollment
   is live for every campaign.

## Rollback

Revert the commit. Jobs run without a MissionTask; Fettler cost rows stay
unattributed.

## Evaluation plan

Success is the db suite covering create/idempotency/no-rewind/transaction-join,
plus the worker bridge covering unbound no-op, missing-mission fail-closed,
agent.run MCU attribution, and campaignId resolution. Reconsideration is
enqueue-time `missionId` on every Fettler job so the unbound path goes away.
