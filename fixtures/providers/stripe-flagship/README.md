# Stripe flagship fixture

Synthetic flagship fixture for offline Fettler demos (not vendor-official).

## Breaking change (v1 → v2)

- **Rename:** `amount_cents` → `amount` on `POST /v1/charges` request and response.

## Files

- `openapi-v1.json` — baseline
- `openapi-v2.json` — breaking rename for demo poll/diff
