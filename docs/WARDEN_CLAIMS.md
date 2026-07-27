# Warden — claim-safe public language

**Product:** **Warden** (Mendpoint’s API integration teammate)  
**Purpose:** Keep public narrative, demos, and design-partner copy aligned with what the monorepo actually ships.  
**Source of truth for gaps:** [`docs/WARDEN_VISION_GAP_ANALYSIS.md`](./WARDEN_VISION_GAP_ANALYSIS.md)  
**Plan:** [`docs/superpowers/plans/2026-07-22-warden-p0-p1.md`](./superpowers/plans/2026-07-22-warden-p0-p1.md)

Use this file when writing README blurbs, launch copy, sales one-pagers, or PR footers. Prefer the **safer accurate language** column over intro-style absolute claims.

---

## We claim today (evidence-backed)

| Claim | What exists in the monorepo |
|-------|-----------------------------|
| **Graph-leaned impact analysis** | Hybrid call-graph + candidate discovery + confirmation → impact report (`@mendpoint/call-graph`, `@mendpoint/code-impact`) |
| **OpenAPI feed poll** | Worker/API poll of versioned OpenAPI (and SDK signals) — not full changelog RSS intelligence |
| **Migration PRs (review-first)** | Generated migration / adopt PRs via mock or real GitHub; customers review and merge |
| **Warden on-demand tool loop** | Goal-driven API debug agent (`@mendpoint/agent`, `/agent`) with bounded multi-step tools |
| **Spec-first plan-of-record** | OpenAPI diff → JSON plan steps (`POST /warden/plans/from-spec`) |
| **Contract gates + API critic** | `@mendpoint/contract` (breaking-change, suite, design review) |
| **Consumer registry** | Who monitors a provider (`GET /registry/providers/:slug/consumers`) |
| **Transformer scaffold** | BSG + DAG campaign types (`@mendpoint/transformer`) — not full migration engine yet |
| **Never auto-merge by default** | Policy defaults to human review; no auto-merge without explicit experimental policy |

---

## We do not claim yet

| Non-claim | Why not yet |
|-----------|-------------|
| Continuous **changelog RSS forever** | OpenAPI poll + SDK probe exist; no production RSS/changelog reasoning loop |
| **Unprompted silent-drift hunting** | Warden needs a goal (and path); not a background unsolicited bug hunter |
| **Quantified $ savings as audited accounting** | Adopt mode can surface new capabilities; cost models are planned/rough, not audited |
| **Published warden-bench leadership vs general agents** | Internal fixture / design-partner eval only; public API-bench forthcoming |
| **Full multi-tenant API history moat** | Local versioned OpenAPI diffs + change history for tracked providers — not a longitudinal multi-tenant moat |

---

## Preferred rewrite (safer accurate language)

| Intro language | Safer accurate language |
|----------------|-------------------------|
| “thousands of decisions…” | multi-step tool loop + hybrid graph impact |
| “full history of API” | versioned OpenAPI diffs + local change history |
| “monitors changelog RSS indefinitely” | polls OpenAPI feeds and SDK signals; changelog on roadmap |
| “quantified savings” | optional adoption PRs (cost estimates planned/rough) |
| “without being asked” | when change detected or Warden run requested |
| “ahead of general-purpose agents on benchmark” | internal fixture eval; public bench forthcoming |
| “auto-merge per risk tier” | human review default; optional low-risk auto-merge experimental |

Expanded forms (same meaning, for long-form copy) live in [`docs/WARDEN_VISION_GAP_ANALYSIS.md`](./WARDEN_VISION_GAP_ANALYSIS.md) §8.

---

## Suggested public one-liner

**Warden** is Mendpoint’s API integration teammate: **graph engineering** (specialized verify-backed nodes, not one mega-agent), reviewable migration PRs, and an on-demand API debug loop-node. Continuous multi-repo watch and public benchmarks are on the design-partner track. Never auto-merges by default.

---

## GA 1.0 public language

**Generally available** for **self-hosted** and **API-key multi-tenant control planes**:

- OpenAPI change → graph impact → **review-first** migration PR  
- Consumer registry + contract gates + Warden debug loop  
- Production probes (`/ready`, `/live`), rate limits, auth required in `NODE_ENV=production`  

**Do not say “GA” for:** Transformer full migration product, Firecracker isolation, GNN training, unprompted multi-repo hunting, or public benchmark leadership.

Full runbook: [`docs/PRODUCTION_GA.md`](./PRODUCTION_GA.md).
