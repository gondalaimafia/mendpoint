# Mission and persistent-context: current state

Repository archaeology performed against `origin/main` @ `2f914cb`, 2026-08-21, ahead of any Mission Space work. Every claim below was checked against code. Where a specification document and the code disagree, the code is reported and the document is named.

Scope note: `docs/intelligence/CURRENT_STATE.md` covers the routing, learning, and cost surface and was independently verified during this sweep — no overclaim was found in it. This document covers the *work unit* and *persistent context* surface and does not duplicate it.

Throughout, three states are distinguished and never collapsed:

- **live** — exists and is called on a real (non-test) path
- **built, uncalled** — exists, is enforced, has zero non-test callers
- **absent** — does not exist under any name

That distinction is the whole finding. Most of what a Mission Space needs is already written and simply never invoked.

---

## Existing Mission model

**A `mission` table exists. It is a write-once ReGauge-only correlation key, not an operating context.**

Schema at `packages/db/src/index.ts:795-820`:

```
id, tenant_id, product ('fettler'|'regauge'), state (12-value CHECK),
trigger_kind, objective,
repository_id       -> connected_repositories(id)   NULLABLE
snapshot_id         -> repository_snapshots(id)     NULLABLE
fettler_campaign_id -> fettler_campaigns(id)        NULLABLE
regauge_campaign_id TEXT (no FK - separate DB)      NULLABLE
owner_principal_id  -> principals(id), revision, created_at, updated_at
```

| Property | State |
|---|---|
| Tenant scope | Present — `tenant_id NOT NULL REFERENCES tenants(id)`, `UNIQUE (tenant_id, id)`. But see *Tenant binding* below: the primary key is `id` alone. |
| Repository / snapshot binding | Columns exist, **never populated**. Both writers pass neither. Every production row has `repository_id = NULL, snapshot_id = NULL`. |
| Change Graph version | **Absent.** No `graph_version_id` or `content_digest` column exists. |
| Decisions, exceptions, corrections, verification | **Absent by design** — `packages/db/src/mission.ts:15`: payloads are never duplicated onto the mission row. Everything is by reference through the linked campaign. |

**Writers — two, one of them unreachable.**

- ReGauge: `POST /regauge/control-plane/campaigns` -> `apps/api/src/transformer-control-plane.ts:904`. **Live.**
- Fettler: `POST /fettler/campaigns/:id/enroll-org` -> `apps/api/src/warden-campaign-enrollment.ts:212`. **Dead in practice** — `autoEnrollWardenCampaignOrg` requires a pre-existing `fettler_campaigns` row in `draft`, and `createWardenCampaign` (`packages/db/src/warden-campaign.ts:135`) has zero non-test callers. The endpoint always 404s.

Both writes sit inside best-effort `try`/`catch` that logs and swallows, so a Mission write failure is invisible to the caller.

**Readers.**

- `transitionMission` — **built, uncalled.** Every production mission row is therefore permanently `state='created'`, and the 12-state machine at `packages/db/src/mission.ts:88-101` is dead code. It already implements optimistic-`revision` CAS plus a hash-chained `domain_events` append, correctly.
- `getMission`, `resolveMissionForFettlerCampaign` — **built, uncalled.**
- `resolveMissionForRegaugeCampaign` — one caller, `apps/worker/src/transformer-pilot-lane.ts:250`, used only to stamp `trajectories.mission_id`.

**Naming hazard.** "Mission" already names three unrelated things: the `mission` table row; the `POST /regauge/missions` blueprint endpoint, which creates no mission row; and a learning-event `missionId` that is a free-form string set to an agent-run `sessionId` (`apps/worker/src/cli.ts:3258`) or a ReGauge `lease.campaignId` (`:3888`). A new domain object must not reuse the bare word.

---

## Existing task workflow

**Four separate state machines. Two live, two built-and-uncalled.**

