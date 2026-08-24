# API `/graph-learn` uses the tenant Change Graph handle

- **Status:** Proposed
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

#375 landed `resolveTenantGraphHandle` so production can refuse an empty or
invented graph. API `/graph-learn/*` still called `getGraphLearnDb()`, which
CREATES `data/graph-learn.sqlite` when the file is missing. A stats or query
call could therefore present a freshly created empty store as tenant Change
Graph authority.

## Decision

Every `/graph-learn` route that opens the graph uses `resolveTenantGraphHandle`
via `withTenantGraphHandle`. Unavailable handles return HTTP 503 with
`graph_handle_unavailable` and the resolver reason. The file is never created.

Read routes refuse an empty tenant view. Ingest routes pass `allowEmpty` so the
first nodes can be written into an already-existing file.

`/graph-learn/slo` does not open the graph (process latency only) and is
unchanged. `getGraphLearnDb()` remains a test/script helper.

## Alternatives considered

- **Keep `getGraphLearnDb()` so first ingest creates the file.** Rejected: the
  same helper is what made empty-file authority look live on read.
- **Fail the whole API process when `GRAPH_LEARN_DB` is unset.** Rejected:
  other API surfaces must keep working; only graph routes fail closed.

## Security impact

Stops presenting an empty created-on-read graph as tenant authority. Tenant
isolation of the resolver is unchanged.

## Data and compatibility impact

Operators must set `GRAPH_LEARN_DB` to an existing sqlite file before graph
HTTP routes succeed. No schema change.

## Migration plan

1. Wire the resolver on API graph routes (this PR).
2. Operators create/ingest a real graph file, then point `GRAPH_LEARN_DB` at it.

## Rollback

Revert the commit. Graph HTTP routes again create `data/graph-learn.sqlite`.

## Evaluation plan

Resolver + helper tests: missing env, missing file (no create), empty tenant
view refused on read and allowed on ingest, ready handle used and closed.
