## mendpoint: migrate payments-api — breaking

- `apiClient` factory: `Authorization: Bearer` instead of `X-API-Key`
- Every `POST /v2/transfers` body includes `idempotency_key: crypto.randomUUID()`
- Comment explaining why the key is required
