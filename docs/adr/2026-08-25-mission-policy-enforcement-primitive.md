# Deterministic Mission Policy Envelope enforcement primitive

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §6.7 states "A prompt reminder is not an authorization control"; §28.1.0
requires policy be inherited **and enforced**. The envelope type and a pure
`evaluatePolicyEnvelope` exist, and (with the binding PRs) a Mission now pins an
envelope, but there was no reusable authorization decision a dispatch seam could
call. `evaluatePolicyEnvelope` had zero non-test callers.

## Decision

Add `evaluateMissionTaskPolicy(db, { tenantId, missionId, task })`
(`@mendpoint/pipeline`): load the Mission's pinned envelope
(`getMissionPolicyEnvelope`), validate it (`parsePolicyEnvelope`), and evaluate
the concrete task (`evaluatePolicyEnvelope`). It returns a **three-state** result
so a caller never conflates "allowed" with "unenforced":

- `enforced` — envelope inherited and evaluated; `decision.allowed` is authoritative.
- `no_envelope` — the Mission pinned none (legacy); the function does NOT silently
  allow — the caller chooses its posture.
- `envelope_invalid` — a corrupt pinned row; **fail closed**.

A companion `missionPolicyDenialReasons(...)` returns the violation strings when a
task MUST be denied (explicit deny or invalid envelope), or `null` to proceed —
the convenience guard a dispatch seam uses to fail closed.

The re-exported `PolicyDecision` name is ambiguous in `@mendpoint/policy` (the
§8.18 envelope decision and the warden PR-risk decision share the name), so the
module derives the envelope decision type via `ReturnType<typeof
evaluatePolicyEnvelope>` rather than importing the ambiguous symbol.

## Alternatives considered

- **Wire enforcement inline at each dispatch seam.** Rejected as the first step: a
  single tested decision function avoids divergent enforcement logic across the
  campaign executor, repair path, and model router, and keeps the authorization
  rule in one place.
- **Return a bare boolean.** Rejected: "allowed" and "no envelope" and "invalid"
  are different product outcomes (§0.3 explicit epistemic state); collapsing them
  would let an unenforced task look identical to an allowed one.

## Security impact

This is the authorization decision, so its correctness is security-critical. It
fails closed on a malformed envelope and never silently allows when no envelope is
inherited. It performs one tenant-scoped read; the evaluation is pure and
collects every violation. This PR ships the decision function and its tests; the
live denial at each dispatch seam (campaign executor, repair, router) is wired in
the follow-on so the blocking behavior can be reviewed against real task shapes.

## Data and compatibility impact

Additive. No schema or wire change; a new pure-ish pipeline function.

## Migration plan

1. Add `evaluateMissionTaskPolicy` + `missionPolicyDenialReasons` with tests.
2. Follow-on (E3): resolve the Mission at the campaign execute dispatch, build the
   `PolicyTaskRequest` from the target/edit (repository, branch, edit paths, tool,
   model class, risk, residency), call this primitive, and fail closed on denial
   before applying edits — mirrored at the repair path and model router.

## Rollback

Revert the commit; no caller depends on it yet.

## Evaluation plan

Success is the unit tests: no-envelope returns `no_envelope` (no silent allow), a
default envelope allows an in-bounds task, a restricted envelope denies with every
violation code, and a malformed pinned envelope returns `envelope_invalid` with a
required denial.
