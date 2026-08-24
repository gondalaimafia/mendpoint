# Ingest PRESERVES_INVARIANT from source annotations

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

Spec §11 and §28.1.1 require important Change Graph edges to have a producer with evidence, and `invariants_for_symbol` is a required query primitive. `PRESERVES_INVARIANT` was a declared edge kind (`packages/graph-learn/src/schema.ts`) with a reader that failed closed because no ingest path wrote the relation. Advertising the op would let a planner treat `0 invariant(s)` as a definitive "this symbol preserves nothing".

## Decision

Add `ingestInvariantAnnotations` and wire it from the live `ingestLspSymbols` path (heuristic files and AST-fallback repo walk).

- Only explicit `@invariant` / `invariant:` annotations adjacent to a function or class become Invariant nodes and Symbol `PRESERVES_INVARIANT` Invariant edges. Unannotated symbols are skipped, never guessed.
- `invariants_for_symbol` still fails closed when the tenant graph has no `PRESERVES_INVARIANT` edges. Once the relation is populated it returns the annotated invariants for a matched symbol, or `target_absent` when the symbol is missing.
- `GRAPH_RAG_TOOLS` and the query-pick rule for `invariants_for_symbol` are restored in the same change as the producer. `migration_ready_units` stays unadvertised until its own DEPENDS_ON producer lands.

## Alternatives considered

- **Treat TESTS edges as invariants.** Rejected: a test covering a symbol is not a declared behavioral invariant; collapsing the two would invent PRESERVES_INVARIANT from a different relation.
- **Advertise the op while the producer is empty.** Rejected: that is the defect the fail-closed handler exists to prevent.
- **File-level invariants without a symbol.** Rejected: the query is `invariants_for_symbol`; an unbound annotation is skipped rather than attached to a guessed symbol.

## Security impact

None beyond existing graph ingest. Annotations are local source text; node ids are repo-scoped; tenant query views still filter `repo_id`.

## Data and compatibility impact

Additive. Existing graphs without annotations keep failing closed on `invariants_for_symbol`. Re-ingest writes new Invariant nodes and PRESERVES_INVARIANT edges. No digest or append-only store is changed.

## Migration plan

1. Land the producer, query restore, and tests together.
2. Re-ingest repositories so annotations become edges.
3. Keep `migration_ready_units` fail-closed until DEPENDS_ON ingest merges.

## Rollback

Revert the commit. The query returns `target_absent` again; leftover Invariant nodes are inert.

## Evaluation plan

Success is the ingest tests writing only annotated edges, the query failing closed on an empty relation and returning complete rows once populated, the planner tool surface advertising `invariants_for_symbol`, and `npm test -w @mendpoint/graph-learn` plus typecheck green.
