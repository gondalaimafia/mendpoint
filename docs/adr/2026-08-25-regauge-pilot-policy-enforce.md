# Enforce the inherited Policy Envelope on the ReGauge pilot lane

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

PR #372 added `evaluateMissionTaskPolicy`. ReGauge launch already pins a
versioned Policy Envelope. The live pilot lane authorized worker-gate and
router policy, then claimed a unit without evaluating the Mission envelope, so
spec §6.7 ("a prompt reminder is not an authorization control") was still open
on that path.

## Decision

- Before taking a lease, resolve the campaign Mission and evaluate the inherited
  envelope against the runnable repository and whether this pass uses external
  adaptive processing.
- Unbound campaigns (no Mission) are a no-op so pre-launch Surface A stays legal.
- A bound Mission with no envelope, an invalid envelope, or an explicit deny
  fails closed and does not claim.
- Branch and target paths are not on the runnable-campaign summary. Empty values
  keep unrestricted default envelopes allowed and fail closed if a tenant has
  scoped branches.

## Alternatives considered

- **Evaluate only after claim.** Rejected: a denied envelope must not hold a
  lease.
- **Fail unbound campaigns.** Rejected: Surface A campaigns without a Mission
  remain legal until launch binds one.
- **Treat `no_envelope` as proceed.** Rejected: launch is supposed to pin an
  envelope. Missing pin is a real fault, same posture as Fettler `agent.run`.

## Security impact

Tenant-scoped Mission lookup. Cross-tenant campaign ids do not resolve. Deny
reasons do not include envelope bodies.

## Data and compatibility impact

Additive. Unbound campaigns keep running. Bound missions without an envelope
now skip instead of executing.

## Rollback

Revert the commit. Pilot-lane claims continue without envelope evaluation.
