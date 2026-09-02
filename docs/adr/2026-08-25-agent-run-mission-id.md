# Bind POST /agent/runs to a claimed Mission

- **Status:** Superseded
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** canonical Fettler campaign Mission authority

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

## Supersession

The claimed id was not sufficient authority for the repository-scoped Mission
task and blocking review handoff required after a candidate becomes ready. A
direct run could therefore complete successfully and still be impossible to
approve or regenerate. `POST /agent/runs` now rejects `missionId` before any
queue or AgentRun persistence. Mission-bound Fettler work must enter through a
campaign, which durably owns the exact tenant, repository, snapshot, policy,
task, and handoff authority. Internal approved successors retain their complete
Mission mutation authority for compatibility and replay.
