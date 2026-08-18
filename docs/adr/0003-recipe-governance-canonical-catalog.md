# ADR-0003: Recipe governance — which catalog is canonical

- **Status:** Proposed
- **Date:** 2026-08-17
- **Author:** Claude Code
- **Supersedes:** none
- **Superseded by:** none

## Context

A governed recipe catalog exists, and the code that selects recipes in production does not use it.

Recipe selection runs over the plain contract. `planTransformerMission` takes a `recipeCatalog: readonly MigrationRecipeContract[]` (`packages/transformer/src/mission-planner.ts:48`), and `MigrationRecipeContract` (`packages/transformer/src/recipe.ts:160-175`) carries `id`, `version`, `digest`, `title`, `source`, `target`, `allowedPaths`, `preconditions`, `transforms`, `verificationCommands`, and `rollback`. It lacks all four of the §14.2 SHOULD-fields: required evidence, known limitations, source/provenance, and approval status (verified absent — no such field names appear in `recipe.ts`).

The governed vehicle that carries the governance signals is entirely off the selection path. `ProviderRecipeArtifact` / `SignedProviderRecipe` (`packages/transformer/src/recipe-catalog.ts:63-144`) carry an ed25519 signature (`recipe-catalog.ts:136-144`), `evidence.requiredSourceKinds` (`recipe-catalog.ts:101-111`), `ownership` (`recipe-catalog.ts:112-116`), and `compatibility` (`recipe-catalog.ts:117-126`); `createProviderRecipeCatalog` verifies each signature and enforces revocation by artifact digest, recipe version, and key id (`recipe-catalog.ts:511,530-544,550`). None of this is reachable from `planTransformerMission`.

The two catalogs are already parallel, not merely disconnected. The production wiring constructs `TransformerMissionService` with a hard-coded array of *plain* contracts — `NODE_RUNTIME_18_TO_20_RECIPE`, `AWS_SDK_JS_V2_TO_V3_RECIPE`, and four more (`apps/api/src/api-runtime.ts:32-46`) — which flow through the service (`apps/api/src/transformer-missions.ts:90,126`) into `planTransformerMission`. The *signed* artifacts for the same providers live in `packages/transformer/src/published-recipes.ts` and are consumed only by the evaluation and canary harnesses (`packages/eval/src/transformer-agent-eval.ts:1114,1406`, `packages/eval/src/transformer-canary.ts:343`). So the governed catalog is exercised in evals while production selection uses ungoverned contracts.

One nuance must be stated plainly so this decision is not oversold. Routing selection through the signed catalog would close §14.2 and the governance bypass, but it would **not** satisfy §14.3, because the signed artifact's own detection signals — `file_exists | manifest_value | source_pattern | provider_evidence` (`recipe-catalog.ts:47-53`) — are themselves text- and manifest-based. Graph-confirmed applicability is the subject of ADR-0002, not this ADR. This ADR is about which catalog governs selection, not about how applicability is proven.

§32 lists "router policy architecture" and "learning provenance classes" among the ADR-gated categories, and the seam that must change to route selection through a governed catalog lives in `apps/api` (`transformer-missions.ts`, `api-runtime.ts`). Which catalog is canonical is therefore an owner decision, recorded here.

## Decision

This ADR does not itself decide. It records the recipe-governance split as an owner decision and places three options before the owner. The decision owed is: **which recipe catalog is canonical for production selection — the signed provider catalog, an extended plain contract, or the status quo.** The options are weighed in full under Alternatives considered.

- **(a)** Make selection consume `SignedProviderRecipe`: verify signature and revocation and honor the signed catalog's governance state as the gate for eligibility.
- **(b)** Add the four §14.2 fields to the plain `MigrationRecipeContract`.
- **(c)** Leave selection as-is.

## Alternatives considered

**(a) Make selection consume `SignedProviderRecipe`.** The mission service resolves recipes through `createProviderRecipeCatalog`, which verifies the ed25519 signature and enforces revocation (`recipe-catalog.ts:511,530-544,550`); an artifact is eligible only if signed by a trusted key and not revoked, and its `requiredSourceKinds`, `ownership`, and `compatibility` become inputs to selection. *Closes:* the governance bypass and §14.2 in substance — the signed artifact carries the required-evidence (`requiredSourceKinds`), provenance (provider/publishedAt/change), and approval (signature + revocation) signals §14.2 asks for. *Leaves open:* §14.3 (detection is still text/manifest based, `recipe-catalog.ts:47-53`); and note that even the signed artifact does not carry a literal "known limitations" field, so satisfying every §14.2 field by name may still require one small addition. *Costs:* the seam in `apps/api` (`api-runtime.ts:32-46`, `transformer-missions.ts:90`) must change from an array of plain contracts to resolved signed artifacts, including where signing keys and revocation lists come from at runtime; and the plain `MigrationRecipeContract` that the transform/apply engine consumes (`mission-planner.ts:150-156`) must be derived from the signed artifact rather than authored directly, so the two shapes need a defined mapping. This is the option that makes the existing governance machinery load-bearing.

