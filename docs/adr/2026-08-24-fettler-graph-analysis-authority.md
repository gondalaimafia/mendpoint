# Fettler Change Graph analysis is authoritative

- **Status:** Proposed
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

#375 landed `resolveTenantGraphHandle` so production can refuse an empty or
invented graph. `runChangePipeline` still defaulted to `getGraphLearnDb()`,
which CREATES `data/graph-learn.sqlite` if missing, and on graph-analyzer
failure it fell back to raw `analyzeImpact` while still delivering a draft PR.
Comments called that a **shadow** path. Spec coverage rules say unknown impact
must abstain, not look like a successful graph-backed remediation.

## Decision

1. **Handle.** Production graph ingest uses `resolveTenantGraphHandle`. Tests
   may still inject `graphDb`. `getGraphLearnDb()` is not the pipeline default.
2. **Unavailable handle.** Skip graph ingest and `graph.updated`. Audit
   `graph.handle_unavailable`. Impact uses deterministic `analyzeImpact` and
   does not claim a `graphVersionId`.
3. **Analyzer failure when a handle is present.** Do **not** fall back to raw
   impact. Record `graph.analysis_failed` and abstain (`prStatus:
   package_failed`, no SCM draft). Unknown graph impact is not delivered as if
   the graph had succeeded.

PR feedback labeling uses the same resolver and skips graph writes when the
handle is not ready, rather than creating an empty sqlite file.

## Alternatives considered

- **Keep the raw fallback so Fettler still opens PRs when the graph throws.**
  Rejected: that is the shadow path. A draft PR after `graph.shadow_failed`
  reads as "we analyzed impact" when we did not have graph authority.
- **Fail the whole pipeline when the handle is missing.** Rejected: local and
  test runs without `GRAPH_LEARN_DB` still need the non-graph analyzer. Missing
  handle is "graph not consulted", not "graph failed mid-analysis."

## Security impact

Stops presenting an empty created-on-boot graph as tenant Change Graph
authority. Tenant isolation of `resolveTenantGraphHandle` is unchanged.

## Data and compatibility impact

Audit action `graph.shadow_failed` is replaced by `graph.analysis_failed`.
Callers that grepped the old action must update. No schema change.

## Migration plan

1. Wire the resolver + fail-closed analyzer (this PR).
2. Operators must set `GRAPH_LEARN_DB` to an already-ingested file for graph
   coverage to be claimed.

## Rollback

Revert the commit. Pipeline again creates an empty graph file and falls back
to raw impact on analyzer errors.

## Evaluation plan

Success is the pipeline tests: analyzer failure abstains (no draft PR), missing
handle audits `graph.handle_unavailable` without `graph.updated`, and existing
injected-graphDb runs still deliver. Reconsideration is requiring a ready
handle for *all* Fettler delivery, including the non-graph analyzer path.
