# Generators (Phase 8 — scaffold)

A later task fills this in. Procedural generators will produce new random
variations from scenario families so we can populate the `validation` and
`holdout` dataset splits and answer the key question:

> Did we improve the product, or just the benchmark?

Planned:

- Family generators that emit a fresh repo + `GroundTruth` for a parameterized
  fault (e.g. "provider field rename" across a random import topology, random
  distractor placement, random language).
- Split assignment: every generated scenario is tagged `development`,
  `validation`, or `holdout` (`dataset_split` in the ground-truth schema).
  Development failures may be inspected while fixing; holdout is the honest
  quality measure and is never inspected during a fix.
- Sibling-scenario expansion (Phase 13): one discovered failure becomes a family
  (enum removed / renamed / semantics changed / optional→required / default
  changed / nested / stale SDK type), converting one bug into coverage for a
  capability class.

Until this lands, all 21 hand-authored scenarios are marked `development` in
their ground truth.
