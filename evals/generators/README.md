# Generators (Phase 8 / 13 / 14)

Procedural generators expand one discovered defect class into a **family** of
sibling scenarios by mutating a seeded healthy repo (never by hand-copying), and
emit the answer key automatically from what the mutation changed. This is how the
`validation` and `holdout` splits grow without hand-authoring, and how we answer:

> Did we improve the product, or just the benchmark?

## Layout

- `templates.ts` — seeded synthetic-repo templates. `tsPaymentsService(seed)`
  builds a healthy TypeScript service whose import topology and distractor
  placement are seed-driven, and declares every file's ROLE (impacted / decoy /
  generated / vendored / looks-generated). The topology mirrors the pattern the
  real Fettler path resolves (verified empirically): a provider-client anchor,
  impacted files reachable through relative imports, and decoys that never reach
  the anchor (so the provenance gate demotes them).
- `families.ts` — the families and their counterfactuals.
- `index.ts` — `generateScenarios()` (validates every auto-emitted key) and
  `materializeRepo()` (writes an in-memory repo + spec pair to scratch).

## Families (all grounded in defects the suite found)

| family | variants | correct behavior |
| --- | --- | --- |
| `$ref` blindness | flat, ref, nested-two-deep, allOf, ref-to-ref | `flag_files` |
| ambiguity | two successors, three successors, two-with-decoy | `abstain` |
| generated / vendored | generated-only, vendored-only, both, looks-generated | `flag_files` (traps excluded) |
| dependency runtime | 18→20, 20→22, unsupported 21→23, already-migrated | `apply_recipe` / `coverage_gap` / `no_op` |
| counterfactual (Phase 14) | no-change rename, already-migrated runtime | `no_op` |

Every significant Fettler family also ships a **counterfactual**: a
near-identical repo where the issue is absent, so a finding there is a scored
false positive.

## Splits (Phase 8)

Every generated scenario carries a `dataset_split` (`development` / `validation`
/ `holdout`). `holdoutRefVariations(n)` procedurally emits `n` UNSEEN ref-rename
scenarios from fresh, deterministic seeds — the honest measure of whether a
change improved the product rather than the benchmark. The report presents the
three splits separately and calls out the holdout number.

The 21 hand-authored corpus scenarios remain `development`.
