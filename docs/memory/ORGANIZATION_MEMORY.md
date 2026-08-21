# Organization Memory

Organization Memory is a durable, tenant-scoped store for organizational
conventions and preferences. It answers "how does *this* organization like to
work" — "we prefer the internal auth client over direct OAuth calls",
"squash-merge only", "keep migration batches small", "no em dashes in
user-facing copy".

This document describes what the code on this branch actually does. It does not
describe intended future wiring.

## Scope boundary

Organization Memory holds **preferences and conventions**. It does **not** hold
objective, verifiable code facts — those belong in the Change Graph
(`packages/graph-learn`). The graph holds *what the code is*; memory holds *what
the organization prefers*. Mixing the two is an explicit failure condition, so
the store has no field for a code fact and no reader that treats a memory as a
fact about code.

This branch deliberately does **not** wire Organization Memory into the model
prompt, the lesson classifier, or a context compiler. Those are separate steps.
The store, its governance, its precedence resolver, and its inspection API are
reviewable on their own.

## The model

Each memory is a chain of immutable records (see `MEMORY_LIFECYCLE.md`). A record
carries:

| Field | Meaning |
|---|---|
| `recordId` | `omv1:` + sha256 of the canonical body (primary key). |
| `tenantId` | Owning tenant. Part of the hashed body, so part of the key. |
| `memoryId` | Stable logical id grouping a supersession chain. |
| `revision` | Position in the chain (1-based). |
| `supersedesRecordId` | The record this one supersedes, or null for the first. |
| `transition` | What produced this record (`observed`, `human_confirmed`, `activated`, `edited`, `disabled`, ...). |
| `scope` | Where the memory applies (for example `tenant`, or a repository scope). |
| `category` | One of the nine categories below. |
| `statement` | The convention, in prose. |
| `structuredValue` | Optional machine-readable value (JSON) or null. |
| `source` | How the memory is known (see source hierarchy). |
| `sourceRefs` | Evidence pointers backing the record. |
| `confidence` | `low` \| `medium` \| `high`. |
| `status` | Lifecycle status (see `MEMORY_LIFECYCLE.md`). |
| `appliesTo` | Applicability targets. |
| `trainingEligible` | Always defaults to `false` on this branch. See below. |
| `actorPrincipalId` | The human principal for a human transition, or null. |
| `lastConfirmedAt` | When the memory was last confirmed or activated. |

### Categories

`ARCHITECTURE_CONVENTION`, `CODING_CONVENTION`, `MIGRATION_PREFERENCE`,
`TESTING_REQUIREMENT`, `REVIEW_PREFERENCE`, `DEPLOYMENT_POLICY`,
`RISK_PREFERENCE`, `INTERNAL_ABSTRACTION`, `PRESENTATION_PREFERENCE`.

### Source hierarchy

Highest confidence first:

1. **`explicit`** — the organization stated it directly (created through the API
   by a human principal).
2. **`policy_config`** — existing configuration implies it.
3. **`repeated_verified_behavior`** — multiple migrations demonstrated it.
4. **`reviewer_correction`** — a reviewer repeatedly made the same change.

Only `explicit` may be created directly as an active memory. The other three are
inferred sources and must go through observation and promotion.

## Why this is a new store, not an extension

- `packages/platform/src/memory.ts` is a per-request, in-process object with no
  persistence and no tenant field. It is a prompt scratchpad, not a store.
- `learning_records` structurally requires five evidence foreign keys (redaction,
  verification, contamination, an accepted review, artifacts). A preference such
  as "prefer the internal auth client" has none of those, so it is
  unrepresentable there. Organization Memory admits on **provenance and
  precedence**, not on an evidence digest.
- The `policies` table is keyed on `consumer_id`, has no API writer, and is
  seed-time only.

## Tenant binding — Tier 1, structural

Organization Memory uses the same structural binding as the Change Graph
(`packages/graph-learn/src/software-intelligence.ts`). The `recordId` is `omv1:`
plus the sha256 of the record's canonical body, and `tenantId` is the first
field of that body. Two tenants that state the identical convention produce
different `recordId`s and different `memoryId`s by construction; a cross-tenant
collision is arithmetically impossible, not merely filtered.

Every read re-hashes the reconstructed body and asserts it matches the stored
`recordId` and `contentSha256`, and that the body's tenant is the one asked for
(`organization_memory_integrity_failed` / `organization_memory_tenant_mismatch`
otherwise). This mirrors how the Change Graph re-hashes and re-asserts tenant on
read.

