# ADR-0001: Canonical product specification is the v2.0 platform specification

- **Status:** Accepted
- **Date:** 2026-08-17
- **Author:** Claude Code
- **Supersedes:** none
- **Superseded by:** none

## Context

The repository carried two documents that each declared canonical authority:

- `docs/FOUNDATIONAL_PRODUCT_SPEC.md` (v1.0), canonicalized 2026-08-01, whose header read `**Repository authority:** Canonical`. Its requirement register `docs/PRODUCT_REQUIREMENTS.json` pins `spec.path` to it and a `spec.sha256` digest over its text, and the `npm run spec:check` gate (`scripts/product-spec-check.ts`) enforces that pin. This is the only spec-authority claim CI enforces.
- `docs/product/mendpoint-product-platform-specification.md` (v2.0), whose §0 also declares itself the canonical product and platform specification. `CLAUDE.md`, `AGENTS.md`, and `docs/agents/OPERATING_PROTOCOL.md` §3 instruct both coding agents to read it.

The result was a live conflict: two canonical specifications, with CI enforcing the one agents are not told to read. `OPERATING_PROTOCOL.md` §4 recorded this explicitly as **Unresolved** and deferred the choice to an owner decision recorded as an ADR (added in PR #145). The owner decided to make v2.0 the single canonical authority.

The v2.0 document is the more complete and current baseline: it carries the platform contracts, normative language, and product invariants that the v1.0 compression omits, and it is already the document new development aligns to.

## Decision

We will make `docs/product/mendpoint-product-platform-specification.md` (v2.0) the single canonical product and platform specification and the release contract authority. Specifically:

- Re-point the enforced requirement register `docs/PRODUCT_REQUIREMENTS.json` at the v2.0 document: `spec.path` to `docs/product/mendpoint-product-platform-specification.md`, `spec.version` to `2.0`, and `spec.sha256` to the digest computed by the repository's own `canonicalTextSha256` over the v2.0 file, so `npm run spec:check` validates against the canonical document.
- Demote `docs/FOUNDATIONAL_PRODUCT_SPEC.md` (v1.0) from `Repository authority: Canonical` to a superseded notice pointing at the v2.0 document. The file is retained unchanged as history.
- Record the resolved source-of-truth hierarchy in `OPERATING_PROTOCOL.md` §4 and update the stale authority pointers in `docs/PRODUCT_CONTRACT.md` and `docs/PRODUCT_SPEC.md`.

The 84 requirements in the register keep their identifiers, evidence, and closure metadata unchanged. They reference code, test, and document evidence locators plus gap-analysis identifiers (`SPEC-01` … `GTM-03`); none reference v1.0 spec section anchors, so re-pointing the spec leaves no dangling section references and no requirement needs remapping.

## Alternatives considered

- **Demote v2.0 to a design baseline and keep v1.0 as the enforced release contract.** This preserves the existing digest and CI wiring with no register change. Rejected by the owner: it keeps agents reading a non-authoritative document, and v1.0 omits the platform contracts the product now depends on. It entrenches the split rather than resolving it.
- **Keep both canonical, formally separating "development baseline" from "release contract."** This matches the prior interim state in `OPERATING_PROTOCOL.md`. Rejected: two documents claiming canonical authority is the defect this ADR exists to remove, and it leaves CI enforcing the document agents are told not to follow.
- **Do nothing.** Rejected: the conflict is live, `spec:check` enforces the wrong document, and `OPERATING_PROTOCOL.md` already flagged it as owing an owner decision.

## Security impact

None. This change moves the authority pointer between two in-repository specification documents and does not touch authentication, authorization, tenancy isolation, secret handling, or any runtime attack surface. No new trust boundary is introduced. The `spec:check` gate remains fully enforced and unweakened; its evidence-existence and manifest-structure assertions are unchanged.

## Data and compatibility impact

No persistence, schema, wire-format, or public-API change. The only machine-consumed artifact affected is `docs/PRODUCT_REQUIREMENTS.json`, whose `spec.path`, `spec.version`, and `spec.sha256` fields change. `scripts/product-spec-check.ts` and `scripts/public-claims-check.ts` read `spec.path` from the manifest, so they follow the re-point without code changes. The manifest schema, the 84 requirement identifiers, `requirementCount`, and all evidence locators are unchanged. The synthetic fixture path in `packages/contract/src/product-requirements.test.ts` is unrelated test data and is intentionally left as-is.

## Migration plan

1. Add the requirement-register and release-contract cross-links to v2.0 §0 (this fixes the canonical document's content before the digest is computed).
2. Compute `spec.sha256` with the repository's `canonicalTextSha256` over the final v2.0 file text.
3. Update `docs/PRODUCT_REQUIREMENTS.json` (`spec.path`, `spec.version`, `spec.sha256`).
4. Demote the v1.0 header; update `OPERATING_PROTOCOL.md` §4, `PRODUCT_CONTRACT.md`, and `PRODUCT_SPEC.md`.
5. Run `npm run spec:check`, `npm run typecheck`, `npm test`, and `npm run build -w @mendpoint/web`.

The change is atomic within one commit; there is no dual-write window or feature gate. If the digest and the file text are edited out of order the gate fails closed with `SPEC_HASH_MISMATCH`, which prevents a silently wrong pin from merging.

## Rollback

Revert the commit. The v1.0 document is retained in full, so restoring the previous `spec.path`, `spec.version`, and `spec.sha256` and the previous header text fully returns the prior state. No data is transformed and nothing is deleted, so rollback is clean at any time.

## Evaluation plan

Success is defined by `npm run spec:check` passing against the v2.0 document (reporting `spec 2.0` and 84 requirements) with no assertion loosened, and by `typecheck`, `test`, and the `@mendpoint/web` build passing. The signal that would trigger reconsideration is a future need to enforce release acceptance against a document other than the canonical specification; that would be handled by a superseding ADR rather than by re-splitting authority.
