# Mutations (Phase 2 / 12)

The mutation engine (`engine.ts`) applies controlled, reversible, **seeded**
defects to an otherwise healthy in-memory repository and emits the exact ground
truth needed to score the result. Nothing here touches disk or the shared
corpus: a mutation takes a `SyntheticRepo` value and returns a new one plus its
answer key, so a family can expand without hand-authoring a repo per case.

## Mutation classes implemented

- **API** (drive Fettler via an OpenAPI v1/v2 diff):
  - `renameApiRequestField` — request-field rename, with a selectable `$ref`
    indirection style (`flat`, `ref`, `nested2`, `allOf`, `refToRef`). Emits
    `flag_files` ground truth from the caller-declared impacted/decoy roles.
  - `counterfactualNoRename` — the Phase-14 counterfactual: v2 == v1, so a
    correct engine flags nothing (`no_op`); every field-bearing file is a trap.
  - `ambiguousApiRename` — replaces the field with ≥2 plausible successors, which
    Change Intelligence must classify `request_field_ambiguous` (no surface).
    Correct behavior is `abstain`; any confident finding is a P0 failure.
- **Dependency** (drive ReGauge via the recipe engine):
  - `bumpNodeRuntime` — pins the Node runtime major across `package.json` /
    `.nvmrc` / `.node-version` / `Dockerfile`. The files it writes ARE the sites
    the migration must change, so the answer key is exactly what it changed.
    Maps to `apply_recipe` (covered bump) or `coverage_gap` (no shipped recipe).

## Contract (upheld by `engine.test.ts`)

- **Deterministic + seeded**: same `(base, seed, opts)` → byte-identical output.
  `mulberry32` is the shared seeded RNG.
- **Reversible**: `inverse()` reproduces the pre-mutation repo exactly, so a
  mutation can never corrupt the source. (The counterfactual is a separate,
  explicit generator, not the inverse.)
- **Self-describing answer key**: `changeLog` records exactly what changed, and
  `groundTruth` states the impacted set and the false-positive traps. A mutation
  that cannot state its own answer key deterministically is not allowed.

## Hard rules

- Never mutate a corpus repo in place — the engine only ever operates on an
  in-memory `SyntheticRepo`; the driver materializes to scratch.
- The generated ground truth is validated (`validateGroundTruth`) before a run.
