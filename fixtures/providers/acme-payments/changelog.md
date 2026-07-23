# Acme Payments API v2.0.0

## Breaking

- **Rename:** `amount_cents` → `amount` on charge create/retrieve payloads.
  Amount remains minor units (e.g. cents for USD).
- **Removed:** `GET /v1/charges/{id}/receipt`. Use invoice export or dashboard receipts instead.

## New

- **Added:** `GET /v1/balance` for available balance.
