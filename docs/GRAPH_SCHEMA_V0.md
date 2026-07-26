# Graph schema v0 (shared platform)

**Store:** SQLite property graph via `@mendpoint/graph-learn` (Kùzu/Neo4j escape hatch).  
**DDL:** applied on open (`gl_nodes`, `gl_edges`).

## Nodes (kinds)

| Kind | Description | Used by |
|------|-------------|---------|
| `file` | Source file | Both |
| `symbol` | Function/class/type | Both |
| `callsite` | Call site | Both |
| `endpoint` | HTTP path+method | Warden |
| `schema` / `field` | Request/response fields | Warden |
| `provider` / `service` | API provider | Warden |
| `consumer` | Downstream repo | Warden |
| `change` / `surface` | Spec diff unit | Warden |
| `pr` | Pull request | Both |
| `pattern` | Plan/migration pattern | Both |
| `bsg_node` / `invariant` / `business_rule` / `table` | BSG | Transformer |

## Edges (kinds)

| Kind | Meaning |
|------|---------|
| `calls` / `imports` / `depends_on` | Code structure |
| `has_endpoint` / `has_field` | Spec structure |
| `monitors` | Consumer → provider |
| `impacts` | Change → consumer/file |
| `breaks` | Breaking change → endpoint |
| `versions_of` | Change → provider |
| `outcome_merged` / `outcome_closed` / `outcome_broke` / `outcome_waived` | Labeled PR outcomes (GNN fuel) |
| `migrated_from` / `preserves_behavior` | Transformer |
| `related` | Generic link |

## Kùzu escape hatch (not built)

```text
// Pseudocode DDL shape — implement when multi-hop volume requires it
CREATE NODE TABLE Node(id STRING, kind STRING, label STRING, props STRING, PRIMARY KEY(id));
CREATE REL TABLE Edge(FROM Node TO Node, kind STRING, props STRING, label DOUBLE);
```

Migration: export SQLite → bulk load; keep query templates stable in `@mendpoint/graph-learn`.
