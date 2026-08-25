# Copy a claimed Mission id onto Fettler CI-repair agent runs

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The live Fettler `agent.run` loop compiles inherited Mission context when
`payload.missionId` is present. POST `/agent/runs` and regenerate already carry
that id when the caller claimed one. CI repair reconstructs a new `agent.run`
payload from the source job and previously dropped `missionId`, so a bound
repair continued as `no_mission_bound`.

## Decision

- When the source `agent.run` payload has a non-empty, unpadded `missionId`,
  copy it onto the repair job. Do not invent a Mission from consumer, campaign,
  or delivery identity.
- Padded, empty, or non-string values are omitted. A missing id must not fail
  an authorized CI repair.
- The worker still fail-closes later if a copied id does not resolve.

## Alternatives considered

- **Spread the entire original payload.** Rejected: repair must replace goal,
  session, snapshot binding, and CI evidence. Copying the claimed Mission id is
  the load-bearing field.
- **Resolve a Mission from the delivery or campaign.** Rejected: that invents a
  binding the source run never claimed.
- **Fail the repair when the source has no Mission.** Rejected: unbound source
  runs remain legal.

## Security impact

Tenant isolation is unchanged: the source job is already tenant-scoped. The
copied id is a string claim; Mission lookup stays tenant-scoped at use.

## Data and compatibility impact

Additive. Unbound source runs keep producing unbound repair runs.

## Rollback

Revert the commit. Repair jobs enqueue; inherited context stays `no_mission_bound`.
