# Adopt the v4.0 platform specification as the canonical development baseline

- **Status:** Accepted
- **Date:** 2026-08-22
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** ADR-0004
- **Superseded by:** none

## Context

ADR-0004 (2026-08-18) made `docs/product/mendpoint-product-platform-specification-v3.md` (v3.0) the single canonical product and platform specification and re-pinned the enforced requirement register `docs/PRODUCT_REQUIREMENTS.json` at it. The register pins `spec.path` and a `spec.sha256` digest computed by the repository's own `canonicalTextSha256`, and the `npm run spec:check` gate (`scripts/product-spec-check.ts`) enforces that pin.

The owner has since supplied a v4.0 development baseline of the same document (`Version: 4.0`, `Status: Development foundation`, `Supersedes: v3.0 as the development baseline`). v4.0 preserves every v3.0 product boundary — the Fettler/ReGauge split, representation-first Change Graph intelligence, review-first execution, hybrid model orchestration, migration data as a compounding asset, and the land-and-expand strategy — and records its additions in its own "Version 4.0 architectural refinement" section. The material new normative surface beyond v3.0 is the **persistent operating-context layer** and a **pluggable structural-extraction boundary**:

1. **Persistent Mission intelligence** (§6.5 Mission Space) — a Mission is the durable operating context for a migration: graph version, repository snapshots, decisions, tasks, verification evidence, exceptions, artifacts, policy, cost, and history MUST survive across agent and human interactions, and MUST NOT rely on conversational transcript alone.
2. **Organization Memory** (§6.6) — tenant-specific engineering conventions with a governed lifecycle and precedence, kept distinct from Change Graph facts, hard policy, recipes, and model weights.
3. **Inherited Policy Envelopes** (§6.7) — every Mission task inherits deterministic repository, tool, model, residency, risk, review, and learning-data boundaries; prompts are not the primary security boundary; a long-running Mission retains the policy version under which a decision was made.
4. **Shared human/agent task state** (§6.8) — one Mission task graph so work can move agent → human → agent without reconstructing context.
5. **Mission Context Compiler** (§6.10) — minimum-sufficient bounded context assembled from structured Mission state rather than a full history dump.
6. **Pluggable structural extraction** (§11.22–§11.26) — low-level code-graph extraction sits behind a Mendpoint-owned `StructuralGraphExtractor` contract; external engines such as Graphify MAY be used behind it but MUST NOT define the canonical ontology, persistence model, tenant semantics, or migration intelligence.

v4.0 also adds the §28.1.0 Mission-and-persistent-context acceptance criteria, the §27 Phase 0–4 release gates, the §29 design-partner readiness scorecard, and §33 open product decisions. It carries forward the v3.0 functional requirements `FET-015`…`FET-018` and `REG-015`…`REG-018` and the §28.1.1 Change Graph acceptance criteria unchanged.

v4.0 is explicit in its §0 and §0.4 that where it introduces detail not present in the prior draft, that detail is a **development baseline**, not a claim about what is already implemented; existing production behavior remains the implementation source of truth until intentionally migrated. This ADR adopts v4.0 on those terms. Making v4.0 canonical does not assert that the repository satisfies it.

## Decision

We will make `docs/product/mendpoint-product-platform-specification-v4.md` (v4.0) the single canonical product and platform specification and the release-contract authority, superseding ADR-0004. Specifically:

- Add the v4.0 document at `docs/product/mendpoint-product-platform-specification-v4.md`, copied byte-for-byte from the owner-supplied source so the pinned digest is faithful to what the owner provided.
- Re-point the enforced requirement register `docs/PRODUCT_REQUIREMENTS.json`: `spec.path` to `docs/product/mendpoint-product-platform-specification-v4.md`, `spec.version` to `4.0`, and `spec.sha256` to `a317c50563e97ddbb97bf5938e64acf12e8855f1ab1875c501ae75dc13dc8679`, the digest computed by the repository's own `canonicalTextSha256` over the v4.0 file, so `npm run spec:check` validates against the canonical document.
- Demote `docs/product/mendpoint-product-platform-specification-v3.md` (v3.0) from canonical authority to a superseded notice pointing at the v4.0 document. The file is retained unchanged below the notice as history.
- Set ADR-0004's `Superseded by` to this ADR so the ADR log carries a single live canonical decision.
- Update the authority pointers that named v3.0 as canonical — `CLAUDE.md`, `AGENTS.md`, `docs/agents/OPERATING_PROTOCOL.md` §4, `docs/PRODUCT_CONTRACT.md`, `docs/PRODUCT_SPEC.md`, `docs/FOUNDATIONAL_PRODUCT_SPEC.md`, and the v2.0 demotion notice — to name the v4.0 document, so both coding agents read the canonical specification.

The requirement register keeps its two register sets, their identifiers, evidence, and closure metadata unchanged. The `additionalRegisterSets` set that enrolled the v3.0 §9.5/§10.4/§28.1.1 additions keeps its provenance string citing v3.0 and ADR-0004, because that string records where and when that set was audited and enrolled; it is a historical provenance claim, not a live pointer, and v4.0 carries those same requirement identifiers unchanged.

The canonical product names remain Fettler and ReGauge. The historical identifiers `Warden` and `Transformer` are NOT renamed by this decision; v4.0 §0.2 is explicit that blind renaming would break persistence and compatibility, so they remain in code, schemas, migrations, telemetry, and APIs where changing them creates risk.

