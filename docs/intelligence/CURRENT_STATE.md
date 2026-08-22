# Intelligence Ownership — Phase 0: Current State

**Status:** Archaeology. Descriptive, not prescriptive.
**Commit under test:** `fcec22e` (`origin/main`, 2026-08-18).
**Gates run from the worktree root:** `npm run spec:check` → `PRODUCT CONTRACT PASS: 84 requirements, spec 2.0` (41 verified / 40 partial / 2 scaffold / 1 blocked_external). `npm run typecheck` → exit 0.
**Canonical authority:** `docs/product/mendpoint-product-platform-specification.md` (v2.0), per `docs/adr/0001-canonical-product-specification.md`.

This document exists to gate a training program. It is written to be pessimistic where the
evidence is thin, because a document that overstates readiness would authorize spending on
post-training that the measurement substrate cannot justify or validate. Every factual claim
carries a `path:line`. Where a claim could not be settled from code, it says so.

Product ↔ code naming: **Fettler = `warden` in code**, **ReGauge = `transformer` in code**
(`docs/agents/OPERATING_PROTOCOL.md:138-145`). DB tables use both (`fettler_*` at
`packages/db/src/index.ts:1322`, `regauge_*` at `packages/db/src/index.ts:1224`). API routes are
double-mounted under both names (`apps/api/src/server.ts:818-819,852-853`).

### Ownership boundary observed by this document

Codex owns the learning-event architecture, datasets, corpus generation, trainer integration,
adapter lifecycle, the model registry, router admission, canaries, rollback, the post-training
control plane, and the independent verifier (Phase 12, in flight). Those subsystems are
**documented here, not critiqued as things Claude should rebuild**. Claude's side is
eval/harness/trajectory. Where the two must meet, this document describes the seam.

---

## Summary of what Phase 0 found

Three findings dominate everything else.

1. **The system records that work happened; it does not record the work.** Per-run cost, tokens,
   model identity, and outcome status are durably and honestly recorded. The prompt, the
   completion, and the tool trajectory are not recorded anywhere, in any form, by any code path.
   `packages/agent/src/agent.ts:2730` builds the model input, `agent.ts:2511` hashes it, and it is
   then discarded. **No SFT or RL corpus can be constructed from production traffic today.**

2. **The evaluation suites cannot observe the failure mode that matters.** Both top-level runners
   stop at analysis — `evals/runners/regauge-runner.ts:183` and `evals/runners/fettler-runner.ts:91`.
   Neither applies a change, installs a dependency, compiles, or runs the subject repo's tests. A
   measured validation against kinked clones of express / react-tutorial / next.js found **12 of 35
   cases where the product is wrong and the eval is green**
   (`C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md:193`).

3. **The governed learning flywheel is real, rigorous, and currently carries constant labels.**
   PR #147/#162 built genuine consent, provenance, split-leakage, lease, and promotion machinery.
   The events it governs hard-code `attribution: "model_behavior"`, `verification.verdict: "passed"`,
   and `correction.substantive: true` (`apps/worker/src/warden-learning-producer.ts:112-117`,
   `apps/worker/src/governed-learning-producer.ts:206,239`). Zero label variance means zero
   learning signal, independent of volume.

The engineering quality of what exists is high. The honesty of the existing instrumentation is
unusually good — `packages/db/src/outcome-metrics.ts:216-224` refuses to report a metric it cannot
support, and `packages/agent/src/model-provenance.ts:36-37` returns a null cost rather than a
guessed one. The gap is not sloppiness. It is that the system was built to *deliver and prove
compliance*, and a training program needs it to *record and measure behaviour*.

---

## 1. Fettler (code: Warden) — external API/SDK/provider-change remediation

**What exists.** Entrypoint `analyzeImpact` (`packages/code-impact/src/index.ts:449`), pipeline
`index → candidates → expand → confirm → report` (`packages/code-impact/src/index.ts:454-474`).
Output `ImpactReport` (schema `packages/shared/src/index.ts:654-677`) carrying `sites`,
`overallConfidence`, `coverage` (`basis: analyzed|partial|not_analyzed`),
`lowConfidenceNotifications`, `ambiguousChanges`, `generatedReferences`, `vendoredReferences`.
Change diffing at `packages/change-intel/src/index.ts:582,746,789`. Worker jobs `pipeline.fanout`
(`apps/worker/src/cli.ts:3210`), `agent.run` (`:2562`), `warden.candidate.deliver` (`:2460`),
`.observe` (`:2482`), `.repair` (`:2501`), `.update` (`:2527`). Tables `impact_findings`
(`packages/db/src/index.ts:233`), `migration_prs` (`:245`), `agent_runs` (`:184`),
`fettler_candidate_deliveries` (`:1322`), `fettler_ci_observations` (`:1393`),
`fettler_model_reservations` (`:128`).

**What works.** One production caller of `analyzeImpact`: `packages/pipeline/src/index.ts:836`.
Reachable end-to-end from `POST /fettler/pilot` (`apps/api/src/warden-pilot-intake.ts:105`).
Extensively tested (`packages/code-impact/src/*.test.ts`, 10 suites;
`apps/worker/src/warden-router.test.ts`, 19 cases). The `coverage.basis` discriminator is the
best-designed honesty primitive in the codebase: an empty `sites` list reads as "clean" only when
`basis === "analyzed"`, otherwise `"unknown"` (`packages/code-impact/src/index.ts:166-172`),
satisfying spec §11.7's "no known impact ≠ complete evidence of no impact".

**What is missing.** The `ImpactReport` is **not persisted**. Only `sites` (flattened into
`impact_findings`, `packages/pipeline/src/index.ts:869-880`) and `coverage` (a JSON blob on
`migration_prs.coverage_json`, `:1643-1645`) survive. `overallConfidence`, `ambiguousChanges`,
`candidateCount`, `confirmedCount`, `lowConfidenceNotifications` exist only in memory. There is no
`impact_reports` table. Also absent: changelog/deprecation-prose ingestion (no RSS parser —
`docs/WARDEN_VISION_GAP_ANALYSIS.md:66-72`), any deprecation calendar, and a cost model for
adoption value (`capability_adoption_opportunities.value_basis` is free text,
`packages/db/src/index.ts:328`). `executeWardenCampaignTarget`
(`packages/pipeline/src/warden-campaign-executor.ts:407`) has tests and **zero production callers**;
its graph gate (`:311-337`) depends on `ingestRepositoryEvidence`
(`packages/graph-learn/src/runtime-evidence.ts:202`) which has no production writer, so the gate
could never pass even if wired.

**What is duplicated.** Two impact entrypoints with divergent confirmation logic — `analyzeImpact`
(`packages/code-impact/src/index.ts:449`) and `analyzeRepo` (`:481`, using a separate
`staticConfirmAll` at `:243`). Two import-graph builders
(`packages/code-impact/src/provenance.ts` for TS/JS, `lang-import-graph.ts` for Python/Go/Java,
whose own header at `:1-32` admits the re-implementation). Four symbol/call extractors
(`packages/call-graph/src/build.ts:1-11`, `packages/codebase-index/src/ts-frontend.ts:1-4`,
`packages/graph-learn/src/ast-ingest.ts:97` regex, `packages/graph-learn/src/lsp-ingest.ts:31,53`
— regex despite the name, admitted at `:25`). Four precision/recall implementations
(`evals/graders/fettler-graders.ts:56`, `packages/eval/src/warden-metrics.ts:78`,
`packages/eval/src/coverage-metrics.ts:661`, `packages/graph-learn/src/impact-benchmark.ts:216`).

**What is not instrumented.** Nothing. `packages/code-impact/src/*` contains zero telemetry calls
and zero log statements. No span wraps `analyzeImpact`. See §17.

**What is not measurable.** **There is no ground truth on any individual impact finding.**
`impact_findings` (`packages/db/src/index.ts:233-243`) has no verdict, label, `confirmed`, or
`was_correct` column, and no migration adds one. `review_decisions`
(`packages/db/src/index.ts:934-946`) keys on a candidate artifact, not a finding, so a rejection
cannot be attributed to a site. The only signal is PR merge/close, which
`packages/pipeline/src/index.ts:1932-1945` converts into `suppressed_patterns` rows scraped from
PR body text — and those are then used to filter future findings (`:850-863`). A PR closed for any
reason ("we'll do it next quarter", "we fixed it by hand") therefore *degrades future recall*, with
no mechanism to detect that it did. `calculateWardenMetrics`
(`packages/eval/src/warden-metrics.ts:78`) would compute precision/recall but requires a
hand-supplied `{truePositive, falsePositive, falseNegative}` struct (`:7`) that nothing produces.
Offline precision/recall exists and is honest — currently **precision 96.4%, recall 79.3%** against
a 85% floor, 2 open P0s (`evals/reports/readiness-scorecard.md:27,29`) — but it measures synthetic
fixtures and has no production counterpart.

---

## 2. ReGauge (code: Transformer) — internal/legacy modernization

**What exists.** 67 files, ~42k lines under `packages/transformer/src`. Recipe engine:
`analyzeRecipe` (`packages/transformer/src/recipe.ts:3642`), `applyRecipe` (`:3849`), inverse
rollback (`:3862`), registry `RECIPE_REGISTRY` (`:2907-2970`, 14 entries / 13 distinct ids).
Mission planning `planTransformerMission` (`packages/transformer/src/mission-planner.ts:78`).
Workspace execution `executeRecipeInWorkspace`
(`packages/transformer/src/recipe-workspace-execution.ts:864`). Tables
`regauge_adaptive_candidates` (`packages/db/src/index.ts:1224`), `regauge_adaptive_deliveries`
(`:1289`), plus two separate SQLite stores (`tf_pilot_*` in
`packages/transformer/src/pilot-execution.ts:1458-1494`; `tf_events` in `control-plane-store.ts:462`).

**Two disjoint execution loops exist, and neither is a superset of the other.**

- *Path A (pilot lane, main worker):* `apps/worker/src/cli.ts:3667` → `transformer-pilot-lane.ts:265`
  → `transformer-router.ts:507` → `packages/transformer/src/attempt-runner.ts:1686` →
  `recipe-workspace-execution.ts:864` → `attempt-runner.ts:843` (persist candidate) → **stop**.
  On the deterministic success path Path A **never produces a PR**; the terminal action is literally
  `"Review the durable candidate before draft delivery"` (`attempt-runner.ts:1878`). A PR appears
  only on the *failure* branch, where LLM adaptive repair engages (`attempt-runner.ts:1979`) and,
  after human approval (`apps/api/src/transformer-adaptive-review.ts:610`), delivery runs
  (`apps/worker/src/transformer-adaptive-delivery.ts:480`).
- *Path B (multinode, the deployed ReGauge topology per `fly.transformer.toml:14`):*
  `apps/worker/src/transformer-service-cli.ts:21` → `transformer-multinode-service.ts:147,175,368`.
  Path B **does** deliver and observe PRs, and **never** uses the router or adaptive repair.

**What works.** 439 tests pass across 36 files in `packages/transformer`. The recipe engine is
genuinely deterministic and correct on its authored surface — 10/10 ReGauge eval decisions correct,
0 unsafe matches (`evals/reports/latest.md:131-140`). Human review is mandatory and cannot be
self-approved (`apps/api/src/transformer-missions.ts:79`,
`apps/api/src/transformer-mission-authority.ts:363,299`). Abstention is a first-class behaviour, not
an afterthought: `mission-planner.ts:142-149` abstains on zero or ambiguous matches, and
`recipe.ts:3806-3814` refuses `unsupported`, `already_applied`, and incomplete states.

**What is missing.** **Execution never sees the repository.** The workspace is populated by
iterating `recipe.allowedPaths` only (`apps/worker/src/transformer-snapshot-loader.ts:181-214`) —
four files for `node-runtime-20-to-22`. There is exactly one process-spawn site in the entire
ReGauge surface (`recipe-workspace-execution.ts:603-630`) and it is hard-pinned to
`process.execPath` with `["--no-warnings", "-e", definition.script]` (`:594-600`). **No `npm`, no
install, no build, no repo test run.** "Verification" is an allowlisted one-liner that asserts the
transform just performed — e.g. the whole of `node-runtime-20-to-22`'s verification is a
`require('./package.json')` engine-string check (`recipe.ts:419-431`). That is a tautology, not
verification. Also missing: any merged/closed/reverted column on `regauge_adaptive_deliveries`
(`packages/db/src/index.ts:1289-1317`, status capped at
`delivery_pending|delivered|delivery_failed`); any signing key, revocation source, or signing tool
for the governed catalog (`grep trustedKeys` → evals and tests only); and any ReGauge readiness
gate (`evals/readiness-gates.json:7-15` defines one capability, Fettler).

