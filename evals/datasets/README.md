# Datasets (Phase 10)

Every run contributes to a clean, versioned model-learning dataset (for eval,
SFT, preference optimization, routing, and retrieval work). We do NOT fine-tune
just because data exists — this builds the corpus.

## Build it

```
tsx evals/datasets/build.ts            # project evals/reports/latest-runs.json
tsx evals/datasets/build.ts --in path  # project a specific runs file
```

`build.ts` projects each per-run record into the `DatasetRecord` shape
(`schema.ts`) and appends a NEW timestamped JSONL file under
`records/<version>/`. The dataset is **append-only**: a build never rewrites a
prior file, so the corpus is an auditable log. The schema and builder are
version-controlled; the emitted JSONL logs are regenerable and git-ignored.

## Record shape (per the spec)

`example_id`, `scenario_id`, `task_type`, `input_reference`, `model_version`,
`tool_trace`, `ground_truth`, `grader_scores`, `failure_type`, `outcome`,
`dataset_split`, `provenance` — plus `model_output` and, for negative examples,
`corrected_output` + `preference_explanation` (forming a same-input bad/better
preference pair).

## Training-signal categories

- **positive** — correct action, and **correct ABSTENTION** (a first-class
  positive here: several of the product's most valuable behaviors are refusals,
  not actions — ambiguous renames, already-migrated repos).
- **negative** — missed / invented / unsafe; carries a preference pair.
- **coverage_gap** — correct abstention-by-absence; kept separate from a defect.

## Hard rules

- **Never** include private chain-of-thought or hidden model reasoning. Only
  observable inputs, outputs, tool interactions, grader scores, and outcomes.
  `validateDatasetRecord` rejects any `reasoning` / `chain_of_thought` /
  `thoughts` / `scratchpad` field.
- `input_reference` is a REFERENCE (scenario id + provenance), not the raw repo.
- `model_version` is `null` on the deterministic path (no model was called) —
  never fabricated.
- Version and split every dataset; keep `holdout` examples out of any fixing loop.
