# Change Graph

Resolve an API change through repository evidence to affected operations, fields, files, symbols, tests, owners, and migration outcomes.

Status: Production pilot
Availability: Real connected snapshots with bounded language and evidence coverage
Last verified: 2026-08-14
Requirements: ME-GRF-001, ME-GRF-002, ME-GRF-003, ME-GRF-004, ME-GRF-005, ME-GRF-006, ME-GRF-007, ME-GRF-008, ME-WAR-001
Public claims: CLM-003

## Start here

Materialize a repository snapshot, index it, and query an approved change or consumer.

1. Create the exact repository snapshot.
2. Build or load the repository index and call graph.
3. Attach the provider change and consumer binding.
4. Query blast radius and inspect truncation, confidence, and evidence.

## What it does

- API surface and consumer impact graphs
- Repository, commit, pull request, file, symbol, test, owner, runtime, migration, and evidence nodes
- AST, LSP, Git, control-plane, impact, and outcome ingestion
- Callers, paths, field consumers, migration readiness, and reverse reachability queries
- Incremental persistent indexes and temporal evidence

## When to use it

- A change must be mapped to concrete code and tests.
- A reviewer needs provenance behind an impact claim.
- A campaign needs owners and dependency ordering.

## How it works

1. Schema and repository observations become typed, tenant-scoped graph nodes and edges.
2. Bounded traversals expand from the changed surface into consumers and code evidence.
3. Static, graph, and heuristic evidence are combined without hiding uncertainty.
4. Outcomes feed durable graph evidence for later planning and evaluation.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| GET /graph/changes/:id | API | Resolve the impact graph for a change. |
| GET /graph/consumers/:id | API | Resolve evidence for a consumer. |
| POST /graph-learn/query | API | Run a bounded knowledge-graph query. |
| GET /graph/agent/mermaid | API | Render the agent graph as Mermaid. |
| Repository evidence graph | Artifact | Snapshot-bound nodes, edges, source refs, and truncation metadata. |

## Evidence and verification

- Change graph: `packages/graph/src/graph.test.ts`
- Knowledge graph: `packages/graph-learn/src/graph-learn.test.ts`
- Code impact: `packages/code-impact/src/index.test.ts`

## Contract sources

- `packages/graph/src/index.ts`
- `packages/graph-learn/src/store.ts`
- `apps/api/src/server.ts`

## Safety model

- Every repository observation is bound to tenant, repository, snapshot, revision, and content digest.
- Traversal limits are explicit and truncation is surfaced.
- Static evidence never claims to observe runtime-generated behavior it cannot see.

## Limitations

- Language frontends have different depth and precision.
- Runtime, CI, deployment, and ownership evidence is only as complete as the configured ingestors.
- The current hosted demo can contain seeded data; connected snapshots are the authority for customer results.

## See also

- [Change ingestion](./change-ingestion.md)
- [Fettler — the first AI API Engineer](./fettler.md)
- [Regauge — the first AI Legacy Engineer](./regauge.md)