**Residual detection exists and is structurally dead at execution time.** `isResidualSite`
(`recipe.ts:3542-3571`) and `residualSitePaths` (`:3573-3589`) are real, and `applyRecipe` refuses a
partial migration (`:3810-3812`). But `residualSitePaths` opens with
`if (allowed.has(path)) continue;` (`:3582`), and at execution the workspace contains *only*
`allowedPaths` files — so the set is always empty and `status` can never be `"incomplete"` inside
`executeRecipeInWorkspace`. Residual detection is live only at plan time
(`apps/api/src/transformer-mission-authority.ts:190-198`). Separately, `isResidualSite` handles only
three precondition kinds and ends `return false` (`recipe.ts:3570`) for every SDK, framework, and
internal-API kind — so for four of five families `residualPaths` is always `[]`.

**What is duplicated.** Two execution loops (above). **Three recipe-selection sites that do not
agree:** `mission-planner.ts:138-141` (source/target + `analyzeRecipe` applicability),
`apps/api/src/regauge-production-bootstrap-runtime.ts:361-365` (source/target only, no
applicability), and the signed catalog's `resolve()`
(`packages/transformer/src/recipe-catalog.ts:558-575`, unreachable from production). Two hardcoded
plain-contract arrays (`apps/api/src/api-runtime.ts:37-44` and
`regauge-production-bootstrap-runtime.ts:63-70`). Three delivery implementations. Two campaign
stores. Every API route mounted twice.

**ADR-0003 is correct, and understates the gap.** Recipe selection runs over plain
`MigrationRecipeContract`s (`recipe.ts:160-175`) that carry no signature, evidence, ownership,
provenance, or approval status. Production wires six of them by hand at
`apps/api/src/api-runtime.ts:37-43`. The signed `SignedProviderRecipe` machinery with ed25519
verification and revocation (`recipe-catalog.ts:136-144,530-552`) has **zero production callers**.
What ADR-0003 does not say: every place the signed catalog *is* exercised, the keypair is generated
in-process microseconds before verification (`packages/eval/src/transformer-agent-eval.ts:1112,1404`,
`packages/eval/src/transformer-canary.ts:339`). The evals prove Node's ed25519 round-trips, not that
a trust anchor governs anything. There is no key material anywhere to route to.

**Also note a production/eval divergence.** The eval runner considers seven exported recipes plus
registry-only internal-API variants (`evals/runners/regauge-runner.ts:105-120`); production wires
six and omits `INTERNAL_API_ACME_USER_RENAME_RECIPE` entirely — `grep internal-api apps/` returns
nothing. The internal-API family is evaluated but not shipped in production mission planning.

**What is not instrumented.** Nothing in ReGauge emits a metric or span; `grep` for
`recordCounter|recordHistogram|startSpan|withSpan` across `packages/transformer/src` and
`apps/worker/src/transformer-*.ts` returns no matches. `synthesizeTransformerRun` hardcodes
`durationMs: 0, toolCalls: 0, verifierCalls: 0` (`apps/worker/src/transformer-router.ts:409-411`).
Abstention reasons are returned to the HTTP caller (`apps/api/src/transformer-missions.ts:128`) and
discarded.

**What is not measurable.** `verificationPassRate` is structurally incapable of reporting failure:
`packages/transformer/src/pilot-execution.ts:1405` throws if `!verificationPassed`, then `:1418`
stores the literal `true`; the metric at `:3756` can only be `1` or `null`. `reviewerEditLines` and
`legacyItemsRemoved` are hardcoded to `0` by the only production observation producer
(`apps/worker/src/transformer-multinode-service.ts:415-416`), so the two human-effort signals are
always zero. Cost and tokens are NULL by construction on the deterministic path
(`transformer-router.ts:346-359`) — honest, since no model is called, but it means the 100%
deterministic path has no cost signal and Path B writes no ledger row at all. Recipe-level outcome
attribution is impossible: the signed artifact's `correlationFields` include
`recipeArtifactSha256` (`recipe-catalog.ts:130`), which production runs do not carry.

---

## 3. Change Graph

**What exists.** Five candidate packages, with very different liveness.

| Package | Verdict |
|---|---|
| `packages/graph` | **Live, not persisted.** Rebuilt per request from `api_changes` + `impact_findings` + `migration_prs` (`packages/graph/src/build-from-db.ts:5-16,159`), 15–60s TTL LRU (`packages/graph/src/cache.ts:41-43`), caps `MAX_FINDINGS=80`, `MAX_GRAPH_NODES=220` (`build-from-db.ts:25-26`). Serves `GET /graph/*` (`apps/api/src/server.ts:926,943,1612,1636`). |
| `packages/graph-learn` | **Live and persisted** — `gl_nodes`/`gl_edges` in a **separate SQLite file** (`packages/graph-learn/src/store.ts:26-50`, `singleton.ts:7-18`, `GRAPH_LEARN_DB`). Written by `runChangePipeline` (`packages/pipeline/src/index.ts:669,690,843,1917`). |
| `packages/call-graph` | **Partially live.** `buildCallGraph`/`buildCallGraphIncremental` consumed only by `packages/codebase-index/src/index.ts:13-14`; `impactSubgraph` only by `packages/graph/src/impact.ts:183`. ~1,014 lines exported and never called (`persistent.ts` 655, `demand.ts` 90, `validate.ts` 104, `snapshot.ts` 83, `red-green.ts` 82). |
| `packages/codebase-index` | **Live, persisted to disk** at `<repo>/.mendpoint/codebase-index.json` (`packages/codebase-index/src/index.ts:979-981`). |
| `packages/egraph` | **Live but cosmetic.** Output becomes `egraphNotes` appended to PR body markdown (`packages/generation/src/index.ts:377,379,464-468`). Changes no decision. |

**What works.** Real ingestion on every change fanout, real query surface (12 `/graph-learn/*`
routes at `apps/api/src/server.ts:1149-1341`), 20 tests in
`packages/graph-learn/src/graph-learn.test.ts`.

**What is missing.** The spec's entity list (`docs/product/mendpoint-product-platform-specification.md:1236-1300`)
demands Webhook, SDKMethod, ProviderVersion, ChangelogItem, Deprecation, ConfigObject, Job,
CIWorkflow, Team, Owner, Environment, Policy, Objective, Mission, Task, Finding, CandidateEdit,
VerificationResult, ReviewDecision, LearningEvent, Recipe, Adapter. `GlNodeKind`
(`packages/graph-learn/src/schema.ts:38-82`) has **none** of them. Spec edge kinds `OWNED_BY`,
`DEPLOYS_TO`, `WRAPS`, `USES_ENDPOINT`, `REPLACED_BY`, `VERIFIED_BY`, `REVIEWED_BY`, `IMPACTED_BY`
(`spec:1305-1329`) are absent from `GlEdgeKind` (`schema.ts:81-147`).

**Built, then not used for anything that changes an outcome.** The single blast-radius query in the
production pipeline (`packages/pipeline/src/index.ts:704-711`) produces `graphRagMd` (`:713`) whose
**only** consumer is string concatenation into the PR body at `:982`. It is decorative markdown. The
only graph query that gates a decision is `graphGateEvidence`
(`packages/pipeline/src/warden-campaign-executor.ts:311-337`) — inside dead code, reading data
nothing writes. Of the nineteen query ops in `packages/graph-learn/src/query.ts:770-789`, exactly
three are invoked by product logic; the rest are reachable only if a human POSTs to
`/graph-learn/query`. **Net: zero graph-gated decisions in production.**

Impact analysis builds and uses its *own* graphs and never reads `gl_nodes`/`gl_edges`. The two
graph systems are connected by one write (`packages/pipeline/src/index.ts:843`) and no read.

**What is duplicated.** Three change-impact graph builders that can disagree with nothing
reconciling them: `analyzeImpact`, `buildImpactGraph` (`packages/graph/src/impact.ts:56`), and
`blast_radius` BFS (`packages/graph-learn/src/query.ts`). Two persistent stores
(`graph-learn/src/store.ts:26-50` live, `call-graph/src/persistent.ts` dead). Two "who consumes
this" implementations.

**What is not instrumented.** Zero telemetry across the entire graph stack. No build-time metric,
no node/edge counts over time, no cache hit/miss counter, no truncation counter — `MAX_FINDINGS` /
`MAX_GRAPH_NODES` silently cap results (`build-from-db.ts:25-26`) while
`docs/website-upload/change-graph.md:60` claims "truncation is surfaced". Graph query failures in
`applyPrFeedback` are swallowed (`packages/pipeline/src/index.ts:1926-1928`).

**What is not measurable.** `gl_edges.confidence` is assigned by fiat at write time —
`1` for control-plane edges, and `1 / 0.7 / 0.4` mechanically derived from the finding's own
confidence string (`packages/graph-learn/src/ingest.ts:205,226,239-240`). It restates an input and
is never validated against an outcome. `gl_edges.label` (declared "GNN / outcome label",
`schema.ts:34`) is never written. `evaluateConfidenceCalibration`
(`packages/graph-learn/src/confidence-calibration.ts:173`) and `runImpactBenchmark`
(`packages/graph-learn/src/impact-benchmark.ts:148`) both exist, are tested, and have **zero
callers** — so there is no way to know whether a `confidence: 0.7` edge is right 70% of the time.
There is no graph completeness measure at all.

---

## 4. Model router

**What exists.** A well-built policy router: `routeTask` (`packages/platform/src/router.ts:450-546`),
deterministic canonical-JSON fingerprints (`:993-1010`), per-executor and per-provider circuit
breakers (`:260-265`), and a durable, fail-closed decision ledger — `recordRoutingDecision`
(`apps/worker/src/warden-router.ts:551-570`) writing `routing_ledger`
(`packages/db/src/index.ts:1108-1136`) with `selected_executor_id`, `eliminated_json`,
`fallback_json`, `breaker_json`, `decision_json`, `handoff_required`. Persistence failure throws
before dispatch (`warden-router.ts:571-576`); outcomes commit exactly once (`:502`).

**What works.** Capability elimination, the circuit breaker, human handoff on high risk,
exactly-once outcome recording, and honest null-cost semantics
(`wardenRoutingOutcomeAttribution`, `warden-router.ts:455-471`, returns all-NULL for an unmeasured
heuristic run rather than a fabricated zero).

**The router is correct and degenerate — confirmed.** Two production registries:

- `buildWardenExecutorRegistry` (`apps/worker/src/warden-router.ts:154-162`) constructs
  `new ExecutorRegistry()` and calls `register` **exactly once** (`:160`). Used at
  `apps/worker/src/cli.ts:2804`. One registered, at most one eligible.
- `buildRoutedExecutorRegistry` (`apps/worker/src/transformer-router.ts:134-143`) registers two
  (`:140,141`) — and every task it builds hardcodes
  `requiredCapabilities: [TRANSFORMER_CAPABILITY]` (`:189`), with no input field to change it
  (`TransformerRoutingRequestInput`, `:145-165`). Warden (`["warden.repair"]`,
  `warden-router.ts:169-171`) is therefore eliminated on 100% of passes at
  `packages/platform/src/router.ts:621-625`. The module comment says so plainly (`:127-133`).

**Exactly one eligible executor per production pass, in both lanes.** The 5-key ranking comparator
(`packages/platform/src/router.ts:691-700`) never breaks a tie, because there is never more than one
candidate. There is no cost/quality tradeoff being made.

**Of 13 router signals, 2 can change a production outcome.** Capability and circuit breaker are
real. Eight are hardcoded constants that can never fire: `status: "healthy"`
(`warden-router.ts:231`, no health probe exists), `commercialUse: true` (`:236`),
`qualityScore: 0.9` against a 0.7 floor (`:241` vs `:296-306`), `estimatedLatencyMs: 60_000` against
a 3,600,000 cap (`:242` vs `:349`), `estimatedCostUsd: 0` against a $25 budget (`:243` vs `:307`),
`allowedTools: []` (`:328`), region always `"internal"` (`:212,371`). **Quality, cost, and latency
are accepted as parameters and ignored.** Risk is a kill switch rather than a selector: risk `high`
returns `human_handoff` before evaluating any executor (`packages/platform/src/router.ts:492-503`),
risk `medium` (the hardcoded default, `warden-router.ts:314`) discriminates nothing. Adaptive
history is dead code in production — `PolicyRouterRuntime`
(`packages/platform/src/router-runtime.ts:266`), the only supplier of `adaptiveStats`, is
instantiated only in tests.

