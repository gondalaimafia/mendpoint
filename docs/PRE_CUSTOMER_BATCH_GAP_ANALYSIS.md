# Pre-customer batch gap analysis

**Source vision:** “Build everything with zero design-partner dependency” — change ingestion, scanning, patch engine, internal benchmark, core product surfaces, human-review gating — so the first partner conversation starts against a **working product**, not a pitch deck.

**Source of truth:** monorepo `C:\Users\Talal\dev\mendpoint` (Fettler / Mendpoint).  
**Related:** `docs/WARDEN_VISION_GAP_ANALYSIS.md`, `docs/WARDEN_CLAIMS.md`, `docs/superpowers/plans/2026-07-22-warden-p0-p1.md`.

**How to read scores:** 0 = absent · 1 = stub · 2 = toy/fixture · 3 = working MVP · 4 = partner-ready · 5 = batch-complete as written.

---

## Executive summary

| Batch component | Score | One-line verdict |
|-----------------|-------|------------------|
| Change-ingestion pipeline | **2.5** | OpenAPI poll + SDK probe solid; multi-source (AsyncAPI, changelog NLP, GH releases, 5–8 live flagships) incomplete |
| Codebase-scanning layer | **3.5** | Strong TS/Python (+ Go/Java/Ruby harnesses); graph-leaned; not yet “any public GitHub repo at scale” productized |
| Patch-generation engine | **3** | Generate patch + PR body + risk + verify/repair loops; not fully “run existing suite then PR” as one autonomous product path |
| Internal evaluation benchmark | **2** | Design-partner fixture eval ≥70%; **not** SWE-bench-style public-issue corpus with resolve/FP rates |
| Core product surfaces | **2** | GitHub PR/Checks-ish comments, severity, dashboards; **no Slack**; exposure report is partial (findings/metrics, not a named report product) |
| Human-review gating | **4.5** | Never auto-merge default is real and enforced in policy |
| **Batch overall** | **~3.0** | **More than a pitch deck; less than “batch complete.”** First design partner can be shown a **real loop on fixtures + mock/real GitHub**, not a blank slide — but several batch items still need a focused pre-customer sprint. |

**Bottom line:** The monorepo already front-loaded much of the “no customer required” work. Remaining pre-customer gaps are mostly **ingestion breadth**, **public-repo benchmark rigor**, **Slack + exposure report polish**, and **hardening flagship vendor feeds** — not greenfield architecture.

**Alignment with exclusions:** Multi-service/monorepo tracing, partner onboarding, SOC2/SSO/VPC, provider channel, cross-customer learning are correctly deferred; note **audit logging already exists** (exportable) despite the vision listing “audit logging” under enterprise-only — treat that exclusion as *compliance-grade* audit, not absence of any audit trail.

---

## 1. Change-ingestion pipeline

### Vision

Pull/parse for **5–8 flagship APIs** (Stripe, OpenAI, Twilio, Plaid, core AWS SDKs):

- OpenAPI / **AsyncAPI** diffs  
- Changelogs, deprecation notices  
- GitHub release notes  
- SDK version bumps  
Prioritize clean structured docs.

### Reality

| Capability | Status | Evidence |
|------------|--------|----------|
| OpenAPI version diff → surfaces | **4** | `@mendpoint/change-intel`, fixtures `acme-payments` v1→v2 |
| Continuous OpenAPI poll + content hash | **3** | `@mendpoint/catalog` poll, worker `poll`/`poll-once` |
| SDK version signals | **2–3** | `probeKnownSdks` |
| Vendor catalog entries | **3** | Stripe, OpenAI, AWS S3, Twilio, GitHub, Acme, etc. in `vendors.ts` |
| **Live** structured feeds for 5–8 flagships | **1–2** | URLs often env-optional; local `file:` fixtures dominate validation |
| AsyncAPI | **0** | Not present |
| Changelog / deprecation NLP | **1–2** | Changelog MD can attach; no robust RSS/releases→surfaces pipeline (P1 plan) |
| GitHub release notes ingestion | **0–1** | Not built as feed |
| Plaid as first-class tracked vendor | **0–1** | Not in core catalog focus |

