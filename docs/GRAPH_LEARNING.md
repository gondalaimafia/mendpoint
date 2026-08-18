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

---

## Graph-context attribution (spec §17.4.2) — the "was it supplied to the model?" precondition

Spec §17.4.2 forbids blaming a missed relationship on the model until Mendpoint has confirmed the relationship "existed, was current, was retrievable, **and was supplied to the model**." Those are four different failure modes with four different owners:

| Failure mode | Owner |
|--------------|-------|
| Edge never materialized | Graph (entity resolution / relationship materialization) |
| Edge existed but not retrieved | Query |
| Edge retrieved but omitted from context | Context compiler |
| Edge supplied and still ignored | Model (post-training) |

The learning event carries this as `GovernedLearningEventV1.references.graphContextArtifactId`. Four facts about the current implementation, so nobody "fixes" a non-bug:

1. **The Fettler agent has no graph tool.** Its tool universe is fixed at nine tools (`packages/agent/src/agent.ts`, `TOOL_NAMES`) — `list_dir, read_file, search, write_file, replace_in_file, delete_file, run_command, http_probe, finish` — and `@mendpoint/agent` imports nothing from `@mendpoint/graph-learn`. The observable context it captures (`packages/agent/src/trajectory-capture.ts`, `assembledContextFrom`) is source-file references plus the error seed. **No production run supplies graph data to the model.** The representation-first thesis (§36.1) therefore cannot currently be tested on the Fettler path at all: the graph could be perfect and the model would still never see it. Recall is not only a graph-completeness problem here; it is also a context-delivery problem.

2. **`graphContextArtifactId: null` is correct today, not a gap.** Both governed producers — `admitWardenGovernedLearningEvent` (Fettler) and `admitTransformerGovernedLearningEvent` (Regauge) — route through `admitGovernedLearningOutcome`, which sets the field null because there is no graph context to reference. The Regauge adaptive loop's model context (`packages/transformer/src/adaptive-loop.ts`, `assembleContext`) is likewise source-file content, not graph output. Populating this field would fabricate the one diagnosis §17.4.2 exists to withhold (`model_behavior`).

3. **Two preconditions before the field can be populated honestly:** (a) a graph tool wired into the agent's context so a run actually receives graph data, or (b) the raw-vs-graph representation benchmark (§36.1) with per-arm context attribution. Until one exists, the field stays null.

4. **Reuse the trajectory store when that day comes — do not invent a fourth artifact mechanism.** `trajectory_blobs` + `trajectories.context_refs_json` (`packages/db/src/trajectory.ts`) is content-addressed, tenant-scoped, and append-only, and its redaction is already fail-closed and **already excludes private chain-of-thought (spec §8.12)** — `trajectory-capture.ts` drops `step.thought`/`intent` and `reportMarkdown` by construction. A future graph-context artifact rides that same path; set `graphContextArtifactId` to the resulting blob digest / context ref. No `artifact_manifests` / `evidence_records` fourth path.

### Making the null interpretable now (implemented)

A single null was carrying two different facts about the world — "no graph context was supplied" and "we captured nothing about this run" — and only the first is a fact. `admitWardenGovernedLearningEvent` now resolves the run's trajectory (`getTrajectoryByRun`, joined by run id: `event.missionId = run.id = trajectory.runId`) and records the discriminator durably in the audit log (`action: "learning.graph_context_attribution"`, `resourceType: "learning_event"`, idempotent id `audit-learning-graphctx-<eventId>`), **without populating the field or inventing a placeholder id**. Three states (`classifyGraphContextDelivery`):

- **`recorded_absent`** — a trajectory was captured and carries no graph-context ref. The null is a fact: this run supplied no graph context. (Every Fettler run today.)
- **`recorded_present`** — a trajectory carries a graph-context ref yet the field is null: the context-compiler failure mode. Cannot occur on the Fettler path today; reported honestly rather than read as absent.
- **`unrecorded`** — no trajectory resolved. The null is missing observation, not a fact about delivery; a reader must not attribute a miss to the model from here.

Dual-read holds: the event schema is unchanged, so events admitted before this change still load; they simply carry no attribution audit (equivalent to `unrecorded`). Scope note: the same treatment for the Regauge producer is a symmetric follow-up (its event keys on `candidate.id`, so it needs the candidate → campaign → mission → trajectory join, not a direct run-id lookup).
