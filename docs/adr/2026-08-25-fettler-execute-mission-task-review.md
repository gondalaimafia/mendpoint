# Hand Fettler MissionTasks to review after campaign execute

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Campaign execute is review-first: a successful `warden.campaign.execute-target`
lands the target at stage `review` and never delivers a PR. #409 already
assigns the enrollment MissionTask on claim (`agent_working`). Spec §6.8's
nominal path still needs the agent→human boundary when that review stage is
reached.

## Decision

After a successful execute outcome, transition the matching task
`agent_working → human_review_required` with handoff reason
`campaign_execute_review`. Missing or already-handed tasks are a no-op. A
handoff glitch must not un-complete the job.

## Alternatives considered

- **Leave the task at `agent_working`.** Rejected: the executor has already
  finished and is waiting on humans.
- **Mark the task complete.** Rejected: review-first means humans still own
  the next step.

## Security impact

Same tenant-scoped lookup as #409. Handoff uses the assigned agent principal
when present.

## Rollback

Revert the commit. Successful execute jobs still complete; tasks stay
`agent_working`.
