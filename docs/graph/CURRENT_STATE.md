# Change Graph current state

This document records repository truth at `d90c5713451b1774c9a744e36e9c17464cf64884`, before issue 185 implementation.

## Working and tested

- `@mendpoint/call-graph` builds TS, JS, Python, Go, and Java oriented function and call relationships, reverse reachability, wrapper discovery, reset-recompute updates, validation, and content-addressed versions.
- `@mendpoint/codebase-index` indexes files, functions, imports, provider-driven SDK calls, HTTP paths, fields, and an embedded call graph under explicit resource bounds.
- `@mendpoint/code-impact` discovers provider candidates, expands indirect callers through the call graph, distinguishes complete, partial, and not-analyzed coverage, and produces an `ImpactReport`.
- `@mendpoint/graph-learn` stores nodes and temporal edges in SQLite, applies tenant-scoped read views, ingests provider/spec/control-plane/findings/outcomes, and exposes bounded query templates.
- The Fettler pipeline runs a tenant-scoped durable graph query and attaches its Markdown projection to the draft package.

## Implemented but not connected as canonical intelligence

- The content-addressed call-graph store retains historical versions, but Fettler missions do not bind to one of those versions.
- Code impact resolves endpoint-to-callers during each run, but the resolved SDK, wrapper, caller, and test relationships are not published to the durable Change Graph.
- The pipeline queries graph-learn before repository impact analysis and writes only coarse file findings afterward. The graph query therefore cannot drive the same mission's repository impact answer.
- Tenant ownership in graph-learn v0 is inferred from identifiers and properties rather than required by the node and edge type contracts.
- Temporal fields exist on mutable v0 edges, but upsert-by-ID overwrites the row. This is not immutable graph-version history.
- Existing graph coverage is query-local and limited to complete, partial, and target absent. It does not record extractor coverage, conflicts, stale evidence, or unsupported languages per graph version.

## Seeded or evaluation-only

- `packages/graph-learn/src/benchmark.ts` validates deterministic seeded graph shapes. It is not a raw-versus-graph model benchmark.
- `impact-benchmark.ts` has useful held-out prediction metrics, but it does not compare context bytes, retrieval calls, token use, latency, cost, or representation failure categories.
- Library graph registration exists in the call-graph store, but provider SDK stitching is roadmap work.

## Not yet built at this baseline

- One immutable, tenant-scoped software graph publication joining provider endpoint, provider SDK method, internal SDK method, wrapper or caller, and test evidence.
- Exact, alias, ambiguous, unresolved, and collision entity-resolution outcomes as a durable contract.
- Atomic graph publication with last-valid-head retention.
- Exact mission graph-version binding and compact evidence-pack compilation.
- A same-model raw versus graph benchmark with development, validation, and hidden holdout splits.
- Failure routing that prevents graph representation defects from becoming model-weight training examples.

## Baseline verification

- Code Impact: 73 of 73 tests passed.
- Call Graph: 24 of 24 tests passed.
- Pipeline: 72 of 72 tests passed.
- Graph Learn: 65 of 66 passed under four-suite parallel load; the one five-second git-history timeout passed alone in 1.7 seconds, 14 of 14 in its focused file.

## Issue 185 foundational implementation

The issue 185 branch adds, beside the unchanged mutable v0 graph:

- immutable, content-addressed, tenant, repository, and provider-scoped software graph versions and heads;
- exact historical reads, response-loss replay, atomic publication, incremental diff and reuse, and last-valid-head retention;
- explicit endpoint, provider SDK method, internal SDK method, function, and test entities;
- evidence-bearing `USES_ENDPOINT`, `USES_SDK_METHOD`, `WRAPS`, `CALLS`, and `TESTS` relationships;
- exact, alias, ambiguous, unresolved, and collision entity resolution;
- complete, partial, stale, conflicted, filtered, and truncated coverage semantics;
- deterministic endpoint-to-repository impact traversal and a compact evidence context compiler;
- real code-index materialization and Fettler pipeline publication tied to the immutable provider change timestamp;
- an append-only graph context artifact, evidence row, audit record, and `change_graph.context_recorded` domain event explicitly routed to graph representation with model-weight eligibility false;
- a same-model raw-versus-graph benchmark contract with split-group isolation, validation and holdout indirect-coverage enforcement, answer-key separation, cost and latency accounting, and optional soft verifier output.

The implementation is not yet canonical for ReGauge, router selection, or model training. Fettler records it as shadow evidence while the existing deterministic impact path remains authoritative. The first live benchmark tied at 6 of 6 correctness but showed the optimized graph context still cost 23.3 percent more than raw retrieval on six tiny repositories. That result blocks graph-first default activation and is recorded in `docs/research/MENDPOINT_CHANGE_GRAPH_BENCHMARK.md`.
