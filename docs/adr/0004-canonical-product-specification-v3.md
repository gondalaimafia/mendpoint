# ADR-0004: Canonical product specification is the v3.0 platform specification

- **Status:** Accepted
- **Date:** 2026-08-18
- **Author:** Claude Code
- **Supersedes:** ADR-0001
- **Superseded by:** 2026-08-22-adopt-v4-product-specification

## Context

ADR-0001 (2026-08-17) resolved a two-canonical-specifications conflict by making `docs/product/mendpoint-product-platform-specification.md` (v2.0) the single canonical product and platform specification and re-pinning the enforced requirement register `docs/PRODUCT_REQUIREMENTS.json` at it. The register pins `spec.path` and a `spec.sha256` digest computed by the repository's own `canonicalTextSha256`, and the `npm run spec:check` gate (`scripts/product-spec-check.ts`) enforces that pin. That is the only spec-authority claim CI enforces.

The owner has since supplied a v3.0 development baseline of the same document and named it the new canonical product and platform specification. v3.0 preserves the v2.0 product boundaries — the Fettler/ReGauge split, graph-scoped reasoning, review-first execution, hybrid model orchestration, migration data as a compounding asset, and the land-and-expand strategy — and strengthens the architecture around five decisions it records in its own "Version 3.0 architectural refinement" section:

1. **Representation-first intelligence** — the Change Graph is the canonical durable representation of software relationships; models SHOULD reason over bounded graph projections rather than reconstructing known relationships from raw files or long prompts.
2. **Resolve once, traverse many times** — high-value relationships SHOULD be entity-resolved and materialized during offline or incremental graph construction when they can be validated, versioned, and reused safely.
3. **Explicit epistemic state** — edges, coverage, staleness, conflict, and provenance are first-class product data; `NO IMPACT FOUND` and `NO IMPACT FOUND WITH INSUFFICIENT COVERAGE` are different product outcomes.
4. **Selective intelligence ownership** — own migration-specific intelligence where proprietary data, quality, latency, or economics justify it, and rent general reasoning where external models remain superior.
5. **Independent soft verification** — deterministic verification remains authoritative; probabilistic model-based verification MAY improve selection and calibration but MUST stay a soft signal beneath tests, graph invariants, runtime evidence, and human decisions.

Measured against the v2.0 document with `git diff --no-index --numstat docs/product/mendpoint-product-platform-specification.md docs/product/mendpoint-product-platform-specification-v3.md`, v3.0 adds 1073 lines and removes 143 (literal added/removed line counts, no whitespace normalization; a whitespace-normalized diff reports a smaller ~1068/134). The added normative surface includes the graph entity contracts §8.13–8.16 (`GraphEntity`, `GraphEdge`, `GraphCoverage`, `MissionGraphProjection`), eight new functional requirements (`FET-015`…`FET-018`, `REG-015`…`REG-018`), an expanded §11 Change Graph, §12.4.1 graph epistemic status, §13.9–13.10, §15.7–15.8, §17.4.1–17.4.3, §17.13, §18.6.1, §20.8, §21.2.1, §23.3.1, the §28.1.1 Change Graph acceptance criteria, §31.6.1–31.6.2, §33.8–33.12, and §36.1.

v3.0 is explicit in its §0 that where it introduces detail not present in the prior draft, that detail is a **development baseline**, not a claim about what is already implemented; existing production behavior remains the implementation source of truth until intentionally migrated. This ADR adopts v3.0 on those terms. Making v3.0 canonical does not assert that the repository satisfies it, and the two coding agents must continue to treat unimplemented v3.0 detail as forward-looking contract rather than current behavior.

## Decision

We will make `docs/product/mendpoint-product-platform-specification-v3.md` (v3.0) the single canonical product and platform specification and the release contract authority, superseding ADR-0001. Specifically:

