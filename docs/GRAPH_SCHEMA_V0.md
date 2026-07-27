# Graph schema v0 (shared platform)

**Canonical source of truth:** [`/schema/v0.md`](../schema/v0.md)

**Store:** SQLite property graph via `@mendpoint/graph-learn` (Kùzu/Neo4j escape hatch).  
**Naming:** `PascalCase` nodes · `SCREAMING_SNAKE` edges · `snake_case` properties · temporal `valid_from`/`valid_to`.

See full node/edge families, Cypher shapes, indexes, evolution rules, and non-goals in **schema/v0.md**.

Quick spines:
- **Warden:** Service → Endpoint → Field → Consumer (+ CONSUMES / BREAKS / OUTCOME_*)
- **Transformer:** Campaign → MigrationUnit → BSGNode → Symbol (+ DEPENDS_ON / REALIZED_BY)

Kùzu DDL: `KUZU_DDL_V0` export from `@mendpoint/graph-learn`.
