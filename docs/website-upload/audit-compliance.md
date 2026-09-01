# Audit and compliance evidence

Retain tenant scoped, attributable, append only operational evidence and export only the governed fields a reviewer is authorized to inspect.

Status: Engineering evidence active
Availability: Audit capture and governed export are implemented; independent compliance assessment remains external
Last verified: 2026-08-30
Publication evidence: not live; no deployed revision or live evidence digest recorded
Requirements: ME-WAR-008, ME-ENT-004, ME-ENT-012
Public claims: None

## Start here

Run one authenticated mutation and use its request identity to inspect the resulting audit record.

1. Perform an authorized mutation with X Request Id.
2. Read the tenant audit trail.
3. Export the governed evidence set for the declared review purpose.
4. Verify redaction, chain integrity, retention, and any legal hold before distribution.

## What it does

- Unified audit records across API and worker effects
- Principal, credential, tenant, request, and subject attribution
- Append only and tamper evident evidence contracts
- Governed redacted export
- Retention and legal hold policy contracts

## When to use it

- A reviewer must reconstruct who authorized a sensitive transition.
- An operator must export evidence without exposing secrets or unrelated tenant data.

## How it works

1. Sensitive actions append an audit record after authority is resolved.
2. Records bind actor, tenant, request, subject, action, outcome, and evidence references.
3. Export applies tenant scope, field policy, retention, and redaction.
4. Independent legal and assessor artifacts remain separate external evidence.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| GET /audit | API | Read tenant scoped audit records. |
| GET /audit/export | API | Export the governed tenant evidence set. |
| Audit chain | Artifact | Append only attributable transition records. |
| Compliance evidence package | Artifact | Engineering controls plus separately supplied legal and assessor evidence. |

## Evidence and verification

- Audit governance contract: `packages/contract/src/audit-governance.test.ts`
- Unified route audit: `apps/api/src/audit-unification.test.ts`
- Governed export: `apps/api/src/audit-export.test.ts`
- Database export: `packages/db/src/audit-export.test.ts`

## Contract sources

- `packages/contract/src/audit-governance.ts`
- `apps/api/src/audit-export.ts`
- `packages/db/src/change-impact-audit.ts`

## Safety model

- Audit reads and exports are tenant scoped.
- Secrets, raw credentials, hidden reasoning, and unauthorized content are excluded.
- Missing or unverifiable audit evidence is not converted to a successful claim.
- Code evidence cannot replace legal approval or independent assessment.

## Limitations

- DPA, subprocessor, penetration test, and independent assessment evidence are externally owned.
- Retention and legal hold qualification depend on the deployed storage and approved policy.

## See also

- [Security and governance](./security-governance.md)
- [Authentication and tenancy](./authentication-tenancy.md)
- [Recovery and reliability](./recovery-reliability.md)
