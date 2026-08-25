# Drive Fettler MissionTasks on the campaign-execute claim

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Enrollment (#408) creates unassigned MissionTasks when repositories become
Fettler campaign targets. Spec §6.8 still needs those tasks driven when the
worker actually claims the work. The live claim is `claimNextJob` for
`warden.campaign.execute-target` (#385).

## Decision

After a campaign-execute job is claimed, parse the payload and assign/start
the matching enrollment task (`unassigned → agent_assigned → agent_working`)
with a tenant-scoped service principal. Missing Mission, target, or task is a
no-op. A MissionTask glitch must not fail the claimed execute.

## Alternatives considered

- **Create the task at claim time.** Rejected: enrollment is when the work
  unit becomes real. Claim should drive, not invent, the primitive.
- **Fail closed when the task is missing.** Rejected: campaigns enrolled
  before #408 are still legal to execute.

## Security impact

Tenant-scoped Mission/target/task reads. Assignee principal is created per
tenant. Cross-tenant campaign ids do not resolve.

## Data and compatibility impact

Additive. Existing execute jobs without a task keep running.

## Rollback

Revert the commit. Claimed execute jobs continue; tasks stay unassigned.