| Machine | Definition | Enforcement | State |
|---|---|---|---|
| Mission, 12 states | `packages/db/src/mission.ts:88-101` | `transitionMission` — revision CAS + `domain_events` | **built, uncalled** |
| Fettler campaign target, 12 stages | `packages/db/src/warden-campaign.ts:248-254` | `transitionWardenTarget` — revision CAS, `warden_pr_package_required` gate on the review transition | **built, uncalled** |
| ReGauge unit / wave / attempt / approval / exception / PR | `packages/transformer/src/control-plane-store.ts:421` `assertTransition` | `TransformerControlPlaneStore` | **live** |
| Fettler CI cycle, 10 states | `packages/db/src/warden-ci-reentry.ts` | seven named functions | **live** — the only working multi-step Fettler work unit |

`agent_runs.status` has **no declared machine and no CHECK constraint**. Transitions are enforced ad hoc by conditional UPDATE, e.g. `apps/api/src/warden-candidate-review.ts:342`.

The entire Fettler campaign layer is unreachable as a consequence of `createWardenCampaign` having no caller: `fettler_campaigns`, `fettler_campaign_targets`, the dependency DAG, `executeWardenCampaignTarget`, `planWardenRollout`, `planWardenRollback`.

**Does stage N know what stage N-1 concluded?** No, in both products. Fettler dependencies gate on `stage === 'completed'` — a boolean. ReGauge waves gate on dependency `state === 'merged'`. Nothing is passed forward. Additionally `mission-planner.ts:174` emits an empty `dependsOn` for every unit, so the `/regauge/missions` planning path never produces more than one wave; multi-wave exists only if a caller hand-builds the campaign input.

---

## Agent to human to agent handoff

**A pause-and-resume path exists and is live on Fettler. Roughly 2 KB of prose and a snapshot binding survive the human step. Everything the prior attempt learned is discarded.**

The gating is strict and genuinely good: `POST /agent/runs/:id/candidate/review` (`apps/api/src/warden-candidate-review.ts:215`) is OIDC-only, requires an active `tenant_memberships` row and a non-revoked human trust principal, and **re-verifies the membership evidence id inside the transaction** (`:288-296`) to defend against mid-request revocation.