`assertTenantScope` in `packages/db/src/tenant-scope.ts` permits an `undefined`
tenant as an allowlisted global read, so it is not used as the only guard here.
The store filters every query by `tenant_id`, and the precedence resolver
(`packages/pipeline`) refuses any layer whose tenant differs from the decision
tenant.

## Schema safety

The `organization_memory` table lives entirely in the static `CREATE TABLE IF
NOT EXISTS` block in `packages/db/src/index.ts`. Because that DDL runs on every
`createDb`, an existing database volume that predates the feature gains the table
on next boot with no `ALTER`. `ensureTables` never alters an existing table, and
this table depends on no additive column migration, so its shape converges
safely. `organization-memory.test.ts` proves this by booting a volume, dropping
the table to simulate a pre-change volume, and reopening to confirm the table is
recreated and functional.

History is append-only. Two triggers
(`organization_memory_append_only_update` / `_delete`) reject any `UPDATE` or
`DELETE`. Every edit, disable, and lifecycle transition is a new row on the
chain, so history is never destroyed. This follows the `learning_consents`
supersession pattern: state is the chain head, re-queried on every check, so a
disable takes effect with no redeploy and no cache.

## Inspection API

Mounted at `/organization-memory` (`apps/api/src/organization-memory-routes.ts`).
Tenant is always derived from the authenticated principal, never from the body.
Mutations that assert a human decision require a human trust principal.

| Method + path | Purpose |
|---|---|
| `GET /` | List current memory heads (optional `?status=`). |
| `POST /` | Create an explicit memory (human). |
| `POST /observations` | Record one observation of a convention (inferred). |
| `POST /:memoryId/confirm` | Human confirmation of a candidate. |
| `POST /:memoryId/activate` | Activate a validated or confirmed memory. |
| `POST /:memoryId/reject` | Reject a candidate. |
| `POST /:memoryId/edit` | Edit content (new revision, history preserved). |
| `POST /:memoryId/disable` | Disable a memory (stops influencing at once). |
| `POST /:memoryId/delete` | Soft-delete (history preserved). |
| `GET /:memoryId/provenance` | Full immutable history. |
| `GET /:memoryId/scope` | Where the memory applies. |

Every active memory is listable with its source and provenance, and every one is
disableable. There is no path that creates invisible, irreversible
personalization.

## Operational status of the observation path

`POST /observations` and the independent-corroboration branch of promotion are
**not operational on this branch** — they are built and fail closed, not live.

Admitting an observation requires every `sourceRefs` entry to resolve to an
`evidence_records` row with `subject_type = "organization_memory_observation"`,
`subject_id` equal to the memory id, `producer_principal_id` equal to the
observing principal, and `verdict = "passed"` (enforced in
`observationAuthority`, `packages/db/src/organization-memory.ts`). This is a
deliberate fail-closed authority control: an observation only counts if an
independent, verified producer vouched for it.

No production code produces such a record. `insertEvidenceRecord`
(`packages/db/src/trust.ts`) is the only writer of `evidence_records`, and no
caller anywhere in `apps/` or `packages/` passes
`subjectType: "organization_memory_observation"` — only test helpers mint it.
Until a dedicated observation-evidence producer is built (the surface that turns
an inferred convention into a verified, attributable observation), `POST
/observations` always rejects with `organization_memory_evidence_invalid`, so no
memory can reach ACTIVE through independent corroboration. Explicit human-created
memory (`POST /`) and human confirmation (`POST /:memoryId/confirm` then
`/activate`) are the only operational promotion paths today.

Do not relax the evidence requirement to make the path reachable — that would
re-open the authority gap the control closes. The path becomes operational only
when the producer exists.

## `trainingEligible`

`trainingEligible` is a field on the model. It defaults to `false` and there is
**no training path** on this branch — nothing reads the field to train anything.
The contributor tier is an owner-approved decision handled elsewhere and is not
touched here.

## Related documents

- `MEMORY_LIFECYCLE.md` — states, transitions, and the promotion threshold.
- `MEMORY_PRECEDENCE.md` — how a decision chooses between memory and higher
  authorities, and how a consumer learns which memory won.
- `docs/adr/0008-organization-memory-governed-store.md` — the architectural
  decision record.