**Score: 2.5**

### Gaps (pre-customer, still zero-dependency)

1. **Stable OpenAPI (or equivalent) sources** for Stripe, OpenAI, Twilio, Plaid, AWS — even if scraped/mirrored into `fixtures/providers/*` for offline accuracy tests.  
2. **Changelog/releases parser** + deprecation dates → surfaces (planned P1.1/P1.5).  
3. **AsyncAPI** only if messaging APIs are in the flagship set; otherwise explicitly drop from batch scope.  
4. Manual **spec-diff accuracy checklist** documented per vendor (vision validation method).

---

## 2. Codebase-scanning layer

### Vision

Static analysis on **arbitrary Python or TypeScript/Node** repos; find every usage of a tracked API; validate on **public GitHub** fixtures.

### Reality

| Capability | Status | Evidence |
|------------|--------|----------|
| TS/JS impact (import, path, field, SDK) | **4** | codebase-index + code-impact candidates/confirm |
| Python impact | **3–4** | harness ≥70% bar, fixtures |
| Call-graph / expand / e-graph assist | **3–4** | graph-native spine (beyond “simple grep”) |
| Go / Java / Ruby | **3** | harnesses + examples (batch text only required Py/TS — **ahead** here) |
| Lockfile / import auto-detect vendors | **3** | catalog detect |
| “Arbitrary public GitHub repo” one-click scan | **2** | Works with local path / App install; no polished “paste GitHub URL → clone → scan” product |
| Validation on many public OSS consumers | **2** | Mostly **owned fixtures**, not a large OSS corpus |

**Score: 3.5**

### Gaps

1. Scripted **OSS fixture pack**: 5–10 public repos (or shallow clones) with known Stripe/OpenAI call sites.  
2. Recall/precision report per language (TS, Python) on that pack.  
3. Optional: GitHub URL → temp clone → scan CLI for demos.

---

## 3. Patch-generation engine

### Vision

Change + call site → **code fix** → **run existing test suite** → **plain-language PR** + **risk score**. E2E on same public fixtures.

### Reality

| Capability | Status | Evidence |
|------------|--------|----------|
| Patch / multi-file edits from impact | **3** | `@mendpoint/generation` |
| Risk on change/PR | **3–4** | structural risk + severity tiers |
| Plain-language PR body | **3** | generation + brand packs |
| Run tests / verify loop | **3** | Fettler `verifyCommand`; repair loop; CI comment helpers |
| Always “customer’s existing suite” first-class | **2** | Needs configured verify/CI; not auto-discovered `npm test`/`pytest` everywhere |
| Adopt / new capability patches | **2–3** | adopt mode + examples |
| Fettler API-debug patches | **3.5** | trained failure modes, tool loop |

**Score: 3**

### Gaps

1. **Auto-detect verify command** from package.json / pytest / go test.  
2. Single pipeline flag: `patch → test → PR` with fail → repair/Fettler retry (budgeted).  
3. Measure resolve rate on internal benchmark (depends on §4).

---

## 4. Internal evaluation benchmark

### Vision

Proprietary **SWE-bench-style** corpus from **public GitHub issues / incidents** (API regressions); primary tool for **resolve rate** and **false-positive rate** before pilots.

### Reality

| Capability | Status | Evidence |
|------------|--------|----------|
| Design-partner fixture eval | **3** | `@mendpoint/eval` ≥70% overall on partner corpus |
| Language harnesses (recall bars) | **3–4** | phase-a TS/Python/Go/Java/Ruby |
| Public GitHub-issue derived cases | **1** | Not a real-issue corpus in-repo |
| Resolve rate (end-to-end unassisted) | **1–2** | Fettler fixture tests; no published suite of 20–50 issues |
| False-positive rate for impact | **1–2** | Confidence tiers exist; no formal FP metric on held-out set |
| Head-to-head vs general agents | **0** | Absent |

**Score: 2**

### Gaps (still no customer)