**`result.impactReport` is not available at selection time — confirmed.** ADR-0002 status is
**Proposed** (`docs/adr/0002-evidence-sequencing.md:3`). Impact analysis runs in the
`pipeline.fanout` job (`packages/pipeline/src/index.ts:836`); routing runs later in a separate
`agent.run` job (`apps/worker/src/cli.ts:2798-2809`). `warden-pilot-join.ts:120` reads
`result.impactReport` off a *completed* run. The router-side escalation mechanism exists —
`graph_coverage_incomplete` at `packages/platform/src/router.ts:369,466-483` — and the in-code
comment states plainly that no production caller supplies `coverage` (`:470-476`). Neither
`buildTaskSpec` populates `coverage`, `product`, or `blastRadius` (`warden-router.ts:318-352`,
`transformer-router.ts:181-218`). **Spec §13.7's escalation is code-complete and unreachable from
production.** Also note the executor that the router dispatches contains no impact-analysis code
at all: `packages/agent/package.json:16-20` declares only `@mendpoint/repair`, `@mendpoint/shared`,
`typescript`.

**What is duplicated.** `warden-router.ts` and `transformer-router.ts` are near-identical twins —
parallel `buildTaskSpec` (`:308` vs `:172`), `buildPolicySnapshot` (`:355` vs `:221`), and
outcome-attribution types (`:441` vs `:266`), each duplicating the same hardcoded constants. Two
canonical-JSON implementations (`warden-router.ts:103-119`, `transformer-router.ts:63-72`).

**What is not instrumented.** No telemetry on any routing path — DB writes only. `routing_ledger`
has **no `model` column**, and `synthesizeWardenRun` sets `provenance: []`
(`apps/worker/src/warden-router.ts:728`), discarding the per-call `LiveModelProvenanceRecord[]` on
that path.

**What is not measurable.** Router *quality* has no denominator — with one eligible executor there
is no selection to evaluate. Counterfactual ranking, whether an eliminated executor would have
succeeded, and the benefit of adaptive ranking (which never runs) are all unobservable. Latency is
derivable from `started_at`/`completed_at` (`packages/db/src/index.ts:1131-1132`) but
`actualLatencyMs` (computed at `packages/agent/src/routed-agent.ts:145`) is never forwarded to
storage.

---

## 5. Model identity, Muse integration, and vendor neutrality

**What is the current primary model in code, by env/config?**

The live call path is `packages/agent/src/agent.ts:2702` →
`resolveTenantModelBackend(task.tenantId, process.env)`.

- With `MENDPOINT_CUSTOMER_MODEL_ROUTING` unset (the default), this is a byte-for-byte pass-through
  to `resolveModelBackend` (`packages/agent/src/model-tenant-routing.ts:190-192`).
- With `MENDPOINT_MODEL_PROVIDER` unset (also the default), `resolveModelBackend` takes the default
  branch (`packages/agent/src/model-providers.ts:282-296`) and resolves the model name via
  `resolveAgentModelName`, which is
  **`env.LLM_AGENT_MODEL?.trim() || "gpt-4o-mini"`** (`packages/agent/src/model-endpoint.ts:59`).

**So the hardcoded fallback on the default path is `gpt-4o-mini`, not any Muse tier.**
`muse-spark-1.2-contributor` is the `defaultModel` of the *named* `muse-spark` provider
(`packages/agent/src/model-providers.ts:121`), reachable only when
`MENDPOINT_MODEL_PROVIDER=muse-spark` is explicitly set. The string **"Muse 1.2" does not appear
anywhere in the repository**.

This default is internally inconsistent: the default branch selects `DEFAULT_MODEL_PRICE_TABLE`
(`model-providers.ts:294`), which prices only `muse-spark-1.2` and `muse-spark-1.2-contributor`
(`packages/agent/src/model-provenance.ts:18,22`). `gpt-4o-mini` is not in it, so
`computeModelCostUsd` returns `null` (`model-provenance.ts:36-37`) and the run fails the
cost-measurement gate. **The env-unset default resolves to a model its own price table cannot
price.**

**What the deployment actually sets.** No committed config pins `LLM_AGENT_MODEL` or
`MENDPOINT_MODEL_PROVIDER` — `fly.toml`, `fly.customer-warden.toml`, and `fly.transformer.toml`
contain neither. The production ReGauge value comes from a GitHub secret:
`LLM_AGENT_MODEL: ${{ secrets.REGAUGE_MODEL_ID }}`
(`.github/workflows/regauge-production.yml:103`). **The production model identity is not knowable
from this repository.** `.env.example:120` carries a commented `# LLM_AGENT_MODEL=muse-spark-1.2`
(the non-contributor tier).

**Where `muse-spark-1.2-contributor` genuinely appears in live logic** (three sites): the
`muse-spark` provider default (`model-providers.ts:121`); the price table
(`model-provenance.ts:22`); and — most importantly — `DEFAULT_TRAINING_TIER_MODELS`, the
fail-closed training-tier denylist (`packages/agent/src/model-tenant-routing.ts:59`). That module
is the data-governance gate: an allowlisted internal tenant may use the contributor training tier;
every other tenant, and any unbound call, fails safe to `non_training` and throws
`model_training_tier_forbidden_for_tenant` if a training tier would be reached
(`model-tenant-routing.ts:130-155`). Note the enforcement is currently dormant: customer routing is
off by default (`:190`), so the guard never fires in the present deployment, and the non-training
endpoint does not exist yet (`:25-29`).

**Hardcoded vendor names in live product logic** (not tests, not docs):
`packages/agent/src/model-endpoint.ts:59` (`gpt-4o-mini`, the default-path fallback);
`packages/agent/src/model-providers.ts:121,132,143,156,168,180` (per-provider defaults:
`muse-spark-1.2-contributor`, `gpt-4o-mini`, `grok-2-latest`, `gpt-4o-mini`,
`claude-3-5-sonnet-latest`, `gemini-1.5-flash`); price-table keys at `model-providers.ts:90-103`
and `model-provenance.ts:18,22`; **`packages/code-impact/src/llm-confirm.ts:168`**
(`xai ? "grok-3-mini" : "gpt-4o-mini"`); and **`packages/repair/src/plan.ts:193`**
(`process.env.LLM_REPAIR_MODEL ?? "gpt-4o-mini"`).

**Four independent model-call implementations exist, with four env schemes.** Only
`packages/agent/src/agent.ts:2702` goes through the governed gateway. `llm-confirm.ts:160-207`,
`packages/repair/src/plan.ts:127-195`, and
`apps/worker/src/transformer-adaptive-planner.ts:229-240` each bypass the tenant training-tier
guard, the price table, and provenance capture entirely. **Spend and model identity attributable to
`llm-confirm` and `repair/plan` are unrecorded.**

**Doc/code disagreement.** `docs/evals/current-system-map.md:80-81` states the gateway default is
`muse-spark-1.2-contributor`. On the env-unset path it is `gpt-4o-mini`
(`model-endpoint.ts:59`). This line should be corrected.

---

## 6. Independent verifier — boundary, not a gap

**Codex owns this. It is in flight and not yet in this tree.** Branch
`codex/172-muse-deepseek-verifier` exists locally with zero commits ahead of `origin/main`;
`origin/codex/muse-nontraining-model` carries one commit touching
`packages/agent/src/model-tenant-routing.ts`. Recording the baseline honestly:

**What exists today: zero occurrences of "deepseek" anywhere in the repository** (case-insensitive,
all file types). Not stubbed, not typed, not documented.

**What exists that is adjacent, and what it is not.**

- *In the product path,* the only "verifier" is a **shell command**, not a model:
  `AgentRunResult.verifier` is `{command, source, status, output}`
  (`apps/worker/src/warden-router.ts:694-699`); `verifierId` is the literal string
  `"warden-verifier"` (`packages/agent/src/routed-agent.ts:153`). `run_command` is restricted to the
  exact `verifyCommand` (`packages/agent/src/agent.ts:2724`). Exactly one model call site exists per
  attempt-loop iteration (`agent.ts:2771`). **No second model, critic model, or judge model is
  invoked anywhere in the product path.**
- *In the evals,* every "judge" is deterministic too. `runJudge`
  (`packages/eval/src/warden-source-eval.ts:543-551`) executes `fail-to-pass.mjs` /
  `pass-to-pass.mjs` Node scripts. `objective.hidden_semantic_judge`
  (`packages/eval/src/agent-eval-live.ts:407`) resolves to a **regex test** (`:496,229-237`).
  `evals/graders/DEFERRED.md:49` states it: "No LLM grader is used here."
  **There is no LLM-as-judge in the evals either.** The word "judge" is used for at least four
  unrelated things, which makes any claim about "judges" unfalsifiable without reading the code.
- *The closest existing thing* is `packages/code-impact/src/llm-confirm.ts` — a genuine
  second-model confirmation for medium-confidence impact sites, reached from
  `packages/code-impact/src/index.ts:465`. It is **off by default**:
  `resolveLlmConfirmMode()` returns `"off"` unless `LLM_CONFIRM_MODE`/`LLM_CONFIRM` is explicitly
  set (`llm-confirm.ts:38-49`), and the sole production caller passes no `useLlm`
  (`packages/pipeline/src/index.ts:836-838`). Verdict: **present, wired, configured off.**

### How Claude-owned eval/harness/trajectory work should integrate when the verifier lands

This is the Claude-side seam, stated as requirements on *our* capture, not on Codex's verifier.

1. **A verifier verdict must attach to a trajectory node, not to a run.** The trajectory schema we
   build (see §9 and Blocker 4) should carry an optional `verification[]` array per step and per
   candidate, each entry `{verifierId, verifierModelId, verdict, confidence, rationaleRef,
   latencyMs, costUsd}`. Attaching at run granularity would make disagreement unanalysable, because
   a run has many candidate states.
2. **Disagreement must be first-class and recorded even when it changes nothing.** The analysable
   quantity is the joint distribution over (verifier verdict, test/compiler result, ground truth,
   human decision). That requires recording the verifier's opinion on runs where it was *overruled*
   — which means capturing it in shadow mode from day one, before it gates anything.
