# Enforce the inherited Policy Envelope at Fettler campaign execute

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

`evaluateMissionTaskPolicy` (ADR `2026-08-25-mission-policy-enforcement-primitive`)
is the deterministic authorization decision, but it had no live caller. Spec
§6.7 requires that a prompt reminder is not an authorization control; §28.1.0
requires the inherited envelope to be **enforced** on the run path. The Fettler
campaign executor (`executeWardenCampaignTarget`) is that run path: it plans
and applies typed edits against a repository snapshot.

## Decision

Call `assertCampaignExecutePolicy` on the live executor, twice:

1. After the exact snapshot is bound, with empty `targetPaths` — denies a
   repository/branch/tool/model/risk/deployment/training violation before any
   edit is planned.
2. After `planEdits`, with the planned paths — denies a forbidden-zone edit
   before `applyEdits` runs.

The campaign MUST resolve to a Mission (`resolveMissionForFettlerCampaign`). A
missing Mission, a Mission with no envelope, an invalid envelope, or an explicit
deny all fail closed with a terminal `WardenCampaignExecutionError`
(`warden_mission_not_bound`, `warden_policy_envelope_missing`,
`warden_policy_denied`). `no_envelope` is a denial at this seam even though the
primitive's convenience guard leaves that posture to the caller.

The task shape is `campaignExecutePolicyTask`: review-first deterministic
`edit`, `isDeployment: false`, `wantsTrainingCapture: false`, risk taken from
the rollout profile (unknown risk treated as `critical`).

## Alternatives considered

- **Enforce only in the worker dispatch wrapper.** Rejected: the executor is
  the shared live path; a stubbed dispatch `execute` would skip the check.
- **Treat `no_envelope` as allow.** Rejected: §6.7 says every Mission must
  reference an envelope; silently allowing recreates the unenforced gap.
- **Single check after planEdits.** Rejected: a repository-scope deny would
  still run baseline verification and graph gates first. The early check fails
  before those side effects.

## Security impact

This is the authorization control for campaign execute. Fail closed on missing
mission, missing/invalid envelope, and every collected violation. Tenant-scoped
reads only. No new secret or cross-tenant surface.

## Data and compatibility impact

No schema or wire-format change. Campaigns that are not mission-bound, or
Missions that never inherited an envelope, now fail closed instead of executing.
The enrollment path already binds the default envelope (#365).

## Migration plan

1. Add `campaignExecutePolicyTask` / `assertCampaignExecutePolicy`.
2. Call them from `executeWardenCampaignTarget`.
3. Bind a Mission + default envelope in the executor fixture; cover missing
   mission, missing envelope, and forbidden-zone deny.

## Rollback

Revert the commit. Execution returns to "policy inherited but unenforced".

## Evaluation plan

Success is the executor suite: the happy path still reaches `review` under the
default envelope; unbound/missing-envelope/forbidden-zone cases fail closed
before review. Reconsideration is triggered by a dispatch seam that needs a
different task shape (tool/model class) — extend the task builder, do not
bypass the assert.
