# Plaid flagship fixture

Synthetic flagship fixture for offline Gauge demos (not vendor-official).

## Breaking change (v1 → v2)

- **Rename:** request field `account_id` → `account_ids` (string → string[]) on `POST /accounts/balance/get`.

## Files

- `openapi-v1.json` — baseline
- `openapi-v2.json` — breaking rename for demo poll/diff