**(b) Add the four §14.2 fields to the plain `MigrationRecipeContract`.** Extend `recipe.ts:160-175` with `requiredEvidence`, `knownLimitations`, `provenance`, and `approvalStatus`, and have the planner honor `approvalStatus`. *Closes:* §14.2 nominally, by field presence. *Leaves open:* §14.3, as above; and it leaves the signature/revocation machinery in `recipe-catalog.ts` unused in production. *Costs:* this looks like the cheap option and is not. It would entrench **two parallel governance models** — a signed, revocable, key-verified catalog (`recipe-catalog.ts`, already the eval/canary path) alongside a plain contract that re-implements approval as an unsigned field the planner is trusted to honor. The parallelism already exists in nascent form (`published-recipes.ts` signed artifacts versus the plain constants in `recipe.ts` wired at `api-runtime.ts:37-44`); option (b) would harden it into two permanent, divergent sources of governance truth, with no cryptographic tie between an "approved" flag and who approved it. That is the specific cost that makes (b) not obviously cheap.

**(c) Leave selection as-is.** Production continues to select over plain contracts with no governance fields. *Closes:* nothing. *Leaves open:* §14.2 (fields absent) and §14.3 (text-based). *Costs:* the governance bypass persists and is now on record; the signed catalog remains eval-only infrastructure that production does not benefit from. The only upside is no change to the `apps/api` seam.

## Security impact

This decision is squarely about a trust boundary. Option (a) makes signature verification and revocation the gate for whether a recipe may run in production, which is a security *improvement*: an unsigned or revoked recipe becomes ineligible for selection rather than silently applicable. It introduces a runtime dependency on trusted signing keys and a current revocation list; where those come from, how keys rotate, and how a revocation reaches the selection path must be specified, because a stale or missing revocation list would let a revoked recipe run. Option (b) is a security *regression relative to (a)*: it represents approval as an unsigned boolean the planner trusts, with no cryptographic binding to the approver, so anything that can construct a `MigrationRecipeContract` can assert `approvalStatus: approved`. Option (c) changes nothing. None of the options affects tenant isolation; recipe catalogs are not tenant-scoped data.

## Data and compatibility impact

Option (a) changes the shape passed into `TransformerMissionService` from `readonly MigrationRecipeContract[]` to signed artifacts, which is a breaking change to that constructor's contract (`transformer-missions.ts:90`) and to the runtime wiring (`api-runtime.ts:32-46`); callers in tests and bootstrap paths that pass plain contracts would need updating, and a mapping from `ProviderRecipeArtifact.boundedEdits.implementationRecipe` to the `MigrationRecipeContract` the apply engine consumes must be defined and versioned. Option (b) is an additive change to `MigrationRecipeContract` (`recipe.ts:160-175`); if the new fields are optional it is backward compatible, but `validateRecipe` (`recipe.ts:3022`) and every recipe constant in `recipe.ts` would need to populate them to be meaningful, and the eval fixtures that build signed artifacts would then diverge further from the plain constants. Option (c) has no impact.

## Migration plan

Because this ADR is Proposed and defers the choice, no migration runs until an option is Accepted. The intended sequencing if (a) is chosen:

1. Record the owner's selection by moving this ADR to Accepted, naming the signed provider catalog canonical.
2. Define the key-provisioning and revocation-list source for the runtime, and the artifact-to-`MigrationRecipeContract` mapping, before touching the seam.
3. Change `api-runtime.ts` to resolve recipes through `createProviderRecipeCatalog` and pass the resolved, verified set into `TransformerMissionService`, keeping the plain-contract shape at the apply-engine boundary via the mapping.
4. Retire the hard-coded plain-contract array once the signed path is proven, so there is a single governance source.

If (b) is chosen, the sequencing is: add optional fields, backfill every recipe constant, and explicitly document that the signed catalog is eval-only — accepting the two-model split on the record. During either migration the current selection behavior is preserved until the new path is enabled.

## Rollback

Option (a) rolls back by reverting the `api-runtime.ts` wiring to the plain-contract array; because the apply engine still consumes `MigrationRecipeContract`, reverting the seam restores current behavior with no data transform. The point past which rollback is no longer clean is when the plain-contract array is retired (step 4): after that, reverting requires reintroducing an ungoverned selection path deliberately. Option (b) rolls back by dropping the added fields, clean as long as nothing persisted a recipe carrying them. Option (c) has nothing to roll back.

## Evaluation plan

Success is measured against `evals/readiness-gates.json` (spec §33.5) and the existing transformer eval and canary harnesses that already exercise the signed catalog (`packages/eval/src/transformer-agent-eval.ts`, `packages/eval/src/transformer-canary.ts`). The signals:

- **Governance is enforced, not decorative (a).** With selection routed through the signed catalog, a test that presents a revoked or unsigned artifact must result in that recipe being ineligible — abstention rather than application — and the eval suite's existing signed-recipe scenarios must still pass, confirming the production path and the eval path now agree.
- **No selection regression.** Recipe-selection precision/recall on the transformer scenarios must not fall below the precision-first bar in `readiness-gates.json` after the seam change; the change is governance, not applicability, so correctness on the applicable/ambiguous/abstain cases must hold.
- **Single source of truth (a).** After step 4, a check that no production caller constructs `TransformerMissionService` from plain `MigrationRecipeContract` values confirms the split is closed rather than doubled.
- **Reconsideration trigger.** If enforcing signature/revocation in production proves operationally infeasible (for example, no reliable runtime revocation source), that is the signal to revisit — but toward a different governed source, not toward (b)'s unsigned approval flag, which this ADR records as the weaker option. Choosing (b) or (c) should itself be revisited as soon as §14.3 work (ADR-0002) lands, since graph-confirmed applicability presumes a governed recipe to attach evidence to.