On a `regenerate` decision the next job payload carries `reviewFeedback` (the reviewer's rationale, capped at 2,000 characters), `supersedesRunId`, `reviewerPrincipalId`, and — inherited via spread — the `snapshotBinding` and `allowedChangedPaths`. The worker string-concatenates the rationale onto the goal at `apps/worker/src/cli.ts:2675`.

**What does not survive:** the prior trajectory, the prior diff, which files were read, which searches were run, which verification commands failed and how, the prior model's reasoning, and any earlier cycle's reviewer rationale. Cycle 3 sees only cycle 3's feedback. Cycles 1 and 2 are in `agent_runs.result_json` of superseded rows that nothing reads.

**ReGauge is different and worse: human correction is captured with full provenance and then never returned to any agent.** `regauge_adaptive_regenerations` (`packages/db/src/index.ts:1366`) durably stores the reviewer principal, rationale, and rationale digest, written on a live path. The worker that processes them, `apps/worker/src/transformer-adaptive-regeneration.ts:29`, marks **every** request blocked with `external_processing_authorization_required`; the `scheduled` counter is initialized to 0 and never incremented anywhere in the file. Given the reason code this reads as a deliberate gate awaiting an authorization decision rather than a defect — but the effect today is that no human correction has ever reached a ReGauge agent.

The closest thing to a persistent operating context is the CI and review re-entry path (`apps/worker/src/warden-ci-repair-dispatch.ts:104`), which persists cycle budgets, allowed paths, base revision, current head, and pause reason across a human pause. Its dispatched payload is still rebuilt from scratch, and the snapshot is deliberately re-materialized at the cycle's current head rather than the original snapshot, because the PR head moves.

---

## Existing user and team preferences

**Absent.** Nothing on main persists a tenant-authored rule, convention, or preference. Four things resemble one:

- `packages/platform/src/memory.ts` — **not organizational memory.** A plain in-process object; `createMemory()` returns fresh empty arrays; no imports, no serialization, no `tenantId` field; ids from a module counter that resets on process start. Its HTTP route builds a fresh object per request and discards it on response. A prompt-string scratchpad. `captureFixup`, the one entry point for learning from a human correction, has zero callers and would be discarded anyway.
- `packages/transformer/src/agent-config.ts` — **built, uncalled, and the closest existing artifact to what is needed.** 725 lines defining a `mendpoint.yaml` / `.json` contract with roles and permissions, environments, coding standards, workflows, and escalation; a fail-closed parser; `resolveEffectiveConfig` layering repo config over tenant defaults; `codingStandardContext()`, `isRecipeAllowed`, `isAgentAllowed`, `roleMayUse`; and an explicit narrow-only invariant that config may tighten platform safety but never widen it. Every symbol is re-exported from the package barrel and called by nothing outside its own test file. Nothing in the repo ever reads a `mendpoint.yaml` off disk.
- `policies` table (`packages/db/src/index.ts:293-298`) — keyed on `consumer_id`, **not** `tenant_id`. One INSERT, one UPDATE in `scripts/seed.ts`. No API route creates or edits a row. Seed-time only.
- `packages/policy/src/index.ts` — **live**, and genuinely fail-closed: `mergePolicy` allows an override only to *add* rules, and auto-merge is hard-off behind `ALLOW_AUTO_MERGE` regardless of config. But it is a global constant, not a store: no per-tenant row, and overrides are caller-supplied rather than loaded.

**The lesson pipeline has nowhere to put a preference.** `LearningDestination` (`packages/pipeline/src/learning-event.ts:51-62`) declares eleven destinations. **Exactly one — `model_weight` — has downstream machinery.** No code branches on `retrieval`, `graph`, `prompt`, `router_policy`, or `deterministic_recipe` to do anything. A lesson classified into any of those ten is computed, stored on the lesson object, and dropped.

A second, richer taxonomy exists at `evals/classification/destinations.ts` with a `PREFERENCE` destination. Nothing outside `evals/classification/` imports it.

---

## Existing permission model

**Enforcement is correctly centralized. Policy *construction* is duplicated, hardcoded, and fail-open on three axes.**

The single evaluation point is `evaluateExecutor` (`packages/platform/src/router.ts:620-689`), which gates capability, tools, tokens, health, licence, privacy classification, region, risk, quality, latency, budget, and circuit breaker in one place. Both production routers import it rather than reimplementing. **This is worth preserving.**

What is duplicated is the *builder*: `buildPolicySnapshot` exists twice with independently hardcoded constants (`apps/worker/src/warden-router.ts:357-391`, `apps/worker/src/transformer-router.ts:221-245`), as does `buildTaskSpec`.

Three fail-open defaults:

1. **Empty `allowedTools`.** Both routers set the task's allowed-tool list to the empty array. The gate is `task.allowedTools.some(...)`, and `[].some()` is always `false`, so **an empty allowlist means no tool restriction**, not "no tools permitted." The `tool_missing` exclusion can never fire in production. Note `apps/web/app/docs/catalog.ts:178` publicly claims eligibility filtering by tool; that axis is structurally inert.
2. **An absent model-source policy widens the allowed classifications to all four** including `restricted` (`warden-router.ts:360-366`). Absence widens rather than closes.
3. **The snapshot is synthesized per call, never loaded.** `buildPolicySnapshot` takes no database handle. Region is the constant `internal`, risk is a literal, budget defaults to 25 USD, and the version is always `1`. The snapshot id is a digest of that body — content-addressed and auditable, but addressing a hardcoded body. **There is no tenant-scoped policy row for it to read**, so nothing can be inherited.

`PolicyRouterRuntime` (`packages/platform/src/router-runtime.ts:266`) — the durable envelope and evidence-store runtime with replay, which is what would carry a snapshot across attempts — is **built, uncalled**.

Genuine fail-closed enforcement worth reusing: `assessOrganizationConstraint` (`packages/transformer/src/organization-constraints.ts:206-238`) is default-deny with an explicit equal-precedence conflict check, and is live. `runGraphQuery` (`packages/graph-learn/src/query.ts:107-117`) makes tenant scope a required positional argument. `apps/api/src/transformer-mission-authority.ts` is a real enforcement point: it re-verifies every file's size and SHA-256 against the manifest, rejects symlinks and path escapes, derives reviewers from `tenant_memberships` while **excluding the planner**, and produces an organization revision digest that is re-checked at launch with drift rejected.

**Model tier:** `packages/agent/src/model-tenant-routing.ts` is live at `packages/agent/src/agent.ts:2702`, fail-safe (an unknown or absent tenant resolves to the non-training tier), and its allowlist can be extended but never narrowed. It is gated behind `MENDPOINT_CUSTOMER_MODEL_ROUTING`, which **defaults off** and is absent from the boot-time validator in `packages/ops/src/env.ts`.

---

## Existing context assembly

**There is no context compiler. Every model call reconstructs identical, tenant-independent context from compiled-in constants.**

The model is called at `packages/agent/src/agent.ts:2702-2760`. The system message is `wardenPlaybook()` — a pure function returning a constant string, taking no tenant and no arguments — concatenated with a hardcoded tool contract and a prompt-injection defence line. The user message is the serialized input.

**No tenant context reaches the prompt.** No conventions, no coding standards, no preferences, no organization constraints, no `codingStandardContext()`, no `memoryForPlanner()`.

Two artifacts are named "compiler" and neither is one:

- `packages/transformer/src/mission-compiler.ts:107` is a pure, I/O-free **validator**: it translates a reviewed blueprint plus approvals plus exact repository snapshots into an execution input, re-verifying the blueprint signature, checking approvals against the reviewer list, forbidding planner self-approval, re-deriving file digests, and rejecting out-of-scope paths. Output is bounded — at most 512 evidence refs, 200-character identifiers, 2,000-character text. It reads no graph, no memory, no policy. **Live**, and its output is not persisted.
- `packages/transformer/src/mission-planner.ts:77` runs *before* human review and abstains rather than guessing on ambiguity. Its output — the blueprint — **does** survive, in `tf_blueprints`.

The one genuine bounded context compiler is `compileFettlerImpactContext` (`packages/graph-learn/src/software-intelligence.ts:564`), capped at 32 KB and live. **Its output goes into a pull-request body for humans** (`packages/pipeline/src/index.ts:1122`). It never reaches a model. The pipeline comments at `:854` that this remains a shadow evidence path.

---

## Existing history

**Six append-only stores, two hash-chained. None records what an agent decided or why.**

| Store | Append-only | Hash-chained | State |
|---|---|---|---|
| `domain_events` (`index.ts:1073`) | convention | **yes** — `prev_hash` / `event_hash`, per-tenant sequence, verified by `verifyDomainEventIntegrity` | live, around 25 call sites |
| `audit_events` (`index.ts:275`) | convention | **yes** | live |
| `tf_events` and versioned `tf_*` tables | **yes** — SQL triggers | no | live |
| `trajectories` / `trajectory_steps` / `trajectory_blobs` | convention | no | live but thin |
| `evidence_records` and `artifact_manifests` | convention | content digest | live |
| `review_decisions` (`index.ts:1033`) | supersession chain via `supersedes_id` | no | live — **but only for `subject_type='migration_pr'` and pilot contracts.** Neither agent candidate-review path writes here; they write a JSON blob into `agent_runs.result_json`. |

Two structural gaps in trajectories:

1. **`missionId` is not passed** at `apps/worker/src/cli.ts:3126-3131`. Every Fettler trajectory has a null `mission_id`, so Fettler spend and history cannot be attributed to a mission at all. The ReGauge lane does pass it (`transformer-pilot-lane.ts:263`).
2. **`context_refs_json` has zero writers repo-wide.** `recordTrajectory` defaults it to the empty array (`packages/db/src/trajectory.ts:456`). The schema slot for "what context did this task actually receive" exists and is empty on every row.

`assembledContextFrom` (`packages/agent/src/trajectory-capture.ts:179-203`) records *references* only — observed paths, digests, search strings, byte counts — deliberately not raw source and not reasoning. So a trajectory says which files were touched, never what was concluded.

The repo documents this honestly at `apps/worker/src/warden-learning-producer.ts:94-140`: `classifyGraphContextDelivery` exists precisely to keep "no context was supplied" distinguishable from "we captured nothing," and it always returns `recorded_absent` on the Fettler path because the Fettler agent has no graph tool.

`packages/db/src/mission-trajectory-join.ts` **does not exist** — only the `.test.ts` is on main, asserting a hand-written join that no production code executes.

---

## Existing cost accounting

Recorded at four grains. Attribution to a **model** and a **task** is genuine; attribution to a **mission** is nearly absent.

| Grain | Table | Real writer? |
|---|---|---|
| Per model call | `fettler_model_reservations` | yes — separates configured from actual model, and reported from charged tokens |
| Per routing envelope | `routing_ledger` | yes |
| Per run | `agent_run_meters` | yes — `PRIMARY KEY (tenant_id, run_id)` |
| Per execution, full breakdown | `actual_execution_cost_entries` | **HTTP only** |

`actual_execution_cost_entries` is the best-designed accounting artifact in the repo — six cost components with a table-level CHECK forcing the total to equal their sum, integer micros, hash-chained, append-only. **Its only writer is the HTTP handler `POST /billing/execution-costs`.** No agent, pipeline, worker, or router writes it, so in practice the table is empty.

**Per migration: absent.** No cost table carries a migration or PR identifier, and `task_id` is a bare text column with no foreign key.

**Per mission: only via `trajectories.mission_id`, and only for ReGauge** — see the Fettler omission above.

**One unaccounted model call site:** `packages/code-impact/src/llm-confirm.ts` makes real billable calls governed only by a call-*count* budget. No reservation, no token capture, no cost, no ledger write. A third live seam, `packages/eval/src/change-graph-live-generator.ts:94`, uses the raw backend resolver and therefore bypasses the tenant training-tier guard; eval-only.

---

## Tenant binding — three inconsistent tiers

**Tier 1, structurally bound.** The Change Graph. `tenantId` is a required field of the canonical body, the content digest is the hash of that canonical JSON, and the version id derives from that digest and **is** the primary key (`packages/graph-learn/src/software-intelligence.ts:164,363,364`). A different tenant produces a different primary key by construction; cross-tenant collision is arithmetically impossible, not merely filtered. Reads re-hash, re-parse, assert the tenant, and re-canonicalize. **This is the pattern new persistent state should follow.**

**Tier 2, filter-bound.** Most of `packages/db`. `mission` is here: `id TEXT PRIMARY KEY` alone, with `tenant_id NOT NULL REFERENCES tenants(id)` and a redundant `UNIQUE (tenant_id, id)`. Three post-write re-reads query by `id` with no tenant predicate (`packages/db/src/mission.ts:173,212,245`); they sit inside transactions that already checked tenant, so they are not exploitable today, but the pattern is one refactor from being so.

**Tier 3, no tenant column at all.** `gl_nodes` and `gl_edges` (`packages/graph-learn/src/store.ts:27-51`). Membership is decided by a four-way heuristic over id prefixes and JSON blob fields (`tenant-scope.ts:24-36`), enforced only in the single guarded seam `runGraphQuery`; seven direct reads of the base tables in `store.ts` bypass it. **Do not extend this pattern.**

Underneath all three: `assertTenantScope` (`packages/db/src/tenant-scope.ts:18-23`) rejects a present-but-blank tenant but **explicitly permits an undefined tenant as an authorized global cross-tenant read**. Across `packages/db`, 38 exported functions take an optional tenant, the fail-open conditional-predicate idiom appears 16 times, and the guard is called 30 times. A second function of the same name in `packages/contract/src/tenant-boundary.ts:46` throws on undefined — two functions, one name, opposite semantics on the same input.

---

## Consent and residency

**Consent is the strongest subsystem found in this sweep.** `learning_consents` is append-only by SQL trigger; revocation is a new row with a supersession pointer, constrained by a table CHECK; `requireActiveConsent` re-queries for a superseding revocation on **every** check, so revocation takes effect on the next call with no redeploy and no cache. Wired end to end from HTTP routes through the pipeline to the corpus consumer. Version monotonicity is enforced.

Two gaps: `purpose` is unenumerated free text, so any string creates a new consent lane; and **residency is a free-text string on three learning tables and does not exist anywhere else in the system** — not in `env.ts`, not on `tenants`, `mission`, `jobs`, or any cost or routing table. It is honored correctly *inside* the corpus gate and nowhere outside it. The router's allowed-execution-regions field is an unrelated hardcoded constant.

---

## Gaps

What prevents a long-running migration from becoming a persistent operating environment, in priority order.

**1. There is no work-unit-level context record, and the schema slot for one already exists and is empty.** `trajectories.context_refs_json` has zero writers. `assembledContext` records paths and digests, deliberately not conclusions. So there is no substrate on which "what stage N-1 concluded" could be stored. This must be filled before anything else, and it does not require a new table.

**2. Human correction does not accumulate, and on ReGauge it is affirmatively withheld.** Fettler carries one 2,000-character string forward, concatenated onto a prompt. ReGauge stores rationale with a digest and blocks every regeneration unconditionally. `review_decisions` — which already has a proper supersession chain and would be the natural home — is used by neither agent review path.

**3. The Mission state machine, its snapshot binding, and the entire Fettler campaign layer are enforced code with no caller.** `transitionMission` already does optimistic-CAS plus hash-chained events correctly. `createWardenCampaign` having no caller makes six further subsystems unreachable. **Building a new primitive beside this would create a third dead campaign layer.** The correct move is to make the existing one advance.

**4. Nothing binds a unit of work to a graph version, and the one bounded compiled context that exists is routed to humans.** `gl_software_versions_v1` is a real versioned graph published on a live path, but no `mission`, `agent_runs`, `jobs`, `fettler_ci_cycles`, `regauge_adaptive_candidates`, or `trajectories` row carries a graph version id. `readSoftwareGraphVersion` and `diffSoftwareGraphVersions` have zero callers.

**5. There is no durable, tenant-scoped store for a non-objective assertion.** Every persistence layer on main is built for objective, evidence-backed facts — `learning_records` structurally *requires* five evidence foreign keys, so a preference such as a naming convention is unrepresentable. Organization Memory needs different admission rules — provenance and precedence rather than evidence digest — plus a consumer for the ten unimplemented lesson destinations. Nothing existing can be extended into it: `memory.ts` is per-request RAM, `policies` is seed-only and keyed on the wrong column, and `agent-config.ts` is unwired and repo-file-based.

**6. The policy envelope is synthesized per call site from hardcoded literals, so nothing can inherit it** — and three of its axes are fail-open when unset.

---

## Specification claims that do not hold

Checked against the canonical v3 product specification:

| Claim | Reality |
|---|---|
| A Mission has repository scope, graph snapshot references, execution history, verification results, review state, outcome, learning provenance | Repository and snapshot columns exist but are never populated; there is no graph-snapshot column; the rest is reachable only through the linked campaign |
| Mission state model | Implemented and never invoked |
| `MigrationTask` with task id, mission id, repository snapshot, graph context, evidence refs, constraints, risk class, verification requirements, allowed tools, expected output schema | **Absent.** Zero code occurrences outside one comment |
| `MissionGraphProjection` | **Absent.** Zero code occurrences |
| Models should receive a bounded graph projection rather than an unbounded dump | The Fettler agent receives no graph context at all, as the code itself states |
| Mission traces retain the graph version so prior decisions remain reproducible | **False.** No work-unit or trajectory row carries a graph version; `context_refs_json` is empty on every row |
| Glossary entry for "Context Compiler" | **Absent** under any name |
