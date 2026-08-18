# Intelligence Moat — Proprietary Asset Register

**Phase 36 of the Intelligence Ownership program. Analysis only; this document changes no code.**

- **Commit under assessment:** `ae42fb6` (`origin/main`, 2026-08-18).
- **Gates run from the worktree root:** `npm run spec:check` → `PRODUCT CONTRACT PASS: 84 requirements, spec 2.0`. `npm run typecheck` → exit 0.
- **Canonical authority:** `docs/product/mendpoint-product-platform-specification.md` (v2.0), per `docs/adr/0001-canonical-product-specification.md`.
- **Companion documents:** `docs/intelligence/CURRENT_STATE.md` (Phase 0 archaeology, PR #181), `docs/intelligence/OWN_VS_RENT.md` (Phase 1 ownership matrix, merged as #180), `docs/research/MENDPOINT_MIGRATION_INTELLIGENCE_BENCHMARK.md` (Phase 33/3, this PR).
- **Product ↔ code naming:** Fettler = `warden` in code, ReGauge = `transformer` in code (`docs/agents/OPERATING_PROTOCOL.md:138-145`).

---

## 0. How to read this document

This is an asset register written to be read by someone who does not believe it. An investor or a
design partner may read it. A document that overstates readiness is worse than no document, because
the overstatement is discovered later by someone with more leverage than we have.

Every quantitative claim carries a source: a `path:line`, a committed report artifact, or a commit
SHA. Where a number does not exist, the register says **not measured** and names the experiment that
would produce it. Nothing here is estimated numerically.

Three claims in this document are **operational** rather than repo-verifiable — that no customer
repository has ever been connected, that there have been no production migrations, and therefore
that the production row counts for several tables are zero. These are owner-stated facts about the
deployment, not things a reader can confirm by reading the repository. They are labelled
`OWNER-STATED` at each use. What the repository *does* independently corroborate is that every
capture path that would populate those tables is either default-off, gated behind a consent no flow
creates, or has no writer at all — each corroboration is cited inline.

### The definition of "compounds" used throughout

The program's own framing is that the moat is **not** "we fine-tuned a model" — it is the whole
compounding system. That framing is only useful if "compounding" has a test. This register uses a
three-part one. An asset **compounds** if and only if:

1. **It grows from routine operation.** Ordinary use of the product adds to it, with no separate
   human authoring step.
2. **Growth feeds back into behaviour.** Something in the product reads the accumulated asset and
   changes a decision because of it.
3. **The feedback is validated.** There is a measurement that can show the change was an
   improvement — and can show it was a regression.

An asset that satisfies (1) and (2) but not (3) is not compounding, it is **drifting**: it changes
behaviour without anyone being able to tell in which direction. Exactly one asset in this register
is in that state, and it is worth naming early: `suppressed_patterns` (§6).

| Verdict | Meaning |
| --- | --- |
| **REAL** | Exists, is substantial, and would survive an audit by a skeptical reader today. |
| **PARTIAL** | Exists in a form that is genuinely useful for something, but not for the thing the moat claim needs. |
| **ASPIRATIONAL** | The mechanism exists in code; the data does not. Zero or near-zero rows. |
| **ABSENT** | Neither the data nor a working mechanism to produce it exists. |

---

## 1. Headline

**One of the eleven candidate assets is real today, and it is the one that measures us rather than
the one that makes us better.**

The register below assesses eleven proprietary-asset candidates. The result:

- **1 REAL** — the Migration Benchmark (synthetic corpus + governed regression catalog).
- **2 PARTIAL** — migration recipes (real, hand-authored, deterministic, but static); verified
  remediation diffs (real for one legacy lane; the "verified" label is not yet trustworthy).
- **6 ASPIRATIONAL** — Change Graph data, migration trajectories, accepted/rejected outcomes,
  provider-specific patterns, framework migration patterns, router outcomes.
- **2 ABSENT** — calibration data, specialized model weights/adapters.

**Zero of the eleven satisfy all three compounding tests.** One (`suppressed_patterns`) satisfies
(1) and (2) and fails (3), and its feedback direction is negative by construction. Everything else
fails at test (1): it does not grow from routine operation, because either nothing writes it, or
nothing runs.

The honest summary of the moat today is: **we have built an unusually good instrument for measuring
a product that has not yet accumulated anything.** That is a better position than the inverse — a
product accumulating unmeasured data is accumulating unvalidatable data — but it is not a moat, and
it should not be described as one.

---

## 2. Master register

| # | Asset | Verdict | Grows from routine operation? | Feeds back into behaviour? | Feedback validated? | Compounds? |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Migration Benchmark (corpus + regression suite) | **REAL** | No — cases are authored | Yes — gates readiness | Self-verifying (`evals/regression/regression.test.ts`, PR #184) | **No** (fails test 1) |
| A2 | Change Graph data | ASPIRATIONAL | Would, on real traffic — none exists | **No** — zero graph-gated production decisions | No — `gl_edges.label` never written | **No** |
| A3 | Migration trajectories | ASPIRATIONAL | No writer exists | No | No | **No** |
| A4 | Verified remediation diffs | PARTIAL | Legacy lane only | No | No — the "verified" label cannot report failure | **No** |
| A5 | Accepted / rejected outcomes | ASPIRATIONAL | Structurally blocked for the shipping lanes | No | No | **No** |
| A6 | Provider-specific patterns | ASPIRATIONAL | **Yes** (`suppressed_patterns`) | **Yes** — filters future findings | **No** | **Drifting** |
| A7 | Framework migration patterns | ASPIRATIONAL | No — one hand-authored recipe | Yes, when it matches | Yes, at the gate level (PASS on PR #184) | **No** |
| A8 | Migration recipes | PARTIAL | No — hand-authored | Yes — they are the product | Yes, per family, analyze-only | **No** |
| A9 | Router outcomes | ASPIRATIONAL | Would, on real traffic | No — one eligible executor | No denominator exists | **No** |
| A10 | Calibration data | ABSENT | No emitter | No | No | **No** |
| A11 | Specialized model weights / adapters | ABSENT | — | Cannot serve a token | — | **No** |

---

## 3. A1 — The Migration Benchmark · **REAL**

### What exists today

The strongest proprietary asset in the company, and the only one that would survive an audit
unchanged.

- **64 scenarios** across two products, on `claude/failure-to-eval` (PR #184, in flight):
  33 Fettler, 31 ReGauge (`evals/reports/latest.md` on that branch). The artifact committed to
  `origin/main` today records **59 scenarios, 45 passed (76%), 7 P0** at commit `1d3ae5a`
  (`evals/reports/latest.md:11-15`).
- **Machine-readable hidden ground truth.** 21 JSON answer keys under `evals/ground-truth/`, schema
  at `evals/ground-truth/schema.ts`, carrying expected findings, acceptable variants, explicit
  false-positive traps, blast-radius truth, difficulty and difficulty rationale. Spec §18.3 makes
  hidden ground truth a SHOULD and answer-key inaccessibility a MUST.
- **Answer-key isolation is enforced as an invariant, not a convention.**
  `evals/runners/isolation.ts` throws `CorpusIsolationError` if `CORPUS_ROOT` ever resolves inside
  the repo, and `evals/runners/stage.ts` stages each repo into scratch with its grading key stripped
  before the product can read it (`evals/runners/fettler-runner.ts:71-73`). The module comment
  states the reason plainly: without it, "every number after that is worthless"
  (`evals/runners/isolation.ts:1-11`).
- **Four dataset tiers**, not two: `development | regression | validation | holdout`
  (`evals/ground-truth/schema.ts:26-30,209-211`). Holdouts are procedurally generated and never
  inspected while fixing.
- **A seeded mutation engine**, so scenarios are generated by mutating a healthy repo rather than
  hand-copied (`evals/generators/families.ts:6`), with the seed recorded in each scenario's `notes`.
- **A versioned governance gate** on what may enter the committed suite
  (`evals/regression/governance.ts`, PR #184): a case is admitted only if its provenance is
  certified `synthetic` or `redacted-from-customer` with a redaction reference, and only if no
  reproducing repo contains an answer-key file. It throws rather than warning.
- **A self-verifying regression catalog** (`evals/regression/regression.test.ts`, PR #184): the
  catalog records each case as `fixed` or `open`, and the test runs the real analyze path and
  asserts the recorded status matches reality. A case cannot silently rot into a lie.
- **Versioned acceptance gates** in one file rather than scattered literals
  (`evals/readiness-gates.json`, `schema_version: 1`, policy `precision-first`, owner Talal).

### Why this counts as proprietary

Not because synthetic repositories are hard to make. Because the **pairing** is: an adversarial
corpus, a hidden key that the product provably cannot read, a deterministic grader per dimension, a
failure taxonomy that maps a symptom to a subsystem (`evals/graders/taxonomy.ts`), owner-decided
numeric gates, and a governed path from a real observed failure to a permanent regression case. Each
piece exists elsewhere; the assembled, self-checking instrument does not, and it is the thing that
makes every later claim about model quality checkable.

### What it would take to make it a real *compounding* asset

It fails compounding test (1) — it does not grow from routine operation. Three specific changes:

1. **A failure-to-case pipeline that runs without an author.** PR #184 builds the governance gate
   and the catalog; what does not exist is a producer that converts a *production* failure into a
   case. Today the two sources are hand-authored synthetic repos and the one-off OSS kinked corpus.
   There is no production failure to convert (`OWNER-STATED`: no customer repositories connected).
2. **An apply-and-verify arm.** Both runners are analyze-only (§9 of the benchmark document). Until
   a scenario can record "the migrated tree compiles and the subject's own tests pass", the corpus
   measures a decision, not an outcome — and cannot validate a trained model either. The graders are
   already specified and deliberately deferred (`evals/graders/DEFERRED.md:8-28`).
3. **CI enforcement.** `evals/runners/run-all.ts` exits non-zero only under `--enforce-readiness`,
   and `package.json:42` (`eval:synthetic`) passes no such flag; `.github/workflows/ci.yml:44-45`
   documents this as deliberate. The build is green while the committed report reads
   `Overall readiness: FAIL`. An asset that cannot block a merge does not defend anything.

### Honest limits

- **All-synthetic.** Every one of the 59/64 scenarios is synthetic. The single look at real
  repository shapes — kinked clones of express (`a3714473`), react-tutorial (`ec8d845a`) and
  next.js (`6be68703`) — found **12 of 35 cases where the product was wrong and the eval was green**
  (`C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md:193`). PR #184 re-checked those twelve and
  reports **10 genuinely fixed by PR #174, 2 still open**.
- **The holdout is four scenarios of one family.** All four holdouts are Fettler ref-rename
  variants (`evals/reports/latest.md`, "Holdout detail"). ReGauge has no holdout at all
  (`evals/reports/readiness-scorecard.md`, holdout row). A 4/4 holdout pass is not evidence of
  generalization at any useful confidence.
- **The corpus lives outside the repository** at `MENDPOINT_CORPUS_ROOT`, default
  `C:/Users/Talal/dev` (`evals/scenarios/index.ts:18-20`). That is what makes isolation enforceable,
  and it also means 21 of the scenarios cannot run on a GitHub-hosted runner and are skipped there
  (`.github/workflows/ci.yml:36-49`). The asset is currently not fully portable.

---

## 4. A2 — Change Graph data · **ASPIRATIONAL**

### What exists

`packages/graph-learn` maintains a genuinely persisted property graph — `gl_nodes` / `gl_edges` in a
separate SQLite file (`packages/graph-learn/src/store.ts:26-50`, `singleton.ts:7-18`, env
`GRAPH_LEARN_DB`) — written on every change fanout by `runChangePipeline`
(`packages/pipeline/src/index.ts:669,690,843,1917`), with twelve `/graph-learn/*` query routes
(`apps/api/src/server.ts:1149-1341`) and 20 tests.

### The three defects that keep it from being an asset

1. **`DEPENDS_ON` has no writer.** The edge kind is declared (`packages/graph-learn/src/schema.ts:118`,
   mapped at `:175`) and read in two places — `dependency-paths.ts:104` and `query.ts:652` — but a
   repository-wide grep for a write finds it only inside `dependency-paths.test.ts:32-33`. The
   dependency-path and blast-radius queries that traverse it therefore traverse an empty relation in
   production. **Verified for this document by direct grep at `ae42fb6`.**
2. **Zero graph-gated decisions in production.** The one blast-radius query in the pipeline
   (`packages/pipeline/src/index.ts:704-711`) produces `graphRagMd`, whose only consumer is string
   concatenation into a PR body at `:982`. The only graph query that gates a decision,
   `graphGateEvidence` (`packages/pipeline/src/warden-campaign-executor.ts:311-337`), sits inside
   code with zero production callers and reads data nothing writes.
3. **Confidence is assigned by fiat and never validated.** `gl_edges.confidence` is `1` for
   control-plane edges and `1 / 0.7 / 0.4` mechanically derived from the finding's own confidence
   string (`packages/graph-learn/src/ingest.ts:205,226,239-240`). `gl_edges.label`, declared in the
   schema as the "GNN / outcome label" (`schema.ts:34`), is never written.

### Recently repaired, and worth recording

PR #177 (`d90c571`, merged 2026-08-17 23:21) fixed a defect where Python `src/` layouts collapsed provider provenance:
`buildPythonModuleMaps` derived first-party roots from the first path segment, so `src/app/...`
yielded root `src`, an absolute `app.client` import looked third-party, no edge was built, and the
failure was not even recorded as unresolved — while coverage still reported `analyzed` with zero
gaps. Confidence therefore **rose** on byte-identical source. The fix derives module names from real
package structure and routes genuine resolution failures to an unresolved list that emits a
`query_truncated` coverage gap. This is the correct class of fix and it is worth noting that the
defect it closed was one where the graph's own quality signal moved in the wrong direction.

### What would make it a real asset

- A writer for `DEPENDS_ON` from the manifest/lockfile layer, so the declared traversals have edges.
- At least one production decision gated on a graph query, with the ungated counterfactual recorded.
- An outcome writer for `gl_edges.label`, plus wiring the two already-written, zero-caller harnesses
  — `evaluateConfidenceCalibration` (`packages/graph-learn/src/confidence-calibration.ts:173`) and
  `runImpactBenchmark` (`packages/graph-learn/src/impact-benchmark.ts:148`) — into a scored eval,
  so a `confidence: 0.7` edge can be checked to be right about 70% of the time.

**Compounds today: no.** Row count in production is zero (`OWNER-STATED`), and even with traffic it
would fail compounding test (2): nothing reads it to change a decision.

---

## 5. A3 — Migration trajectories · **ASPIRATIONAL (empty table)**

**This is the asset the whole program is named after, and it currently contains no rows.**

### What exists

A storage layer, landed in PR #183 (`claude/trajectory-capture`, **open** at time of writing):
three new tables in `packages/db/src/index.ts` — `trajectory_blobs` (`:829`), `trajectories`, and
`trajectory_steps` (`:876`) — with a twelve-function API in `packages/db/src/trajectory.ts`
(`putTrajectoryBlob`, `recordTrajectory`, `recordModelCall`, `recordToolCall`,
`recordVerificationStep`, `recordRouterDecisionStep`, `getTrajectoryStepPair`, and others). The
design is careful: content-addressed by the digest of the *original* bytes so it joins to existing
digests like `fettler_model_reservations.request_digest`; every payload passes through
`redactSourceForModel` and **fails closed** on high-entropy residue; hidden chain-of-thought is never
stored (spec §8.12); cross-boundary references are by id only.

### What does not exist

**A writer.** A grep across `apps/**`, `packages/agent/**` and `packages/pipeline/**` on the PR #183
branch for any trajectory symbol returns **nothing**. The PR body says so itself and names the seam
the follow-up must use: `packages/agent/src/attempt-engine.ts` around line 1099, where the live
`AgentRunResult.steps` still exists before the attempt engine reduces it to counts.

On `origin/main` today the situation is unchanged from the Phase 0 finding: **no `(input → output)`
pair is persisted anywhere, in any form, by any code path.** `packages/agent/src/agent.ts:2730`
builds the model input, `agent.ts:2511` hashes it, and the text is discarded — only
`fettler_model_reservations.request_digest` survives (`packages/db/src/index.ts:136`). Tool calls
are counts only (`agent_runs.steps`, `packages/db/src/index.ts:192`); the per-step record exists in
memory (`packages/agent/src/types.ts:63-69`) and is explicitly dropped at
`apps/worker/src/warden-router.ts:701` (`steps: []`).

### What it would take

1. Land PR #183 (store).
2. Land the emit: `attempt-engine` → `WardenAttemptResult` → worker persistence, per the PR's own
   scope note. This is a contained change; the seam is identified.
3. Run something. Even with store and emit, the table stays empty until a real migration executes
   (`OWNER-STATED`: none have).

**Compounds today: no. It is an empty table with a well-designed schema.** It should be described
that way in any external material — a schema is a plan, not a proprietary dataset.

---

## 6. A4 — Verified remediation diffs · **PARTIAL**

### What exists

Real unified diffs exist for exactly one lane: `migration_prs.patch_unified`
(`packages/db/src/index.ts:252`), written at `packages/pipeline/src/index.ts:1626`. That is the
legacy migration-PR path.

The modern delivery lanes do not store a diff. Warden and ReGauge record file paths only
(`agent_runs.files_changed_json`, `packages/db/src/index.ts:193`) with the candidate held as an
off-DB sealed file referenced by `sealed_path` / `sealed_sha256` (`:1335-1336`).

The one structure in the repository that actually looks like a training example is
`LearningCorpusExample` (`packages/db/src/learning-corpus.ts:62-111`): an explicit `input`
(task, changed paths, target paths), an `output` with per-edit path / semantic category / risk /
rationale, `verificationSummary`, optionally `afterContent[]` carrying **exact before/after file
bytes** (`:50-55`), and labels including `verificationPassed` and `decision: "accepted" | "rejected"`
(`:95-97`) — i.e. real negatives. It is built by `buildLearningCorpus` (`:286`) and exported by a
manual CLI (`scripts/learning-export-corpus.ts:54`). No scheduler, no job, no trigger.

### Why "verified" is not yet a trustworthy label

This is the part that most needs stating plainly, because "verified remediation diffs" is exactly
the phrase that would go in a deck.

- `verificationPassRate` is **structurally incapable of reporting failure**:
  `packages/transformer/src/pilot-execution.ts:1405` throws if `!verificationPassed`, `:1418` then
  stores the literal `true`, and the metric at `:3756` can only be `1` or `null`.
- The attempt engine **normalizes verification failures away** in the off-DB artifact
  (`packages/agent/src/attempt-engine.ts:758,771`), and that artifact is deleted on retention expiry
  (`apps/worker/src/cli.ts:1157,1163-1168`). Commands and exit codes live nowhere else.
- **The sandbox backend that actually ran is recorded nowhere** (`packages/repair/src/verify-sandbox.ts:73-75`),
  so a refusal is indistinguishable downstream from a genuine test failure.
- And until 2026-08-17, four of the five migration families were shipping partial migrations as
  *verified successes*. The kinked-clone validation found four cases where
  `executeRecipeInWorkspace` produced a **signed `transformer.recipe.execution` evidence record with
  both verification commands at exit 0** for a repository that no longer installs
  (`VALIDATION-REPORT.md:203-210`, signed executions `tre_execution_d4d53d63…`, `4817f4d2…`,
  `0a04aa23…`, `b7622a40…`). PR #174 (`428d9fa`) closed this for the SDK, framework and runtime
  shapes; PR #184's re-check reports 10 of the 12 fixed and 2 still open.

**The direct consequence for the moat: a dataset assembled from pre-`428d9fa` "verified" outcomes
would encode those false successes as positive training examples.** Any capture that is enabled must
be enabled after `428d9fa`, and any historical outcome recorded before it must be treated as
unlabelled, not as a positive.

### What it would take

Persist the diff on the modern lanes; record per-check exit codes and the sandbox backend that ran;
make `verificationPassRate` able to emit a failure; and only then treat the `verified` flag as a
label. Volume then follows from traffic, of which there is none.

**Compounds today: no.**

---

## 7. A5 — Accepted / rejected outcomes · **ASPIRATIONAL, and structurally blocked**

This is the **keystone** asset. Without an outcome label, none of A2, A3, A4, A6, A9 or A10 can
satisfy compounding test (3), no matter how much data they accumulate.

### Why there is no data, beyond "no customers"

Even with customers, the shipping lanes could not record the outcome today:

- **No terminal state exists to write.** `fettler_candidate_deliveries`
  (`packages/db/src/index.ts:1327-1329`) and `regauge_adaptive_deliveries` (`:1294-1296`) both cap
  `status` at `delivery_pending | delivered | delivery_failed`. There is no
  `merged` / `closed` / `reverted`.
- **The GitHub webhook cannot find the row.** `findPrByGitHubIdentityAndNumber` queries
  `migration_prs` alone (`packages/db/src/index.ts:3057-3066`), even though both delivery tables
  store `draft_pr_number` (`:1343`, `:1306`). A merge of a Warden or ReGauge PR returns
  `{ok: true, applied: null, reason: "no matching migration PR"}` (`apps/api/src/server.ts:2564`).
- **A human approving in the GitHub UI is invisible.** `pull_request_review` events are used only to
  wake CI (`apps/api/src/warden-review-webhook.ts:21-50`); the review state is normalized away
  (`packages/github/src/webhooks.ts:202-222`). `reconcileMigrationPrNativeReview`
  (`apps/api/src/reviews.ts:329`) would record it and has zero production callers.
- **Three non-reconciled review surfaces** with three decision enums and no cross-table join key:
  `review_decisions` (`packages/db/src/index.ts:934-955`), `agent_runs.status` mutation
  (`apps/api/src/warden-candidate-review.ts:297-300`), and
  `regauge_adaptive_candidates.review_decision` (`packages/db/src/index.ts:1249`).
- **Reverts and follow-up commits are not recorded at all.** `packages/db/src/outcome-metrics.ts:216-224`
  sets `escapedRegressionRate` to `{value: null, basis: "unavailable"}` with a written explanation.
  That refusal is the single most honest line of code in the repository, and it is also the exact
  shape of the gap this program must close.
- **And the governed learning events that do exist carry constant labels.** Both producers hard-code
  `observedOutcome.status: "corrected"`, `attribution: "model_behavior"` and
  `correction.substantive: true` (`apps/worker/src/warden-learning-producer.ts:112-117`;
  `apps/worker/src/transformer-governed-learning-producer.ts:93-98`), and
  `apps/worker/src/governed-learning-producer.ts:206` hard-codes `verification.verdict: "passed"`.
  The corpus filter then keeps only `destination === "model_weight"`, reachable only through those
  same constants (`packages/pipeline/src/learning-operations.ts:700-702`,
  `learning-event.ts:321-324`). **The corpus is 100% positive examples by construction — zero label
  variance, therefore zero learning signal, independent of volume.**

### What it would take

Add terminal statuses to both delivery tables; widen the webhook lookup to them; call
`reconcileMigrationPrNativeReview`; derive the label from observed reality rather than a literal.
Each is small. Together they are the difference between a system that records that work happened and
one that records whether the work was right.

**Compounds today: no.**

---

## 8. A6 — Provider-specific patterns · **ASPIRATIONAL, and drifting**

### The one asset with a live feedback loop — pointing the wrong way

`suppressed_patterns` (`packages/db/src/index.ts:292-303`) is the only table in the product that is
written automatically by routine operation *and* read back to change a future decision:

- **Written** by `applyPrFeedback` when a PR is closed, scraped from the PR body text
  (`packages/pipeline/src/index.ts:1932-1945`), inserted `INSERT OR IGNORE`
  (`packages/db/src/index.ts:3527`).
- **Read** to filter future findings (`packages/pipeline/src/index.ts:850-863`).

It therefore satisfies compounding tests (1) and (2) and fails (3) — and the failure matters,
because **a PR closed for any reason at all degrades future recall.** "We'll do it next quarter",
"we fixed it by hand", "wrong repo" — all become a suppression that narrows what the product will
ever flag again, with no mechanism to detect that it did, and no measurement that would show recall
falling. That is drift, not compounding.

### And the architecture is deliberately not provider-specific

The readiness scorecard records supported providers as **"provider-agnostic (driven by the OpenAPI
diff, not a provider allowlist); exercised only against synthetic providers"**
(`evals/reports/readiness-scorecard.md`, Supported providers row). The residual provider literals
that remain — `/fetch|axios|http|acme|stripe/i` in the confidence-promotion path
(`packages/code-impact/src/candidates.ts:401`) and hardcoded `charges.*` tokens
(`packages/change-intel/src/index.ts:734-738`) — are treated as defects elsewhere in the same
codebase.

So "provider-specific patterns" is not merely empty; **the product was designed so that it would
stay empty**, and spec §17.8's vendor-adapter strategy currently has nothing to specialise on.

### What it would take

First, decide whether provider specificity is wanted at all — this is an owner decision, not an
engineering gap. If yes: a per-provider surface catalogue keyed to observed diffs, plus a
suppression record that carries a *reason class* rather than scraped prose, plus a recall
measurement that can detect suppression-induced degradation. If no: retire the phrase from the moat
narrative rather than leaving it in as an aspiration.

**Compounds today: no — it drifts.** Row count in production is zero (`OWNER-STATED`).

---

## 9. A7 — Framework migration patterns · **ASPIRATIONAL**

"Framework migration patterns" is, concretely, **one recipe**: `react-dom-17-to-18`
(`REACT_DOM_17_TO_18_RECIPE`, `packages/transformer/src/recipe.ts`), classified
`{family: "framework", provider: "react-dom", framework: "react-dom"}` by
`classifyRecipeContract` (`recipe.ts:3267-3269`). It is exercised by **4 scenarios** and its gate,
`regauge-framework-migration`, reports **PASS** on the PR #184 run (apply 1/1, residual-refusal 1/1,
abstention 2/2, zero open P0) — up from **FAIL** on the artifact committed to `main`
(residual_refusal 0/1, 1 open P0), because PR #174 landed between the two runs.

The structural limit is the one the OSS validation found first: the framework and SDK recipes
hardcode `allowedPaths` to exact filenames — `src/index.jsx`, `src/index.tsx`, `src/s3.js`,
`src/client.js` — and hardcode their verifier file lists to the same paths. **No real repository has
those paths.** express (213 files) and next.js (31,220 files) contain none of them
(`VALIDATION-REPORT.md`, §1). For any real consumer, every other file using the framework is a
residual *by construction*; the residual case is the default, not an edge case.

**What it would take:** path discovery rather than path hardcoding, more than one framework, and an
apply-and-verify measurement. **Compounds: no** — a hand-authored recipe does not grow.

---

## 10. A8 — Migration recipes · **PARTIAL (real, and static)**

### The second-strongest asset, and genuinely real

- `RECIPE_REGISTRY` (`packages/transformer/src/recipe.ts`) holds **15 map-literal entries resolving
  to 14 unique `id@version` keys across 13 distinct recipe ids** (counted programmatically at
  `ae42fb6`; the duplicate is `node-runtime-18-to-20@2`, listed twice).
- **Five declared families** in `MigrationLabelFamily` (`recipe.ts:3224-3229`): `sdk`, `framework`,
  `runtime`, `internal_api`, `warden-provider`. Worth noting for accuracy: `classifyRecipeContract`
  (`recipe.ts:3256-3283`) can return only the first four; `warden-provider` is a vocabulary member
  with no classifier branch, so no shipped recipe classifies into it today. Four families are gated
  in `evals/readiness-gates.json`.
- The engine is genuinely deterministic and genuinely restrained. Abstention is first-class:
  `mission-planner.ts:142-149` abstains on zero or ambiguous matches, and `recipe.ts:3806-3814`
  refuses `unsupported`, `already_applied` and incomplete states. Human review is mandatory and
  cannot be self-approved (`apps/api/src/transformer-missions.ts:79`,
  `apps/api/src/transformer-mission-authority.ts:363,299`). 439 tests pass across 36 files in
  `packages/transformer`.

### What today changed, and why it is the most important entry in this register

Until PR #174 (`428d9fa`, merged 2026-08-17 22:14), `isResidualSite` (`recipe.ts:3542`) handled only
three runtime precondition kinds and ended in a bare `return false` (`:3570`) for every SDK,
framework and internal-API kind. For those families `residualPaths` was **always `[]`**, `status`
could **never** be `incomplete`, and a residual file was invisible — while the manifest edit was
repo-wide. Four of the five families were therefore capable of shipping a partial migration as a
signed, verified success. PR #174 extended residual detection to both blast-radius shapes and closed
six runtime idioms the guard missed (`--platform` flags, `@sha256` digest pins, partially-migrated
multi-stage Dockerfiles, and nested `engines.node` values outside the exact canonical selector set).

**The two artifacts disagree, and the newer one is right.** The scorecard committed to `origin/main`
was generated at `1d3ae5a` — *before* `428d9fa` — and still reports sdk-upgrade, framework-upgrade
and internal-api-rename as FAIL with residual_refusal 0%. It was carried forward unchanged by PR
#179 (`80bf1d2`), which merged six minutes after #174 from a branch cut before it. The regenerated
run on PR #184 (at `80bf1d2`) reports sdk **PASS 4/4**, framework **PASS 1/1**, runtime **PASS 4/4**,
internal-api **FAIL 0/2**. Anyone reading `evals/reports/readiness-scorecard.md` on `main` today is
reading a pre-fix measurement.

### Why it is PARTIAL rather than REAL

Recipes are hand-authored artifacts. They do not grow from operation, nothing learns from them, and
they are validated only on the analyze decision — not on an applied, installed, compiled result. The
signed-catalog machinery that would make a recipe a governed, portable asset
(`SignedProviderRecipe`, ed25519 verification, revocation, `recipe-catalog.ts:136-144,530-552`) has
**zero production callers**, and everywhere it is exercised the keypair is generated in-process
microseconds before verification (`packages/eval/src/transformer-agent-eval.ts:1112,1404`,
`packages/eval/src/transformer-canary.ts:339`). There is no key material anywhere to route to.
ADR-0003 records this.

**What it would take:** real signing keys and a production caller for the signed catalog;
path discovery in place of hardcoded `allowedPaths`; an apply-and-verify gate; and a recipe-authoring
loop that turns an observed customer migration into a new recipe. That last one is what would make
recipes compound. **Compounds today: no.**

---

## 11. A9 — Router outcomes · **ASPIRATIONAL**

The router is well-built and its ledger is honest: `routing_ledger`
(`packages/db/src/index.ts:1108-1136`) records `selected_executor_id`, `eliminated_json`,
`fallback_json`, `breaker_json`, `decision_json` and `handoff_required`, persistence failure throws
before dispatch (`apps/worker/src/warden-router.ts:571-576`), outcomes commit exactly once (`:502`),
and unmeasured runs write NULL cost rather than a fabricated zero (`:455-471`).

It is also **degenerate**. `buildWardenExecutorRegistry` (`apps/worker/src/warden-router.ts:154-162`)
calls `register` exactly once (`:160`). `buildRoutedExecutorRegistry`
(`apps/worker/src/transformer-router.ts:134-143`) registers two, but every task it builds hardcodes
`requiredCapabilities: [TRANSFORMER_CAPABILITY]` (`:189`), eliminating Warden on 100% of passes. **One
eligible executor per production pass in both lanes.** The 5-key ranking comparator
(`packages/platform/src/router.ts:691-700`) never breaks a tie because there is never more than one
candidate. Of thirteen router signals, two — capability and circuit breaker — can change an outcome;
eight are hardcoded constants that can never fire. And `routing_ledger` has **no `model` column**, so
model identity and routing decision are not joinable in one query.

`packages/eval/src/router-value-proof.ts` is a precisely specified, unit-tested arithmetic validator
over caller-supplied baseline/candidate observations — **fed by nothing anywhere in the monorepo**.

**Router outcomes have no data and, more fundamentally, no denominator.** With one eligible executor
there is no selection to evaluate. **What it would take:** a second genuinely eligible executor per
pass, a `model` column on the ledger, and a producer for the value-proof validator — in that order.
**Compounds: no.**

---

## 12. A10 — Calibration data · **ABSENT**

There is no ground truth on any individual impact finding. `impact_findings`
(`packages/db/src/index.ts:233-243`) has no verdict, label, `confirmed` or `was_correct` column, and
no migration adds one. `review_decisions` keys on a candidate artifact, not a finding, so a rejection
cannot be attributed to a site.

Two calibration harnesses exist, are tested, and have **zero callers**:
`evaluateConfidenceCalibration` (`packages/graph-learn/src/confidence-calibration.ts:173`) and
`runImpactBenchmark` (`packages/graph-learn/src/impact-benchmark.ts:148`). There is consequently no
ECE, no Brier score, and no selective-accuracy curve for any phase of the product — and no way to
know whether a `confidence: 0.7` edge is right 70% of the time. Spec §12.2 requires calibrated
confidence; today the reported confidence is an ungated self-score.

**What it would measure it:** an emitter of `ConfidenceCalibrationSample` from the production finding
path plus a verdict column on `impact_findings`; then wire the two existing harnesses into a scored
eval capability. **Compounds: no. Nothing exists to compound.**

---

## 13. A11 — Specialized model weights / adapters · **ABSENT**

Nothing exists, and three independent blockers stand between the current system and a single
adapter serving a single production token.

- **No adapter table exists repo-wide.** The registry is event-sourced: `registerPostTrainedAdapter`
  (`packages/pipeline/src/post-trained-application.ts:37-75`) writes a manifest to
  `artifact_manifests` and a pointer to `domain_events`. The gates around it are real — human
  approver, unrevoked principal, training-completion digest match, independent evaluation with
  `passed === true`, canary evidence, hash-chain integrity.
- **The trainer service is not in this repository and is not proven to exist.** The client is a
  genuine authenticated `fetch` with a 16 MiB cap (`apps/api/src/advanced-ai-applications.ts:140-161`),
  returning `{}` → 503 unless six variables including
  `MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED === "1"` are set (`:127-139`).
  `docs/learning/current-state.md:101` states the service's absence directly.
- **A corpus built from today's producers can never be sent to the configured trainer.** Both
  producers hard-code `mayLeaveTenantBoundary: false`
  (`apps/worker/src/warden-learning-producer.ts:127`,
  `transformer-governed-learning-producer.ts:104`); `externalProcessingAllowed` is the AND over all
  examples (`packages/pipeline/src/learning-operations.ts:625-626`), blocking external dispatch
  (`:968-970`) — while the external trainer is enabled only when `processingBoundary: "external"`
  (`apps/api/src/advanced-ai-applications.ts:188`). This is a hard contradiction in the current
  wiring, not a configuration choice.
- **And the production routers do not know adapters exist.** `"adapter"` appears in the router only
  as a type-union member (`packages/platform/src/router.ts:35`) and a preference weight (`:1074`).
  The only adapter routing is a dry run that fabricates a one-executor registry
  (`post-trained-application.ts:134-142`). `docs/learning/ship-readiness.md:34` lists "Actual adapter
  model invocation" as a ship blocker. **An adapter can be registered, evaluated, canaried, approved
  and marked eligible — and still never serve a production token.**

There is also no meaningful corpus to train on even if all three were fixed: `toExample`
(`packages/pipeline/src/learning-operations.ts:881-922`) yields an artifact **ID** for input, a review
blurb for output, and a constant for reward. **Compounds: no.**

---

## 14. Where the compounding loop is broken

The program's framing — that the moat is the compounding system, not the fine-tune — is correct, and
holding the assets against that framing is more useful than holding them against a data-volume
target. The loop the framing implies is:

```text
run a migration
  → capture the trajectory (input, tools, output)
    → observe the real outcome (merged / reverted / edited)
      → label the trajectory with that outcome
        → measure whether the model or the recipe caused it
          → improve the recipe, the router, or the weights
            → verify the improvement on a held-out benchmark
              → run a better migration
```

**Six of the eight arrows are cut today:**

| Arrow | Status | Cut by |
| --- | --- | --- |
| run a migration | **CUT** | No customer repositories connected (`OWNER-STATED`) |
| → capture the trajectory | **CUT** | Store landed PR #183, no writer anywhere (§5) |
| → observe the real outcome | **CUT** | No terminal status column; webhook cannot match the row (§7) |
| → label the trajectory | **CUT** | Producers hard-code positive labels; zero variance (§7) |
| → measure cause | **CUT** | No per-finding ground truth; calibration harnesses have no callers (§12) |
| → improve | **PARTIAL** | Recipes improve by hand, and do; router and weights cannot (§10, §11, §13) |
| → verify on holdout | **INTACT** | The benchmark exists and works (§3) — 4 holdout scenarios, one family |
| → run a better migration | **CUT** | Closes back onto the first cut arrow |

The single intact arrow is the benchmark. That is the correct arrow to have built first — a loop
that improves without a verifier improves into an unmeasurable state — but it is one arrow.

---

## 15. Strongest and weakest

### Strongest: the Migration Benchmark (A1)

It is the only asset that is substantial, self-checking, honest about its own limits, and would
survive a hostile audit unchanged. It has a governance gate on admission, a self-verifying catalog,
enforced answer-key isolation, four dataset tiers, deterministic graders, a failure taxonomy that
maps symptom to subsystem, and owner-versioned numeric gates. Its own verdict on the product is
**FAIL**, which is the strongest evidence that it is measuring rather than flattering.

Its honest ceiling: it is all-synthetic, it is analyze-only, its holdout is four scenarios of one
family, and it cannot fail a build.

### Weakest: specialized model weights / adapters (A11)

Nothing exists, and — unlike the other empty assets — the path to the first one is blocked at three
independent points: the external trainer service is not proven to exist, the corpus the producers
build can never legally be sent to it, and a registered adapter cannot serve a production token even
after approval. Every other empty asset is empty for want of traffic or a writer. This one is empty
for want of three subsystems that contradict each other.

### The keystone (neither strongest nor weakest, but the one to fix first): accepted/rejected outcomes (A5)

Without an outcome label, no other asset can satisfy compounding test (3). It is also the cheapest
to fix: terminal statuses on two tables, a widened webhook lookup, and one zero-caller function
called. Everything downstream — calibration, router learning, trajectory labelling, recipe
improvement — is gated on it.

---

## 16. What we must not claim

Recorded explicitly so that a future deck, landing page, or design-partner conversation can be
checked against it.

| Claim that must not be made | Why |
| --- | --- |
| "We have a proprietary corpus of migration trajectories" | Zero rows. The store is an open PR with no writer (§5). |
| "Our models learn from every migration" | No model call is on by default; no `(input → output)` pair is persisted; the learning corpus is 100% positive constants (§7). |
| "96.4% precision / 79.3% recall" without the caveat | Those numbers measure the deterministic pipeline with the model OFF (`evals/runners/fettler-runner.ts:92`). See the benchmark document, §8.1. |
| "Verified migrations" | Until `428d9fa` (today) four of five families could sign exit-0 evidence for repositories that no longer install (§6). |
| "Our Change Graph powers impact analysis" | Zero graph-gated decisions in production; impact analysis builds and reads its own separate graphs (§4). |
| "Our router optimizes cost and quality" | One eligible executor per pass; cost, quality and latency are accepted as parameters and ignored (§11). |
| "Calibrated confidence" | No calibration measurement exists anywhere (§12). |
| "Fine-tuned / specialized models" | No adapter exists; one could not serve a token if it did (§13). |
| Any per-family ReGauge readiness figure read off `main` | The committed scorecard predates PR #174 and understates three families (§10). |

The claims that **can** be made today, with sources, are: a governed adversarial benchmark with
hidden ground truth and enforced answer-key isolation (§3); a deterministic, restrained,
human-review-gated recipe engine across four gated families (§10); and unusually honest
instrumentation that refuses to report metrics it cannot support
(`packages/db/src/outcome-metrics.ts:216-224`, `packages/agent/src/model-provenance.ts:36-37`).

---

## 17. Every quantitative claim in this document, and its source

| Claim | Source |
| --- | --- |
| 64 scenarios; 53 passed (83%); 4 P0 | `evals/reports/latest.md` on `origin/claude/failure-to-eval` (PR #184) |
| 59 scenarios; 45 passed (76%); 7 P0 | `evals/reports/latest.md:11-15` on `origin/main` (`ae42fb6`), generated at `1d3ae5a` |
| Splits 45 dev / 9 validation / 6 regression / 4 holdout | `evals/reports/latest.md`, "Dataset splits" (PR #184 run) |
| precision 96.4% / recall 79.3%, 2 open P0 | `evals/reports/latest.md`, `fettler-impact-analysis` gate table (both runs) |
| Gate thresholds 0.9 / 0.85 / 0 / 10pp | `evals/readiness-gates.json` |
| 12 of 35 kinked cases product-wrong-eval-green | `C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md:193` |
| 10 of 12 fixed by #174, 2 open | PR #184 description; corroborated by the regenerated family gates |
| 4 signed exit-0 evidence records for broken repos | `VALIDATION-REPORT.md:203-210` |
| express 213 files, next.js 31,220 files, no matching `allowedPaths` | `VALIDATION-REPORT.md`, §1 |
| 15 registry entries / 14 unique keys / 13 distinct ids | Counted programmatically over `RECIPE_REGISTRY` in `packages/transformer/src/recipe.ts` at `ae42fb6` |
| 5 declared families, 4 classifier-reachable | `packages/transformer/src/recipe.ts:3224-3229`, `:3256-3283` |
| 439 tests / 36 files in `packages/transformer` | `docs/intelligence/CURRENT_STATE.md` §2 (PR #181) |
| 13 router signals, 2 effective; 1 eligible executor per pass | `docs/intelligence/CURRENT_STATE.md` §4 (PR #181), citing `apps/worker/src/warden-router.ts:154-162,231-243`, `transformer-router.ts:189` |
| `DEPENDS_ON` has no writer | Direct grep at `ae42fb6`: reads at `dependency-paths.ts:104`, `query.ts:652`; schema at `schema.ts:118,175`; only write is `dependency-paths.test.ts:32-33` |
| Trajectory store has no writer | Direct grep across `apps/**`, `packages/agent/**`, `packages/pipeline/**` on `origin/claude/trajectory-capture` — no matches |
| `npm run spec:check` → 84 requirements, spec 2.0 | Run from this worktree at `ae42fb6` |

**Claims used in this document that could not be sourced to the repository:** the three
`OWNER-STATED` operational facts (no customer repository has been connected; no production
migrations have run; production row counts for the outcome, router, graph and learning tables are
therefore zero). They are consistent with — but not proven by — the default-off flags, the absent
consent flow, and the missing writers cited above.

---

*Phase 36 analysis by Claude Code. No file outside `docs/intelligence/INTELLIGENCE_MOAT.md` and
`docs/research/MENDPOINT_MIGRATION_INTELLIGENCE_BENCHMARK.md` was modified.*