1. Build **`warden-bench` v0** (P1.6): 10–30 cases from public issues (redacted), goal text only, verify script, pass/fail.  
2. Metrics: resolve@1, files-touched precision, FP rate for candidate discovery.  
3. Keep results **internal** until methodology review (`WARDEN_CLAIMS.md`).

This is the **largest batch gap** relative to “working, benchmarked version of Fettler.”

---

## 5. Core product surfaces

### Vision

- Read-only **exposure report**  
- **Slack** + **GitHub Checks**  
- Per-API **risk-tiering** configuration  
Internally dogfoodable; point at a real repo when partner connects.

### Reality

| Surface | Status | Evidence |
|---------|--------|----------|
| Provider/consumer dashboards | **3** | Next.js apps: changes, PRs, feeds, graph, metrics |
| Impact findings / change detail | **3** | API + UI — acts as exposure **lite** |
| Named “exposure report” export (PDF/MD share pack) | **1–2** | Metrics + audit export; not a first-class exposure report product |
| GitHub PR delivery | **3–4** | Mock + Octokit + App path |
| GitHub Checks / PR comments | **2–3** | `checks.ts` comment/summary style — not full Checks API productization |
| Slack | **0** | Not implemented |
| Severity / risk tier (`required` / `recommended` / `optional`) | **3** | DB + pipeline + UI severity form |
| Notification-only mode | **3** | policy `notificationsOnly` |
| Graph explorer | **3** | `/graph` — bonus vs vision |

**Score: 2**

### Gaps

1. **Exposure report** generator: markdown/JSON “APIs you depend on + open risks + last change” for a consumer.  
2. **Slack** webhook: change detected / PR opened / needs review (generic; no customer required to build).  
3. Tighten **GitHub Check runs** (status API) vs comment-only.  
4. Per-API risk tier **UI** polish for flagship catalog.

---

## 6. Human-review gating

### Vision

Default HITL for every PR; **no auto-merge at this stage**; mature dependency-bot posture.

### Reality

| Capability | Status | Evidence |
|------------|--------|----------|
| `autoMergeLowRisk: false` default | **5** | `@mendpoint/policy` |
| Never-touch paths / auth dual-review labels | **4** | policy engine |
| PR copy / footers “human review” | **3–4** | branding / Fettler footers (P0.2 in progress) |
| Auto-merge code path exists but opt-in | **3** | flag present; not productized — consistent with “no auto-merge at this stage” if left off |

**Score: 4.5** — **batch requirement met.**

### Gaps

- Optional: hard-disable auto-merge compile-time / env `ALLOW_AUTO_MERGE=0` for demos so it cannot be flipped accidentally.

---

## 7. What the batch deliberately excludes — vs monorepo

| Excluded item | Batch rationale | Monorepo note |
|---------------|-----------------|---------------|
| Design-partner recruitment / onboarding | Needs live customer | Correctly out; `DESIGN_PARTNER_PATH` plan is FDE-side |
| Opportunity-capture tuned to customer stacks | Needs feedback | Adopt mode is generic, not stack-tuned |
| Multi-service / monorepo tracing | Batch defers | **Partial** graph impact exists; full multi-service PR orchestration still P1/P2 |
| SOC 2, VPC/self-host, SSO | Enterprise contracts | Stub tenants/plans only — aligned |
| Audit logging (as enterprise) | Deferred in vision | **SQLite audit + export already** — fine for pre-customer; not compliance-grade |
| Provider-channel partnerships | Needs customers | Brand packs scaffold only |
| Cross-customer fix-pattern learning | Needs acceptance data | Local `suppressed_patterns` only |

No conflict: exclusions remain valid; do not block batch completion on them.

---

## 8. Batch summary table (vision vs actual)

