# Fettler vision gap analysis

**Source vision:** Mendpoint “Introducing Fettler” product narrative (Cognition/Devin-style launch structure).  
**Source of truth:** monorepo at `C:\Users\Talal\dev\mendpoint` (OSS: `gondalaimafia/mendpoint`, as of gap review).  
**Date:** 2026-07-22  

**How to read scores:** 0 = absent · 1 = stub/doc · 2 = toy/fixture · 3 = working MVP · 4 = design-partner ready · 5 = GA claim-safe.

---

## Executive summary

The intro sells **Fettler** as a continuously watching, long-horizon integration engineer that:

1. monitors vendor signals (changelogs, specs, deprecations),
2. finds impact across multi-service codebases,
3. opens reviewable PRs (migrate + adopt),
4. self-corrects when tests fail,
5. learns from feedback,
6. beats general agents on an API-scoped SWE-bench-like benchmark.

**What the repo actually is today:** a strong **Mendpoint platform scaffold** (change → graph impact → migration PR → policy → optional repair) **plus** a **Fettler agent** that is a **bounded, goal-driven API debug tool-loop** with a rich failure-mode catalog — mostly on **local paths/fixtures**, not a continuous multi-tenant cloud teammate.

| Layer | Vision claim | Maturity | Verdict |
|-------|--------------|----------|---------|
| Branding / positioning | Cognition-style teammate for API sync | 3 | Narrative ready; product surface partially renamed |
| Continuous vendor watch | Changelog RSS + OpenAPI forever | 2 | OpenAPI poll + SDK probe; not real changelog RSS intelligence |
| Graph impact / multi-file | Trace change across sprawling monorepo | 3–4 | Hybrid call-graph + impact pipeline real on fixtures |
| Migration PRs | Open PRs before deprecation window | 3 | Mock + real Octokit path; not continuous production fleet |
| Feature adoption / savings | “Cheaper batch endpoint + $ estimate” | 2 | `adopt` mode + example fixture; no cost model |
| Autonomous bug find | Silent drift, repro, fix unprompted | 2 | Fettler needs goal/error/verify; not background hunter |
| Self-correct on CI | Patch fails tests → iterate | 2–3 | Repair loop + Fettler verify; limited CI integration |
| Learning history | Full API evolution + accepted fix patterns | 2 | Suppressed patterns from closed PRs; no multi-vendor longitudinal store |
| Sandbox + VCS | Shell/editor/tests in sandboxed compute | 2–3 | Local sandbox tools; no cloud isolation fleet |
| SWE-bench-style eval | Real issues, unassisted, published | 2 | Design-partner fixture eval; not public API-SWE-bench |
| Trust model | Human review default; selective auto-merge | 4 | Never auto-merge default; policy flag exists |
| Neutral multi-vendor | One agent, all deps | 3 | Catalog multi-vendor; live scale unproven |
| Enterprise / FDE ops | Waitlist, design partners, capacity | 1 | Product/ops outside monorepo |

**Overall readiness to ship the intro as-is:** **not claim-safe**.  
**Overall readiness as design-partner narrative with caveats:** **plausible** if language is tightened to “scaffolded platform + Fettler agent on partner repos” rather than continuous unprompted production teammate.

---

## 1. Product framing: who is “Fettler”?

| Vision | Codebase reality | Gap |
|--------|------------------|-----|
| Fettler is *the* product teammate | **Mendpoint** = monorepo/platform; **Fettler** = `@mendpoint/agent` (`runWarden`) + UI `/agent` | Split identity: pipeline/PR path is not branded as Fettler end-to-end |
| Same category as Devin (long-horizon) | Fettler default **max ~20–24 steps**, heuristic + optional LLM tool suggest | Not thousands of decisions; no persistent multi-hour sessions |
| Watches *or* independently fixes | Pipeline = reactive on version/change; Fettler = on-demand run | No unified “always on Fettler” daemon per customer |

**Gap (P0 narrative):** Unify product language so **pipeline + repair + agent** are one **Fettler** experience (or explicitly “Mendpoint platform / Fettler agent” and don’t claim they are one loop).

---

## 2. Capability-by-capability (sample claims)

