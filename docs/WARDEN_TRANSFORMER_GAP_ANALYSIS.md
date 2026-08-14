# Gauge × Regauge capabilities — gap analysis

**Source:** Gauge × Regauge Capabilities Matrix (Devin-class autonomy in two niches)  
**Codebase:** `mendpoint` monorepo · product **Gauge** today · **Regauge** not productized  
**Date:** 2026-07-23  

Scores: 0 absent · 1 stub · 2 toy · 3 MVP · 4 partner-ready · 5 GA

---

## Executive summary

| Product | Role in matrix | Maturity | Verdict |
|---------|----------------|----------|---------|
| **Gauge** (API engineer) | Spec-first design/build/evolve/test/secure/operate APIs + consumer impact | **~3.4 / 5** post-matrix-build (consumer PR + plans/gates/registry/critic; sandbox local-only) | Spec plan, contract gates, critic, registry wired; VM/in-cluster still stub |
| **Regauge** (legacy migration) | COBOL/VB6/.NET-Fx/Py2/monolith → modern; BSG + DAG campaigns | **~1.5 / 5** | BSG/DAG/campaign + multi-repo router + output diff; no COBOL/mainframe engines |
| **Shared platform** | Planner/executor, sandbox VM, 4-layer memory, knowledge store, multi-SCM | **~3.0 / 5** | Plan harness, local sandbox, 4-layer memory, knowledge seed, canary hooks; no real multi-SCM |

**Strategic fit:** Monorepo now includes **Dimension 6 graph learning substrate** (`@mendpoint/graph-learn`): durable KG, graph-RAG, PR outcome labels. Registry/multi-repo become graph queries. GNN deferred to v1.5. See `docs/GRAPH_LEARNING.md`.

---

## Dimension-by-dimension

### D1 — Task planning

| Requirement | Gauge score | Regauge score | Reality today |
|-------------|--------------|-------------------|---------------|
| Planner/executor + JSON plan + success criteria | 2 | 0 | Orchestrator graph + Gauge heuristic steps; **no durable JSON plan-of-record** |
| Plan = **OpenAPI/Proto spec diff** | 3 | — | `change-intel` surfaces map to diffs; not first-class **versioned plan object** driving every step |
| Plan = **BSG** (behavioral spec graph) | — | 0 | Not started |
| Horizon: multi-release / multi-week | 1 | 0 | Single pipeline run; no service/campaign object |
| Persistence: **service** / **campaign** | 1 | 0 | Provider + consumer entities; no campaign/DAG |
| **Priority** | P0 | P0 | |

**Gaps:** Spec-first `Plan` schema; Proto; BSG extraction; campaign/DAG planner.

### D2 — Code execution

| Requirement | Gauge | Regauge | Reality |
|-------------|--------|-------------|---------|
| Ephemeral VM sandbox | 1 | 0 | Local process sandbox (Gauge tools); no VM/DB/in-cluster |
| Live-service sandbox (DB, mocks, curl own API) | 0 | — | Missing |
| Multi-runtime matrix (JVM/.NET/COBOL) | — | 0 | Language *analysis* harnesses only |
| Contract-conformance (fuzz, authz, oas-diff) | 1 | — | Policy + path checks; no contract test runtime |
| Differential execution / parity | — | 0 | Missing |
| Pact-style consumer-driven blocks | 1 | — | Findings exist; not contract suite gate |
| Scaffolding / feature flags coexistence | — | 0 | Missing |

### D3 — Environment

| Requirement | Gauge | Regauge | Reality |
|-------------|--------|-------------|---------|
| Terminal parity | 2 | 2 | `run_command` with denylist |
| LSP / tree-sitter | 1 | 0 | Heuristic index “tree-sitter-ready” |
| Spectral / oas-diff / Buf | 1 | — | OpenAPI diff only |
| Postman/Bruno/gateway/auth adapters | 0 | — | Missing |
| Mainframe connectors | — | 0 | Missing |
| CI gates (spec lint, contract, security, SLO) | 2 | 0 | Gauge CI comment; policy; no full gate suite |
| PR-per-DAG-node | — | 0 | One PR per consumer/change |

