# Twilio flagship fixture

Synthetic flagship fixture for offline Fettler demos (not vendor-official).

## Breaking change (v1 → v2)

- **Rename:** form field `Body` → `Content` on `POST .../Messages.json` (and response `body` → `content`).

## Files

- `openapi-v1.json` — baseline
- `openapi-v2.json` — breaking rename for demo poll/diff
