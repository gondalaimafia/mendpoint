# Gauge / Mendpoint — Production GA 1.0

**Status:** General Availability (self-hosted + API-key multi-tenant control plane)  
**Version:** `1.0.0` · channel `ga` · product **Gauge** on platform **Mendpoint**  
**Date:** 2026-07-27

This document is the **production GA story**: what is in, what is out, how to run it, and what you may claim.

---

## One-liner (GA)

**Gauge** opens **reviewable migration PRs** when APIs change: OpenAPI-aware impact analysis on connected codebases, graph-backed blast radius, contract gates, and an on-demand debug loop — **never auto-merges by default**.

---

## What GA 1.0 includes (customer-facing)

| Capability | Evidence |
|------------|----------|
| OpenAPI diff → impactable surfaces | `@mendpoint/change-intel` + pipeline |
| Graph / hybrid impact analysis | call-graph + code-impact + fixtures |
| Migration PR generation (mock or real GitHub) | `@mendpoint/generation` + `@mendpoint/github` |
| Human review default / no silent write | `@mendpoint/policy` |
| Consumer registry | API `/registry/...` |
| Spec-first plans | `/warden/plans/from-spec` |
| Contract gates + API design critic | `@mendpoint/contract` |
| Gauge debug agent loop | `@mendpoint/agent` |
| Feed poll (OpenAPI / SDK signals) | worker + catalog |
| Audit log + product metrics | SQLite control plane |
| API key auth (required in production) | `API_AUTH=required` |
| Rate limiting + security headers | `@mendpoint/ops` + API middleware |
| Liveness / readiness / version / status | `/live` `/ready` `/version` `/status` |
| Multi-language impact harnesses | TS / Python / Go / Java / Ruby phase harnesses |
| Graph-RAG + outcome labels (learning substrate) | `@mendpoint/graph-learn` |

---

## Explicitly **not** GA (experimental)

| Capability | How to enable (if at all) |
|------------|---------------------------|
| Regauge full BSG/campaign product | `MENDPOINT_FEATURES=transformer_bsg_campaigns` |
| Firecracker / real microVM | host + `FIRECRACKER_BIN` |
| Kùzu native graph store | `npm i kuzu` |
| GNN training | offline; export only in-repo |
| Low-risk auto-merge | experimental policy only |
| Whole-repo LLM scan | never GA; slices only |

---

## Production run (self-hosted)

### Docker Compose

```bash
docker compose up --build
# API  http://localhost:3001/status
# Web  http://localhost:3000
```

### Bare metal

```bash
export NODE_ENV=production
export API_AUTH=required
export API_PORT=3001
export WEB_URL=https://app.example.com
export CORS_ORIGINS=https://app.example.com
# optional real GitHub
# export GITHUB_MODE=real GITHUB_TOKEN=...

npm ci
npm run ga:check
npm run dev:api    # or: npm run start -w @mendpoint/api
npm run build -w @mendpoint/web && npm run start -w @mendpoint/web
```

### First API key (required when `API_AUTH=required`)

1. Temporarily start with `API_AUTH=off` **or** seed a bootstrap key via `npm run db:seed` docs  
2. `POST /keys` with admin role → store token once  
3. Restart with `API_AUTH=required`  
4. Call API with `Authorization: Bearer me_...`

---

## Probes (orchestrators)

| Path | Use |
|------|-----|
| `GET /live` | Liveness (process up) |
| `GET /ready` | Readiness (env + DB ping) — 503 if fail |
| `GET /health` | Human-readable health + version |
| `GET /status` | Full GA status + feature lists |
| `GET /version` | Release + feature matrix |

---

## SLOs (operational targets for self-hosted GA)

| Signal | Target |
|--------|--------|
| API readiness | process + DB ping |
| Graph-RAG p50 (local SQLite) | &lt; 50ms typical |
| Migration demo path | `npm run demo` offline |
| Auth | required in production |
| Rate limit default | 120 req / 60s per IP or API key |

---

## Support / security posture

- **Secrets:** never commit tokens; use env  
- **Customer code:** not used to train foundation models without opt-in  
- **PRs:** review-first; audit trail on control-plane actions  
- **Webhooks:** signature verification when `GITHUB_WEBHOOK_SECRET` set  
- **CORS:** explicit `CORS_ORIGINS` in production  

---

## YC / partner demo spine (GA story)

1. Problem: API breaks → consumers break silently  
2. `npm run demo` → PR with evidence  
3. Registry / graph blast radius  
4. Optional Gauge agent on fixture  
5. Open `/status` → **GA 1.0 operational**  
6. Ask: design partners / self-host pilots — **not** “finish Firecracker”

---

## Claim-safe language

See `docs/WARDEN_CLAIMS.md`. Preferred public line:

> Gauge is generally available for self-hosted and API-key multi-tenant control planes: review-first migration PRs from OpenAPI changes, graph-backed impact, and an on-demand API debug loop. Continuous multi-repo “unprompted” hunting and public leaderboard benchmarks remain design-partner track.
