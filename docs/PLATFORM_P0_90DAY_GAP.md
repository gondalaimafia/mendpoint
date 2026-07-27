# Shared Platform P0 — 90-day plan vs monorepo

**Source:** Shared Platform P0 90-Day Execution Plan  
**Repo:** mendpoint · **As of:** outstanding-closure ship  

Scores: 0 absent · 1 stub · 2 partial · 3 working dogfood · 4 day-90 ready · 5 production multi-tenant

---

## Executive summary

| 90-day P0 pillar | Score | Status |
|------------------|-------|--------|
| Graph substrate | **4.5** | Schema v0 + git temporal + **AST/LSP ingest** + incremental reingest + GNN export |
| Graph-RAG query layer | **4.5** | Templates + SLO + **NL query pick** + promote/meta-graph + A/B lift |
| Outcome-labeling pipeline | **4.0** | PR feedback + **plan attribution** + experiment arms |
| Devin-style base harness | **4.2** | Plans, trajectories, dogfood, **cost**, **HITL edit UI**, VM backends |
| **Day-90 dogfoodable platform** | **~4.3** | SDK + API + web platform pages; Firecracker real microVM still host-dependent |

**Philosophy match:** Ship deterministic graph + harness first; GNN **export** shipped, training out-of-process.

---

## Phase 0–3 coverage (closed)

| Item | Score | Monorepo |
|------|-------|----------|
| Graph schema v0 | 4 | `schema/v0.md` + graph-learn |
| Kùzu DDL | 2 | `KUZU_DDL_V0` |
| Planner/executor + resume | 4 | `@mendpoint/harness` |
| Ephemeral sandbox / VM | 3–4 | `createVmSandbox` local\|docker\|firecracker-stub + build cache |
| Live-service sandbox | 4 | `startLiveSandbox` mock HTTP + curl |
| Eval trajectories | 4 | runs/ + trajectory viewer CLI/UI |
| AST ingest Py/TS/Java | 4 | `ingestAstRepo` |
| LSP ingester | 3–4 | LSP-shaped backends + heuristic TS/Py |
| Git temporal 12mo | 4 | `backfillGitTemporal` |
| Incremental &lt;30s | 3–4 | `incrementalReingest` + hash snapshot |
| 20-query benchmark | 4 | graph:bench |
| 4-layer memory | 4 | platform memory |
| VM + build cache | 3–4 | vm.ts cacheKey |
| HITL plan edit UI | 4 | `/platform/plans` + PATCH API + RBAC |
| Graph-RAG templates | 4 | full tool list |
| p50/p99 SLOs + alerts | 4 | slo.ts + alerts.ts + API |
| PR webhooks → outcomes | 3–4 | applyPrFeedback + plan_id / experiment |
| Attribution plan↔nodes | 4 | EXECUTED_PLAN edges |
| Dashboards success rates | 4 | metrics + dogfood + platform pages |
| Dogfood 30 runs | 4 | dogfood ledger + report |
| Graph-RAG NL pick | 4 | `pickGraphQuery` |
| Ranking by outcomes | 4 | pattern rates + promotePatterns |
| Trajectory viewer UI | 4 | web + CLI |
| Cost accounting | 4 | estimateCost + score.costUsd |
| Pattern promote / meta-graph | 4 | promotePatterns PROMOTED |
| A/B lift | 4 | measureAbLift ≥10pp target field |
| Platform SDK | 4 | createPlatform full surface |
| Multi-SCM | 3 | ScmAdapter github + gitlab/bitbucket stubs |
| Multi-tenant RBAC | 3–4 | roles/permissions + plan:edit gate |
| GNN export | 4 | exportGnnFeatures JSON/JSONL (no train loop) |
| Handoff docs | 4 | this doc + PLATFORM_RUNBOOK |

---

## Host-dependent / external (interfaces shipped)

| Item | Notes |
|------|--------|
| Real Firecracker microVM | Requires `FIRECRACKER_BIN` + kernel/rootfs; falls back local |
| Docker backend | Uses docker when daemon present |
| External LSP process | Interface accepts command; default heuristic |
| Neo4j | Not required — Kùzu DDL escape hatch remains |
| GNN training | Export only; train offline |
| COBOL/mainframe engines | Runtime matrix marks planned |

---

## CLIs

```bash
npm run platform:dev
npm run graph:temporal -- . --months=12
npm run graph:slo
npm run dogfood:report
npm run trajectory:list
```

## API surface (platform)

- `GET /platform/dogfood` · `/platform/trajectories` · `/platform/plans`
- `PATCH /platform/plans/:runId` (RBAC plan:edit)
- `GET /platform/vm` · `POST /platform/vm/sandbox` · `POST /platform/live-sandbox`
- `GET /platform/scm` · `/platform/alerts` · `POST /platform/cost/estimate`
- `POST /graph-learn/pick` · `/ast-ingest` · `/lsp-ingest` · `/incremental` · `/promote-patterns`
- `GET /graph-learn/ab` · `/gnn-export` · `/slo`

## Web

- `/platform` · `/platform/dogfood` · `/platform/trajectories` · `/platform/plans`
