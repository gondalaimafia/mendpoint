# Y Combinator Application — Mendpoint / Warden

**Prepared for:** YC application form (standard questions)  
**Product:** **Warden** (first agentic product) on **Mendpoint** (platform)  
**Repo:** https://github.com/gondalaimafia/mendpoint  
**Status:** GA 1.0 (self-hosted + API-key multi-tenant control plane)  
**Date:** 2026-07-27  

> **How to use this doc:** Paste answers into apply.ycombinator.com. Replace `[BRACKETED]` placeholders (founders, traction numbers, batch). Keep claims aligned with `docs/WARDEN_CLAIMS.md` and `docs/PRODUCTION_GA.md`.

---

## Company

| Field | Answer |
|-------|--------|
| **Company name** | Mendpoint |
| **Describe what your company does in 50 characters or less** | API change → reviewable migration PRs |
| **Company URL** | https://github.com/gondalaimafia/mendpoint *(or product URL when live)* |
| **Demo video URL** | `[record 60–90s of npm run demo + PR body + /status]` |
| **Product / app URL** | Self-hosted GA; demo: repo + `npm run demo` |

---

## Founders

| Field | Answer |
|-------|--------|
| **Founders** | `[Name 1]` · `[Name 2 if any]` |
| **Who writes code / technical?** | `[Primary technical founder]` |
| **Who is the CEO?** | `[Name]` |
| **Equity split** | `[e.g. 50/50 or sole founder 100%]` |
| **Are you a full-time team?** | `[Yes / will be full-time on YC funding]` |
| **How long have you worked together?** | `[X months/years]` |
| **Where do you live?** | `[City, Country]` |
| **Will you relocate to SF / Bay Area for YC?** | `[Yes / Prefer remote with visits]` |

---

## Progress

### What is your company going to make?

**Warden** is an **API integration teammate**. When a provider ships a breaking (or high-value) API change, we:

1. Normalize the change from **OpenAPI** (and related signals)  
2. Run **graph-backed impact analysis** on connected consumer codebases (not whole-repo LLM dumps)  
3. Open a **reviewable migration PR** with risk, evidence, and confidence  
4. Optionally run **Warden**, an on-demand verify-backed debug loop for API/integration failures  

**Humans always review.** We never auto-merge customer code by default.

Platform layer **Mendpoint** is the graph + harness + control plane underneath (registry, contract gates, audit, learning substrate). First wedge is **API consumer migration**; longer-term platform supports a second line (**Transformer** — legacy migration campaigns), still scaffolded and **not** the YC wedge.

### Where do you live now, and where would the company be based after YC?

`[City now]`. After YC: `[SF Bay Area / remote-first with SF hub]`.

### Progress so far (most impressive thing)

We shipped **Warden / Mendpoint GA 1.0** as a working product, not a deck:

- End-to-end path: OpenAPI diff → hybrid call-graph impact → generated PR (mock or real GitHub)  
- Multi-language impact harnesses (TypeScript, Python, Go, Java, Ruby) with internal recall bars  
- Spec-first plans, contract/breaking-change gates, API design critic  
- Consumer registry (“who uses this provider?”)  
- On-demand Warden agent loop  
- Production packaging: auth required in prod, rate limits, `/ready` `/live` `/status`, Docker Compose, CI, `npm run ga:check`  
- Public monorepo: https://github.com/gondalaimafia/mendpoint  

Honest gap: **design-partner / revenue traction is still the next proof point** — the product path is real on fixtures and self-host; we are not claiming public SaaS ARR yet.

### How far along are you?

| Stage | Status |
|-------|--------|
| Idea | Done |
| Prototype | Done |
| Working product (GA self-host) | **Done (1.0.0)** |
| Design partners | `[0 / in conversation / signed]` |
| Paying customers | `[0 / $X]` |
| Revenue | `[pre-revenue / $X MRR]` |

### How long have each of you been working on this?

`[e.g. Founder A: N months full-time; built monorepo and GA ship.]`

### Tech stack

TypeScript monorepo (npm workspaces): Hono API, Next.js web, SQLite control plane, hybrid static analysis + optional LLM on **slices only**, GitHub delivery (mock/real), graph-learn property graph (SQLite; Kùzu escape hatch).

---

## Idea

### Why did you pick this idea?

Modern software is glued together by **vendor APIs**. Providers ship breaking changes constantly. Consumer teams find out in production or via frantic Slack. General coding agents optimize “write code from a prompt”; they do **not** maintain a durable model of *who consumes which surface* or produce **reviewable, evidence-backed migration PRs** as the default artifact.

We picked a **narrow, painful, recurring** workflow (API break → fix all consumers) where:

- The artifact is a **PR** (buyers already trust PRs)  
- Graph + static analysis can be **high-recall** before any LLM  
- Trust defaults (never auto-merge) match enterprise reality  
- Distribution can start via **providers** (help customers migrate) or **consumers** (FDE-assisted)  

### Why are you the right people?

`[Personalize — e.g. shipped integration-heavy products; felt API break pain; built graph + agent systems; domain in platform engineering / API platforms.]`

Technical depth is already visible in the open monorepo (graph engineering doctrine, multi-lang harnesses, production ops). We are not a thin wrapper around a single chat API.

### Who needs what you're making?

**Primary (wedge):** Engineering teams that **consume** third-party or internal HTTP APIs at scale (fintech, SaaS platforms, multi-service companies).

**Secondary:** **API providers** who want to ship breaking changes without stranding customers (migration kits as PRs into consumer repos, with permission).

**Economic buyer:** Eng manager / platform lead / API program owner.  
**User:** Staff/senior eng, FDE, integration team.