### 2.1 Detect a breaking change before production (changelog → every usage → PR)

| Piece | Status | Evidence |
|-------|--------|----------|
| Detect structural API change | **3–4** | `@mendpoint/change-intel` OpenAPI diff → surfaces |
| Changelog *text* / deprecation notice NLP | **1–2** | Changelog MD attached sometimes; **no RSS parser**, no “read Stripe deprecation prose → field list” |
| Find every usage | **3–4** | Hybrid impact (index + candidates + call-graph expand + confirm) |
| Open PR before window closes | **2–3** | PR generation + GitHub mock/real; **no deprecation calendar / deadline tracker** |

**Gap:** Changelog intelligence, deprecation windows, continuous multi-repo fanout with SLA.

### 2.2 Surface valuable new feature nobody noticed (+ savings estimate)

| Piece | Status | Evidence |
|-------|--------|----------|
| New capability surfaces | **3** | `new_capability` / `adopt` mode in pipeline + example `05-stripe-feature-adoption` |
| Quantified savings | **0–1** | No cost model, token pricing, or $ estimate in PR body |
| Proactive “nobody noticed” discovery | **1** | Needs pipeline run / feed poll; not ambient recommendation engine |

**Gap:** Feature adoption ranking + economic justification (cost, latency, reliability).

### 2.3 Autonomously find and fix silent API drift bugs

| Piece | Status | Evidence |
|-------|--------|----------|
| Silent field type change → bug | **2** | OpenAPI type/rename surfaces if in versioned specs; not runtime traffic drift |
| Reproduce bug | **2** | Fettler runs `verifyCommand` if provided; does not invent repros |
| Fix without being asked | **1** | Fettler requires **goal** (+ path); no unsolicited bug hunting job |

**Gap:** Runtime/contract shadow testing, anomaly detection, unsolicited issue → Fettler sessions.

### 2.4 Trace one API change across multi-service monorepo → coordinated PRs

| Piece | Status | Evidence |
|-------|--------|----------|
| Multi-file impact in one repo | **3–4** | Code-impact + generation multi-file |
| Multi-service monorepo | **2–3** | Repo-root scan; weak service boundary model |
| Coordinated **set** of PRs | **1–2** | Fanout jobs per consumer/provider; not “one change → N service PRs with epic” |

**Gap:** Service graph, monorepo package ownership, PR bundling/orchestration UX.

### 2.5 Read vendor changelog continuously (RSS)

| Piece | Status | Evidence |
|-------|--------|----------|
| Continuous OpenAPI poll | **3** | `catalog` poll, worker `poll`, content-hash versions |
| SDK version signals | **2–3** | `probeKnownSdks` |
| Changelog RSS → relevance → action | **1** | URL fields exist; **no RSS/HTML changelog reasoning loop** |

**Gap:** Real changelog/RSS/GitHub releases ingestion + relevance filter against monitored surfaces.

### 2.6 Contribute fixes to real mature production repositories

| Piece | Status | Evidence |
|-------|--------|----------|
| Real GitHub PR path | **3** | Octokit + App runtime JWT/install |
| Phase A sandbox ship | **3** | `phase-a` harness + ship script |
| Unassisted on arbitrary prod repo | **2** | Works with local path / App install; not proven at scale |

**Gap:** Design-partner installs, permissions, multi-repo fleet, observability.

### 2.7 Self-correct when generated patch fails tests

| Piece | Status | Evidence |
|-------|--------|----------|
| Agentic repair | **3** | `@mendpoint/repair` diagnose→plan→apply→verify |
| Fettler verify loop | **3** | Tool loop until verify passes |
| Full CI (GitHub Checks) close the loop | **2** | CI comment/check helpers; not full “fail → re-run Fettler on PR” product |

**Gap:** PR-scoped CI failure → automatic Fettler re-attempt with budget.

### 2.8 Tools of a senior integration engineer

