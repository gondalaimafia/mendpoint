# Fettler — the first AI API Engineer: investor sizzle reel script

The reel is a self-contained, offline HTML file (`demo/fettler-reel.html`) the
founders screen-record. It is built on the console design system (navy ground,
single indigo accent) and walks one illustrative payments scenario end to end: a
provider breaking change, the Change Graph into the codebase, a narrow draft PR,
the four-question review record, and the Regauge migration-recipes surface.

- **Product names:** **Fettler — the first AI API Engineer** and **Regauge — the first AI Legacy Engineer**.
- **Stage:** fixed 1920x1080 (16:9), scaled to the viewport.
- **Runtime:** auto-advances with a top progress bar + `NN / 07` scene counter.
  Controls: `Space` pause/resume, `R` restart, `←`/`→` scene nav, `C` captions
  toggle, `F` fullscreen, `▶ Replay` at the end.
- **Reduced motion:** `prefers-reduced-motion` collapses fade-up entrances,
  typing, edge-draw, and promote into plain crossfades; every scene still reads.
- **Honesty rails (persistent on-screen):**
  - An **"Illustrative scenario"** pill is fixed top-left on every data scene (2–6).
  - Every pull request is a **draft requiring human review**; nothing is
    auto-merged. Fettler never merges.
  - No live customer, no fabricated customer name, no invented metrics.
  - Regauge is shown as production-capable code with a dedicated runtime
    profile. The reel uses illustrative repository names and labels live
    deployment and repository-connection status as unverified.
- **Illustrative data (used verbatim throughout):** provider **Payments API**,
  `POST /v1/charges`; breaking change **request field `source` → `payment_method`**
  (charges v1 → v2). Illustrative repo **`seed/payments-service`**. Five dependents:
  `src/clients/payments-client.ts` (client wrapper), `src/services/charge-service.ts`
  and `src/services/refund-service.ts` (two services), `tests/fixtures/charges.json`
  (test fixtures), `src/jobs/settlement-reconciler.ts` (background job).

## Timing arithmetic

Per-scene durations (seconds):

```
Scene 1  10   0:00 – 0:10
Scene 2  17   0:10 – 0:27
Scene 3  22   0:27 – 0:49
Scene 4  21   0:49 – 1:10
Scene 5  21   1:10 – 1:31
Scene 6  20   1:31 – 1:51
Scene 7   9   1:51 – 2:00
```

**10 + 17 + 22 + 21 + 21 + 20 + 9 = 120 seconds (2:00).** Within the 100–135s
target. The `DURATIONS` array in `fettler-reel.html` is `[10000, 17000, 22000,
21000, 21000, 20000, 9000]` ms and sums to `120000`.

Scenes 1–5 use the founders' application timings as a reference
(0:10, 0:28; 0:52 ≈ 0:53; 1:14 ≈ 1:18; 1:36 ≈ 1:42). The application's single
closing beat (Talal, 1:42–1:58) is expanded into a full Regauge product scene
(Scene 6) plus the brand close (Scene 7); Talal's two closing sentences are split
across those two scenes, verbatim.

---

## Scene 1 — The break (0:00 – 0:10) · 10s · **Talal**

- **Framing:** dark hero, brand mark, `FETTLER` eyebrow.
- **On screen:** headline "A provider ships a breaking change in seconds."; sub
  "Its customer spends days finding what it touches — and proving the migration
  is safe."; one mono spec row that types in: `~ POST /v1/charges`
  `source → payment_method` (amber sign, red→emerald tokens).
- **Voiceover (Talal, verbatim):** "This is Fettler. A provider can publish a
  breaking change in seconds. Its customer may spend days discovering what the
  change touches and proving the migration is safe."
- **Caption:** "A provider ships a breaking change in seconds." (headline) — the
  full VO is spoken, not captioned, to keep the hero clean.

## Scene 2 — Spec change ingested · /changes (0:10 – 0:27) · 17s · **Ijlal**

- **Route:** `/changes` inside the real AppShell (244px rail + 64px topbar). Rail
  group **Fettler** active on **Breaking changes**. Topbar: search
  `seed/payments-service`, a **"Spec ingested"** pill, the single indigo
  **Analyze change** CTA.
- **On screen:** `FETTLER · BREAKING CHANGES` eyebrow; title "Payments API · spec
  update ingested"; sub "Provider OpenAPI spec · charges v1 → v2". Four-stat grid —
  **Classification: Breaking** (amber), **Operation: POST /v1/charges**, **Field
  renamed: 1**, **Repository: seed · 1**. Then a **Spec diff** panel titled
  "recorded operation and field" with a `1 BREAKING` badge: row 1 `BREAKING`
  `POST /v1/charges` · request field `source → payment_method` · "renamed ·
  required"; row 2 `RECORDED` "operation + field" · "exact change captured for the
  migration record" · `charges.v2`.
