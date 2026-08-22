# Enroll the v4.0 persistent-context requirements as their own register set

- **Status:** Accepted
- **Date:** 2026-08-22
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

`2026-08-22-adopt-v4-product-specification.md` made the v4.0 specification canonical and recorded a **deliberate enforcement gap**: v4.0's new persistent-context surface — Mission Space (§6.5), Mission decisions/exceptions/artifacts (§6.9), the §28.1.0 Mission acceptance criteria, the Shared Mission Task Engine (§6.8), Organization Memory (§6.6), the Policy Envelope (§6.7), the Mission Context Compiler (§6.10), and the pluggable structural-extractor contract (§11.22–§11.26) — was canonical but **not enrolled** in the enforced requirement register, because folding those requirements into the foundational set's `closurePlan.requirementCount` would corrupt a provenance integrity check (the same reasoning ADR-0004 gave for the v3.0 additions).

The multi-register-set validator that ADR-0004's follow-up introduced already carries a second set (`v3-platform`) with its own `source`, `auditedRevision`, and accepted-identifier list, validated by `npm run spec:check`. That is exactly the mechanism this ADR uses.

## Decision

Enroll the v4.0 persistent-context surface as a third register set, `v4-platform`, with its own provenance and accepted identifiers, so the register asserts and enforces those requirements without touching the foundational or v3.0 sets.

- Add `V4_PLATFORM_REQUIREMENT_IDS`, the identifier/gap patterns (`ME-(MSN|MTE|OMM|PEV|MCC|SXT)-NNN`), and `V4_PLATFORM_REGISTER_SET` to `packages/contract/src/product-requirements.ts`, and include it in `PRODUCT_REGISTER_SETS`. The accepted-identifier set lives in code, so `closurePlan.requirementCount` stays an integrity check on a provenance claim rather than a value the manifest asserts about itself.
- Add the keyed `v4-platform` entry to `docs/PRODUCT_REQUIREMENTS.json` `additionalRegisterSets` with `source` citing the v4.0 sections and this ADR, `auditedRevision` pinned to the audited commit, `requirementCount` 8, and eight requirements: `ME-MSN-001`/`002`/`003`, `ME-MTE-001`, `ME-OMM-001`, `ME-PEV-001`, `ME-MCC-001`, `ME-SXT-001`.
- Record each requirement's **honest** implementation status. All eight are `partial`: the primitives exist in code (cited as evidence) but are not yet fully load-bearing — Mission rows do not yet pin graph/policy versions, the artifact registry is not wired into live execution, the Policy Envelope is not retained per Mission, and most live Fettler runs are not mission-bound. These are the substantive gaps the remaining gap-closure PRs address.
- Add a validator test asserting `v4-platform` is enforced by default and that its count/identifier contract fails closed.

The identifiers, evidence, and counts of the foundational (84) and `v3-platform` (9) sets are unchanged.

## Alternatives considered

- **Fold the v4.0 requirements into the foundational set.** Rejected: corrupts the `closurePlan.requirementCount` provenance claim, exactly as ADR-0004 rejected for v3.0.
- **Mark the new requirements `verified` because the primitives exist.** Rejected as overclaiming. `spec:check` would accept `verified` here, but the persistent-context layer is not yet load-bearing; recording it as done would reintroduce the claimed-vs-actual split the register exists to remove. `partial` with real code evidence is the accurate state.
- **Leave the surface unenforced (status quo after the adoption ADR).** Rejected: the owner asked to close the gaps, and enrolling the set is the named follow-up.

## Security impact

None. Documentation and requirement-register data plus a validator constant and a test. No authentication, authorization, tenant-isolation, secret, or runtime attack surface is touched. `spec:check` remains fully enforced and is strengthened by one additional enforced set.

## Data and compatibility impact

No persistence, schema, wire-format, or public-API change. `docs/PRODUCT_REQUIREMENTS.json` gains one `additionalRegisterSets` entry; `packages/contract/src/product-requirements.ts` gains one exported register-set definition. The foundational and v3.0 sets are byte-unchanged.

## Migration plan

1. Add the `v4-platform` register-set definition and include it in `PRODUCT_REGISTER_SETS`.
2. Add the keyed `v4-platform` entry to the manifest with the eight requirements and pinned provenance.
3. Add the validator test.
4. Run `npm run spec:check`, `npm run adr:check`, the contract tests, and `npm run typecheck`.

If the set definition and the manifest entry are added out of order, `spec:check` fails closed with `REGISTER_SET_MISSING` or `REQUIREMENT_COUNT`, preventing a half-enrolled set from merging.

## Rollback

Revert the commit. The register returns to two sets; nothing is transformed or deleted.

## Evaluation plan

Success is `npm run spec:check` reporting three register sets with `v4-platform: 8 requirements` and no loosened assertion, and the contract tests and `typecheck` passing. Reconsideration is triggered by a decision to change any enrolled requirement's status to `verified`, which must be backed by evidence that the corresponding persistent-context capability is load-bearing.
