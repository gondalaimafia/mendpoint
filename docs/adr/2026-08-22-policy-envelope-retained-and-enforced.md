# Retained, deterministically-enforced Policy Envelope

- **Status:** Accepted
- **Date:** 2026-08-22
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The v4.0 specification requires a Policy Envelope (§6.7, §8.18) that every Mission task **inherits**, that is **retained** under the version a decision was made, and that is **deterministically enforced** — "A prompt reminder is not an authorization control." (§6.7). The §28.1.0 acceptance criteria list "Policy Envelope restrictions are inherited and enforced."

The gap-closure evaluation found the envelope only partially present: `packages/policy/src/warden-policy.ts` carries a versioned scoped *risk*-policy resolver with approval/waiver state, but there was **no** §8.18 task-boundary object (repository/branch/tool/model/residency/review/deployment/training constraints), no persisted retention of the envelope a mission pinned, and no single deterministic enforcement function. Enforcement was split across ephemeral router synthesis. The v4-platform register records `ME-PEV-001` as `partial`. The previous gap-closure PR added `mission.policy_envelope_version` but nothing it could reference.

## Decision

Add the Policy Envelope as a first-class, retained, deterministically-enforced object that **extends** the canonical policy package rather than creating a second policy platform (spec §31.7).

- **Type + enforcement (`packages/policy/src/policy-envelope.ts`).** Define the §8.18 `PolicyEnvelope` and a pure, deterministic `evaluatePolicyEnvelope(envelope, task)` that collects every violation (repository/branch scope, forbidden zones, tool/model allowlists, external processing, risk ceiling, deployment, training capture, residency). Allowlist semantics are documented and explicit: an empty allowlist is unrestricted; a non-empty allowlist permits only its members; forbidden zones are a segment-boundary denylist; the boolean/ceiling controls fail closed. `parsePolicyEnvelope` validates untrusted stored JSON and fails closed, so a corrupt or attacker-shaped row can never be enforced as a real envelope. This is complementary to `warden-policy.ts` (PR-edit risk layering), not a duplicate of it.
- **Retention (`packages/db` `policy_envelopes`).** A versioned, tenant-scoped, **immutable** table (BEFORE UPDATE/DELETE triggers `RAISE(ABORT)`), storing the envelope as opaque canonical JSON owned/parsed by `@mendpoint/policy`, with a content digest so re-creating a version is idempotent on identical content and fails closed on different content. Keeping the type in the policy package avoids a `db -> policy` dependency.
- **Inheritance.** `bindMissionToPolicyEnvelope` binds a mission to a version only if that envelope is already retained for the mission's tenant (no dangling pin), delegating the set-once, revision-fenced write to the existing `bindMissionPolicyEnvelopeVersion`. `getMissionPolicyEnvelope` resolves the exact envelope a mission inherited, for a task compiler to hand to `evaluatePolicyEnvelope`.

## Alternatives considered

- **Extend `warden-policy.ts` to carry the §8.18 fields.** Rejected: that module models a different spec concept (layered PR-edit risk policy with approvals/waivers). Overloading it would conflate risk layering with task-boundary enforcement and complicate both. The envelope is a distinct §8.18 object; the two are complementary and referenced as such.
- **Store the envelope in the policy package's own DDL (as `WardenPolicyStore` does).** Rejected: a mission lives in the main AppDb; a mission that pins a policy version must reference a retained row in the same database, or the "retained + inherited" contract becomes a cross-database projection with no integrity. The envelope body stays opaque so the db still does not depend on the policy type.
- **Enforce at the live task dispatch in this change.** Deferred: wiring the evaluator into the router/execution seam is a separate, higher-risk change. This PR lands the deterministic primitive, its retention, and its inheritance read — the pieces a dispatch enforcement point needs — so `ME-PEV-001` advances from "scattered" to "a single retained, deterministic object", while remaining `partial` until a live caller enforces it.

## Security impact

Strengthens deterministic policy enforcement and touches no authentication/authorization/tenant-isolation surface adversely. The evaluator is pure and fails closed; `parsePolicyEnvelope` rejects malformed stored data; the store is tenant-scoped and immutable; a mission cannot pin an envelope from another tenant (the retention check is tenant-scoped) or a non-existent version. No secrets, no external calls, no new trust boundary.

## Data and compatibility impact

Additive. One new table (`policy_envelopes`) created via `CREATE TABLE IF NOT EXISTS` with immutability triggers; it converges on fresh and pre-change databases with no `ALTER`. New pure functions and db accessors are additive to `@mendpoint/policy` and `@mendpoint/db`. No wire-format or existing-API change.

## Migration plan

1. Add the `PolicyEnvelope` type, `evaluatePolicyEnvelope`, `parsePolicyEnvelope`, and canonical serializer to `@mendpoint/policy`; export them.
2. Add the immutable `policy_envelopes` table and the `createPolicyEnvelope`/`getPolicyEnvelope`/`bindMissionToPolicyEnvelope`/`getMissionPolicyEnvelope` accessors to `@mendpoint/db`; export them.
3. Add unit tests for the evaluator and store/inheritance.
4. Run the policy and db test suites, `typecheck`, and `adr:check`.

## Rollback

Revert the commit. The new table is unreferenced by existing code paths and the new functions have no existing callers, so removal is clean; an older build simply ignores the table.

## Evaluation plan

Success is the policy and db suites passing with the evaluator, store, immutability, tenant-scoping, and inheritance covered, and `typecheck`/`adr:check` green. The signal to revisit is wiring the evaluator into a live dispatch enforcement point (the follow-on that would move `ME-PEV-001` toward `verified`), which will need its own change against the router/execution seam.
