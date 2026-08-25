# Bind POST /agent/runs to a claimed Mission

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

`agent.run` payloads already carry optional `missionId`. Candidate
regenerate forwards it. Trajectories (#403) persist it when present.
`POST /agent/runs` was the live enqueue writer that dropped the field, so
new runs could not claim the Mission they belong to.

## Decision

Accept optional `missionId` on the run body. A claimed but missing row
fails closed (404). The id is copied onto the job payload so inherited
context, policy, and trajectory writers see the same binding. Omitted
`missionId` stays legal — that is the enrollment gap, not a fabricated
Mission.

## Alternatives considered

- **Resolve Mission from consumer/campaign automatically.** Rejected: no
  unique binding exists on this route.
- **Ignore an unknown missionId.** Rejected: a claimed id must fail closed.

## Security impact

`getMission` is tenant-scoped. Cross-tenant ids are indistinguishable from
missing.

## Rollback

Revert the commit. Clients that omit `missionId` are unchanged.
