# Completion Assurance — Implementation Plan

**Status:** Planning contract. Not an implementation.  
**Depends on:** [CURRENT_STATE.md](./CURRENT_STATE.md) at `da3ba221a889def6d5a2d1526dc81a9353133693`.  
**Parent spec:** Mendpoint Completion Assurance Product Spec for Cursor v1.0 — **not in this repository**; every `§` citation below is unverifiable from this repo until it is vendored (see [CURRENT_STATE.md](./CURRENT_STATE.md) Part C).  
**Horizon:** entire spec (Phases 0–5 / A–J) with hard stop points.

No customer-ready claims. No `MENDPOINT_CUSTOMER_READY=1`. No `v4-platform` row flipped to `verified`. Cursor does not self-merge material PRs.

---

## Product outcome

Fettler and ReGauge stop because an independent CompletionGate says the Mission is ready for human review — or a human explicitly accepts residual risk. The implementer never owns the definition of done and never sees hidden validation cases.

Today that authority is missing (CURRENT_STATE findings 1–4). This plan sequences how to add it **on top of** Mission Space, not beside it.

```text
Mission Objective
      │
      ▼
Completion Planner  (new; before material edits)
      │
      ▼
CompletionStandard + hidden instrument
      │
      ├─ public requirements ──► Implementer (Fettler / ReGauge)
      └─ hidden procedures ────► Validator
                                      │
Candidate artifact ───────────────────┤
                                      ▼
                              ValidationRun / Findings
                                      │
                                      ▼
                              Orchestrator
                         ┌────────────┴────────────┐
                         ▼                         ▼
              RemediationDirective          Human escalation
                         │
                         ▼
                    Implementer (repair)
                         │
                         ▼
                   CompletionGate
              NOT_READY | HUMAN_ACCEPTANCE_REQUIRED | READY_FOR_HUMAN_REVIEW
```

---

## Wire before you build

Reuse (do not duplicate):

- Mission join + state machine (`packages/db/src/mission.ts`)
- `classifyMissionVerificationEvidence` as the **only** freshness algorithm
- `artifact_manifests` / `mission_artifacts` / `evidence_records` (add a visibility class, not a blob store)
- Policy Envelope for reference-system and hidden-instrument policy
- MissionTask + `openTaskHandoff` for implementer continuation
- `jobs` leases for ValidationRun
- `@mendpoint/verifier` as soft rank only
- `admitGovernedLearningEvent` without inventing GRAPH / H4 / FET-015 sinks
- `evals/mutations` as the instrument-eval family

Do not invent: Graphify production, H2 training, H4 `organization_memory` routing, FET-015/018 write-back, REG-015/016, a user-preference store, `getGraphLearnDb()` as a production graph.

Bind Fettler evidence from the **caller execution snapshot**, never `mission.snapshotId` (CURRENT_STATE Part D).

---

## Package placement

- Persistence + repositories: `packages/db` — `CREATE TABLE IF NOT EXISTS`, append-only triggers, tenant-in-digest IDs, composite FK `(tenant_id, mission_id)`. List every new table in `packages/db/src/index.ts`. No lazy `CREATE TABLE` in workers.
- Domain + gate + wall checks: new `packages/completion-assurance` **or** `packages/pipeline/src/completion-*`. A new workspace package is its own PR (skeleton only). Do not mix a package.json workspace edit into a schema PR.
- Worker: one job type that **imports** the engine. Do not duplicate gate/selection in `cli.ts`.
- API: thin routes under existing Mission conventions. Hidden GETs fail closed for implementer principals.

ADR in Wave 0b locks package vs pipeline-module.

---

## Validator wall (hard gate before Phase C)

Prompt instructions are not a wall.

