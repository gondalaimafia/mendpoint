# Security and governance

Bind every sensitive operation to tenant identity, least-privilege authority, immutable evidence, human approvals, and revocable policy.

Status: Profile-specific pilot controls
Availability: Private preview deployments with profile-specific authentication, encryption, and governance controls
Last verified: 2026-08-14
Requirements: ME-ENT-001, ME-ENT-002, ME-ENT-003, ME-ENT-004, ME-WAR-008
Public claims: CLM-014

## Start here

Run the deployment preflight, bootstrap one owner authority, and configure the narrowest repository, model, and delivery permissions required.

1. Select the exact deployment profile.
2. Configure encryption, authentication, tenant, repository, and egress authority.
3. Bootstrap and rotate scoped API keys or SSO bindings.
4. Verify readiness, audit, backup, revocation, and incident procedures before customer access.

## What it does

- Tenant-scoped API keys, RBAC, memberships, and trust principals
- GitHub account, installation, and repository binding
- Per-record encryption, checkpoint encryption, domain-separated keys, and cryptographic erasure
- Human review, waiver, escalation, production delivery, and policy gates
- Append-only audit and domain events with governed export
- SAML and OIDC integration surfaces

## When to use it

- A deployment handles private repositories or model egress.
- An operator needs attributable approvals and revocation.
- A tenant requires bounded data retention and audit export.

## How it works

1. Authentication resolves a durable principal and tenant before route authority.
2. RBAC and domain-specific gates authorize the exact action and scope.
3. Sensitive data is encrypted at rest and excluded from logs and public evidence.
4. Every transition records immutable evidence and rechecks stale or revoked authority at effect boundaries.
5. Readiness fails closed when profile-required controls are absent.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| GET /keys | API | List scoped API keys without returning secret values. |
| POST /keys | API | Create a scoped key. |
| POST /keys/:id/revoke | API | Revoke a key. |
| GET /audit | API | Read tenant audit events. |
| GET /audit/export | API | Export governed audit evidence. |
| Deployment profile | Configuration | Fail-closed environment contract for each runtime role. |

## Evidence and verification

- Authentication and RBAC: `apps/api/src/auth.test.ts`
- Tenant isolation: `packages/db/src/provider-tenant-isolation.test.ts`
- Customer profile: `scripts/customer-warden-profile.test.ts`
- Design partner encryption: `apps/api/src/design-partner-applications-store.test.ts`

## Contract sources

- `apps/api/src/auth.ts`
- `packages/contract/src/tenant-boundary.ts`
- `packages/contract/src/audit-governance.ts`

## Safety model

- Tenant identity comes from authenticated authority, never request body claims.
- Secrets are not returned by list APIs or serialized into evidence.
- Human approval never grants merge or deployment capability.
- Profile-required missing authority stops startup rather than falling back.

## Limitations

- Security posture depends on correct deployment secrets, network policy, and operator procedures.
- High availability differs by profile; the current dedicated Regauge coordinator is single-authority.
- External providers and SCM integrations create egress only when explicitly configured.

## See also

- [Repository connections](./repository-connections.md)
- [Verification and attestations](./verification-attestations.md)
- [Deployment and operations](./deployment-operations.md)
