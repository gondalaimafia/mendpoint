/**
 * Phase 9 — Lesson Classification.
 *
 * Route every validated failure to the LIGHTEST intervention that fixes it, and
 * make it structurally impossible to train a model around a deterministic bug.
 *
 * - `destinations.ts` — the eleven destinations, the intervention each routes to,
 *   the training prerequisites, and the type-level + runtime guards.
 * - `classify.ts` — the total map from the canonical eval failure taxonomy to a
 *   destination, and the classifier itself.
 * - `real-failures.ts` — the failures that exist in the repo today, as inputs.
 */
export * from "./destinations.js";
export * from "./classify.js";
export * from "./real-failures.js";
