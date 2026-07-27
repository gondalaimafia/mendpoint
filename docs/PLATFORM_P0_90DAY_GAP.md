# Shared Platform P0 — 90-day plan vs monorepo

**Source:** Shared Platform P0 90-Day Execution Plan  
**Repo:** mendpoint · **As of:** post Dim-6 graph-learn ship  

Scores: 0 absent · 1 stub · 2 partial · 3 working dogfood · 4 day-90 ready · 5 production multi-tenant

---

## Executive summary

| 90-day P0 pillar | Score | Status |
|------------------|-------|--------|
| Graph substrate | **4.2** | Schema v0 + **git temporal backfill** (Commit/Author/File, MODIFIES valid_from/to); AST/LSP still light |
| Graph-RAG query layer | **4.3** | Multi-hop ops + 20-query bench + **p50/p99 SLO ring buffer** (`latency_stats`, `npm run graph:slo`) |
| Outcome-labeling pipeline | **3.0** | PR feedback → labeled edges; webhook PR→outcome attribution partial |
| Devin-style base harness | **3.5** | Plan JSON, memory, sandbox, recovery; **dogfood ledger + trajectory viewer**; no Firecracker VM |
| **Day-90 dogfoodable platform** | **~3.8** | SDK + stubs + git temporal + SLOs + **≥30-run dogfood report**; A/B lift + full LSP remain open |

**Philosophy match:** Ship deterministic graph + harness first; GNN/meta-graph post-90 — **aligned**.

---

## Phase 0 (Days 1–15) coverage

| Deliverable | Score | Monorepo |
|-------------|-------|----------|
| Monorepo scaffold + CI-ish tests | 4 | npm workspaces, vitest all packages |
| One-command local bring-up | 3 | `npm run platform:dev` (this ship) |
| Graph schema v0 | 4 | Canonical `schema/v0.md` · code mirror in `@mendpoint/graph-learn` · pointer `docs/GRAPH_SCHEMA_V0.md` |
| Kùzu DDL | 2 | `KUZU_DDL_V0` export + docs; **SQLite implements schema** |
| Planner/executor + plan disk persist + resume | 3–4 | `@mendpoint/harness` (this ship) + orchestrator plans |
| Ephemeral sandbox | 2–3 | Local workdir (`@mendpoint/platform`); not Firecracker |
| Pilot repo selection | 3 | `fixtures/` + `docs/PILOT_REPOS.md` |
| Eval: `runs/<id>/{plan,trace,score}` | 4 | `@mendpoint/harness` trajectory writer |

**Day-15 demo:** Covered by `npm run platform:dev` + harness hello-world.

---

## Phase 1 (Days 16–45) coverage

| Track | Item | Score | Notes |
|-------|------|-------|-------|
| A | AST/tree-sitter ingest Py/TS/Java | 2–3 | codebase-index + call-graph → graph-learn ingest helpers |
| A | LSP ingester | 1 | Not built; tree-sitter-ready path |
| A | Git temporal 12mo | 3–4 | `backfillGitTemporal` + `npm run graph:temporal` (commit/file/author; CALLS still AST/LSP) |
| A | Incremental <30s | 2 | call-graph incremental exists; graph-learn partial reingest helper |
| A | 20-query benchmark | 4 | `graph-learn` 20-case pack covers v0 ops (consumers_of_field, time_travel_calls, migration_ready, …) |
| B | 4-layer memory | 4 | `@mendpoint/platform` |
| B | Deterministic recovery | 3 | Warden/repair + plan step fail branches |
| B | VM + build cache | 2 | Local sandbox + cacheKey; no gVisor |
| B | HITL plan edit UI | 1 | API returns editable plan JSON; full UI stub light |
| C | Graph-RAG templates | 4 | callers, consumers, blast_radius, path, neighborhood, pattern_success_rates, time_travel_calls, migration_ready_units, … |
| C | p50/p99 latency SLOs | 4 | Ring buffer + targets + `checkSlos` + `npm run graph:slo` |

---

## Phase 2 (Days 46–75) coverage

| Item | Score | Notes |
|------|-------|-------|
| PR webhooks → outcomes | 2–3 | GitHub webhooks exist; outcome edges on `applyPrFeedback` |
| Attribution plan↔nodes | 2 | PR/change/consumer edges; full plan id attribution improving |
| Dashboards success rates | 2 | Metrics pages; pattern rates via graph query |
| Specialist stubs on harness | 3 | Warden/Transformer hello specialists (this ship) |
| Dogfood 30 runs | 4 | `collectDogfood` + ledger on every harness run + `npm run dogfood:report` |
| Graph-RAG v1 LLM query pick | 1 | Templates only |
| Ranking by outcome edges | 2 | Simple pattern success rates (this ship) |

---

## Phase 3 (Days 76–90) coverage

| Item | Score | Notes |
|------|-------|-------|
| SLOs + alerts | 1 | Documented targets only |
| Trajectory viewer UI | 3 | CLI `trajectory:list` / `trajectory:view` (full UI still open) |
| Cost accounting | 1 | score.json fields reserved |
| Pattern extractor + planner inject | 3 | `@mendpoint/graph-learn` patterns (this ship) |
| A/B lift | N/A | Needs dogfood volume |
| Platform SDK | 4 | `@mendpoint/sdk` (this ship) |
| Handoff docs | 3 | `docs/PLATFORM_RUNBOOK.md` |

---

## Explicit out-of-scope (still out)

GNN, cross-campaign meta-graph auto-promotion, multi-tenant RBAC, Neo4j, full specialist agents, browser tool — **correctly deferred**.

---

## What this ship closes

1. Formal **90-day gap map** (this doc)  
2. **Harness** with plan persist/resume + trajectory artifacts  
3. **Graph schema v0** first-class — `schema/v0.md` SoT, full node/edge kinds, temporal edges, legacy migrate, KUZU_DDL_V0  
4. **platform:dev** one-command demo  
5. **SDK** + Warden/Transformer specialist stubs  
6. **Learned signal v0** — pattern success rates from outcome edges  
7. **20-query benchmark** on real v0 query shapes (not stats padding)

---

## Day-90 metrics (status)

| Metric | Target | Code support |
|--------|--------|--------------|
| Dogfood merge rate ≥50% | Process | Outcome edges + dashboards partial |
| Learned-signal lift ≥10% | Process | Pattern ranks injectable into planner context |