- **Voiceover (Ijlal):** "In this illustrative payments scenario, the
  provider has replaced the source field with payment method. Fettler ingests the
  specification change, classifies it as breaking, and records the exact operation
  and field that changed."
- **Caption:** "Fettler ingests the spec change, classifies it breaking, and
  records the exact operation and field."

## Scene 3 — Change Graph (0:27 – 0:49) · 22s · **Ijlal**

- **Route:** `/graph` (Fettler group active on **Change graph**). Topbar: **5
  dependents** pill; **Draft the migration** CTA.
- **On screen:** `FETTLER · CHANGE GRAPH` eyebrow; title "The path from the
  changed field to every file it touches". A legible dependency graph: root node
  **Provider change · POST /v1/charges · `source → payment_method`** → hub node
  **Client wrapper · `src/clients/payments-client.ts` · request + response model**
  → four dependents: **Service `charge-service.ts`**, **Service
  `refund-service.ts`**, **Test fixtures `charges.json`**, **Background job
  `settlement-reconciler.ts`**. Edges are labelled with the reason each file is
  relevant ("defines request field", "calls create()", "calls refund()", "fixture
  shape", "reads response field"). A **path inspector** strip reads the selected
  path end to end: "source → payments-client.ts (request model) →
  settlement-reconciler.ts (reads charge.source at runtime)".
- **Motion:** edges draw in; nodes fade-up-stagger; the background-job node and
  its path are highlighted so the multi-hop path is unmistakable.
- **Voiceover (Ijlal, verbatim):** "Fettler then follows the Change Graph into
  this codebase. It finds the client wrapper, two services, the test fixtures, and
  a background job that still depends on the old field. The engineer can inspect
  the path that made every file relevant."
- **Caption:** "The Change Graph shows the path that makes every affected file
  relevant."

## Scene 4 — Draft PR · /prs/[id] (0:49 – 1:10) · 21s · **Ijlal**

- **Route:** `/prs/1`. Topbar: **Draft · human review required** pill; **Open on
  GitHub** (outline). No merge CTA here.
- **On screen:** back link "All pull requests"; eyebrow `seed/payments-service` +
  `draft` pill; title **"Rename source to payment_method #1"**; a `narrow
  migration` badge. Amber breaking-change alert: "Breaking change · POST
  /v1/charges — the request field `source` was renamed to `payment_method`.
  Fettler updated the request model, both call sites, and the fixtures. It did not
  touch anything the change did not require." Body is a two-column grid: three
  stacked diffs on the left — `payments-client.ts` (request model), `charge-service.ts`
  (call site), `charges.json` (fixtures), each `+1/−1` — and on the right a
  **SCOPE** panel ("Changed: 4 files — request model, 2 call sites, test
  fixtures"; "Not touched: background job flagged for review, not rewritten";
  "Unrelated: no refactors, no version bumps, no formatting") plus an **AUTHORED
  BY Fettler** card ("Draft by default. Merging is always a human action — Fettler
  never merges.").
- **Voiceover (Ijlal, verbatim):** "From that scope, Fettler opens the draft pull
  request. It updates the request model, the affected call sites, and the tests.
  The change is deliberately narrow. Fettler does not search for unrelated
  improvements."
- **Caption:** "Fettler opens a draft PR — deliberately narrow, with no unrelated
  changes."

## Scene 5 — Evidence record (1:10 – 1:31) · 21s · **Ijlal**

- **Route:** the PR review panel. Topbar: **Draft · human review required** pill;
  indigo **Approve & merge** CTA (a human action, not Fettler's).
- **On screen:** `FETTLER · REVIEW RECORD` eyebrow; title "Every PR answers four
  questions"; a "The engineer decides whether to merge" pill. A 2×2 evidence grid:
  1. **What changed?** — provider operation `POST /v1/charges`, request field
     `source` → `payment_method`, classified breaking from the OpenAPI spec.
  2. **Where does it matter?** — the five dependents (client wrapper, both call
     sites, fixtures, background job) with roles; Owner: `payments-team`.
  3. **What did Fettler alter?** — the smallest justified migration: request model,
     both call sites, fixtures — 4 files. No unrelated edits, no version bumps, no
     reformatting.
  4. **What must be verified?** — contract check vs charges v2 (required),
     repository test suite (required), policy: draft only / no auto-merge, and an
     amber **human-judgment** line: the background job reads `charge.source` at
     runtime (flagged, not rewritten).
- **Voiceover (Ijlal):** "The review panel shows the provider change,
  the dependency path, the checks required, and the assumptions that still need
  human judgment. Fettler proposes the migration and records what must be verified. The
  engineer decides whether to merge."
- **Caption:** "The record: what changed, where it matters, what Fettler altered,
  and what it verified."

## Scene 6 — Regauge · migration recipes (1:31 – 1:51) · 20s · **Talal**

- **Route:** `/regauge` (Regauge group active on **Migration recipes**, meta
  `staging`). Topbar: search `seed/* (illustrative repositories)`; an amber **status ·
  "Live status not verified"** pill; a **Review draft PRs** outline button (no live
  merge action).
- **On screen:** `REGAUGE · MIGRATION RECIPES` eyebrow; title "The same graph and
  verification layer, pointed inward at legacy systems"; sub "Deterministic
  recipes stage small, reversible, reviewable draft PRs across a codebase". A
  prominent note banner: **"Production-capable code. Deterministic recipe,
  checkpoint, and worker paths are implemented and covered by repository tests.
  This illustrative reel is not execution evidence. Live deployment and repository
  connection were not verified for this recording."** Family tabs: All families
  / SDK / Framework / Runtime / Internal API. Four migration-recipe cards on
  illustrative repos, each an **illustrative migration plan** with `test required`
  and `reversible` badges:
  `seed/payments-service` aws-sdk v2 → v3 (SDK); `seed/orders-web` React 17 → 18
  createRoot (Framework); `seed/inventory-worker` Node 18 → 20 runtime (Runtime);
  `seed/internal-billing` internal billing API v1 → v2 (Internal API). Mid-scene
  the first card promotes from `planning` to `reviewable plan`.
- **Voiceover (Talal, verbatim — first sentence of the closing beat):** "The same
  graph and verification layer can later point inward at legacy systems through
  Regauge."
- **Caption:** "Regauge runs legacy migrations as small, reversible, reviewable
  draft PRs — production-capable code, with live deployment status unverified."

## Scene 7 — Close (1:51 – 2:00) · 9s · **Talal**

- **On screen:** a sequencing pair — **Fettler · today** ("Provider breaking
  changes into reviewable, verified migration PRs. The change that is easiest to
  detect and prove.") and **Regauge · production-capable code · live status unverified** ("The same
  graph and verification layer, pointed inward at legacy systems. Built and
  tested.") — that dissolves to the brand lockup: mark + **"Fettler — provider
  changes into reviewable, verified migration PRs."** + the line **"Graph-backed ·
  Verify-first · Human-approved."**
- **Voiceover (Talal, verbatim — second sentence of the closing beat):** "We start
  with the change that is easiest to detect and prove."
- **Caption:** "The same graph and verification layer, pointed inward through
  Regauge — starting with the change that is easiest to detect and prove."

---

## Full voiceover, in order (verbatim)

1. **Talal:** "This is Fettler. A provider can publish a breaking change in
   seconds. Its customer may spend days discovering what the change touches and
   proving the migration is safe."
2. **Ijlal:** "In this illustrative payments scenario, the provider has replaced the
   source field with payment method. Fettler ingests the specification change,
   classifies it as breaking, and records the exact operation and field that
   changed."
3. **Ijlal:** "Fettler then follows the Change Graph into this codebase. It finds
   the client wrapper, two services, the test fixtures, and a background job that
   still depends on the old field. The engineer can inspect the path that made
   every file relevant."
4. **Ijlal:** "From that scope, Fettler opens the draft pull request. It updates
   the request model, the affected call sites, and the tests. The change is
   deliberately narrow. Fettler does not search for unrelated improvements."
5. **Ijlal:** "The review panel shows the provider change, the dependency path,
   the checks required, and the assumptions that still need human judgment.
   Fettler proposes the migration and records what must be verified. The engineer decides
   whether to merge."
6. **Talal:** "The same graph and verification layer can later point inward at
   legacy systems through Regauge. We start with the change that is easiest to
   detect and prove." *(Sentence one lands over Scene 6 (Regauge); sentence two
   over Scene 7 (close).)*

---

## Notes for the recording

- Open `demo/fettler-reel.html` directly in a browser (no server needed). Go
  full-screen (`F`) and let it auto-play once for the clean take; `R` resets
  between takes, `Space` holds on a frame, `C` hides captions for a voiceover
  take. See `demo/FETTLER_RUNBOOK.md`.
- Nothing here calls the network. Confirm in DevTools → Network that zero requests
  fire while it plays.
