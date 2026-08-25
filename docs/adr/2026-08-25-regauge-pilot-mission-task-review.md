# Hand ReGauge MissionTasks to review after a successful pilot-lane complete

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

PR #407 assigns the launch-created MissionTask on the live pilot-lane claim.
Spec §6.8's nominal path still needs the agent→human handoff when that work
reaches review. The ReGauge live loop is review-first: `completeAttempt` records
a verified candidate, not a delivered PR. Leaving the task at `agent_working`
would say the agent still owns finished work.

## Decision

- After a successful `completeAttempt`, the pilot-lane coordinator transitions
  the matching launch task `agent_working → human_review_required` with handoff
  reason `pilot_lane_review`.
- Repository identity comes from the completed campaign unit snapshot. The
  worker does not invent a second complete path.
- Missing Mission or missing task is a no-op (pre-#404 / unbound Surface A).
- A MissionTask glitch must not un-complete an already-recorded attempt.
- Failed or adaptive-failed attempts do not hand off.

## Alternatives considered

- **Hand off from `recordAttemptFailure` as well.** Rejected: a failed attempt
  is still the agent's work. Review starts after verification passes.
- **Create a separate complete wrapper in `@mendpoint/transformer`.** Rejected:
  MissionTask is a platform primitive. The transformer package stays
  graph-learn/db-free of MissionTask internals.
- **Fail closed when the task is missing.** Rejected: campaigns launched before
  #404, and unbound Surface A campaigns, are still legal to complete.

## Security impact

Tenant isolation is unchanged: Mission lookup and task reads are tenant-scoped.
Handoff uses the assigned agent principal when present.

## Data and compatibility impact

Additive. Existing campaigns without a launch task keep completing.

## Rollback

Revert the commit. Successful completes continue; tasks stay `agent_working`.
