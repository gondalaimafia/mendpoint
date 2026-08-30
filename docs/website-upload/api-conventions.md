# API conventions

Use consistent authentication, request identity, idempotency, error, and retry rules when integrating with Mendpoint APIs.

Status: Route specific production contract
Availability: Documented behavior applies only where the referenced route implements the named convention
Last verified: 2026-08-30
Requirements: ME-FND-007, ME-ENT-001, ME-ENT-002, ME-WAR-008
Public claims: None

## Start here

Begin with a read request, then add one replay safe mutation using an exact idempotency key.

1. Use HTTPS and a tenant scoped Bearer credential.
2. Send Content Type application/json for JSON mutations.
3. Supply X Request Id for traceability and Idempotency Key where the route requires it.
4. Treat status, error code, and request ID as the failure contract.

```sh
curl -H "Authorization: Bearer $MENDPOINT_API_KEY" -H "X-Request-Id: example-request-1" https://your-mendpoint.example/ready
```

## What it does

- Bearer authentication
- Caller supplied or generated request identity
- Route specific idempotent mutations
- Structured error codes
- Explicit overload retry guidance

## When to use it

- A service calls Mendpoint directly.
- A caller must recover safely after response loss or worker takeover.

## How it works

1. Authentication and tenant resolution run before protected routes.
2. The request ID follows the operation into audit and failure responses.
3. Mutation routes that require Idempotency Key bind it to the exact request fingerprint.
4. Same key and same bytes can replay; same key and different bytes conflict.
5. Retry only read operations, explicit overload responses, or exact replay safe mutations.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| Authorization: Bearer <token> | Configuration | Tenant scoped API credential. |
| X-Request-Id | Configuration | Optional caller request identity returned or retained for diagnosis. |
| Idempotency-Key | Configuration | Required only on routes that declare replay safety. |
| Error response | Artifact | HTTP status plus a stable error code and request identity where the route provides it. |
| Retry-After | Configuration | Delay supplied by an overload response when present. |

## Evidence and verification

- Authentication contract: `apps/api/src/auth.test.ts`
- Request identity and overload: `apps/api/src/production.test.ts`
- Error boundary: `apps/api/src/error-boundary.test.ts`
- Idempotent application routes: `apps/api/src/advanced-ai-applications.test.ts`

## Contract sources

- `apps/api/src/auth.ts`
- `apps/api/src/production.ts`
- `apps/api/src/error-boundary.ts`

## Safety model

- Never send a production credential over plain HTTP or through a redirect.
- Do not assume every mutation is idempotent; require an explicit route contract.
- Do not retry authorization, validation, or idempotency conflict responses without changing authority or input.
- List pagination is endpoint specific; absence of a cursor contract is not proof that an unbounded list is complete.

## Limitations

- The API does not yet publish one complete OpenAPI document for every route.
- Pagination and rate limits are not uniform across all route groups.

## See also

- [Authentication and tenancy](./authentication-tenancy.md)
- [Webhooks and domain events](./webhooks-events.md)
- [Limits, errors, and retries](./limits-errors.md)
