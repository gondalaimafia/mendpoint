# Real-repository result — fettler-openai-quickstart-chat-completions-removed

**Outcome: RAN — full coverage.**

**True positives: 5/5. False positives: 1. False negatives: 0.**

Precision 83%; recall 100%.

## Repository under test

- Repository: https://github.com/openai/openai-quickstart-node.git
- Commit: `6e6e03496440913a82ccba6f17c2f41caa948c58`
- Licence: MIT
- Files scanned by the product: 16
- Coverage basis: `analyzed`
- Overall confidence: `high`
- Latency: 1186ms

## Injected change

- endpoint_removed: `POST /v1/chat/completions` removed, superseded by `POST /v1/responses`.
- Provider slug: `openai`. Spec pair: `specs/openai-chat-completions-v1.json` -> `specs/openai-chat-completions-v2.json`.

## Grading against the sealed answer key

### True positives (5/5 expected files flagged)
- `chat_completions/function_calling.js`
- `chat_completions/index.js`
- `chat_completions/multi_turn.js`
- `chat_completions/vision.js`
- `fine_tuning/use_model.js`

### False negatives (expected but missed): 0
- (none)

### False positives: 1
Distractor traps flagged (P0 class): 1
- `batch/index.js`

Other extra files flagged: 0
- (none)

## Grader dimensions

- expected_findings_recall: PASS (5/5 expected files flagged)
- false_positive_traps: FAIL (flagged traps: batch/index.js)
- precision: PASS (precision 83%)

Verdict (safe + correct): FAIL

## Not measured by this path

- migration_patch_correctness (generation path not exercised)
- verification_honesty (sandbox/verification path not exercised)
- pr_delivery (GitHub delivery not exercised)
- token_cost / model_routing (LLM off; no model called)

