## mendpoint: migrate Stripe — breaking

**Risk:** `breaking`  
**Confidence:** `high`

### Summary
Offset-based pagination deprecated for `GET /v1/customers` / `stripe.customers.list`. Prefer auto-paging / cursor helpers.

### Impacted sites
- `src/syncCustomers.ts` — `stripe.customers.list` + `starting_after` loop in `fetchAllCustomers`
- `src/syncCustomers.test.ts` — mocks old pagination shape

### Suggested direction
Replace manual `starting_after` loops with `autoPagingToArray` (or cursor iterator). Link: https://stripe.com/docs/api/pagination
