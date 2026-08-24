# ADR 2026-08-24: Tenant-scoped harness state

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** OpenAI Codex
- **Supersedes:** none
- **Superseded by:** none

## Context

The filesystem harness persisted plans, traces, scores, dogfood ledgers, and reports in one shared `runs/<run-id>` collection. Two tenants could select the same run identifier and overwrite or read each other's state. The platform API also exposed that shared collection to authenticated customer principals. GitHub issue [#349](https://github.com/gondalaimafia/mendpoint/issues/349) requires removal of these cross-tenant paths.

The canonical v4 specification requires tenant boundaries across traces and datasets in §19.1 and requires representation and harness evaluations to compare like-for-like inputs in §11.21. Harness persistence therefore needs deterministic tenant ownership without treating a model-visible or caller-supplied tenant identifier as a trusted filesystem path.

## Decision

We will persist tenant-scoped harness state below `<base>/tenant-runs/<tenant-namespace>/runs`, where `tenant-namespace` is SHA-256 over the UTF-8 byte-length-prefixed tenant identifier. A supplied blank tenant scope fails closed. Plans, traces, scores, dogfood ledgers, synthetic seed records, and reports use the same resolved scope, and scores and ledger entries retain the owning `tenantId` as explicit evidence.

API and tenant-bound SDK callers MUST supply their authenticated tenant scope. Direct CLI callers MAY omit scope to use the established `<base>/runs` layout. This unscoped path is compatibility-only and is never exposed through customer-scoped API or SDK reads.

Existing unscoped records are deliberately quarantined. They cannot be safely attributed to a tenant from their run identifier or content, so the system MUST NOT automatically backfill, copy, or guess ownership. A system operator may inspect them through explicit unscoped CLI commands and may migrate a record only with independent ownership evidence.

## Alternatives considered

- **Keep one shared run collection and filter on `score.tenantId`.** Rejected because plans can exist before scores, direct run identifiers still collide, and a missing or corrupt score would become an authorization decision.
- **Use the raw tenant identifier as a directory name.** Rejected because arbitrary identifiers can traverse, alias, or create platform-dependent paths.
- **Automatically assign legacy records to the current or system tenant.** Rejected because the persisted data has no authoritative ownership evidence. Guessing would turn unknown provenance into tenant authority.
- **Remove unscoped CLI support.** Rejected because local development and historical evaluation scripts depend on it. The explicit compatibility path is safe when it is not reachable from tenant-facing surfaces.
- **Do nothing.** Rejected because identical run identifiers can collide and authenticated customers can reach shared state.

## Security impact

This decision strengthens tenant isolation for plans, traces, scores, reports, and alert-producing dogfood evaluation. Tenant namespaces are opaque, fixed-width, and derived from length-prefixed input, so tenant identifiers never become filesystem path segments. Authorization remains the responsibility of the API and SDK principal binding; the namespace is defense in depth, not a replacement for authorization. No new secret or external trust boundary is introduced.

## Data and compatibility impact

No database schema or public wire format changes. `RunScore` and dogfood ledger JSON gain an optional `tenantId`, preserving readers of historical files. Existing unscoped CLI calls continue to read and write `<base>/runs`. Scoped callers move to a new location and will not see historical unscoped data. This visibility change is intentional quarantine, not data deletion.

## Migration plan

1. Add one scoped path resolver and keep the legacy resolver only when scope is omitted.
2. Thread tenant scope through execution, resume, plan editing, trajectory viewing, dogfood reads, reports, and synthetic seeding.
3. Bind API, SDK, worker, and `platform-dev` callers to their authoritative tenant.
4. Leave existing `<base>/runs` records unchanged and inaccessible to customer-scoped surfaces.
5. If an operator needs a historical record, verify ownership outside the record, copy the complete run directory into the resolved tenant namespace, add `tenantId` to its score and ledger evidence, and record the migration in the operator audit trail.

Migration is backward compatible for explicit unscoped CLI consumers. There is no dual-read fallback from a scoped tenant into unscoped state because that would reopen the isolation defect.

## Rollback

Revert the scoped resolver and caller propagation to restore the legacy layout. This is mechanically safe because scoped writes are additive and legacy records are not modified, but it reintroduces the cross-tenant collision and disclosure risk and therefore is not an acceptable production rollback. A safer operational rollback is to disable tenant-facing harness routes while preserving scoped data for diagnosis. No irreversible data transformation occurs.

## Evaluation plan

Regression tests MUST prove that identical run identifiers resolve to different tenant roots, path-shaped tenant identifiers remain contained, blank scope fails closed, tenant scores and synthetic seed records retain `tenantId`, customer list/read/patch endpoints cannot observe or mutate foreign plans or trajectories, and legacy unscoped listings do not enumerate tenant namespaces. The `platform-dev` path must generate and read its hello run, seeds, report, and visible UI state only in tenant `platform-dev`.

Success requires the focused harness and API suites, relevant script typecheck, all affected workspace typechecks, `npm run adr:check`, and repository diff checks to pass. Reconsider this decision if a durable state store replaces filesystem harness persistence or if a verified ownership ledger enables an auditable legacy backfill without inference.