### D4 — Error recovery

| Requirement | Gauge | Regauge | Reality |
|-------------|--------|-------------|---------|
| Deterministic tool errors | 3 | 1 | Gauge/repair verify loops |
| Contract-violation structured diffs | 1 | — | Partial in Gauge knowledge modes |
| Differential-trace diffs | — | 0 | Missing |
| Read-only API design critic | 0 | — | Missing |
| BSG fidelity critic | — | 0 | Missing |
| Escalate w/ impact report | 2 | 0 | Reports + FDE handoff language |
| Canary / cross-PR rollback | 0 | 0 | Never auto-merge only |

### D5 — Cross-repo context

| Requirement | Gauge | Regauge | Reality |
|-------------|--------|-------------|---------|
| 4-layer memory | 0 | 0 | Single-run context |
| Consumer registry (who calls what) | 2.5 | — | consumers + monitored_apis + findings; not endpoint-level registry query product |
| One-agent-per-repo orchestrator | 1 | 0 | Fanout jobs; not multi-agent-per-repo |
| Style guide / playbook knowledge | 1 | 0 | Brand packs + suppressed_patterns |
| Learning from PR fix-ups | 2 | 0 | Feedback → suppressed_patterns |

---

## Gauge P0 roadmap vs repo

| # | P0 item | Score | Build now? |
|---|---------|-------|------------|
| 1 | Spec-first planner (OpenAPI/Proto plan-of-record) | 2.5 | **Yes** — plan JSON from surfaces |
| 2 | Live-service sandbox | 0 | Scaffold only (interface + local mock) |
| 3 | Contract-conformance runtime | 1 | **Yes** — oas-diff + response schema checks on fixtures |
| 4 | PR gates (lint, oas-diff, contract, security) | 2 | **Yes** — gate evaluator package |
| 5 | API reviewer critic | 0 | **Yes** — heuristic design scorer |
| 6 | Consumer registry | 2.5 | **Yes** — query “who uses this surface/provider” |

## Regauge P0 vs repo

| # | P0 item | Score | Build now? |
|---|---------|-------|------------|
| 1–7 | DAG, BSG, differential, critic, LSP, multi-repo, campaign | 0–1 | **Scaffold types + stubs + docs**; not full engines |

## Shared platform vs repo

| Item | Score | Build now? |
|------|-------|------------|
| Planner/executor harness + JSON plan | 2 | **Yes** — extend orchestrator |
| Ephemeral sandbox VM | 0 | Interface stub |
| Four-layer memory | 0 | Minimal types + pruning helper |
| Deterministic recovery loop | 3 | Exists (Gauge/repair) |
| Knowledge store | 1 | Style-guide seed file + retrieval stub |
| PR/CI adapters | 3 | GitHub only |

---

## Recommended build sequence (this sprint)

1. Gap doc (this file)  
2. Shared `Plan` + executor store  
3. Spec-first plan from OpenAPI  
4. Contract suite + PR gates  
5. API reviewer critic  
6. Consumer registry API  
7. Regauge package scaffold (BSG/DAG/campaign)  
8. Wire API routes + tests  

**Explicitly deferred:** real VMs, COBOL/mainframe, Proto/Buf full, canary deploy, multi-SCM, months-long campaigns.

---

## Bottom line

- **Gauge today** ≈ “API change intelligence → **consumer** code PRs + debug agent.”  
- **Matrix Gauge** ≈ “full API engineer with **spec as law** + **contract runtime** + **consumer blast radius**.”  
- Closing the matrix means **productizing the spec as plan-of-record and executable contracts**, not rewriting the graph impact core.  
- **Regauge** is a **second product line** — share platform harness; do not conflate with Gauge v1.
