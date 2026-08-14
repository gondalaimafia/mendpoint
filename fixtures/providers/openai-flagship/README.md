# OpenAI flagship fixture

Synthetic flagship fixture for offline Fettler demos (not vendor-official).

## Breaking change (v1 → v2)

- **Rename:** `max_tokens` → `max_completion_tokens` on `POST /v1/chat/completions`.

## Files

- `openapi-v1.json` — baseline
- `openapi-v2.json` — breaking rename for demo poll/diff
