# Dimension 6 — Graph Learning (platform substrate)

**Doctrine:** Graph learning is both a **sixth agentic dimension** and the **substrate** under Fettler and Regauge. It turns smart-per-run systems into **smarter-per-campaign** systems that compound across PRs and customers.

Grounding: RANGER, [GitLab Knowledge Graph](https://docs.gitlab.com/user/gitlab_duo/knowledge_graph/), [CodexGraph](https://arxiv.org/abs/2408.03910), AST-derived graph-RAG ([arXiv 2601.09842](https://arxiv.org/abs/2601.09842)), GitTemporalAI temporal KGs.

---

## Principle

| Layer | Role |
|-------|------|
| **Domain graphs** (call-graph, product UI) | Local truth for one analysis |
| **Agent orchestration graph** | Control flow between loop-nodes |
| **Graph learning substrate** | Durable multi-hop memory + outcome labels + (later) GNN |

**v1 ships deterministic graph-RAG** (works cold-start). **v1.5 adds GNN** when enough labeled PR outcomes exist. Do not block launch on GNN quality.

**Store:** SQLite-backed embedded graph in `@mendpoint/graph-learn` (swap-ready for Kùzu/Neo4j). Prefer Kùzu for multi-hop speed when ops justify native deps.

---

## Graph objects

### API Graph (Fettler)

| Nodes | Edges |
|-------|--------|
| service, endpoint, schema, field, auth_scope, consumer, error_type, slo, change, pr | calls, depends_on, deprecated_by, breaks, secures, versions_of, monitors, impacts, outcome_* |

### Code Graph + BSG (Regauge)

| Nodes | Edges |
|-------|--------|
| file, symbol, callsite, table, business_rule, invariant, bsg_node | calls, imports, reads, writes, preserves_behavior, migrated_from, depends_on |

---

## Construction (ingest)

1. Spec parsers → endpoint/field/schema nodes  
2. AST / codebase-index / call-graph → file/symbol/call edges  
3. Control plane (consumers, monitored_apis, findings, PRs) → monitors/impacts  
4. PR outcomes → **labeled edges** (`outcome_merged`, `outcome_closed`, `outcome_broke`)  

---

## Retrieval (graph-RAG tools)

Templates exposed to planners (deterministic multi-hop):

- `who_consumes_provider(slug)`  
- `who_consumes_endpoint(provider, path, method?)`  
- `blast_radius(changeId | surfaceId)`  
- `files_before(symbol)` / `depends_on_path(nodeId)`  
- `outcomes_for_pattern(pattern)`  

These **replace** separate consumer-registry and multi-repo “subsystems” as the primary API — those become thin facades over graph queries.

---

## Learning signal

| Event | Graph write |
|-------|-------------|
| PR merged | `consumer -[:outcome_merged {surfaceIds}]-> change` |
| PR closed without merge | `outcome_closed` |
| Feedback rejected | `outcome_broke` + suppress pattern (existing) |
| Contract gate fail | `breaks` edge with evidence |

GNN (P1): node classification (migrate next), link prediction (spec change → break consumer). Nightly retrain per campaign; promote patterns to **meta-graph** with human gate.

---

## How D6 upgrades D1–D5

| Dim | With graph learning |
|-----|---------------------|
| Planning | Blast-radius queries before code; DAG from depends_on |
| Execution | Failures attach to neighborhoods; next nodes inherit warnings |
| Environment | LSP/AST ingest feeds the same store |
| Recovery | At-risk consumers via multi-hop; rollback = subgraph op |
| Cross-repo | Graph *is* cross-repo memory |

---

## Package map

| Package | Role |
|---------|------|
| `@mendpoint/graph-learn` | Store, ingest, graph-RAG, outcomes |
| `@mendpoint/graph` | Product UI graphs (view projection) |
| `@mendpoint/call-graph` | Analysis-time call graph (feeds ingest) |
| `@mendpoint/orchestrator` | Agent control-flow graph |

---

## Cold-start

Ship graph + graph-RAG day one. Label every PR. Add GNN when ≥N outcomes. Meta-graph promotion is human-reviewed (no silent learning).
