# Authentication and tenancy

Authenticate one durable principal, derive its tenant from protected authority, and authorize the exact requested capability.

Status: Profile specific controls
Availability: Scoped API key authentication is active; enterprise identity integrations require separately configured authority
Last verified: 2026-08-30
Requirements: ME-ENT-001, ME-ENT-002, ME-ENT-003
Public claims: None

## Start here

Create a tenant scoped credential through an authenticated administrator and keep its secret outside source control.

1. Select the tenant and least privileged role.
2. Create the credential and capture its value once through the protected operator path.
3. Send it as a Bearer token over HTTPS.
4. Rotate or revoke it and verify that later requests fail closed.

```sh
curl -H "Authorization: Bearer $MENDPOINT_API_KEY" https://your-mendpoint.example/ready
```

## What it does

- Tenant scoped API key authentication
- Durable principals, memberships, roles, expiry, and revocation
- Request identity and audit attribution
- Service principal and enterprise identity contracts

## When to use it

- A human or service needs access to a protected Mendpoint API.
- An operator must rotate or revoke access without changing tenant data.

## How it works

1. The authentication middleware resolves the credential to one durable principal and tenant.
2. Membership and role checks authorize the exact route capability.
3. Mutation code revalidates authority at the effect boundary.
4. Audit records retain principal, credential, tenant, and request identity without storing the secret.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| GET /keys | API | List credential metadata without secret material. |
| POST /keys | API | Create a scoped credential through tenant administration authority. |
| POST /keys/:id/revoke | API | Revoke one credential. |
| GET /tenants | API | List tenants visible to the authenticated principal. |
| POST /tenants/memberships | API | Create a tenant membership when authorized. |

## Evidence and verification

- Authentication middleware: `apps/api/src/auth.test.ts`
- Membership lifecycle: `apps/api/src/tenant-memberships.test.ts`
- Cross tenant denial: `apps/api/src/cross-tenant-denial.test.ts`

## Contract sources

- `apps/api/src/auth.ts`
- `apps/api/src/tenant-memberships.ts`
- `packages/contract/src/tenant-boundary.ts`

## Safety model

- Tenant identity never comes from a request body claim.
- Credential values are returned only at creation and are never listed.
- Expiry and revocation are rechecked before protected effects.
- Production credentials require HTTPS and must not follow redirects.

## Limitations

- SAML and SCIM need an approved enterprise identity tenant for live qualification.
- Authentication availability depends on the selected deployment profile.

## See also

- [API conventions](./api-conventions.md)
- [Security and governance](./security-governance.md)
- [Audit and compliance evidence](./audit-compliance.md)