### How do you know they need it?

- API versioning and deprecations are a permanent industry tax (Stripe, AWS, OpenAI, internal platform APIs).  
- Status quo: grepping repos, tribal knowledge, delayed upgrades, production incidents.  
- Internal fixtures and multi-vendor example packs (Stripe pagination, OpenAI chat, S3 v3, fintech transfers, multi-lang) encode real change shapes we already handle offline.  
- `[Add: conversations with N teams / personal incident stories / LOIs]`

### How will you make money?

**Phase 1 — design partners:** paid pilot (monthly or project) for 1–2 consumers or one provider-led migration program.  
**Phase 2 — product:**  
- **Seat / org SaaS** (hosted control plane) + usage on repos / PRs  
- **Self-host enterprise** (license + support) for air-gapped / regulated  
- Optional **FDE / migration services** as high-touch wedge (not the long-term business, but accelerates learning)

Pricing sketch (not locked): mid-market ~$2–10k/mo; enterprise self-host higher + support.

### How much could this make a year? (market size)

**Bottom-up:** If 10k mid-market eng orgs pay ~$5k/yr average → **$50M** ARR; if 500 enterprises pay $100k/yr → **$50M**. Global software integration / API management adjacent markets are multi-billion; we take a **slice of API change / migration labor**, not all of iPaaS.

**Top-down honesty:** We do not need the whole “AI coding” market. We need to own **API-break → verified consumer PR**.

### How will customers find out about you?

1. **Open source + demos** (repo, `npm run demo`, transparent claims)  
2. **Provider partnerships** (“ship v2 with customer migration PRs”)  
3. **FDE / design-partner loops** with platform teams  
4. Content on API breakage, graph engineering, review-first agents  
5. YC network for first 10 design partners  

### Competitors / alternatives

| Alternative | Why we win / lose |
|-------------|-------------------|
| **Manual process** | Default; slow; misses call sites |
| **Generic coding agents** (Cursor, Devin-class, Claude Code) | Great at editing; weak durable consumer registry + change→PR product loop |
| **iPaaS / API gateways** | Manage traffic/contracts; don’t open PRs in customer app code |
| **Static tools alone** | Miss dynamic HTTP; no PR workflow / learning loop |
| **Consultancies / FDEs alone** | Don’t scale; we productize the playbook |

**Differentiation:** **Graph engineering** (specialized verify-backed nodes, not one mega-agent) + **PR as the product** + **never auto-merge by default**.

### What do you understand about your business that others don’t?

1. The unit of value is not “chat completions” — it’s a **mergeable PR with evidence**.  
2. **Whole-repo LLM** is the wrong architecture for impact; hybrid graph + slices wins on cost and trust.  
3. Enterprises buy **control and audit**, not maximum autonomy.  
4. Learning moat is **outcome edges** (which migrations merged vs broke), not model weights alone.  
5. Second product (legacy **Transformer**) can share the platform later; shipping both at once is how API-migration startups die.

---

## Equity / batch (form fields)

| Field | Answer |
|-------|--------|
| **Batch** | `[e.g. Winter 2027 / Summer 2026]` |
| **Legal entity** | `[Delaware C-Corp / forming]` |
| **Have you incorporated?** | `[Yes/No]` |
| **Previous funding** | `[None / angels $X]` |
| **How much money are you applying for?** | Standard YC deal (unless form asks otherwise) |
| **How long can you last at current burn?** | `[N months]` |
| **Are people going to school / other jobs?** | `[No / will leave]` |

---

## Optional: longer “explain your product” (if character limits allow)

Mendpoint is building **Cognition-style applied agents for software migration**, starting with **API consumers**.

**Today (GA 1.0):** Self-hostable control plane + web UI. Provider OpenAPI versions, consumer repos, impact pipeline, PR delivery, Warden agent, registry, gates, audit, production probes. Open source: https://github.com/gondalaimafia/mendpoint  

**Demo (offline):**

```bash
git clone https://github.com/gondalaimafia/mendpoint.git
cd mendpoint && npm install && npm run db:seed
npm run ga:check   # GA preflight
npm run demo       # Acme OpenAPI break → shop-app PR
npm run agent:demo # Warden debug loop
```

**Not claiming yet:** public multi-tenant SaaS ARR, Firecracker isolation as default, full legacy mainframe Transformer, leaderboard vs general agents.

---

## Suggested application “elevator” (paste into short boxes)

### Company description (≤50 chars)

`API breaks → reviewable migration PRs`

### Please describe your company in 1–2 sentences

Warden (by Mendpoint) turns API provider changes into **reviewable migration PRs** using graph-backed impact analysis and a verify-first agent loop. We never auto-merge customer code by default.

### What is your product? (short)

OpenAPI-aware change intelligence + hybrid call-graph impact + PR generation + on-demand API debug (Warden). Self-hosted GA 1.0 live in open monorepo.

---

## Attachments / links checklist

- [x] GitHub: https://github.com/gondalaimafia/mendpoint  
- [ ] 1-minute demo video (record `demo` + PR + `/status`)  
- [ ] Founder LinkedIns / X  
- [ ] Any LOI / design-partner email (if exists)  
- [ ] Optional: investor one-pager PDF if already generated  

---

## Internal notes (do **not** paste into YC form)

- Lead with **Warden wedge**, not “platform package dump.”  
- GA = self-host + API keys + production ops — say it clearly.  
- If asked about traction and you have none: *product + open execution + design-partner plan*; do not invent logos.  
- Transformer / GNN / Firecracker = roadmap, not application thesis.  
- Update this file when traction lands.