| Component | Dependency claimed | Validation claimed | **Actual maturity** | **Validation we can run today** |
|-----------|--------------------|--------------------|---------------------|----------------------------------|
| Change-ingestion | Public vendor docs | Manual spec-diff accuracy | **2.5** | Acme/fixture OpenAPI poll; limited live flagships |
| Codebase scanning | Public GitHub | Scan accuracy on fixtures | **3.5** | Owned fixtures + harness bars |
| Patch generation | Public GitHub | Benchmark resolve rate | **3** | Demo/examples/Fettler tests; resolve rate informal |
| Internal benchmark | Public GH history | Self-contained | **2** | Partner eval ≥70%; not issue-corpus bench |
| Exposure / Slack / Checks / risk tier | None | Dogfood | **2** | Risk tier + Checks-ish + dashboards; no Slack |
| Human-review gating | None | Built-in | **4.5** | Policy tests + defaults |

---

## 9. “Working product in minutes for first partner” — honesty check

| Claim | Fair? |
|-------|-------|
| Demo end-to-end on fixtures (diff → impact → PR candidate) | **Yes** — `npm run demo` halts fail-closed at delivery gates (no PR opened); examples, UI |
| Connect GitHub App / token → real PR on a chosen repo | **Mostly** — path exists; ops polish needed |
| Continuously watch 5–8 flagships with production-grade ingestion | **No** — not batch-complete |
| Quote resolve/FP rates from proprietary API-SWE-bench | **No** — not built |
| Slack-native review workflow | **No** |
| Pitch deck only | **No** — real software exists |

**Recommended external phrasing:**  
*“We have a working Fettler loop on fixtures and a real GitHub path; pre-customer batch completion means finishing flagship feeds, internal issue-bench, exposure/Slack surfaces, then design partners.”*

---

## 10. Pre-customer completion program (ordered)

Maps to remaining batch work **without** requiring a design partner.

### Batch-A (1–2 weeks) — “Demo-ready hard”

1. **Human-review freeze** — confirm auto-merge off in all demo envs (done/default).  
2. **Flagship fixture pack** — mirrored OpenAPI pairs for Stripe/OpenAI/Twilio/AWS (and Plaid if in scope) under `fixtures/providers/`.  
3. **Exposure report v0** — one markdown/JSON export per consumer: deps + open changes + findings count.  
4. **GitHub Check run** polish on PR path.

### Batch-B (2–4 weeks) — “Benchmarked”

5. **warden-bench v0** — ≥15 public-issue-derived cases; resolve + FP metrics.  
6. **Patch → test → PR** unified path with auto verify discovery.  
7. **Changelog/releases ingestion** for 2–3 clean vendors.

### Batch-C (parallel / stretch) — “Surfaces”

8. **Slack** notifications (webhook).  
9. **OSS scan pack** — N public repos scripted.  
10. Optional AsyncAPI only if Twilio/messaging messaging-spec is in scope.

**Do not put in this batch:** multi-tenant cloud, SSO, SOC2, partner onboarding UI, provider marketplace.

---

## 11. Scorecard snapshot

| Pillar | Score /5 |
|--------|----------|
| Change ingestion | 2.5 |
| Codebase scanning | 3.5 |
| Patch engine | 3.0 |
| Internal benchmark | 2.0 |
| Product surfaces | 2.0 |
| Human-review gating | 4.5 |
| **Pre-customer batch readiness** | **~3.0** |

---

## 12. Bottom line

- The original idea — **front-load zero-dependency engineering** — matches how this monorepo was built.  
- You are **past pitch-deck** and **into working MVP** for the core loop (scan → impact → patch → PR → human review).  
- You are **not yet “batch complete”** on: multi-source change ingestion for 5–8 live flagships, SWE-bench-style internal benchmark, Slack, and a crisp exposure-report product.  
- Completing **Batch-A + Batch-B** above is the honest definition of “first design-partner conversation against a working, benchmarked Fettler.”  
- The concurrent P0/P1 plan (`2026-07-22-warden-p0-p1.md`) overlaps heavily with Batch-B/C (changelog, bench, demos); use this document as the **batch gate**, that plan as the **task breakdown**.

---

## Related docs

- `docs/WARDEN_CLAIMS.md` — what we may say publicly  
- `docs/WARDEN_VISION_GAP_ANALYSIS.md` — Cognition-style intro gaps  
- `docs/superpowers/plans/2026-07-22-warden-p0-p1.md` — executable P0/P1 tasks  
- `docs/ARCHITECTURE.md` — system design  
