# Completion Assurance

Independent, evidence-backed definition of done for Fettler and ReGauge.

This directory is the planning and architecture home for that capability. It is **not** a claim that Completion Assurance is implemented or that Fettler/ReGauge migrations are complete.

## Wave 0 documents (this PR)

- [CURRENT_STATE.md](./CURRENT_STATE.md) — repository archaeology against `origin/main`. Every Completion Assurance spec requirement classified SATISFIED / PARTIAL / MISSING / CONFLICTING / DEFERRED.
- [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) — sequenced build program (Phases 0–5 / A–J), PR slicing, wall, gate binding, collisions, truth boundary.

## Later waves (do not invent here)

The product spec also names ARCHITECTURE, DOMAIN_MODEL, VALIDATOR_WALL, VALIDATION_ENGINE, REGAUGE_STANDARD, FETTLER_STANDARD, INSTRUMENT_BENCHMARK, and OPERATIONS. Those are filled when the matching wave lands. Do not duplicate [docs/missions/CURRENT_STATE.md](../missions/CURRENT_STATE.md), [docs/intelligence/CURRENT_STATE.md](../intelligence/CURRENT_STATE.md), or [docs/graph/CURRENT_STATE.md](../graph/CURRENT_STATE.md).

## No automated check guards these citations, and the pin is always stale

No gate reads `docs/completion-assurance/`. `scripts/evidence-reachability-check.ts` walks `docs/PRODUCT_REQUIREMENTS.json` and `apps/web/app/docs/catalog.ts` only (`:6`, `:80`), not `docs/**/*.md`. Every `path:line` citation in these files is therefore **human-verified only** and decays silently as main moves. Re-verify citations against the pinned commit before acting on any classification here.

**The pin is stale by construction.** The commit named in CURRENT_STATE.md is the one the archaeology was actually verified against, not main's tip — main moves faster than this document can be re-verified, so a document pinned to a moving branch is already stale when it merges. That is inherent and is not a defect to be chased.

**Refreshing the pin is not a safe no-op.** When the pin last moved (`d232a27` → `da3ba22`), two cited files had changed, and the three line-range citations into `packages/db/src/index.ts` survived only because every insertion in that diff landed after all three ranges. Before refreshing the pin, diff the old and new commits for each cited file and re-check any citation whose file moved. Do not assume stability.

## Parent authority

- Product spec: uploaded `Mendpoint Completion Assurance Product Spec for Cursor` v1.0 — **not vendored into this repository**, so CURRENT_STATE.md Part C and the `§` citations in IMPLEMENTATION_PLAN.md cannot be checked against it here
- Platform: [docs/product/mendpoint-product-platform-specification-v4.md](../product/mendpoint-product-platform-specification-v4.md) §8.6 Mission
- Soft verifier: [docs/adr/0007-evidence-constrained-model-verification.md](../adr/0007-evidence-constrained-model-verification.md)