- Add the v3.0 document at `docs/product/mendpoint-product-platform-specification-v3.md`, copied byte-for-byte from the owner-supplied source so the pinned digest remains faithful to what the owner provided.
- Re-point the enforced requirement register `docs/PRODUCT_REQUIREMENTS.json` at the v3.0 document: `spec.path` to `docs/product/mendpoint-product-platform-specification-v3.md`, `spec.version` to `3.0`, and `spec.sha256` to `726854e51599c5da71272cdb6b187b11f3f8a1f21e1252c1d866e0fc4900f951`, the digest computed by the repository's own `canonicalTextSha256` over the v3.0 file, so `npm run spec:check` validates against the canonical document.
- Demote `docs/product/mendpoint-product-platform-specification.md` (v2.0) from canonical authority to a superseded notice pointing at the v3.0 document. The file is retained unchanged as history.
- Set ADR-0001's status to `Superseded by ADR-0004` so the ADR log carries a single live canonical decision.
- Update the authority pointers that named v2.0 as canonical — `CLAUDE.md`, `AGENTS.md`, `docs/agents/OPERATING_PROTOCOL.md` §4, `docs/PRODUCT_CONTRACT.md`, `docs/PRODUCT_SPEC.md`, and the v1.0 demotion notice in `docs/FOUNDATIONAL_PRODUCT_SPEC.md` — to name the v3.0 document, so both coding agents read the canonical specification.

The 84 requirements in the register keep their identifiers, evidence, and closure metadata unchanged. They reference code, test, and document evidence locators plus gap-analysis identifiers (`SPEC-01` … `GTM-03`); none reference v2.0 or v1.0 spec section anchors, so re-pointing the spec leaves no dangling section references and no requirement needs remapping.

The canonical product names remain Fettler and ReGauge. The historical identifiers `Warden` and `Transformer` are NOT renamed by this decision; v3.0 §0.2 is explicit that blind renaming would break persistence and compatibility, so they remain in code, schemas, migrations, telemetry, and APIs where changing them creates risk.

## Alternatives considered

- **Keep v2.0 canonical and treat v3.0 as an unenforced design note.** Rejected by the owner: v3.0 is the document new development is meant to align to, and leaving it unenforced recreates the split-authority defect ADR-0001 exists to remove — a canonical document the register does not pin and agents are not told to read.
- **Adopt v3.0 by editing v2.0 in place rather than adding a new file.** Rejected: it would destroy the v2.0 history, and the pinned digest must be computed over a faithful, unmodified copy of the owner-supplied v3.0 text. A new file with a superseded notice on v2.0 preserves the chain.
- **Adopt v3.0 and enroll its eight new functional requirements and §28.1.1 Change Graph acceptance criteria into the enforced foundational register in the same change.** Rejected as wrong, not merely out of scope. The register's accepted identifier set is enforced from the `FOUNDATIONAL_REQUIREMENT_IDS`/`DOMAIN_COUNTS` constant in `packages/contract/src/product-requirements.ts`, and `closurePlan.source`/`closurePlan.auditedRevision` pin that set's provenance to the 2026-08-01 foundational gap analysis at a specific revision. The register therefore asserts a precise claim: *these 84 requirements were derived from that audit, at that revision, and here is their closure state.* `closurePlan.requirementCount` is the integrity check on that provenance claim, not bookkeeping. Inflating `DOMAIN_COUNTS` to absorb eight requirements drawn from a specification written seventeen days later would make the foundational register assert that those requirements were part of an audit that never covered them — the same move as widening a test's expected value to make it pass. The v3.0 additions are a distinct normative surface with different provenance; they must be enrolled as their own set, with their own `source` and `auditedRevision`, once the validator is taught to carry more than one register. That is a deliberate contract change deserving its own PR and review, which is exactly why it does not belong in this docs-and-register re-point.
- **Do nothing.** Rejected: the owner has decided v3.0 is canonical; leaving the register and the agent-facing pointers on v2.0 keeps CI enforcing a superseded document.

## Security impact

None. This change moves the authority pointer between in-repository specification documents and updates documentation pointers. It does not touch authentication, authorization, tenancy isolation, secret handling, or any runtime attack surface, and introduces no new trust boundary. The `spec:check` gate remains fully enforced and unweakened; its evidence-existence and manifest-structure assertions are unchanged.

