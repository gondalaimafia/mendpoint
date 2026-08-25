# Drive ReGauge MissionTasks on the pilot-lane claim

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

PR #404 creates unassigned `code_migration` MissionTasks when a ReGauge campaign
launches. Spec §6.8 still needs those tasks driven on the live work path. The
ReGauge live loop is `transformer-pilot-lane`, not `jobs`. Claim happens inside
`runTransformerAttempt` via `coordinator.claimNextAttempt`. The worker cannot
import `apps/api`, so the launch id formula had to move to a shared package.

## Decision

- Keep one id formula: `regaugeLaunchMissionTaskId` lives in `@mendpoint/db`.
- After a successful `claimNextAttempt`, the pilot-lane coordinator assigns and
  starts the matching launch task (`unassigned → agent_assigned → agent_working`)
  with a tenant-scoped service principal.
- Missing Mission or missing task is a no-op (pre-#404 / unbound Surface A).
- A MissionTask glitch must not fail a claimed lease.

## Alternatives considered

- **Create the task at claim time.** Rejected: launch is the moment the work
  unit becomes real. Claim should drive, not invent, the primitive.
- **Put the id helper in `apps/api` and duplicate it in the worker.** Rejected:
  two formulas will drift.
- **Fail closed when the task is missing.** Rejected: campaigns launched before
  #404, and unbound Surface A campaigns, are still legal to execute.

## Security impact

Tenant isolation is unchanged: Mission lookup and task reads are tenant-scoped.
The assignee principal is created per tenant. Cross-tenant campaign ids do not
resolve.

## Data and compatibility impact

Additive. Existing campaigns without a launch task keep running.

## Rollback

Revert the commit. Claimed attempts continue; tasks stay unassigned.
