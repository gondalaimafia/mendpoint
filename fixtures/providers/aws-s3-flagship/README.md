# AWS S3 flagship fixture

Synthetic flagship fixture for offline Fettler demos (not vendor-official).

## Breaking change (v1 → v2)

- **Rename:** response header `x-amz-meta-filename` → `x-amz-meta-object-name` on `GetObject`.

## Files

- `openapi-v1.json` — baseline
- `openapi-v2.json` — breaking rename for demo poll/diff
