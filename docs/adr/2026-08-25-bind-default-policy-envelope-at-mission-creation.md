# Bind a default Policy Envelope at Mission creation

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §6.7 requires that **every Mission MUST reference a versioned Policy
Envelope**. The persistence primitives exist (`createPolicyEnvelope`,
`bindMissionToPolicyEnvelope`, `getMissionPolicyEnvelope`) and the envelope type +
deterministic evaluator exist (`@mendpoint/policy`), but no production caller
bound an envelope: Missions were created with `policyEnvelopeVersion: null`, so
there was nothing for downstream task dispatch to inherit or enforce. This is the
first of the "built-but-inert" activation gaps.

## Decision

At the Fettler mission-creation seam (the enrollment route, the only place a real
principal exists), ensure the tenant's **default** Policy Envelope exists and bind
the Mission to it set-once.

- `defaultPolicyEnvelope(...)` (`@mendpoint/policy`) — a permissive-but-explicit
  default chosen to keep product invariants true rather than to be maximally open:
  `reviewRequired: true`, `deploymentAllowed: false`, `trainingDataAllowed: false`
  (§0.3 review-first + governed learning), with unrestricted repository/branch/
  tool/model scope (empty allowlists) so existing execution is not blocked until a
  tenant authors a stricter envelope.
- `ensureDefaultPolicyEnvelopeBinding(db, ...)` (`@mendpoint/pipeline`) — composes
  `db` (persistence) and `policy` (shape/serializer), which deliberately do not
  depend on each other. Idempotent: creates the tenant default once (immutable
  version 1) and binds the Mission set-once; repeated calls neither error nor
  rewrite the envelope.
- Wired into `warden-campaign-enrollment.ts` inside the existing best-effort
  Mission bookkeeping block, so envelope binding — like mission creation/linking —
  is metadata that never fails an enrollment.

## Alternatives considered

- **Add `@mendpoint/policy` as a direct `apps/api` dependency and build the
  envelope inline.** Rejected: `@mendpoint/pipeline` already depends on both `db`
  and `policy` and is the natural composition seam; keeping the API thin avoids a
  new cross-package dependency.
- **Construct the envelope body in `@mendpoint/db`.** Rejected: `db` intentionally
  keeps the envelope body opaque to avoid a `db → policy` dependency and a
  duplicate policy platform (spec §31.7).
- **Scope the default envelope to the enrolled repositories.** Deferred: an empty
  (unrestricted) scope is non-breaking now; a repository-scoped default is a
  natural follow-on once enforcement (next PR) is proven not to regress execution.

## Security impact

Additive and fail-safe. The default envelope is permissive on scope but closes
deployment, training capture, and (via `reviewRequired`) auto-merge by default,
matching product invariants. Binding is set-once with optimistic concurrency, so a
policy version a Mission inherited can never be silently rewritten (§6.7). This PR
only **binds**; deterministic enforcement at task dispatch is the next change.

## Data and compatibility impact

Additive. Uses the existing `policy_envelopes` table and `mission.policy_envelope_version`
column; no schema change. Existing Missions created before this change keep
`policyEnvelopeVersion: null` until re-bound; readers already tolerate null.

## Migration plan

1. Add `defaultPolicyEnvelope` + `ensureDefaultPolicyEnvelopeBinding`.
2. Wire into the Fettler enrollment mission block.
3. Follow-on: bind on the ReGauge bootstrap path; then enforce the inherited
   envelope deterministically at worker task dispatch and model routing.

## Rollback

Revert the commit. The binding is best-effort metadata with no reader that
requires a non-null envelope version, so removal is clean.

## Evaluation plan

Success is the unit tests: the default envelope is created once per tenant, shared
across that tenant's Missions, pins version 1 set-once, is idempotent, and reads
back through `getMissionPolicyEnvelope` as the product-invariant default. The
enrollment suite remains green (binding never fails an enrollment).
