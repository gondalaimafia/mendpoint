# Current system map — where the evaluation harness attaches

Phase 0 deliverable. This describes the real MendPoint architecture as it exists
in this repo (read from the code, not assumed), and states exactly how a
repository is submitted to each product and where the eval harness connects.

Product ↔ internal name: **Fettler = "Warden"**, **ReGauge = "Transformer"**
(confirmed in `README.md`, `packages/*/src/*warden*`, `packages/transformer`,
and the legacy-name guard `scripts/product-names-check.ts`). Code, DB tables, and
audit metadata still use `warden`/`transformer` interchangeably with the product
names.

---

## Fettler (Warden) — API change → impact → migration PR

**Pipeline entry:** `packages/pipeline/src/index.ts` → `runChangePipeline(input)`.
Its declared graph topology (mapped to `wardenProductGraph()` in
`@mendpoint/orchestrator`) is:

```
change_intel → index → candidates → expand → confirm → generate → verify → review_gate
```

Stage-by-stage, with the implementing package:

| Stage | Package | Key function |
| --- | --- | --- |
| Provider/version lookup | `@mendpoint/db` | `getProviderBySlug`, `listVersionsForProvider` |
| Spec diff → surfaces | `@mendpoint/change-intel` | `normalizeChange(oldSpec, newSpec, {providerSlug})` |
| Plan-of-record | `@mendpoint/orchestrator` | `planFromSpecDiff` |
| PR gates + design critic | `@mendpoint/contract` | `evaluatePrGates`, `reviewOpenApiDesign` |
| Blast-radius RAG | `@mendpoint/graph-learn` | `runGraphQuery({op:"blast_radius"})` |
| Index → candidates → expand → confirm | `@mendpoint/code-impact` | `analyzeImpact(repoRoot, surfaces, opts)` |
| Generation (draft PR) | `@mendpoint/generation` | `generateMigration(...)` — deterministic, no LLM |
| Policy gate | `@mendpoint/policy` | `evaluatePolicy(...)` — never auto-merge |
| Agentic repair (opt-in) | `@mendpoint/repair` | `runRepairSession(...)` (`AGENTIC_REPAIR=1`) |
| Verification | `@mendpoint/contract` + sandbox | `evaluateVerificationWaiver`, sandbox in `@mendpoint/platform` |
| Delivery | `@mendpoint/github` | `createBranch` → `commitFiles` → `openPullRequest` |

**`normalizeChange`** (`packages/change-intel/src/index.ts`) diffs the two
OpenAPI specs (`diffOpenApi` → `classifyRisk`) and maps each change to an
**Impactable Surface** (`ImpactableSurface`, a Zod schema in
`packages/shared/src/index.ts`): `kind` (http_path/http_method/request_field/
response_field/auth/other), `op`, path/method/field, `severity`,
`migrationStrategy`, and `searchTokens` (path leaves, field names, SDK dotted
hints). Surfaces are the searchable contract the rest of the pipeline consumes.

**`analyzeImpact`** (`packages/code-impact/src/index.ts`), options
`{minConfidence="medium", useLlm=false, persistIndex}`:
1. `buildIndexIncremental` (`@mendpoint/codebase-index`) with SDK context derived
   from the surfaces.
2. `discoverCandidates` — high-recall tiers, each gated by **provider
   provenance / reachability** (`provenance.ts`): SDK-graph, syntactic, string
   heuristic, import expansion. A file that cannot reach a provider anchor via
   imports is downgraded, never dropped.
3. `expandContexts` — call-graph hops, enclosing function, callers, wrappers
   (`@mendpoint/call-graph`).
4. `confirmImpacts` — static confirmation; LLM only if `useLlm`.
Returns an **`ImpactReport`** (`packages/shared`): `sites` (confident, ≥
minConfidence), `lowConfidenceNotifications`, `overallConfidence`,
`candidateCount`, `confirmedCount`.