| Tool | Vision | Reality |
|------|--------|---------|
| Shell | Yes | `run_command` with denylist |
| Editor | Yes | read/search/replace/write sandboxed to repo root |
| Test runner | Yes | via shell + verify command |
| API-spec diffing | Yes | change-intel OpenAPI (pipeline); **not inside Fettler tool loop as first-class tool** |
| Sandboxed compute | Cloud isolation | **Local process**; no Firecracker/gVisor fleet |
| Connected VCS | Continuous | Mock + App; not always-on |

**Gap:** Spec-diff tool inside Fettler; true sandbox; VCS-native session UX.

### 2.9 Collaborate with engineers (report, why, feedback)

| Piece | Status | Evidence |
|-------|--------|----------|
| Report what/why/changed | **3** | PR body + Fettler markdown report + audit |
| Accept feedback before merge | **3** | PR feedback API, suppressed patterns learning |
| Conversational adjust fix | **1–2** | No chat-revise-PR loop; re-run with new goal |

**Gap:** Interactive “revise this PR” agent thread on the PR.

---

## 3. Performance / benchmark claims

Vision: SWE-bench-style **API regression** corpus; Fettler resolves meaningful share **unassisted**; ahead of general agents; **publish technical report**.

| Claim element | Reality | Score |
|---------------|---------|-------|
| API-scoped benchmark | Design-partner cases in `@mendpoint/eval` (fixtures) | 2 |
| Real GitHub issues / production incidents corpus | Not in repo | 1 |
| Unassisted (no file hints) | Harness has expected sites for scoring impact; Fettler fixture is guided by goal text | 2 |
| Head-to-head vs general agents | Not implemented | 0 |
| Published methodology | Planned language only | 0 |

**Gap (P0 for launch honesty):** Either (a) build `warden-bench` and report numbers, or (b) remove/soften performance section until data exists.

---

## 4. Platform / data moat claims

Vision: **compounding proprietary data** — history of every tracked API change + how codebases resolved them; **model-agnostic routing**.

| Asset | Reality | Score |
|-------|---------|-------|
| Structured change history | SQLite versions/changes/findings/PRs per install | 2–3 |
| Multi-tenant longitudinal vendor graph | Local SQLite; no global Mendpoint cloud graph | 1 |
| Accepted fix pattern library | `suppressed_patterns` + brand packs; not rich playbook memory | 2 |
| Model routing | Env flags for LLM confirm / LLM agent; no router product | 1–2 |

**Gap:** Cloud control plane + anonymized resolution memory across design partners (the actual moat).

---

## 5. Trust, hire, and GTM claims

| Claim | Reality | Score |
|-------|---------|-------|
| Human review before merge | Default; policy `autoMergeLowRisk=false` | **4–5** |
| Selective auto-merge per API/risk | Flag exists; not productized per-dependency UI | 2 |
| Design-partner waitlist / capacity | Outside monorepo | 0–1 |
| Neutral multi-vendor (not one agent per vendor) | Catalog + brand packs support both narratives | 3 |
| Provider-side distribution later | Brand packs scaffold | 2 |

**Aligned:** Never-auto-merge-first is **implementation-true** and should stay front-and-center.

---

## 6. Architecture map: vision loops vs code

```
VISION                              CODE TODAY
─────────────────                   ────────────────────────────
Changelog RSS ──┐                   
OpenAPI ────────┼─► continuous      OpenAPI poll + SDK probe
SDK release ────┘   watch           (changelog RSS missing)
        │
        ▼
Impact across services              change-intel → code-impact → graphs
        │
        ▼
Migrate PR + Adopt PR + $           generation + adopt mode; no $
        │
        ▼
CI fail → self-heal                 repair + Warden (partial CI)
        │
        ▼
Learn accepted patterns             suppressed_patterns (thin)
        │
        ▼
Unprompted drift bugs               MISSING (Warden is on-demand)
```

**Naming gap:** Intro uses **Fettler** for the whole loop; code still says **pipeline / repair / agent**. Product should either rebrand the loop as Fettler or rewrite intro to three products under Mendpoint.

---

## 7. Priority gap-closure program (recommended)

### P0 — Claim safety (before public “Introducing Fettler”)

