# Mendpoint — Investor one-pager

**Status:** Working product (open-source monorepo) · Design-partner ready track  
**Repo:** [github.com/gondalaimafia/mendpoint](https://github.com/gondalaimafia/mendpoint) · MIT  
**As of:** July 2026 · `main`

---

## The problem

Modern software is a mesh of **external APIs**. Breaking changes, silent field renames, and SDK drift ship constantly. Changelogs go unread; teams discover breakage in **production incidents**, not pull requests. General coding agents are not built to track vendor change signals, map blast radius through real call graphs, or ship **review-first** migration PRs at portfolio scale.

## The company

**Mendpoint** is an applied AI company for **legacy and integration code migration**—Cognition-style (reasoning + agentic systems + FDE delivery), focused on one underserved job: **keeping codebases correct as the APIs they depend on keep changing**.

**Warden** is the first product: an API integration teammate that turns structured API change into **impact analysis → reviewable PRs → optional agentic repair**, with human review by default.

## What we have shipped (evidence, not pitch)

### 1. End-to-end product loop (live software)

| Capability | Shipped |
|------------|---------|
| OpenAPI structural change → **impactable surfaces** | Yes — `@mendpoint/change-intel` |
| Hybrid **codebase index** + candidate discovery | Yes — not whole-repo LLM |
| **Call-graph** expand (wrappers, callers) + e-graph rewrite assist | Yes — graph-native spine |
| Migration **PR generation** (risk, evidence, multi-file) | Yes — migrate + adopt modes |
| GitHub delivery | **Mock + real Octokit** + **GitHub App** install/runtime path |
| Policy: **never auto-merge by default** | Yes — hard-gated unless explicit env |
| Audit trail + metrics + severity tiers | Yes — SQLite control plane, export |
| Dual dashboards (provider / consumer) + feeds + graph UI | Yes — Next.js + Hono API |
| Worker: feed poll, job queue | Yes |

**Demo in minutes:** `npm run demo` — Acme OpenAPI v1→v2 → shop-app scan → mock PR.

### 2. Graph engineering as the agentic system (not a chat toy)

We adopted **graph engineering** as the default: specialized **loop-nodes** with explicit routing and shared state—not one overloaded agent.

```
change intel → index → candidates → expand (fan-out) → confirm → generate → verify → human review
```

- Orchestrator topology: `@mendpoint/orchestrator` (`wardenProductGraph`)
- Domain graphs: call-graph, e-graph, product/API impact explorer (`/graph`)
- API: `GET /graph/agent` (inspectable control flow)

### 3. Warden — API debug agent (on-demand)

- Goal-driven tool loop: search / read / edit / run verify / optional HTTP probe  
- Trained failure modes: protocol, serialization, semantic, network, cascading errors, webhooks, rate limits  
- **Internal warden-bench: 5/5** fixture cases resolve end-to-end  
- UI `/agent` · `npm run agent:demo` · `npm run eval:warden`

### 4. Quality bars (internal, multi-language)

| Bar | Status |
|-----|--------|
| TS impact recall harness | ≥70% target (Phase A) |
| Python / Go / Java / Ruby harnesses | Shipped |
| Design-partner fixture eval | ≥70% overall on partner corpus |
| Concrete vendor examples | Stripe, OpenAI, AWS S3, fintech, adoption (+ Go/Java/Ruby) |
| Flagship offline OpenAPI packs | Stripe, OpenAI, Twilio, AWS S3, Plaid fixtures |

### 5. Pre-customer / trust surfaces

| Item | Status |
|------|--------|
| Exposure report per consumer | `GET /consumers/:id/exposure` |
| Changelog deprecation parser | Catalog package |
| Slack notify package | Optional webhook |
| Brand packs (provider-skinned agents) | Stripe / OpenAI / Acme-style |
| Notification-only mode | Policy |
| Design-partner path doc | `docs/DESIGN_PARTNER_PATH.md` |
| Claim-safe public language | `docs/WARDEN_CLAIMS.md` |

### 6. Open source & IP posture

- Full monorepo public (MIT) — reproducible demos for diligence  
- 20+ workspace packages; phases A–F + gap-closure + repair + Warden + orchestrator  
- Customer code not used to train foundation models without opt-in (product policy)

---

## Architecture in one glance

**Input:** OpenAPI versions, SDK signals, optional changelog text  
**Core:** Graph-leaned impact (index → candidates → expand → confirm)  
**Output:** Reviewable PR + findings + risk/severity  
**Agents:** Pipeline graph nodes + Warden/repair verify loops  
**Trust:** Human review gate · path denylist · audit · no auto-merge default  

---

## Traction stage (honest)

| Stage | Where we are |
|-------|----------------|
| Working product vs deck | **Past deck** — runnable E2E product |
| Design partners | **Path ready** — App/token + local path; not a public customer logo slide |
| Continuous multi-vendor watch at scale | **Partial** — OpenAPI poll + fixtures; full RSS/changelog fleet on roadmap |
| Public competitive API-SWE-bench | **Internal only** — warden-bench + partner eval; not marketed as leadership |
| Enterprise (SSO, SOC2, multi-SCM) | **Stub / deferred** |

---

## Why this is investable now

1. **Narrow wedge, huge pain** — API change → customer code is chronic and expanding with AI-driven API sprawl.  
2. **Differentiated system, not a wrapper** — graph impact + graph-engineered agents + policy/trust, vs generic coding chat.  
3. **Shipped depth** — multi-language harnesses, GitHub App path, agent + repair, open repo for diligence.  
4. **GTE / FDE model fits** — high-dependency stacks (fintech, AI infra, devtools) need white-glove first, then productize.  
5. **Neutral multi-vendor** — one platform watches many APIs; provider-branded packs as a later channel.

---

## Near-term use of capital (design-partner phase)

1. Live flagship feeds + 3–5 design partners (real App installs)  
2. Expand internal API-regression bench; publish methodology when ready  
3. Harden multi-service monorepo PR orchestration  
4. Cloud sandbox workers + production ops  
5. FDE capacity for onboarding high-API-density teams  

---

## Ask / contact

**Product:** Warden on Mendpoint  
**Artifact for diligence:** Clone the repo, run `npm install && npm test && npm run demo && npm run eval:warden`  
**Claims policy:** We sell only what the monorepo can show — see `docs/WARDEN_CLAIMS.md`

---

*One page. Evidence-backed. Human review required on every customer PR.*
