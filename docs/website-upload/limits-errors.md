# Limits, errors, and retries

Treat every bounded input, overload response, partial result, and unavailable dependency as explicit operational state.

Status: Profile specific limits
Availability: Runtime bounds and error contracts vary by route, workload tier, and deployment profile
Last verified: 2026-08-30
Publication evidence: not live; no deployed revision or live evidence digest recorded
Requirements: ME-FND-006, ME-FND-007, ME-ENT-005, ME-ENT-009
Public claims: None

## Start here

Read the exact route contract and declare a workload budget before sending production work.

1. Confirm input byte, file, path, token, time, cost, and concurrency bounds for the route.
2. Supply request and idempotency identity where supported.
3. Handle validation, authorization, conflict, overload, dependency, and internal failures separately.
4. Abort at the declared threshold and preserve evidence for a bounded retry or rollback.

## What it does

- Bounded request and response bodies
- Concurrency admission and Retry After guidance
- Structured error codes and request identity
- Budget, timeout, and saturation controls
- Explicit partial, indeterminate, and unavailable states

## When to use it

- A caller needs a safe retry policy.
- An operator needs to size or abort a production workload.

## How it works

1. Each route validates its own inputs and authority before work.
2. Admission control can reject excess concurrency with an explicit retry delay.
3. Domain errors preserve a stable code; unexpected errors are redacted and retain request identity.
4. Partial or indeterminate evidence remains distinct from success and from proven absence.
5. Workload tests report declared percentiles and abort conditions for the tested profile only.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| Error response | Artifact | HTTP status, stable code, and request identity where available. |
| Retry-After | Configuration | Explicit overload delay in seconds. |
| Performance contract | Artifact | Workload tier, concurrency, latency, cost, saturation, abort, and recovery boundaries. |
| Idempotency-Key | Configuration | Exact replay authority only on routes that declare it. |

## Evidence and verification

- Production boundary: `apps/api/src/production.test.ts`
- Error redaction: `apps/api/src/error-boundary.test.ts`
- Performance contract: `docs/PERFORMANCE_CONTRACT.md`

## Contract sources

- `apps/api/src/production.ts`
- `apps/api/src/error-boundary.ts`
- `docs/PERFORMANCE_CONTRACT.md`

## Safety model

- Never retry indefinitely.
- Never convert unavailable evidence into an empty successful result.
- Do not retry the same idempotency key with different request bytes.
- A synthetic or pilot workload is not production performance proof.

## Limitations

- A universal API wide pagination and rate limit contract is not yet implemented.
- Production safe load and soak results require an approved target and workload envelope.

## See also

- [API conventions](./api-conventions.md)
- [Deployment and operations](./deployment-operations.md)
- [Recovery and reliability](./recovery-reliability.md)