3. **The verifier must remain a soft signal.** It must never override, and the schema must make
   overriding impossible to express: tests, compiler output, ground truth, graph invariants, and
   human correction are hard signals. Concretely, the precedence must be encoded in data
   (`signalClass: "hard" | "soft"`) rather than in the consuming code, so a later change cannot
   quietly promote it. Note the existing failure mode this protects against:
   `packages/repair/src/verify-sandbox.ts:12-17` records that a silent fallback "already produced a
   fake-green once (#99)".
4. **Verifier cost and latency must land in the same accounting as any other model call.** Today
   `packages/agent/src/model-provenance.ts:66-100` captures echoed model, tokens, host, and cost per
   call; a verifier call must produce the same record, or verifier spend will be invisible the way
   `llm-confirm` spend is invisible today (§5).
5. **What we owe Codex:** a stable candidate identity to attach a verdict to. Today the Warden
   candidate is a sealed file referenced by
   `fettler_candidate_deliveries.sealed_path`/`sealed_sha256`
   (`packages/db/src/index.ts:1335-1336`); that digest is a usable join key and should be the
   verdict's subject.

---

## 7. Test-time compute / Best-of-N — Phase 13 baseline

**Absent. Completely.** Grep for `bestOf`, `best_of`, `rerank`, `majority`, `self-consistency`,
`selfConsistency`, `nSamples`, `candidateRank`: **zero hits**. Every `sampleCount` hit is a
statistics field over observations (`packages/eval/src/coverage-metrics.ts:67,121,132`), not
generations.

Every model request is single-shot at a fixed temperature, with no `n` parameter anywhere:
`temperature: 0.1` (`packages/agent/src/agent.ts:2740,2765`), `temperature: 0`
(`apps/worker/src/transformer-adaptive-planner.ts:234`,
`packages/code-impact/src/llm-confirm.ts:202`), `temperature: 0.1`
(`packages/repair/src/plan.ts:193`). No loop varies temperature; no path issues parallel
generations; no path scores or selects among generations.

Two things that look like Best-of-N and are not:

- **"Candidate" already means a pull request here**, not a sample. `warden-candidate-*.ts` is the
  PR pipeline, one candidate per run (`packages/db/src/outcome-metrics.ts:211`). Any Best-of-N work
  will collide with this vocabulary and should pick a different noun.
- **`pass@k` in the evals is measurement, not selection.**
  `packages/eval/src/agent-eval-contract.ts:226-227` computes `passAtK = trials.some(...)` over
  repeated independent offline trials. It never selects a best candidate and never runs in the
  product path.

Retries are not Best-of-N: `fallbackPolicy: {maxAttempts: 3, sameExecutorRetries: 1}`
(`warden-router.ts:340-346`) is failure-triggered and gated on
`["timeout","rate_limited","provider_unavailable"]`. A successful-but-poor result is never retried,
and there is no ranking step.

**Candidate provenance is not recordable today.** `routing_ledger` has exactly one
`selected_executor_id` per envelope with `UNIQUE (tenant_id, job_id, envelope_id)`
(`packages/db/src/index.ts:1108-1136`). The schema physically cannot hold multiple candidates per
envelope. Any Phase 13 work needs a new candidate table before it needs a sampler.

---

## 8. Retrieval

**What exists.** **No semantic, vector, or embedding retrieval anywhere.** The only thing named
"embedding" is `hashEmbedding` (`packages/graph-learn/src/embeddings.ts:32`), which builds a vector
by SHA-256 hashing `${text}::${i}` — its header says "deterministic hash vectors (no ML dep)"
(`:1-3`). Two semantically identical strings differing by one character produce uncorrelated
vectors. Its only caller is an admin HTTP endpoint (`apps/api/src/server.ts:1327`). No cosine, no
nearest-neighbour, no pgvector, no bm25, no tf-idf. The schema declares the field unused
(`schema/v0.md:31`: "Not populated in Phase 1"), and `"embedding"` is a declared but never-produced
`CandidateSource` enum arm (`packages/shared/src/index.ts:478`).

Retrieval is lexical plus AST/import-graph, in two disjoint systems:

- **The agent's retrieval** (the one that feeds prompts): the `search` tool
  (`packages/agent/src/tools.ts:595-668`) walks the tree (`:619`) and builds
  `new RegExp(escaped, "i")` (`:621`) — an escaped literal, case-insensitive substring match.
  **There is no ranking.** Hit order is filesystem walk order, truncated at 40
  (`packages/agent/src/agent.ts:94`).
- **The impact-analysis retrieval** (`packages/code-impact/src/candidates.ts:1-9`): four
  provenance-gated layers, with confidence as a 3-value ordinal bucket (`:20-26,230`). This does
  **not** feed the agent prompt.

**The file-selection policy, in full.** `nextHeuristicCall`
(`packages/agent/src/heuristics.ts:32`): take search hits, dedupe, `.slice(0, 10)` (`:92-96`); else
filter `list_dir` filenames by `/client|api|http|sdk|charge|webhook|retry|fetch/i` **on the filename
string**; else `files.slice(0, 8)` (`:97-103`). That is the ranker.

**The agent package depends on no index.** `packages/agent/package.json:16-20` lists
`@mendpoint/repair`, `@mendpoint/shared`, `typescript`. Not `codebase-index`, not `call-graph`, not
`graph`. **The static-analysis stack is architecturally disconnected from the agent that writes
code.**

**What is not instrumented.** No hit-rate, hits-per-query, or queries-to-first-relevant-file
counter. `AgentStep` (`packages/agent/src/types.ts:63-69`) has no timestamp and no duration. There
is no record of *which* search produced the file that was ultimately edited. Truncation *is*
honestly counted and surfaced to the planner (`tools.ts:657-666`) — the one bright spot.

**What is not measurable: recall@k cannot be computed.** The numerator exists on one of two paths —
`metrics.sourceContext.observedFiles` (`packages/agent/src/types.ts:312`) reaches
`agent_runs.result_json.agent` on the immutable-snapshot attempt path
(`apps/worker/src/cli.ts:3043`); the legacy path writes only six scalars (`:2656-2664`). **The
denominator does not exist at all.** `agent_runs.files_changed_json` records what the agent changed,
not what the correct fix should have changed — using it as ground truth is circular. No table links
a run to a human-authored gold patch. The only gold-file dataset is offline and synthetic
(`evals/ground-truth/*.json`), and it grades `code-impact`, not the agent
(`evals/runners/fettler-runner.ts:47,11-15`).

---

## 9. Context assembly

**Four independent prompt builders, sharing no template, budget, or serializer:** the Warden agent
(`packages/agent/src/agent.ts:2713-2730`), the repair planner
(`packages/repair/src/plan.ts:161-172`), impact LLM confirmation
(`packages/code-impact/src/llm-confirm.ts:52,204-206`), and the Transformer adaptive planner
(`apps/worker/src/transformer-adaptive-planner.ts:236-238`).

**The single context-selection function is `plannerInput()`
(`packages/agent/src/agent.ts:2432-2492`).** By default **no file content enters the prompt**:
`redactedEvidence` (`:2383-2415`) reduces a `read_file` result to
`{path, offset, totalChars, truncated, contentDigest, contentBytes}` and a `search` result to
`{path, line}` pairs — content is replaced by a SHA-256 digest. Source text reaches the model only
when a tenant has an approved external-processing policy (`modelSourceAuthorized`, `:2418-2430`;
`fly.customer-warden.toml:39` sets `MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED = "1"`, `fly.toml` does
not). The model therefore plans over filenames, line numbers, digests, and 500-char summaries.

**Budgets exist; compaction does not.** `maxPromptEvidenceBytes: 16 * 1024`
(`agent.ts:95`), enforced by byte-slicing mid-string (`:2458` —
`bytes.subarray(0, remaining).toString("utf8")`, which can emit a truncated UTF-8 sequence).
Structural caps are fixed constants: last 10 steps (`:2450`), 40 observed digests (`:2443`), 40
search hits (`:2407`), goal ≤4000 chars (`:2481`), errorLog ≤2000 (`:2482`). **There is no token
counting** — every budget is in bytes or item counts, and `promptTokens` is read back from the
provider's usage response (`:2644`), never estimated. **There is no compaction or summarization**:
`steps.slice(-10)` is a hard window against `MAX_WARDEN_STEPS = 48` (`:69`), so a full-length run
discards ~79% of its own history with no carried summary.

**Is the assembled context persisted? No.** The prompt is built as local consts
(`agent.ts:2713,2730,2736`), used for the HTTP body (`:2790`) and for a **reservation digest**
(`reserveExternalModelCall(task, requestBody, ...)`, `:2771`; digest computed `:2511`, stored as
`fettler_model_reservations.request_digest`, `packages/db/src/index.ts:136`). A digest proves two
runs sent the same bytes. It does not let you read them.

What lands durably instead: `agent_runs.result_json.agent` = `WardenAttemptAgentSummary`
(`packages/agent/src/attempt-engine.ts:110-144`) — counts, `stoppedReason`, `reportMarkdown`,
`sourceContext`, `missionPlan`, `usage`. `report_md`'s "Trace" section is the last 12 steps, one
line each, no arguments and no results (`agent.ts:2982-2986`). The durable checkpoint stores
`callDigest`/`resultDigest` — **hashes, not values** (`packages/agent/src/checkpoint.ts:63-72`) —
head-only via compare-and-swap so prior generations are destroyed
(`apps/worker/src/warden-checkpoint-journal.ts:333-346`), and only when
`MENDPOINT_APPLICATION_DATA_KEY` is set (`apps/worker/src/cli.ts:2868-2872`), which `fly.toml` does
not set.

`artifact_manifests.content_text` (`packages/db/src/index.ts:548`) *could* hold a prompt. Nothing
ever puts one there.

---

## 10. Tools (the agent action space)

**What exists.** Nine declared, eight usable. Type union `packages/agent/src/types.ts:6-15`,
allowlist `packages/agent/src/agent.ts:100-110`, dispatch `packages/agent/src/tools.ts:484,850`:
`list_dir` (`:492`), `read_file` (`:529`), `search` (`:595`), `write_file` (`:671`),
`replace_in_file` (`:716`), `delete_file` (`:769`), `run_command` (`:799`/`:855-905`, restricted to
the exact `verifyCommand` at `:861`), `finish` (`:831`). The ninth, `http_probe` (`:808`), is
**dead**: it returns `sync_not_supported` (`:826`), `allowNetwork: false` is hardcoded
(`apps/worker/src/cli.ts:2639`), and it is omitted from the system prompt's tool list
(`agent.ts:2716`).

**What works — and it is genuinely strong.** Every mutation requires a versioned
`AgentExecutionIntent` (`packages/agent/src/types.ts:36-53`) carrying `targetDigest` and
`evidenceRefs` validated against digests the agent actually observed
(`packages/agent/src/agent.ts:1728,1739`), plus a post-hoc `expectedResultDigest` check (`:4074-4084`).
This is the best-engineered grounding mechanism in the codebase.

**What is not instrumented — and this is the trajectory blocker.** `AgentStep`
(`packages/agent/src/types.ts:63-69`) holds tool name, args, result, and error **in memory**
(pushed at `agent.ts:4091-4097`). It has **no duration and no timestamp** — there is no `Date.now()`
around `executeTool`/`executeToolAsync` at `agent.ts:3467,4046,4158,3880`. There are **zero log
statements in the 4,222-line agent** (`grep console.log|console.error|logger` in
`packages/agent/src/agent.ts` → nothing). Args and results are **never persisted**: they survive
only as digests in the conditional checkpoint, and `synthesizeWardenRun` explicitly drops the array
— `steps: []` (`apps/worker/src/warden-router.ts:701`). There is no `agent_steps`, `tool_calls`, or
`trajectory` table anywhere in `packages/db/src/index.ts`.

**Two trajectory systems, neither giving a production transcript.** `packages/harness/src/trajectory.ts`
writes `runs/<id>/{plan.json, trace.jsonl, score.json}` (`:50-62`) with typed events
(`:14-19`) and per-step start/end (`packages/harness/src/executor.ts:139-145,172-177`) — the best
event model in the repo, and **`apps/worker` does not import `@mendpoint/harness` at all**; its only
API consumer uses `collectDogfood` (`apps/api/src/server.ts:209,1527`). The other is the digest-only
checkpoint (§9).

**What is not measurable.** Per-tool success rate, which tool sequence correlates with success,
whether `search` or `list_dir` is the better entry point, time-to-first-edit. All require per-call
records that are never written. `AgentExecutionMetrics` (`packages/agent/src/types.ts:293-322`) has
one aggregate `toolCalls` and `verifierCalls`, with no breakdown by name.

---

## 11. Verification

**What exists.** `SandboxKind = "local" | "vm" | "in_cluster" | "fly_machines"`
(`packages/platform/src/sandbox.ts:24`). `local` is `mkdtempSync` in the OS temp dir, and its own
comment says "Not process or network isolation" (`:200-202`). `fly_machines` is real
(`packages/platform/src/fly-sandbox.ts`, verification path
`packages/repair/src/verify-sandbox.ts`). `vm` and `in_cluster` **throw** (`sandbox.ts:193-197`).
There is no `docker` backend. Eleven verification profiles exist
(`packages/repair/src/verify.ts:12-26`) with real discovery (`:87-113`) and real `execFile`
(`:350-357`); the attempt engine runs baseline plus final target/regression/security suites
(`packages/agent/src/attempt-engine.ts:968-1010,1168-1183`).

**[Refreshed 2026-08-21, past this document's `fcec22e` pin.]** The two paragraphs below describe
current `origin/main`, not the pinned `fcec22e` (2026-08-17). This is the most security-relevant
claim in the file, and it changed the morning after the pin: PR #164 (`a930ee6`, 2026-08-18 05:28,
"Enable fly_machines sandbox verification on the demo app") switched the sandbox on in config, and a
later customer-profile change re-granted the worker its credential. At `fcec22e` the original text —
default `local`, `MENDPOINT_SANDBOX_KIND` absent everywhere, worker denied the credential — was
accurate. It no longer is. The rest of this document remains as of `fcec22e` unless similarly marked.

**What is the effective default in production? `fly_machines`.** The resolution order is unchanged —
`opts.kind → tenantSandboxKind → MENDPOINT_SANDBOX_KIND → "local"`
(`packages/platform/src/sandbox.ts:226-228`), so an *unset* variable still falls back to `local`. But
`MENDPOINT_SANDBOX_KIND` is now **explicitly set to `fly_machines`** in both deployed configs —
`fly.toml:35` (demo) and `fly.customer-warden.toml:43` (customer) — each pinned to an immutable image
digest (`fly.toml:48`, `fly.customer-warden.toml:56`). It remains **absent only from
`fly.transformer.toml`** (env block `:6-20`), whose worker therefore still resolves to `local`. `vm`
and `in_cluster` still throw (`sandbox.ts:237,244-248`); `local` still self-describes as "Not process
or network isolation" (`:254`). So the earlier claim that host `execFile` runs "in every deployed
configuration" now holds only for the transformer pilot, not the demo or customer apps.

**`fly_machines` was already written, tested, and fail-closed at the pin; what changed is that it is
now selected in config and the worker is granted the token.** PR #164 — described in the pinned
revision as "not merged" and "BLOCKED" — merged as `a930ee6` (2026-08-18). The image is
digest-pinned in reviewed config (`fly.toml:48`), which contradicts the pinned revision's "image was
likely never pushed." The worker is **no longer structurally denied the credential it needs.**
`resolveFlySandboxToken` prefers `MENDPOINT_SANDBOX_FLY_TOKEN`, falling back to `FLY_API_TOKEN`
(`packages/platform/src/fly-sandbox.ts:352-355`). The customer profile still strips both sensitive
tokens (`scripts/customer-warden-profile.ts:149`), but `CUSTOMER_ROLE_SECRETS.worker` now **re-grants
`MENDPOINT_SANDBOX_FLY_TOKEN`** (`:125`, re-added at `:151-153`); a test asserts the worker child now
receives it (`scripts/customer-warden-profile.test.ts:171`) while the generic `FLY_API_TOKEN` stays
denied (`:176`). Two caveats remain, checkable only against operational state and not the repo:
whether the sandbox Fly app is actually provisioned and reachable, and whether the
`MENDPOINT_SANDBOX_FLY_TOKEN` secret is actually set on the app. If no token resolves, `fly-sandbox`
fails closed and refuses host fallback (`fly-sandbox.ts:547`) rather than degrading to the old
behaviour.

**Does verification run the target repo's build/tests? Mechanically yes; in deployed config,
effectively no.** When `NODE_ENV === "production"`, `packages/repair/src/verify.ts:261-294` requires
either a `node-check` file whose SHA-256 is in `MENDPOINT_APPROVED_VERIFIER_SHA256S`, or the exact
normalized command in `MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION` — otherwise **exit 126**.
`fly.toml:28` lists exactly one approved hash. **`MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION` is set
nowhere in the repository** (it appears only in `packages/repair/src/session.test.ts`).
`fly.customer-warden.toml` sets neither. So on the demo app only one specific `check.mjs` can run,
and in the customer profile **all verification fails closed with exit 126** unless an operator
injects the variables at runtime — while `MENDPOINT_VERIFY_FIRST = "1"` is set in both
(`fly.toml:27`, `fly.customer-warden.toml:35`).

**Is the result persisted per attempt? Partially, and the useful part is off-database.**
`VerificationRecord = {command, ok, exitCode, outputSha256}`
(`packages/agent/src/attempt-engine.ts:194-199`) — note **no duration** — is written into an
**evidence artifact file** (`:1252-1263`, `writeArtifactPair` `:1272-1279`), not the DB. Only the
file's sha256 reaches the database. Worse, `reviewEvidence` normalizes failures away, rewriting
every command to `ok: true, exitCode: 0` after asserting they all passed (`:758,771`). The legacy
path stores `verifier: {command, source, status, output}` in `result_json`
(`apps/worker/src/cli.ts:2657`, type `packages/agent/src/types.ts:325-330`) — command and pass/fail,
**no exit code**. And the artifact holding exit codes is deliberately deleted on retention expiry
(`apps/worker/src/cli.ts:1157,1163-1168`).

**What is not measurable.** Verification pass rate by command/profile/language; verifier wall-clock
(never measured anywhere); **the exit-126 refusal rate**, which given the above is probably the
dominant failure mode in deployed configs and is invisible — both a genuine test failure and an
approval-gate refusal surface as `verifier.status = "failed"` (`agent.ts:4128`); and **which sandbox
backend actually ran** — `configuredSandboxKind()` (`packages/repair/src/verify-sandbox.ts:73-75`)
is never recorded in any column, audit field, or artifact. Given that a silent fallback "already
produced a fake-green once (#99)" (`verify-sandbox.ts:12-17`), the inability to retrospectively tell
whether a run was isolated is the single most dangerous audit gap found.

**Doc defect.** `docs/SANDBOX_VERIFIER.md:163-165` claims the sandbox variables are "already wired
in `fly.toml` and `fly.customer-warden.toml`". They are in neither file.

---

## 12. Synthetic repo evals

Two suites exist. **Correction to prior briefs: `evals/` IS wired into CI**, as of `75e3ea1`
(2026-08-17).

### Suite 1 — `packages/eval` (the hard gate)

`.github/workflows/ci.yml:26-27` runs `npm run eval:agents -- --repetitions=3`
(`package.json:41`). 45 scenarios × 3 = 135 trials. Threshold is **100% with determinism**:
`agent-eval-contract.ts:277-278` requires `results.every(r => r.passed)` with zero critical and zero
determinism failures; per-scenario `passed = passToK && deterministic` (`:243`) is pass^3, not
pass@3; exit 1 on failure (`agent-eval.ts:102`).

Fixtures are **synthetic string literals materialized to a tmpdir**: the held-out repository is five
strings (`transformer-agent-eval.ts:98-113`), the gold answer is a hardcoded digest (`:126-127`),
and the "tests" are two inline one-line node scripts (`:134-145`). No `npm install`, no `tsc`, no
repo test run anywhere in this suite.

The strongest artifact in the whole eval estate is `PRODUCTION_RUNNER_SCENARIO`
(`transformer-agent-eval.ts:746-1087`): it materializes a real repo on disk, drives the **real
production worker lane** `runTransformerPilotLaneOnce` (`:904-918`) against a real SQLite DB, and
runs an **independent fail-to-pass / pass-to-pass judge** by spawning `node -e` on baseline and
candidate trees (`:943-946`), graded critical (`:1032-1045`). That is a strong regression harness
for executor plumbing. It is not evidence that a migration on a customer repo compiles.

**The live-model lane is empty and silently green.** `agent-eval.ts:85-87` prints "Live model
capability not evaluated" when the lane is empty; every scenario declares `contract` or
`simulated_scripted` (`specialist-scenarios.ts:136,285,499`,
`transformer-adaptive-delivery-eval.ts:202`, `warden-source-eval.ts:1060,1123`). The `passed`
computation (`agent-eval.ts:45`) does not require the lane to be non-empty. The real live-model eval
runs only in `.github/workflows/regauge-production.yml:294`.

### Suite 2 — top-level `evals/`

43 scenarios (21 hand-authored synthetic repos on disk under `MENDPOINT_CORPUS_ROOT`,
`evals/scenarios/index.ts:18-20,43-164`; 22 seeded mutations,
`evals/generators/families.ts:376-411` incl. 4 holdouts at `:365-373`). Grading is **100%
deterministic** — no LLM judge anywhere (`evals/graders/fettler-graders.ts:12`,
`regauge-graders.ts:4`, `DEFERRED.md:49`), with the model hard-disabled
(`fettler-runner.ts:92`).

Wired at `.github/workflows/ci.yml:46-49`, plus a nightly full-corpus job
(`.github/workflows/nightly-synthetic-eval.yml:19-43`). **It cannot fail the build**:
`run-all.ts:274-277` exits non-zero only with `--enforce-readiness`, which CI does not pass; the
workflow comment states this deliberately (`ci.yml:44-45`). The build is green while
`evals/reports/latest.md:21` reads "Overall readiness: FAIL". Also, `evals/package.json:5` declares
itself "not a workspace", so `evals/**/*.test.ts` are invisible to root `npm test` and run only via
`eval:synthetic:check`.

**Both runners are analyze-only — confirmed, and the briefing was incomplete: Fettler's is too.**
- `evals/runners/regauge-runner.ts:182-191` calls `analyzeRecipe` at **line 183** and nothing else;
  `produced_edit: false` (`:166`); self-declared unmeasured dimensions at `:170-175`; imports carry
  no `child_process`, no `applyRecipe`, no `executeRecipeInWorkspace` (`:19-35`).
- `evals/runners/fettler-runner.ts:91-95` calls `analyzeImpact` and nothing else;
  `produced_edit: false` (`:122`); unmeasured dimensions at `:62-67`.

**Readiness gates cover exactly one capability — confirmed.** `evals/readiness-gates.json:7-15`
defines only `fettler-impact-analysis` (`impact_precision_min: 0.9`, `impact_recall_min: 0.85`,
`max_open_p0: 0`, `holdout_dev_gap_max_pp: 10`). Two skips: capability-level at
`evals/readiness.ts:241-248` (an `if (name === "fettler-impact-analysis")` with no `else`, so any
other capability is silently dropped) and run-level at `:127-128`
(`if (s.record.product !== "fettler") continue`). All 10 ReGauge scenarios contribute nothing to any
readiness metric; the scorecard says "not gated" (`evals/reports/readiness-scorecard.md:37`).

**Current verdict: FAIL.** precision 96.4% (pass), recall 79.3% vs 85% (fail), 2 open P0s (fail),
holdout within 10pp (pass) — `evals/reports/latest.md:27-30`. Sixteen open entries in
`evals/FAILURES.md`, every one carrying the placeholder root cause "to be diagnosed (Phase 7)" and
owner `unassigned`.

**The grader's own definition of "passed" is self-referential.**
`evals/graders/regauge-graders.ts:16-17`: *"`passed` = the engine did the SAFE, expected thing for
the CURRENT shipped engine. COVERAGE_GAP and HARNESS_LIMITATION notes never flip it"*, enforced at
`:212`. It grades against current behaviour, not against what a customer needs.

### Does anything measure "the PR compiles, tests pass, migration complete"? No.

| Claim | Suite 1 | Suite 2 |
|---|---|---|
| The PR | Never created — `transformer-agent-eval.ts:1054-1064` grades `runner.no_delivery_side_effect`, i.e. it **rewards not delivering** | `fettler-runner.ts:65` "pr_delivery (not exercised)" |
| Compiles | No `tsc`, no build, no install anywhere in `packages/eval/src` | `evals/graders/DEFERRED.md:8-17` "deferred (no migrated tree yet)" |
| Tests pass | Two hand-written judge scripts on a 5-file string fixture | `DEFERRED.md:19-28` "deferred (needs apply + sandbox)" |
| Migration complete | Byte-equality against a frozen gold digest on a 4-file diff | File-set overlap vs a JSON key; residuals recorded but non-fatal (`regauge-graders.ts:93`) |

### The measured consequence

The independent OSS validation (`C:\Users\Talal\dev\oss-kinked\VALIDATION-REPORT.md`) built 35 cases
from kinked clones of express (`a3714473`), react-tutorial (`ec8d845a`), and next.js (`6be68703`),
and found **12 cases where the product is wrong and the eval is green** (`:193`). In four of them
the product produced a **signed `transformer.recipe.execution` evidence record with both
verification commands at exit 0** for a repo that no longer installs (`:203-210`).

**I re-verified this report against current `main`.** `git diff --stat 1d3ae5a..fcec22e --
packages/transformer/src/recipe.ts packages/transformer/src/recipe-workspace-execution.ts evals/`
returns **empty** — the three trees the report analysed are byte-identical to the commit it was
written against. `isResidualSite` is still at `recipe.ts:3542` ending `return false` at `:3570`;
`dockerNodeMajors` at `:3529`; the incomplete-refusal throw at `:3812`. The report stands in full.
PR #174 (`claude/residual-detection-all-families`) and `claude/regauge-family-readiness`, which
would change this, are **open and unmerged**.

**A structural note the report makes and that matters most for Phase 2:** the SDK and framework
recipes hardcode `allowedPaths` to exact filenames (`src/s3.js`, `src/client.js`, `src/index.tsx`).
No real repository has those paths — express has 213 files and next.js 31,220, and neither contains
one. So for any real consumer, every other file using the SDK is a residual **by construction**. The
residual case is not an edge case for those families; it is the default.

---

## 13. Learning events (Codex-owned — documented)

**What exists.** `GovernedLearningEventV1` (`packages/pipeline/src/learning-event.ts:46-106`): a
carefully bounded envelope with identity (`:47-53`), specialization (`:54-62`), execution
(`modelId`, `adapterId`, `routerDecisionId`, `fallback`, `:63-68`), artifact references
(`:69-73`), `prediction {summary, evidenceRefs}` (`:74`), `observedOutcome` (`:75-80`),
`verification.verdict` (`:81-84`), `reviewerDecision.decision` (`:85-88`), `correction` (`:89`),
economics (`:90-96`), and governance (`tenantId`, `residencyRegion`, `consentId`, `sourceClass`,
`provenanceQualifiers`, `mayLeaveTenantBoundary`, `:97-104`). Private reasoning is actively rejected
(`:169-174,394-406`) and an exact key allowlist is enforced (`:181-185`).

**What is in the schema, and what is not.** No prompt/context field. No completion field. No tool
field of any kind — one would be rejected as `learning_event_field_invalid` (`:410`).
Verification is an enum plus evidence-ref IDs, with no per-check results. **The event is a metadata
envelope, not a training example.**

**Who emits in production.** Two real call sites, both post-commit and best-effort:
`apps/worker/src/warden-candidate-delivery.ts:322` and
`apps/worker/src/transformer-adaptive-delivery.ts:598` (via
`admitWardenGovernedLearningEvent` `apps/worker/src/warden-learning-producer.ts:66` and
`admitTransformerGovernedLearningEvent` `transformer-governed-learning-producer.ts:35` →
`admitGovernedLearningOutcome` `governed-learning-producer.ts:144`). **PR #162 fixed the
zero-emitter problem in code.** Four gates stand between a delivery and a row: a default-off flag
(`MENDPOINT_REGAUGE_LEARNING_ENABLED`, `apps/worker/src/transformer-learning-outcome.ts:310-312` —
note the Fettler producer is gated by a ReGauge-named variable); a pre-existing consent under
purpose `governed-adapter-training` that only `POST /advanced-ai/learning/consents`
(`apps/api/src/advanced-ai-applications.ts:266`) creates and no UI or onboarding flow produces;
reviewer approval; and silent failure — every error returns `{admitted:false, reason}`
(`governed-learning-producer.ts:261-264`) which **both call sites discard**
(`warden-candidate-delivery.ts:330-332`, `transformer-adaptive-delivery.ts:606-608`).

**Storage.** No `learning_events` table. The body is serialized into
`artifact_manifests.content_text` as a `governed_learning_lesson`
(`packages/pipeline/src/learning-operations.ts:295-301,348`), with trust rows in
`learning_consents` (`packages/db/src/index.ts:812`), `learning_records` (`:834`),
`learning_dataset_versions` (`:862`), `learning_dataset_members` (`:883`),
`learning_deletion_events` (`:897`). Consequence: you cannot `SELECT` on `attribution`,
`capability`, or `verdict`; every query parses JSON blobs.

**The label problem.** Both producers hard-code `observedOutcome.status: "corrected"`
(`warden-learning-producer.ts:112`, `transformer-governed-learning-producer.ts:93`),
`attribution: "model_behavior"` (`:114`, `:95`), `correction.substantive: true` (`:117`, `:98`), and
`governed-learning-producer.ts:206` hard-codes `verification.verdict: "passed"`. The corpus filter
then drops anything without `destination === "model_weight"`
(`learning-operations.ts:700-702`), which is reachable only via `attribution === "model_behavior"`
**and** `correction.substantive === true` (`learning-event.ts:321-324`). **The corpus is 100%
positive examples by construction — zero variance, therefore zero learning signal.**

Separately, `assertAdmissionBindings` (`learning-operations.ts:1301-1331`) compares the event
against an authority resolved from **the same `facts` object that built the event**
(`governed-learning-producer.ts:232-248`). The comparison is tautological.

**The reference graph is circular.** `assertEventAuthority` requires
`event.references.proposedActionArtifactId === record.redacted_artifact_id` **and**
`event.correction.artifactId === record.redacted_artifact_id`
(`learning-operations.ts:726-730`) — and the redacted artifact *is* the lesson document containing
the event (`:295-301`). There is no third artifact holding real content, and the invariant makes it
structurally impossible to add one without changing the assertion.

**Not instrumented.** Zero metrics (`grep learning|adapter|post_trained packages/ops/src/telemetry.ts`
→ nothing). No audit record for admission or rejection. The well-designed reason taxonomy
(`disabled`, `no_active_consent`, `not_approved`, `contamination_temporal`, `error:*`) is entirely
unrecorded. **A producer failing on every delivery is indistinguishable from one switched off.**

---

## 14. Datasets and corpus generation (Codex-owned — documented)

**What exists.** `materializeGovernedLearningCorpus`
(`packages/pipeline/src/learning-operations.ts:499-660`) is real and substantial: consent check
(`:508-513`), dedupe by `content_sha256` (`:551`), dataset sealing (`:568-573`), split assignment
(`:610-612`), refusal on empty training (`:613`), signed split manifest (`:615-623`).

**Split-leakage prevention is genuinely rigorous — four independent layers.** Split is a function of
the *group*, not the example (`SPLIT_POLICY` `:234-237`, `governedLearningSplit` `:924-931`), so a
repo or family cannot straddle splits; `authorizeGovernedLearningCorpus` (`:933-1021`) re-derives
every assignment and rejects straddling (`:978-981`); the trainer rejects ID overlap
(`packages/pipeline/src/post-trained-training.ts:244-245`); the evaluator rejects holdout identities
in training (`post-trained-evaluation.ts:268`) and the canary refuses to run unless
`overlapCount === 0` (`post-trained-canary.ts:82`). Branch
`claude/learning-provenance-and-splits` is **merged** (tip `cdef477`, ancestor of main).

**What is missing.** Invoked from exactly one place — `POST /advanced-ai/learning/corpora`
(`apps/api/src/advanced-ai-applications.ts:328`). **No scheduler, no worker job, no threshold
trigger**; `docs/learning/ship-readiness.md:40` records this as explicitly deferred.

**What a corpus example actually contains.** `CorpusExample`
(`learning-operations.ts:193-231`, built `:881-922`): `task.inputArtifactId` (an ID string, `:898`),
`originalOutput = event.prediction` (`{summary, evidenceRefs}`, `:904`), `verifiedOutcome`
(`:905`), `correction` (`:906`). **No prompt text, no completion text, no diff, no code.** In
production that `inputArtifactId` points at a `governed_learning_source` provenance document —
`{product, repositoryId, revision, snapshotDigest, scenarioId, sourceClass, provenanceQualifiers}`
(`:302-314`). That is lineage metadata, not a prompt.

**A hard contradiction in the current wiring.** Both producers hard-code
`mayLeaveTenantBoundary: false` (`warden-learning-producer.ts:127`,
`transformer-governed-learning-producer.ts:104`), and `externalProcessingAllowed` is the AND over
all examples (`learning-operations.ts:625-626`), blocking external dispatch (`:968-970`) — while the
external trainer is enabled only when `processingBoundary: "external"`
(`apps/api/src/advanced-ai-applications.ts:188`). **A corpus built from today's producers can never
be sent to the configured trainer.**

**The legacy corpus is the one with trainable structure.** `LearningCorpusExample`
(`packages/db/src/learning-corpus.ts:62-111`) carries an explicit `input` (`task`, `changedPaths`,
`targetPaths`), an `output` with `edits[]` (path / semanticCategory / risk / rationale),
`verificationSummary`, and optionally `afterContent[]` with **exact before/after file bytes**
(`:50-55`), plus `labels` including `verificationPassed` and
`decision: "accepted" | "rejected"` (`:95-97`) — i.e. **real negatives**. Built by
`buildLearningCorpus` (`packages/db/src/learning-corpus.ts:286`), exported by a manual CLI
(`scripts/learning-export-corpus.ts:54`). It still lacks the assembled prompt, but it is the only
thing in the repo today that resembles trainable data.

**Two complete parallel learning subsystems coexist**, firing from the same seam — three admissions
per ReGauge delivery (`apps/worker/src/transformer-adaptive-delivery.ts:568,583,598`), isolated only
by purpose-string disjointness (`governed-learning-producer.ts:17-27`).

**The eval-side dataset builder is orphaned.** `evals/datasets/build.ts` has no CI reference and no
`package.json` script; its output is gitignored (`evals/datasets/records/.gitignore`). Its schema
anticipates a `tool_trace` (`evals/datasets/schema.ts:19-22,54`) — but note
`evals/datasets/schema.ts:49`: *"A reference to the input, NOT the raw input"*. **Even the eval
dataset does not store the model input.**

---

## 15. Trainer, adapter registry, canary, rollback (Codex-owned — documented)

**Trainer: a real HTTP client, not a stub.** The pipeline side is a pure port
(`PostTrainedTrainer`, `packages/pipeline/src/post-trained-training.ts:29-32`, called `:111-118`);
the concrete implementation does a genuine `fetch` with bearer auth, `redirect: "error"`, and a
16 MiB cap (`apps/api/src/advanced-ai-applications.ts:140-161`), wired at
`apps/api/src/server.ts:805-807`. It returns `{}` (→ 503) unless six variables are set including
`MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED === "1"`
(`advanced-ai-applications.ts:127-139`). **The service it points at is not in this repository and is
not proven to exist** — `docs/learning/current-state.md:101` says so directly. The job itself
(`runPostTrainedTrainingJob`, `post-trained-training.ts:61`) has real lease machinery (`:147-166`),
request digests (`:74`), receipt signature verification (`:210`), and split-overlap checks (`:245`),
with state reconstructed by event replay (`:132-140`).

**Adapter registry: event-sourced, no table.** `registerPostTrainedAdapter`
(`packages/pipeline/src/post-trained-application.ts:37-75`) writes a manifest to
`artifact_manifests` and a pointer to `domain_events`; reads find the newest `.registered` event
(`:162-167`). `grep "CREATE TABLE" | grep -i adapter` returns **zero rows repo-wide**. Gates are
real: human approver (`:41`), unrevoked principal (`:40`), training-completion digest match
(`:181-198`), independent evaluation with `passed === true` (`:199-224`), canary evidence (`:226-232`),
eight evidence groups (`:255-272`), hash-chain integrity (`:182`). Rollback
(`:77-103`) requires a human approver and an exact digest match, and `admissionFor` hard-fails after
it (`:147`).

**Router admission: the production routers do not know adapters exist.** `buildWardenExecutorRegistry`
(`apps/worker/src/warden-router.ts:154-162`) and `buildRoutedExecutorRegistry`
(`transformer-router.ts:139-141`) register only the two built-in descriptors. `"adapter"` appears in
the router only as a type-union member (`packages/platform/src/router.ts:35`) and a preference
weight (`:1074`). The only adapter routing is a **dry run** that fabricates a one-executor registry
(`post-trained-application.ts:134-142`), exposed at
`POST /advanced-ai/post-trained/adapters/:adapterId/route-dry-run`. `docs/learning/ship-readiness.md:34`
lists "Actual adapter model invocation" as a **ship blocker**. **A trained adapter can be registered,
evaluated, canaried, approved, and marked eligible — and still never serve a production token.**

**Canary metrics are supplied by the external service, not computed here.** `PostTrainedCanaryReport`
(`packages/pipeline/src/post-trained-canary.ts:10-14`) carries `sampleCount`, `successRate`,
`errorRate`, `policyViolationCount`, `p95LatencyMs`, `costUsd`, evaluated against a pinned policy
(`:108,135`). Every field arrives verbatim from the external canary response
(`apps/api/src/advanced-ai-applications.ts:516`); the repo validates shape and HMAC receipt but
computes none of it. There is no counter, gauge, or histogram for canary success rate anywhere.
A failing canary does **not** auto-rollback — it settles a `failed` event
(`post-trained-canary.ts:127`) and never satisfies `assertCanaryEvidence`;
`docs/learning/ship-readiness.md:37` records monitoring and circuit breaking as deferred.

**Stale doc.** `docs/learning/current-state.md:15,98` and `docs/learning/ship-readiness.md:17-18`
state that production Fettler/ReGauge paths do not emit the common event. PR #162 (`8bc364b`) made
that false and did not update these files.

**Could we train tomorrow? No — and the blocker is the schema, not the volume.** Realistic volume is
zero (the consent no flow creates, plus two default-off flags), and nobody can currently prove the
number either way because emission is unlogged and uncounted. Even with 10,000 events, `toExample`
(`learning-operations.ts:881-922`) would yield an artifact ID for input, a review blurb for output,
and a constant for reward.

---

## 16. Telemetry

**What exists.** One hand-rolled module, `packages/ops/src/telemetry.ts:1-291` — spans (`:75,104`),
counters (`:117`), histograms (`:129`), OTLP/HTTP JSON payload builders (`:181,203`), export
(`:262`). No `@opentelemetry/*`, `prom-client`, `statsd`, or `datadog` dependency anywhere. Storage
is three **process-local in-memory** containers (`:40-42`), drained and reset on flush (`:147-153`).

**Gated entirely on `OTEL_EXPORTER_OTLP_ENDPOINT`** (`:49-60`); unset means every helper is a no-op
(`:76,105,118,130`). **That variable appears in no deployment config, no `.env.example`, and no
workflow** — its only mention repo-wide is prose at `docs/CUSTOMER_INCIDENT_RUNBOOK.md:89`.
**Production telemetry is therefore a no-op today.**

**What PR #153 actually did.** It wired *export*: flush timers at `apps/api/src/server.ts:3747-3752`
and `apps/worker/src/cli.ts:3539-3544`, with final drains at `server.ts:3763` and `cli.ts:3726`. It
also wired the audit-chain sweep (`cli.ts:3556` → `apps/worker/src/audit-integrity.ts:34-59`) and
consent routes (`server.ts:861`). But **instrumentation** did not follow: `grep` for
`recordCounter|recordHistogram|withSpan(|startSpan(` across `apps/` and `packages/` excluding
`packages/ops/src` returns **zero non-test hits**. The only instrumented production function is
`readiness()` (`packages/ops/src/readiness.ts:55,144,145`). Two of the three instrumented functions
in `packages/ops` — `assessServiceHealth` (`service-health.ts:132,185`) and `runMeasuredDrDrill`
(`dr-drill.ts:210,261-262`) — still have no production caller. `withSpan` has zero callers outside
its own re-export.

Not instrumented: HTTP request handling (`apps/api/src/server.ts:712-746` measures `ms` and emits a
`Server-Timing` header but never records it), the worker job loop, model calls, tool calls,
verification, sandbox operations, routing decisions, candidate delivery, human review, and webhook
ingest.

**What is duplicated.** Four parallel "metrics" computations over different tables with no shared
definitions: `computeProductMetrics` (`packages/db/src/metrics.ts:39`, over `migration_prs`),
`computeDesignPartnerMetrics` (`packages/db/src/index.ts:5356`), `computeOutcomeMetrics`
(`packages/db/src/outcome-metrics.ts:132`, over `agent_runs` + `routing_ledger`), and
`computeSelfServeDashboard` (`packages/db/src/self-serve-dashboard.ts:423`). The first measures
migration PRs; the third measures agent runs. **They will never agree and nothing reconciles them.**
Three append-only hash-chained event logs exist (`audit_events`
`packages/db/src/index.ts:268`, `domain_events` `:974`, `tf_events`
`packages/transformer/src/control-plane-store.ts:462`).

**PR #159's audit log is real and broad.** `audit_events` with `prev_hash`/`event_hash`/
`metadata_sha256`/`event_sequence` (`packages/db/src/index.ts:271-275`), computed and inserted in
`recordAudit` (`:2389-2438`), verified by `verifyAuditIntegrity` (`:2447`), exported at
`apps/api/src/server.ts:2616-2626`. It records ~60 distinct action kinds spanning installations,
changes, impact, policy, reviews, deliveries, campaigns, billing, and training-dataset inclusion.
Not fully unified: `tf_events`/`tf_pilot_events` remain separate local logs, so
`exportAuditJson` is not a complete record of ReGauge control-plane activity.
`packages/contract/src/audit-governance.ts` (retention classes, legal holds, redaction profiles)
remains entirely uncalled.

**What is not measurable from telemetry.** Nothing longitudinal. With no collector configured,
nothing is recorded at all; with one, the only series is `readiness_check_*`. **Every real
measurement in this system comes from SQL over SQLite, not from the telemetry module.**

---

## 17. Review outcomes

**Three independent, non-reconciled review surfaces.**

- **(A) Migration-PR review → `review_decisions`.** Table `packages/db/src/index.ts:934-955`
  (`decision IN ('approve','reject','request_changes','regenerate','waive')`, `rationale`,
  `reviewer_principal_id`, `supersedes_id`); write `packages/db/src/trust.ts:348-367`; route
  `POST /prs/:id/reviews` (`apps/api/src/review-routes.ts:97-151`). PR #149 wired the console to
  this: `apps/web/app/components/console/interactions.ts:88-113`, and it honestly never claims a
  merge (`:82-87`). RBAC-gated (`review-routes.ts:98`), human-principal-gated
  (`apps/api/src/reviews.ts:24-31`), rationale-enforced (`:136-140`), supersession-chained
  (`trust.ts:337-347`), all in one transaction (`review-routes.ts:119-147`).
- **(B) Warden candidate review → `agent_runs.status` mutation.**
  `apps/api/src/warden-candidate-review.ts:297-300` sets
  `candidate_approved|candidate_rejected|candidate_superseded`. **Writes nothing to
  `review_decisions`**; the decision and rationale live only inside `result_json` (`:287-288`).
- **(C) ReGauge adaptive candidate review → `regauge_adaptive_candidates.review_decision`**
  (`packages/db/src/index.ts:1249`), written by
  `apps/api/src/transformer-adaptive-review.ts:610-760`.

**Three decision enums, three persistence models, no cross-table join key.**
`review_decisions.subject_id` is a `migration_prs.id`; `fettler_candidate_deliveries.run_id` is an
`agent_runs.id`. Nothing bridges the migration-PR world to the agent-run world. And **the
`review_decisions` table PR #149 wired the console to is read by no metric** — its only readers are
learning, pilot-contract, and trust modules; not `metrics.ts`, not `outcome-metrics.ts`, not
`self-serve-dashboard.ts`, both of which use surface (B) instead
(`packages/db/src/outcome-metrics.ts:84,173-176`).

**GitHub webhook ingestion.** Handler `apps/api/src/server.ts:2259-2570`, HMAC verified (`:2275-2280`),
delivery-deduped (`:2292`). Subscribed events (`packages/github/src/app-install.ts:57-64`):

| Event | Handled | Persisted |
|---|---|---|
| `installation`, `installation_repositories` | yes (`server.ts:2304-2475`) | `github_installations`, `consumers`, `audit_events` |
| `pull_request` | only `action === 'closed'` (`server.ts:2511`, `packages/github/src/webhooks.ts:233-242`) | `migration_prs.status`/`resolved_at` via `applyPrFeedback` (`packages/pipeline/src/index.ts:1900`), `audit_events` `pr.merged`/`pr.closed`, plus `suppressed_patterns` on close (`:1936`) |
| `pull_request_review`, `..._comment` | CI-wake only (`apps/api/src/warden-review-webhook.ts:21-50`) | the review **state** (approved / changes_requested) is normalized away (`webhooks.ts:202-222`); no `review_decisions` row |
| `push` | **no** — falls through to `{type:"other"}` (`webhooks.ts:225-229`) and returns `ok` (`server.ts:2569`) | **nothing** |

`reconcileMigrationPrNativeReview` (`apps/api/src/reviews.ts:329`) — which would record a
GitHub-native review — has **zero production callers**. So a human approving in the GitHub UI is
invisible.

**Can we compute "acceptance rate of Mendpoint PRs"? No.** Two partial numbers exist and neither
covers the PRs the product actually ships:

1. In-system candidate approval rate over `agent_runs.status`
   (`packages/db/src/outcome-metrics.ts:78-85,210-214`) — measures whether a human clicked Approve
   *inside Mendpoint*, not whether GitHub merged anything.
2. GitHub merge rate for `migration_prs` only (`packages/db/src/metrics.ts:12,39`).

**The modern delivery lanes are structurally excluded.** `fettler_candidate_deliveries`
(`packages/db/src/index.ts:1327-1329`) and `regauge_adaptive_deliveries` (`:1294-1296`) both cap
`status` at `delivery_pending | delivered | delivery_failed` — **there is no merged/closed/reverted
terminal state to write**. And the webhook's only lookup is
`findPrByGitHubIdentityAndNumber`, whose SQL queries **`migration_prs` alone**
(`packages/db/src/index.ts:3057-3066`), even though both delivery tables store `draft_pr_number`
(`:1343`, `:1306`). A merge of a Warden or ReGauge PR returns
`{ok: true, applied: null, reason: "no matching migration PR"}` (`server.ts:2564`).

**Reverts and follow-up commits are not recorded at all**, acknowledged in-code:
`packages/db/src/outcome-metrics.ts:216-224` sets `escapedRegressionRate` to
`{value: null, basis: "unavailable"}` with a written explanation that every judge gates *before*
delivery so recorded data cannot show a regression that escaped. This is the correct behaviour and
the clearest statement in the codebase of the gap this program must close.

---

## 18. The measurement audit — Phase 4's nine questions, answered today

Verdicts are about **durable storage**, not log lines.

| | Question | Verdict | Evidence |
|---|---|---|---|
| a | **What task** was attempted | **RECORDED** | `jobs.type`/`payload_json` (`packages/db/src/index.ts:106-107`); `agent_runs.goal` (`:188`); `result_json.source.{repositoryId,snapshotId,revision}` (`apps/worker/src/cli.ts:3029-3034`); `routing_ledger.task_kind`/`task_snapshot_id` (`:1113,1116`). Caveat: JSON blobs, queryable only via `json_extract`. |
| b | **What context** was given | **PARTIAL — the critical half is missing** | Retrieved-file list yes: `result_json.agent.sourceContext` (`packages/agent/src/types.ts:312`, written `apps/worker/src/cli.ts:3043`) — but only on the attempt path; the legacy path writes six scalars (`:2656-2664`). **The prompt itself: NOT RECORDED.** Only `fettler_model_reservations.request_digest` (`packages/db/src/index.ts:136`, computed `packages/agent/src/agent.ts:2511`). |
| c | **Which model** was used | **RECORDED, per call** | `fettler_model_reservations.configured_model` (`packages/db/src/index.ts:140`) and `actual_model` — the provider's echo, not our request (`:141`, written `packages/db/src/warden-model-accounting.ts:344`). Keyed `UNIQUE (tenant_id, job_id, lease_generation, call_index)` (`:162`). **But `routing_ledger` has no `model` column**, so model identity and routing decision are not joinable in one query, and `synthesizeWardenRun` drops the provenance array (`apps/worker/src/warden-router.ts:728`). |
| d | **Which tools** were called | **NOT RECORDED** | Counts only: `agent_runs.steps` (`packages/db/src/index.ts:192`), `result_json.agent.toolCalls` (`packages/agent/src/attempt-engine.ts:116`). The per-step record exists in memory (`packages/agent/src/types.ts:63-69`) and is explicitly dropped at `apps/worker/src/warden-router.ts:701` (`steps: []`). No `agent_steps`/`tool_calls` table exists. |
| e | **What result** was produced | **PARTIAL** | `migration_prs.patch_unified` yes (`packages/db/src/index.ts:252`, written `packages/pipeline/src/index.ts:1626`). Warden/ReGauge: file paths only (`agent_runs.files_changed_json`, `:193`), with the candidate as an off-DB sealed file referenced by `sealed_path`/`sealed_sha256` (`:1335-1336`). |
| f | **How it was verified** | **PARTIAL, and untrustworthy as a label** | Verdict yes: `evidence_records.verdict` (`:567`), `fettler_ci_observations.verdict` (`:1398`). Commands and exit codes live **only** in an off-DB artifact file that **normalizes failures away** (`packages/agent/src/attempt-engine.ts:758,771`) and is deleted on retention expiry (`apps/worker/src/cli.ts:1157,1163-1168`). Duration is never measured. **The sandbox backend is NOT RECORDED anywhere** (`packages/repair/src/verify-sandbox.ts:73-75`). |
| g | **Whether it was accepted** | **PARTIAL** | In-system decision yes, across three incompatible surfaces (§17). Merged/closed only for `migration_prs`. Changes-requested-on-GitHub, reverted, and commits-pushed-on-top: **NOT RECORDED**. |
| h | **Cost** | **RECORDED, at three grains, honestly** | Per call: `fettler_model_reservations.reported_*`/`charged_*` (`packages/db/src/index.ts:151-158`). Per envelope: `routing_ledger.{input,output,total}_tokens`, `cost_usd` (`:1127-1130`). Per run: `agent_run_meters` with an explicit `cost_measured` flag (`:1186-1190`, derived at `packages/db/src/agent-run-meter.ts:116-117` by aggregating `routing_ledger`). Unmeasured runs write NULL, never 0 (`apps/worker/src/warden-router.ts:455-471`). **Gap:** `llm-confirm` and `repair/plan` make real billable calls with no accounting at all. |
| i | **Latency** | **PARTIAL** | Per attempt derivable from `routing_ledger.started_at`/`completed_at` (`:1131-1132`) and `agent_run_meters.duration_ms` (`:1185`). Per model call derivable from `reserved_at`/`settled_at` (`:160-161`). **No latency column exists** — `actualLatencyMs` (`packages/agent/src/routed-agent.ts:145`) is computed and never forwarded. Per-tool and per-verification-command latency: **never measured**. |

Read as a set: **the system can tell you what it spent and what happened. It cannot tell you what it
did.** Cost and outcome are well-instrumented; input, action, and verification detail are not. That
is precisely the wrong half for training.

---

## What blocks Phase 2

Ranked by how completely each one invalidates a training program, most blocking first. Ownership is
marked **Claude**, **Codex**, or **Shared** so the remaining phases can be sequenced without
collision.

### 1. No (input → output) pair exists anywhere in the system — **Shared (Claude leads capture; Codex owns the landing zone)**

This alone makes training impossible, regardless of volume or label quality. The prompt is built at
`packages/agent/src/agent.ts:2713,2730`, hashed at `:2511`, and discarded. The completion is parsed
and dropped. The governed learning event has no field that could hold either, and its exact-key
allowlist (`packages/pipeline/src/learning-event.ts:181-185`) would reject one. Even the eval
dataset stores "a reference to the input, NOT the raw input"
(`evals/datasets/schema.ts:49`).

*Closing it requires:* a write of `{system, user}` at `packages/agent/src/agent.ts:2730` and of the
raw completion at the parse site — Claude's harness work; plus a content-artifact reference on the
learning event that is not the circular `redactedArtifactId`
(`packages/pipeline/src/learning-operations.ts:726-730`) — Codex's schema. Neither half works alone.

### 2. Every governed learning event carries a constant label — **Codex**

`observedOutcome.status`, `attribution`, `correction.substantive`, and `verification.verdict` are
hard-coded (`apps/worker/src/warden-learning-producer.ts:112-117`,
`apps/worker/src/transformer-governed-learning-producer.ts:93-98`,
`apps/worker/src/governed-learning-producer.ts:206`), and the corpus filter admits only
`model_weight` destinations (`learning-operations.ts:700-702`), which those constants guarantee.
Zero variance means zero gradient. The governance layer around this is excellent and should be kept;
what must change is that failures, rejections, and non-substantive corrections become admissible.
Note the legacy corpus already models this correctly, including negatives
(`packages/db/src/learning-corpus.ts:95-97`).

### 3. Acceptance is unmeasurable for the lanes that actually ship PRs — **Shared**

`fettler_candidate_deliveries` and `regauge_adaptive_deliveries` cap `status` at
`delivered` (`packages/db/src/index.ts:1327-1329,1294-1296`) — no merged/closed/reverted state
exists to write — and the PR webhook matches `migration_prs` alone (`:3057-3066`). Reverts and
follow-up commits are not ingested; `push` is subscribed and dropped
(`packages/github/src/webhooks.ts:225`). Without a terminal human outcome there is no reward signal
and no way to validate that a trained model improved anything.
`packages/db/src/outcome-metrics.ts:216-224` already states this gap precisely.

### 4. No tool-call trajectory is persisted — **Claude**

Args, results, and per-call durations exist only in memory (`packages/agent/src/types.ts:63-69`) and
are explicitly discarded (`apps/worker/src/warden-router.ts:701`); the checkpoint keeps digests, not
values (`packages/agent/src/checkpoint.ts:63-72`), head-only, and only when
`MENDPOINT_APPLICATION_DATA_KEY` is set. There are zero log statements in the agent. Without a
trajectory there is no RL signal, no tool-selection analysis, no failure attribution, and — relevant
to Phase 12 — nowhere for an independent verifier's verdict to attach.
`packages/harness/src/trajectory.ts` already has the right event model and is not on the production
path.

### 5. The evals cannot observe post-apply reality, so they cannot validate a trained model either — **Claude**

Both runners stop at analyze (`evals/runners/regauge-runner.ts:183`,
`evals/runners/fettler-runner.ts:91`); nothing installs, compiles, or runs a subject repo's tests in
either suite. The measured consequence is 12 of 35 cases wrong-and-green
(`VALIDATION-REPORT.md:193`), four of them with signed exit-0 evidence for repos that no longer
install (`:203-210`). A training program whose acceptance test is an analyze-only harness cannot
detect a regression it introduces. This is the gate that must exist *before* training, not after.

### 6. Readiness gates cover one capability of the seventeen traced here — **Claude**

`evals/readiness-gates.json:7-15` defines only `fettler-impact-analysis`;
`evals/readiness.ts:241-248` silently drops anything else and `:127-128` pools only Fettler
`flag_files` runs. ReGauge is "not gated"
(`evals/reports/readiness-scorecard.md:37`) with no holdout split (`:47`). And the suite that does
run cannot fail CI (`evals/runners/run-all.ts:274-277` needs `--enforce-readiness`, which
`ci.yml:49` does not pass), so the build is green while readiness reads FAIL. There is no
"did this get better?" bar for any capability a training program would target.

### 7. "Verified" is not a trustworthy label — **Shared**

Production verification is refused with exit 126 for essentially every real repo command
(`packages/repair/src/verify.ts:279-293`, with `MENDPOINT_ALLOW_UNSANDBOXED_VERIFICATION` set
nowhere), and a refusal is indistinguishable downstream from a genuine test failure
(`packages/agent/src/agent.ts:4128`). The sandbox backend that ran is recorded nowhere
(`packages/repair/src/verify-sandbox.ts:73-75`), despite a documented history of a silent fallback
producing a fake-green (`:12-17`). Exit codes survive only in an artifact that normalizes failures
to zero (`packages/agent/src/attempt-engine.ts:758,771`) and is later deleted. Training on
`verification.verdict === "passed"` today would be training on a label the system cannot substantiate.

### 8. Production emits no telemetry, so nothing is measurable in aggregate — **Shared**

`OTEL_EXPORTER_OTLP_ENDPOINT` is set in no config, so `packages/ops/src/telemetry.ts:49-60` makes
every helper a no-op; and even with a collector, the only instrumented production function is
`readiness()`. Learning-event admissions fail silently and uncounted
(`apps/worker/src/governed-learning-producer.ts:261-264`, both callers discarding the result), which
means the very first Phase 2 question — "how many eligible events do we have?" — cannot be answered
without opening the SQLite file.

### 9. The router has no denominator, so router-policy learning has nothing to learn from — **Shared (Codex owns admission)**

Exactly one eligible executor per production pass in both lanes
(`apps/worker/src/warden-router.ts:154-162`, `transformer-router.ts:139-141,189`); eight of thirteen
signals are hardcoded constants; adaptive ranking never runs in production
(`packages/platform/src/router-runtime.ts:266`, test-only). Spec §17.12's "routing outcomes are
themselves learning data" has no variance to learn from until a second executor is genuinely
eligible. This is not urgent for *model* training, but it blocks the router-policy destination that
`packages/pipeline/src/learning-event.ts` already models.

### 10. Retrieval quality is unmeasurable, so the largest likely error source is invisible — **Claude**

Retrieval is an unranked literal substring match plus a filename regex
(`packages/agent/src/tools.ts:619-621`, `packages/agent/src/heuristics.ts:92-103`), and the agent
package depends on no index at all (`packages/agent/package.json:16-20`). recall@k has a numerator
on one of two paths and **no denominator anywhere** (§8). Spec §17.4 names `RETRIEVAL` as a
first-class lesson destination — "model never saw the required file" — and that is exactly the
diagnosis we currently cannot make. Fine-tuning to compensate for a retrieval defect is the failure
mode spec §17.4 explicitly warns against.

### Sequencing note

Blockers 1, 4, 5, 6, and 10 are Claude-owned and mutually reinforcing: they are all the same missing
substrate (capture the input, capture the actions, be able to score the result). Blockers 2 and 9
are Codex-owned and depend on 1 and 3 landing first — there is no point widening the label space
before there is content to label. Blocker 3 is the one true shared dependency and is on the critical
path for both sides.

---

## Corrections to earlier briefs

Recorded so stale findings are not re-propagated.

1. **`evals/` IS wired into CI.** Added in `75e3ea1` (2026-08-17), running at
   `.github/workflows/ci.yml:46-49` plus a nightly full-corpus job. It is **non-blocking** by
   deliberate design (`ci.yml:44-45`; `evals/runners/run-all.ts:274-277`). The earlier
   characterization — "only recently added to CI" — was right in spirit and now has a date and a
   line number.
2. **The Fettler eval runner is analyze-only too.** Prior briefs identified this only for ReGauge.
   `evals/runners/fettler-runner.ts:91-95` stops at `analyzeImpact` with `produced_edit: false`
   (`:122`). Neither suite applies, installs, compiles, or runs subject tests.
3. **The readiness "skip" is two skips, not one.** `evals/readiness.ts:127-128` filters runs to
   Fettler `flag_files`; `:241-248` drops non-Fettler *capabilities*. The brief's "~line 126" maps
   to the first.
4. **`packages/eval` is a harder gate than described** — pass^3 on 45 scenarios with zero tolerance
   (`agent-eval-contract.ts:243,277-278`) — but its live-model lane is empty and passes silently
   (`agent-eval.ts:45,85-87`).
5. **Model identity: the repo default is `gpt-4o-mini`, not Muse.** `packages/agent/src/model-endpoint.ts:59`
   is the env-unset fallback. `muse-spark-1.2-contributor` is a *conditional* provider default
   (`model-providers.ts:121`) and the training-tier denylist entry
   (`model-tenant-routing.ts:59`). "Muse 1.2" appears nowhere. The production value is a GitHub
   secret (`REGAUGE_MODEL_ID`) and is not knowable from this repository.
   `docs/evals/current-system-map.md:80-81` states the Muse default and is wrong.
6. **"Model identity is vendor-neutral at the routing layer" needs one qualification.** It is
   neutral in `packages/agent`, but there are **four** independent model-call paths, and three of
   them (`packages/code-impact/src/llm-confirm.ts:168`, `packages/repair/src/plan.ts:193`,
   `apps/worker/src/transformer-adaptive-planner.ts`) bypass the gateway, the training-tier guard,
   the price table, and provenance entirely.
7. **Cost is better instrumented than assumed.** Three durable grains with an explicit
   measured/unmeasured flag (§18h). The gap is per-call *joinability* to routing, and the two
   unaccounted model paths — not absence.
8. **Acceptance is partially recorded, for the wrong lane.** `migration_prs` gets real merge/close
   ingestion (`apps/api/src/server.ts:2511-2532`). The modern candidate-delivery lanes do not, and
   structurally cannot without a schema change.
9. **The OSS validation report is current, not stale.** `git diff 1d3ae5a..fcec22e` over
   `packages/transformer/src/recipe.ts`, `recipe-workspace-execution.ts`, and `evals/` is **empty**.
   PR #174 and `claude/regauge-family-readiness` remain unmerged.
10. **DeepSeek V4 Flash / independent verifier:** not present in this tree (zero occurrences of
    "deepseek" repo-wide), owned by Codex, in flight on `codex/172-muse-deepseek-verifier`. Recorded
    here as a boundary and an integration surface (§6), not as a gap for Claude to fill.