**How a repo is submitted (production):** two registration paths converge on the
`consumers` + `consumer_repos` + `monitored_apis` tables in `@mendpoint/db`
(SQLite via Node's `node:sqlite`):
- `POST /consumers` then `POST /consumers/:id/monitor` (`apps/api/src/server.ts`)
  — stores the on-disk repo path in `consumer_repos.local_path`.
- Self-serve clone-on-connect (`apps/api/src/repository-connect.ts`,
  gated by `MENDPOINT_SELF_SERVE_CONNECT`).
The trigger is the worker feed poll (`apps/worker/src/cli.ts` → `pollAllFeeds`);
a new upstream OpenAPI version enqueues a job that calls
`runChangePipeline({tenantId, providerSlug})`, which reads
`getConsumerRepo(...).local_path` and hands it to `analyzeImpact`.

**Model routing:** the pipeline runs deterministic by default. Optional LLM sites
are impact confirmation (`packages/code-impact/src/llm-confirm.ts`, env
`LLM_CONFIRM*`) and repair (`packages/repair/src/plan.ts`, `AGENTIC_REPAIR`/
`LLM_REPAIR`). The governed multi-provider gateway is `packages/agent`
(`model-providers.ts` — muse-spark/openai/xai/anthropic/gemini; default
`muse-spark-1.2-contributor`), with per-tenant training-tier enforcement
(`model-tenant-routing.ts`) and durable `routing_ledger` observability
(`apps/worker/src/warden-router.ts`). `generateMigration` never calls a model.

**Sandbox:** `Dockerfile.sandbox` booted as a Fly Machine microVM
(`packages/platform/src/fly-sandbox.ts`); verification is fail-closed
(`packages/repair/src/verify-sandbox.ts`) — no host fallback.

---

## ReGauge (Transformer) — legacy modernization / migration campaigns

**Engine core:** `packages/transformer/src/recipe.ts` (barrel
`packages/transformer/src/index.ts`):
- `analyzeRecipe(reference, input: RecipeFiles, opts?) → RecipeAnalysis` —
  classifies applicability: `applicable | already_applied | unsupported |
  incomplete`, with `matchedPaths` and `residualPaths` (sites outside
  `allowedPaths` that still match the source pattern → `incomplete`, refuses to
  apply rather than silently half-migrate).
- `applyRecipe` → content-addressed `RecipeOperation[]`; refuses on
  unsupported/incomplete/already_applied.
- `applyInverseOperations` — rollback with digest drift guards.

**Shipped recipe registry** (`RECIPE_REGISTRY`), by family:
- runtime: `node-runtime-18-to-20` (v1,v2), `node-runtime-20-to-22`
- sdk: `aws-sdk-js-v2-to-v3`, `stripe-node-v10-to-v11`, `googleapis-v25-to-v26`
- framework: `react-dom-17-to-18`
- internal_api: `internal-api-acme-user-rename` plus several registry-only
  variants (orders, auth-barrel, warden-reviewer, order-type, review-decision).

Recipes are **deterministic** AST/regex/JSON rewrites — no LLM. Authoring is
factory-only (`authorFactoryRecipe`, families `internal_api_rename` /
`internal_api_type_rename`) and **default-off** (`recipeAuthoringEnabled()`).

**Blast radius / abstention:** ReGauge does NOT use `call-graph`/`codebase-index`/
`egraph`. Its "what breaks" model is per-recipe `allowedPaths` + residual
detection + the `MIGRATION_COMPATIBILITY_RULES` severity catalog +
`blueprint-planner` dependency waves. Abstention points: recipe status
`unsupported`/`incomplete`; planner `abstained(reasons)`; review-tier `blocked`.
Review is always human — no tier auto-applies.

**How a repo is submitted (production):** `apps/web /transformer` (human review
UI) → `apps/api/src/transformer-mission-routes.ts` (`POST /`, `POST
/:campaignId/launch`, RBAC `plan:execute`) → `apps/worker`
(`admitTransformerPilotAttempt` → coordinator lease → `transformer-snapshot-
loader.ts` loads the repo snapshot from DB into `RecipeFiles`). The repo-path →
run primitive is `executeRecipeInWorkspace(...)`
(`packages/transformer/src/recipe-workspace-execution.ts`): materialize temp
workspace → `applyRecipe` → run `verificationCommands` via
`runRecipeVerificationGate` → evidence.

**Adaptive LLM repair (optional):** `runAdaptiveRepairLoop`
(`adaptive-loop.ts`) drives an injected planner; the concrete implementation
(`apps/worker/src/transformer-adaptive-planner.ts`) delegates model/provider
selection to `@mendpoint/agent` — the same gateway Fettler uses.

---

## Shared components

`@mendpoint/agent` (model gateway, routing, provenance), `@mendpoint/orchestrator`
(graph topology), `@mendpoint/platform` (executor registry, RBAC `can()`,
sandbox), `@mendpoint/policy`, `@mendpoint/ops`, `@mendpoint/shared` (Zod domain
types), `@mendpoint/db` (SQLite control plane, `repository_snapshots` shared by
both). Fettler-only: `call-graph`, `codebase-index`, `graph`, `graph-learn`,
`egraph`, `code-impact`, `change-intel`, `generation`.

---

## Where the eval harness attaches

The harness invokes each product through its **deterministic analysis core** —
the same components production wraps — and stops before the parts that require a
seeded DB, a sandbox, or GitHub credentials (recorded as unmeasured, never
bypassed to flatter the product).

- **Fettler** — `evals/runners/fettler-runner.ts` calls
  `normalizeChange(oldSpec, newSpec, {providerSlug})` then
  `analyzeImpact(repoPath, surfaces, {useLlm:false, minConfidence:"medium"})`.
  This is exactly the path `scripts/impact-grade.ts` exercises (its exported
  `gradeRepo`), i.e. pipeline stages `change_intel → index → candidates → expand
  → confirm`. Not exercised: generate/verify/deliver.
- **ReGauge** — `evals/runners/regauge-runner.ts` snapshots the repo into
  `RecipeFiles` and calls `analyzeRecipe(recipeReference(recipe), snapshot)` for
  every shipped recipe — the engine's real applicability/matched-path/residual
  decision, the same core `executeRecipeInWorkspace` wraps. Not exercised:
  apply + verification-gate, inverse/rollback, adaptive LLM repair, delivery.

Ground truth lives in `evals/ground-truth/*.json` (corpus) or in memory
(generated), loaded only by the graders after the product runs. The corpus repos
live outside this git repo (`C:/Users/Talal/dev`, overridable via
`MENDPOINT_CORPUS_ROOT`), so a run cannot read a repo's own answer key.

### Answer-key staging (leak closed)

Each corpus repo carries a prose grading key INSIDE it (`EXPECTED.md`,
`SYNTHETIC_REPO_NOTES.md`). Before either product sees a repo, the runner stages
it into scratch with those keys (and dependency/VCS trees) excluded
(`evals/runners/stage.ts`) and hands the product the staged copy. This prevents
an LLM-enabled runner from reading its own answer key. The staged tree prunes
exactly the directories `classifyDependencyDirectory` (`@mendpoint/shared`)
prunes, so it never diverges from what a product's own walkers index.
`stage.test.ts` asserts no answer-key file reaches a staged tree.

### Generation, holdout, and the learning dataset

- **Mutation engine** (`evals/mutations/engine.ts`, Phase 2/12): seeded,
  reversible, self-describing API and dependency mutations that emit their own
  ground truth.
- **Generators** (`evals/generators/`, Phase 8/13/14): families expanded by
  mutation ($ref blindness, ambiguity, generated/vendored, dependency runtime),
  each with a counterfactual; splits (`development`/`validation`/`holdout`) and a
  procedural holdout generator. `scenarios/resolve.ts` unifies corpus + generated
  into one runnable list; generated repos materialize to scratch per run.
- **Dataset** (`evals/datasets/`, Phase 10): one append-only, versioned record
  per run (positive / negative / coverage-gap; correct abstention is a positive),
  observable fields only — never chain-of-thought.
- The report (`evals/reports/latest.md`) presents the three dataset splits
  separately; holdout is the honest product-quality signal.

### Notes / conflicts found vs. the task brief
- The brief references `scripts/synthetic-e2e.ts`. That file is **not on
  origin/main** (it exists only on the unmerged `codex/synthetic-e2e` worktree).
  The runner therefore reuses `scripts/impact-grade.ts`'s importable approach —
  the same `change-intel → code-impact` core — rather than depending on an
  absent file. `synthetic-e2e.ts` additionally seeds a temp SQLite DB and runs
  the full `runChangePipeline`; that path is available for a future runner that
  also grades generation/delivery.
- Several corpus `EXPECTED.md` files predate recipes that now ship
  (`react-dom-17-to-18`, the SDK recipes, internal-api renames) and assert
  "abstention by absence". The runner does not trust those claims; it records
  empirically which shipped recipe matches each repo.