1. Artifact manifests gain authorization scope: `PUBLIC | ORCHESTRATOR_ONLY | VALIDATOR_HIDDEN`.
2. Hidden case bytes live only in hidden-scoped manifests. Implementer repository methods for hidden cases **do not exist**.
3. RemediationDirective schema forbids hidden case IDs, expected bytes, fixture paths, weights.
4. Log/trace/error/timeline redaction: hidden expected output never appears in `jobs.error` or public domain events.
5. Leak matrix (spec §28.2 / §28.8) is release-blocking: normal API, artifact lookup by ID, `storage_ref`, timeline, debug, logs, traces, errors, directive body, restored backup, shared worker volume, cross-tenant, prompt-injected “reveal hidden cases”.

Mutation: delete the deny and the leak test must go red. Security-focused independent review required. **Do not start live ValidationRuns until this PR is reviewed.**

Roles are scopes, not a new `principals.kind`, unless the wall ADR proves a kind is required.

---

## Persistence sketch (Phase A — after docs + ADRs)

Names illustrative; ADR locks them. All append-only, tenant-in-digest:

- `completion_standards` — `mission_id`, `version`, `status` (`draft|active|superseded|frozen_for_gate|archived`), `created_before_execution`, `supersedes_version`, `coverage_model`, `source_refs`
- `completion_requirements` — category, criticality, weight, source, status, evidence_requirement
- `validation_procedures` — type, visibility, comparison_policy, execution_policy
- `validation_cases` — hidden-scoped; no implementer accessors
- `validation_runs` — bind standard version, candidate snapshot/digest, graph version, policy snapshot, job/lease
- `validation_results`, `validation_findings`, `remediation_directives`, `validation_relaxations`, `completion_gates`

Reuse `mission_exceptions` for accepted residual risk **or** have relaxations reference an exception — ADR chooses one; do not store the same acceptance twice.

Add `mission_artifacts` roles only if an existing role would lie. Do not stuff hidden instruments into `test_run`.

**`created_before_execution`:** activation allowed only when Mission state is in `{created, discovering, scoped, planning}`. Otherwise record `COMPLETION_STANDARD_CREATED_TOO_LATE` and refuse ACTIVE. Do not back-date a standard onto an executing Mission.

**Candidate digest** = existing snapshot identity (`snapshotId` + `resolvedSha` + `manifestSha256`), plus candidate digest in scope as campaign-execute already does. Gate invalidation calls `classifyMissionVerificationEvidence`. No third algorithm.

---

## Open product decisions (do not silently decide)

Create one issue or ADR per item that changes architecture. Foundation PRs store the fields.

1. Default BLOCKING categories — Fettler
2. Default BLOCKING categories — ReGauge
3. Minimum graph coverage for READY
4. Whether human acceptance may override graph-coverage gaps
5. Which procedures stay hidden permanently
6. When a hidden failure may become a visible regression test
7. How much of the standard is customer-visible
8. Whether validator and implementer may use different model families
9. Risk tier where differential validation is mandatory
10. Mutation-detection threshold before activation
11. Weight vs hard blockers
12. Mission types too small for a hidden instrument
13. Tenant retention/deletion of standards
14. Evidence required before loosening comparison tolerance
15. When validator cost escalates to a human instead of more compute

**Fail-closed defaults for foundation/shadow only** (overridable by accepted ADR):

- Any BLOCKING fail → NOT_READY
- Missing graph version → INSUFFICIENT_COVERAGE, not PASS
- Human override of graph gaps → HUMAN_ACCEPTANCE_REQUIRED, not READY
- DeepSeek never flips a fail to pass
- No implicit relaxation

---

## Sequenced program

Every wave: GitHub issue (when the authoring environment can write issues) → isolated worktree `/tmp/wt/...` → branch `cursor/<issue>-<slug>-f457` off current `origin/main` → tests → draft PR → `@claude review` → do not self-merge.

This PR is Wave 0a (docs only). Schema is Wave A.

### Phase 0 — Offline architecture

**Wave 0a (this PR):** CURRENT_STATE + IMPLEMENTATION_PLAN + this directory README.

**Wave 0b — ADRs (one concern per PR):**