## Alternatives considered

- **Keep v3.0 canonical and treat v4.0 as an unenforced design note.** Rejected by the owner: v4.0 is the document new development is meant to align to, and leaving it unenforced recreates the split-authority defect ADR-0001/ADR-0004 exist to remove — a canonical document the register does not pin and agents are not told to read.
- **Adopt v4.0 by editing v3.0 in place rather than adding a new file.** Rejected: it would destroy the v3.0 history, and the pinned digest must be computed over a faithful, unmodified copy of the owner-supplied v4.0 text. A new file with a superseded notice on v3.0 preserves the chain.
- **Enroll v4.0's new normative surface (persistent Mission, Organization Memory, Policy Envelope, task engine, structural extractor, and the §28.1.0 acceptance criteria) into the enforced register in the same change.** Rejected as wrong, not merely out of scope, for the same reason ADR-0004 gave: the foundational register's `closurePlan.requirementCount` is an integrity check asserting its enrolled set came from the 2026-08-01 audit at its pinned revision. Absorbing requirements drawn from a later specification would make the register assert they were part of an audit that never covered them — the same move as widening a test's expected value to make it pass. The v4.0 additions are a distinct normative surface with different provenance and must be enrolled as their own register set, with their own `source` and `auditedRevision`, in a deliberate follow-up PR with review.
- **Do nothing.** Rejected: the owner has decided v4.0 is canonical; leaving the register and agent-facing pointers on v3.0 keeps CI enforcing a superseded document.

## Security impact

None. This change moves the authority pointer between in-repository specification documents and updates documentation pointers. It does not touch authentication, authorization, tenancy isolation, secret handling, or any runtime attack surface, and introduces no new trust boundary. The `spec:check` gate remains fully enforced and unweakened; its evidence-existence and manifest-structure assertions are unchanged.

## Data and compatibility impact

No persistence, schema, wire-format, or public-API change. The only machine-consumed artifact affected is `docs/PRODUCT_REQUIREMENTS.json`, whose `spec.path`, `spec.version`, and `spec.sha256` fields change. `scripts/product-spec-check.ts` and `scripts/public-claims-check.ts` read `spec.path` from the manifest, so they follow the re-point without code changes. The manifest schema, both register sets' requirement identifiers, `requirementCount`, the `closurePlan` provenance, and all evidence locators are unchanged.

## Enforcement gap: canonical but not yet enforced

v4.0's new normative surface — persistent Mission Space (§6.5), Organization Memory contract (§6.6), Policy Envelope (§6.7), Shared Mission Task Engine (§6.8), Mission Context Compiler (§6.10), the pluggable structural-extractor contract (§11.22–§11.26), and the §28.1.0 Mission-and-persistent-context acceptance criteria — is **canonical as of this ADR but is NOT yet enforced by `npm run spec:check`**. The enforced register continues to carry exactly its existing two register sets, unchanged. This is a **known, deliberate gap**, recorded here so the register is never read as covering v4.0 when it does not, and it is exactly the discipline v4.0's own emphasis on explicit epistemic state requires.

The named follow-up is to enroll the v4.0 persistent-context requirements as their own register set — with their own `source` and `auditedRevision` reflecting this specification and its audit — extending the multi-register-set validator that ADR-0004's follow-up already introduced. Until it lands, these requirements are canonical, forward-looking, and largely unimplemented; the accompanying gap-closure assessment records their current implementation status against the code.

## Migration plan

1. Add the v4.0 document as a byte-for-byte copy at `docs/product/mendpoint-product-platform-specification-v4.md`.
2. Compute `spec.sha256` with the repository's `canonicalTextSha256` over the final v4.0 file text.
3. Update `docs/PRODUCT_REQUIREMENTS.json` (`spec.path`, `spec.version`, `spec.sha256`).
4. Demote the v3.0 header to a superseded notice; set ADR-0004 `Superseded by` to this ADR; update `OPERATING_PROTOCOL.md` §4, `CLAUDE.md`, `AGENTS.md`, `PRODUCT_CONTRACT.md`, `PRODUCT_SPEC.md`, the `FOUNDATIONAL_PRODUCT_SPEC.md` notice, and the v2.0 demotion notice.
5. Run `npm run spec:check`, `npm run adr:check`, `npm run names:check`, `npm run claims:check`, `npm run docs:check`, `npm run typecheck`, and `npm test`.

The change is atomic within one commit; there is no dual-write window or feature gate. If the digest and the file text are edited out of order the gate fails closed with `SPEC_HASH_MISMATCH`, which prevents a silently wrong pin from merging.

## Rollback

Revert the commit. The v3.0 document is retained in full, so restoring the previous `spec.path`, `spec.version`, and `spec.sha256`, the previous v3.0 header, and ADR-0004's `Superseded by: none` fully returns the prior state. No data is transformed and nothing is deleted, so rollback is clean at any time.

## Evaluation plan

Success is defined by `npm run spec:check` passing against the v4.0 document (reporting `spec 4.0`) with no assertion loosened, and by `adr:check`, `names:check`, `claims:check`, `docs:check`, `typecheck`, and `test` passing. The signal that would trigger reconsideration is a decision to enforce release acceptance against a document other than the canonical specification, or a decision to enroll the v4.0 persistent-context requirements into the enforced register; either would be handled by a superseding or follow-up change rather than by re-splitting authority.
