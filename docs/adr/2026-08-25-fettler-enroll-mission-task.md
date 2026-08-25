# Create unassigned MissionTasks when a Fettler campaign enrolls

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §6.8 needs a shared work primitive under the Fettler Mission created at
org enrollment. Enrollment already create-or-links the Mission and binds the
default Policy Envelope. Campaign execute (#385) now claims live targets, but
those targets had no MissionTask rows. ReGauge launch (#404) already creates
unassigned tasks on its launch seam; Fettler had no equivalent.

## Decision

After the Mission is linked and the envelope is bound, create one unassigned
`code_migration` MissionTask per currently enrolled campaign target. If the
campaign has no targets, create one mission-level task. The id formula
(`fettlerCampaignMissionTaskId`) lives in `@mendpoint/db`. Creation is
idempotent and does not assign or transition the task.

Target list is the campaign's current rows, not just this scan's newly
enrolled set, so a replay cannot invent a mission-level task beside existing
per-repo rows.

## Alternatives considered

- **Create tasks at campaign-execute claim.** Rejected as the first writer:
  enrollment is when the repositories become real work units and a principal
  exists. Claim can drive the rows later.
- **Fail enrollment if task creation fails.** Rejected: Mission bookkeeping
  stays best-effort so a task glitch cannot fail the enrollment write.

## Security impact

Tenant-scoped Mission and task writes. Actor is the enrollment trust principal.

## Data and compatibility impact

Additive. Existing campaigns without tasks stay legal to execute.

## Rollback

Revert the commit. Enrollment continues; no tasks are created.