- Hidden-artifact authorization and validator-wall scopes
- Validator orchestration (job type, lease, idempotency, who may start a run)
- Differential-execution isolation (sandbox, egress deny, Policy Envelope)
- CompletionGate vs Mission state (shadow → advisory → required; never auto-merge)
- Optional: new package vs pipeline module

Stop after 0b until ADRs are reviewed. Do not sneak schema into an ADR PR.

### Phase A — Domain and persistence

Tables + repositories + domain events. Tests: standard before execution; version increment; superseded immutable; unauthorized weaken denied; relaxation requires a record. **No validation API. No Fettler/ReGauge call sites.**

### Phase B — Validator wall

Scopes, hidden class, API filtering, log redaction, full leak matrix. Stop-the-line.

### Phase C — Deterministic validation engine

Dispatch types that already have evidence: `DETERMINISTIC_TEST`, `STATIC_QUERY` / `GRAPH_QUERY` (UNKNOWN if no bound graph version), `HUMAN_REVIEW`. Run lifecycle on jobs/leases. Findings without hidden IDs.

Crash/resume: 60% complete, kill worker, resume, no duplicate deterministic checks, same candidate/standard binding.

### Phase D — Orchestrator loop

Triage, root-cause grouping, one RemediationDirective per shared cause, MissionTask continuation, revalidation. Noise rejection is a recorded finding status, not a delete.

### Phase E — Gate (record only)

Evaluate CompletionGate from results + `classifyMissionVerificationEvidence` + graph epistemic state + instrument-quality placeholder (`unmeasured` until Phase H). Persist the gate. **Do not change `transitionMission`.** Tests: blocker → NOT_READY; digest/standard change invalidates; accepted exception → HUMAN_ACCEPTANCE_REQUIRED.

### Phase F — Differential validator

Reference vs candidate observations, versioned comparison policy, explicit relaxation for nondeterminism. Reference unavailable → UNKNOWN/failure, never PASS. Sandbox + default-deny egress. One synthetic reference scenario is enough.

### Phase G — ReGauge vertical slice A

Synthetic modernization Mission: 3–5 stages; one legacy behavior absent from unit tests; one sequencing constraint; one runtime-only/dynamic dependency; one human ambiguity; one rollback; one security requirement; one injected omission.

Proof (spec §29.3): standard before implementation; wall holds; validator catches the omission; ReGauge sees only a high-level directive; repair; differential where a reference exists; NOT_READY before repair; gate advances after evidence; restart survival; human residual exception.

Prefer a **synthetic fixture + new job** over editing `transformer-pilot-lane.ts` while #542 (or a successor) is open.

### Phase H — Instrument eval

Extend `evals/mutations` (missing edit, overbroad edit, broken error path, omitted stage, auth regression, stale schema). Measure recall/precision/false alarms. Hidden holdout not used for iterative tuning. Thresholds stay owner-decided (decision 10). This phase **measures**; it does not activate.

### Phase I — Fettler vertical slice B

One realistic API/SDK change: direct usage, wrapper, alias, generated/client if practical, similar unaffected usage, tests, one graph uncertainty.

Proof (spec §30.3): direct + indirect migrated; counterfactual unchanged; graph uncertainty surfaced; stale graph/test cannot false-pass; review package has completion evidence without hidden cases.

Hook **after** existing `tryRecordFettlerCampaignMissionVerification`, or via a new post-execute job. Do not restack `warden-candidate-review.ts`.

### Phase J — Learning + telemetry

Admit `LearningEvent`s for stable gaps. Wrapper edge → `graph` **admission only**. Repeated replacement → `deterministic_recipe` if that sink is live; otherwise `no_action` + explicit unrouted. Validator miss → eval destination if one exists. Cost metrics: `cost_per_closed_requirement`, validator vs implementer cost. No invented sinks. No training on infrastructure failures.

### Rollout Phases 3–5