1. **Rewrite performance section** until `warden-bench` exists; ship internal numbers only.  
2. **Unify brand:** UI + PR footers + docs: “Opened by Fettler” for pipeline + agent.  
3. **Explicit non-claims:** no unprompted production hunting; no full RSS; no $ savings yet.  
4. **One design-partner path:** App install → monitor → feed poll → PR on *their* repo, end-to-end recorded.

### P1 — Make the six demos true

| Demo | Build |
|------|--------|
| Breaking before prod | Changelog/release notes → surfaces + deprecation deadline field |
| New feature + savings | Adopt scoring + simple cost heuristic in PR |
| Silent drift | Contract test / response schema probe job → Fettler session |
| Multi-service coordinated PRs | Service ownership map + multi-PR grouping |
| Continuous changelog | RSS/GitHub Releases poller + relevance classifier |
| Real repo fixes | Partner eval pack (5–10 real issues) with redacted logs |

### P2 — Teammate depth

- PR conversation “revise”  
- CI fail → auto Fettler re-run (budgeted)  
- Longitudinal API history UI  
- Cloud sandbox workers  

### P3 — Moat / scale

- Cross-customer anonymized resolution memory  
- Model router  
- Provider distribution channel  

---

## 8. Claim rewrite guide (safe language)

| Intro language | Safer accurate language |
|----------------|-------------------------|
| “thousands of decisions across an entire codebase” | “multi-step tool loop + hybrid graph impact across the connected repo” |
| “recalls the full history of how a given API has evolved” | “uses versioned OpenAPI diffs and local change history for tracked providers” |
| “monitors changelog RSS indefinitely” | “polls OpenAPI feeds and SDK version signals; changelog monitoring on roadmap” |
| “opens a PR with quantified savings” | “can open optional adoption PRs for new capabilities (cost estimates planned)” |
| “without being asked” | “when a change is detected or a Fettler run is requested” |
| “meaningfully ahead of general-purpose agents on … benchmark” | “internal fixture eval for API migrations; public API-bench forthcoming” |
| “auto-merge … per risk tier” | “defaults to human review; optional low-risk auto-merge policy (experimental)” |

---

## 9. Scorecard snapshot

| Vision pillar | Score (0–5) |
|---------------|-------------|
| Continuous watch | 2 |
| Change intelligence (OpenAPI) | 4 |
| Graph impact | 3.5 |
| Migration PR delivery | 3 |
| Feature adoption | 2 |
| Fettler debug agent (API bugs) | 3.5 |
| Self-heal / CI loop | 2.5 |
| Learning / data moat | 2 |
| Sandbox cloud | 1.5 |
| Benchmark / public eval | 1.5 |
| Trust (no auto-merge) | 4.5 |
| Neutral multi-vendor | 3 |
| Enterprise GTM/ops | 1 |
| **Weighted product readiness** | **~2.7 / 5** |

---

## 10. Bottom line

- **Do not** publish the Cognition-style intro **unedited** — several claims (RSS forever, unprompted silent-drift hunting, SWE-bench leadership, $ savings, full API history moat) **over-claim** the monorepo.  
- **Do** position honestly: *Mendpoint is building Fettler — a graph-leaned, human-reviewed integration teammate. Today: OpenAPI-driven impact → PR, plus on-demand Fettler agent trained on API communication failures. Design partners next for continuous multi-repo watch.*  
- **Closest-to-true differentiators already in code:** hybrid **graph** impact, **never auto-merge** policy, multi-language fixtures, **Fettler** failure-mode training, GitHub App path, adopt vs migrate modes.  
- **Largest gaps vs the intro:** continuous changelog intelligence, unsolicited autonomy, multi-service PR coordination, published eval, cloud sandbox + data moat, GTM waitlist.

---

## Related docs

- `docs/WARDEN_CLAIMS.md` — claim-safe public language
- `docs/superpowers/plans/2026-07-22-warden-p0-p1.md` — P0/P1 plan
- `docs/GAP_ANALYSIS.md` — earlier platform gap vs provider-agent vision  
- `docs/WARDEN_TRAINING.md` — API communication failure training  
- `docs/API_BUG_AGENT.md` — Fettler agent loop  
- `docs/AGENTIC_REPAIR.md` — batch repair  
- `docs/ARCHITECTURE.md` — system design  