## Data and compatibility impact

No persistence, schema, wire-format, or public-API change. The only machine-consumed artifact affected is `docs/PRODUCT_REQUIREMENTS.json`, whose `spec.path`, `spec.version`, and `spec.sha256` fields change. `scripts/product-spec-check.ts` and `scripts/public-claims-check.ts` read `spec.path` from the manifest, so they follow the re-point without code changes. The manifest schema, the 84 requirement identifiers, `requirementCount`, the `closurePlan` provenance, and all evidence locators are unchanged. The synthetic fixture path in `packages/contract/src/product-requirements.test.ts` is unrelated test data and is intentionally left as-is.

## Enforcement gap: canonical but not yet enforced

v3.0's new normative surface — the eight functional requirements `FET-015`…`FET-018` and `REG-015`…`REG-018`, and the §28.1.1 Change Graph acceptance criteria — is **canonical as of this ADR but is NOT yet enforced by `npm run spec:check`**. The enforced register `docs/PRODUCT_REQUIREMENTS.json` continues to carry exactly the 84 foundational requirements, unchanged. This is a **known, deliberate gap**, recorded here so the register is never read as covering v3.0 when it does not.

The gap is deliberate for the reason given under Alternatives: folding these requirements into the foundational closure plan would corrupt a provenance claim, because `closurePlan.requirementCount` is the integrity check asserting that the enrolled set came from the 2026-08-01 audit at its pinned revision. Recording an unenforced requirement as enforced would be exactly the split between claimed and actual coverage that this repository has been removing, and it would be a poor way to adopt a specification whose central theme is explicit epistemic state.

The named follow-up is to enroll the v3.0 requirements as their own register set — with their own `source` and `auditedRevision` reflecting this specification and its audit — after `packages/contract/src/product-requirements.ts` is extended to validate more than one register set. That follow-up is a deliberate contract change with its own PR and review. Until it lands, these requirements are canonical, forward-looking, and almost entirely unimplemented; they are tracked by the specification text, not by the enforced register.

## Migration plan

1. Add the v3.0 document as a byte-for-byte copy at `docs/product/mendpoint-product-platform-specification-v3.md`.
2. Compute `spec.sha256` with the repository's `canonicalTextSha256` over the final v3.0 file text.
3. Update `docs/PRODUCT_REQUIREMENTS.json` (`spec.path`, `spec.version`, `spec.sha256`).
4. Demote the v2.0 header to a superseded notice; set ADR-0001 to `Superseded by ADR-0004`; update `OPERATING_PROTOCOL.md` §4, `CLAUDE.md`, `AGENTS.md`, `PRODUCT_CONTRACT.md`, `PRODUCT_SPEC.md`, and the `FOUNDATIONAL_PRODUCT_SPEC.md` demotion notice.
5. Run `npm run spec:check`, `npm run ga:check`, `npm run typecheck`, and `npm test`.

The change is atomic within one commit; there is no dual-write window or feature gate. If the digest and the file text are edited out of order the gate fails closed with `SPEC_HASH_MISMATCH`, which prevents a silently wrong pin from merging.

## Rollback

Revert the commit. The v2.0 document is retained in full, so restoring the previous `spec.path`, `spec.version`, and `spec.sha256`, the previous v2.0 header, and ADR-0001's `Accepted` status fully returns the prior state. No data is transformed and nothing is deleted, so rollback is clean at any time.

## Evaluation plan

Success is defined by `npm run spec:check` passing against the v3.0 document (reporting `spec 3.0` and 84 requirements) with no assertion loosened, and by `ga:check`, `typecheck`, and `test` passing. The signal that would trigger reconsideration is a decision to enforce release acceptance against a document other than the canonical specification, or a decision to enroll the v3.0 functional requirements and Change Graph acceptance criteria into the enforced register; either would be handled by a superseding or follow-up change rather than by re-splitting authority.