- **Phase 3 Shadow:** generate standard + run validator + record gate on an internal repo. Existing workflow remains authoritative. Flag e.g. `completion_assurance.mode=shadow`.
- **Phase 4 Advisory:** surface public findings + gate on review UX. No automatic merge. No hidden samples.
- **Phase 5 Product gate:** `transitionMission(verifying → awaiting_review)` requires latest gate `READY_FOR_HUMAN_REVIEW` or `HUMAN_ACCEPTANCE_REQUIRED` with a recorded exception. Rollback = flag off (absent gate preserves today’s transition). Automatic production deploy remains separately governed.

---

## PR / issue DAG

```text
0a docs → 0b ADRs → A schema → B wall → C engine
                                      ↘ D orch
                                      ↘ E gate (record)
                                      ↘ F differential
                         D+E+F → G ReGauge slice → H evals
                                                ↘ I Fettler slice
                         J learn ──────────────────┘
                         G+H+I+J → 3 shadow → 4 advisory → 5 bind
```

Suggested issue titles when issues can be opened:

- `completion-assurance: CURRENT_STATE + IMPLEMENTATION_PLAN` (this wave)
- `adr: hidden artifact authorization`
- `adr: completion gate vs mission state`
- `completion-assurance: domain schema`
- `completion-assurance: validator wall + leak tests`
- `completion-assurance: deterministic validation engine`
- `completion-assurance: orchestrator + directives`
- `completion-assurance: gate evaluator shadow`
- `completion-assurance: differential validator`
- `completion-assurance: ReGauge synthetic vertical slice`
- `completion-assurance: instrument mutation eval`
- `completion-assurance: Fettler synthetic vertical slice`
- `completion-assurance: learning events + telemetry`

---

## Test strategy (spec §28)

Each wave ships the slice it claims. Do not name tests `CONTROL:` if they are duplicates minus an assertion.

- Standard lifecycle, wall leak, validation epistemics, differential, gate invalidation, mutation, durability (crash/restart/reassign/duplicate callback/restored-volume/stale lease), security (cross-tenant, secrets, sandbox egress, prompt injection)
- Quality bar: FAILURE_MODES pre-flight; production caller traced when a caller exists; mutation goes red if the control is deleted
- Tests must not call `bindMissionScope` to fake the Fettler path

---

## Integration rules

- Standard expansion = new version row. Do not mutate ACTIVE in place. Do not delete failing requirements because the candidate cannot pass.
- Implementer context = public Mission compiler projection only. Hidden procedures never enter `apps/worker/src/mission-context.ts` payloads.
- Policy pin `policy_envelope_version` on every ValidationRun.
- Soft verifier = optional `LLM_SEMANTIC_JUDGMENT`; stored with criteria snapshot, model identity, cost, latency; cannot change gate hard fields.
- UX = Phase 4+. Public: requirements established, blocking, high unresolved, graph coverage, verification standing, freshness, decision.

---

## Truth boundary (spec §38)

| Claim | When it may be set |
|---|---|
| `COMPLETION_ASSURANCE_FOUNDATION` | After Phases A–F + wall leak tests |
| `COMPLETION_ASSURANCE_ACTIVATED_IN_REGAUGE` | After slice A + configured shadow/advisory |
| `COMPLETION_ASSURANCE_ACTIVATED_IN_FETTLER` | After slice B |
| `CUSTOMER_OUTCOME_PROVEN` | Design-partner / benchmark evidence only |

Do not claim “Fettler migrations are complete” or “ReGauge preserves legacy behavior” because this program landed.

---

## Rollback

- Waves 0–A: revert the docs/schema PR. Unused tables are inert.
- Wave B: revert scopes; default deny hidden if a flag is mid-rollout.
- Waves C–J: disable the validation job type; no Mission transition depends on them until Phase 5.
- Phase 5: set `completion_assurance.mode` off. `transitionMission` returns to today’s un-gated table.

---

## First next step after this PR is reviewed

Wave 0b: hidden-artifact authorization ADR on its own branch. No schema in that PR.
