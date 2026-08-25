# Production tenant Change Graph handle

- **Status:** Proposed
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Fettler campaign execution (`executeWardenCampaignTarget`) already requires a `graphDb` and fail-closes when repository evidence is missing. The production hazard is how that handle is obtained:

- `getGraphLearnDb()` and `openGraphLearnDb()` CREATE `data/graph-learn.sqlite` (or `GRAPH_LEARN_DB`) if the file is absent, so a worker can present an empty store as the Change Graph.
- `fieldRenameRecipeDependencies` defaults `graphDb` to `openGraphLearnMemory()`, an ephemeral empty graph that can never satisfy production gates.
- `runGraphQuery` already wraps a persistent handle in `createTenantGraphView`, so the missing piece is not a second view — it is a resolver that refuses to invent a graph.

Spec §11 and §28.1.0 require the live Fettler path to consult a real, tenant-scoped Change Graph. An empty memory handle is not that graph.

## Decision

We will resolve production graph handles through `resolveTenantGraphHandle` (`packages/pipeline/src/tenant-graph-handle.ts`):

- The path comes from an explicit argument or `GRAPH_LEARN_DB`. An unset path is `unavailable`.
- An in-memory / `:memory:` path is refused (`path_ephemeral`). Tests may still call `openGraphLearnMemory()` directly.
- A missing file is `file_missing`. The resolver never creates the file.
- A file that opens but contains zero nodes owned by the tenant is `empty_tenant_view`.
- Only a persistent file with tenant-owned nodes returns `ready`, and the caller owns `close()`.

`productionGraphFilePresent` is the process-level gate for claiming `warden.campaign.execute-target` jobs: the worker enables that claim only when a real graph file exists. Per-job, dispatch still resolves the tenant view and fail-closes if that tenant owns nothing.

## Alternatives considered

- **Keep defaulting to `openGraphLearnMemory()` in production.** Rejected: campaign gates then always fail (or, worse, a future change could treat empty evidence as "no impact"). The empty store is a test fixture, not a graph.
- **Use `getGraphLearnDb()` and create the file on first boot.** Rejected: creating an empty sqlite file would make "graph present" true while the tenant view is empty, hiding the absence of ingested evidence.
- **Wrap the handle in `createTenantGraphView` at resolve time.** Rejected as the default: `runGraphQuery` already opens a tenant view per query. Returning the persistent db avoids nesting TEMP views on a projection. Callers that need a view can wrap it.

## Security impact

Fail-closed tenant isolation: another tenant's nodes never make this tenant's handle `ready`. No new auth surface. Refusing ephemeral graphs prevents a worker from executing campaign edits against an empty, non-authoritative store.

## Data and compatibility impact

Additive library and tests. Existing test callers that pass `openGraphLearnMemory()` as `dependencies.graphDb` are unchanged. Production workers that do not set `GRAPH_LEARN_DB` to a real file continue not to claim campaign-execute jobs.

## Migration plan

1. Land `resolveTenantGraphHandle` + tests.
2. Follow-on: `run-service` claims campaign-execute jobs only when `productionGraphFilePresent()` is true, and dispatch resolves the per-tenant handle before `executeWardenCampaignTarget`.
3. Follow-on: stop defaulting `fieldRenameRecipeDependencies.graphDb` to memory on any production path.

## Rollback

Revert the commit. Callers that have not yet switched to the resolver are unaffected.

## Evaluation plan

Success is the pipeline unit suite: missing path, ephemeral path, missing file (no create), empty tenant view, ready handle with tenant-owned nodes, and cross-tenant isolation.
