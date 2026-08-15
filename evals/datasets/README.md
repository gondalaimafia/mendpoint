# Datasets (Phase 10 — scaffold)

A later task fills this in. Every run should contribute to a clean, versioned
model-learning dataset (for eval, SFT, preference optimization, routing, and
retrieval work) — but we do NOT fine-tune just because data exists.

The raw per-run records the driver already emits
(`evals/reports/latest-runs.json`) are the seed. The dataset builder will project
those into the record shape from the spec:

```json
{
  "example_id": "", "scenario_id": "", "task_type": "",
  "input_reference": "", "system_context_version": "", "model_version": "",
  "tool_trace": [], "model_output": {}, "ground_truth": {}, "grader_scores": {},
  "failure_type": "", "corrected_output": {}, "successful_remediation": {},
  "outcome": "", "dataset_split": "", "provenance": {}
}
```

## Hard rules

- **Never** include private chain-of-thought or hidden model reasoning. Only
  observable inputs, outputs, tool interactions, and outcomes.
- Version and split every dataset; keep `holdout` examples out of any training or
  fixing loop.
- Positive, negative, and preference-pair examples are all valuable (see the
  spec's "Capture Training Signals").
