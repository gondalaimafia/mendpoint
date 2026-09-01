# Completion Assurance — Current State

**Status:** Archaeology. Descriptive, not prescriptive.  
**Commit under test:** `da3ba221a889def6d5a2d1526dc81a9353133693` (`origin/main`, 2026-08-31).  
**Source contract:** Mendpoint Completion Assurance Product Spec for Cursor v1.0.  
**This document does not authorize training, customer-ready claims, or flipping `v4-platform` rows to `verified`.**

Where this file and [docs/missions/CURRENT_STATE.md](../missions/CURRENT_STATE.md) disagree, **believe the code cited here**. The Mission CURRENT_STATE snapshot is older than the live ReGauge launch writer of `transitionMission`.

---

## How to read this document

Two vocabularies are kept separate.

**Code reachability** (what exists):

- **LIVE** — exists and is called on a real (non-test) path
- **BUILT UNCALLED** — exists and is enforced, zero non-test callers for the claimed purpose
- **ABSENT** — does not exist under any name

**Spec satisfaction** (what the Completion Assurance contract requires):

- **SATISFIED** — production path meets the requirement
- **PARTIAL** — a related primitive exists; the requirement is not met
- **MISSING** — no implementation
- **CONFLICTING** — existing types/paths would lie if reused without a new mapping
- **DEFERRED** — explicitly out of scope for Completion Assurance (do not invent)

A requirement is never SATISFIED because a table exists, a test exists, or an agent is confident.

---

## Findings that dominate everything else

1. **The named Completion Assurance domain is ABSENT.** Zero matches for `CompletionStandard`, `CompletionRequirement`, `ValidationProcedure`, `ValidationCase`, `ValidationRun`, `ValidationResult`, `ValidationFinding`, `RemediationDirective`, `ValidationRelaxation`, `CompletionGate`, `COMPLETION_VALIDATOR`, or `validator wall`. There is no `docs/completion-assurance/` tree on main before this PR.

2. **Mission Space persistence is real; completion authority is not.** Missions, decisions, exceptions, verifications, tasks, artifacts, and policy envelopes exist. Nothing independently defines done. Nothing advances a Mission to `verifying` or `awaiting_review` in production.

3. **“Ready for review” today is a local loop, not a gate.** Fettler campaign-execute can move a *Warden target* to stage `review` and write a best-effort `mission_verifications` row. ReGauge `completeAttempt` can mark a *pilot unit* `executed` and hand off a MissionTask. Neither calls `transitionMission` past `executing`. Neither is a CompletionGate.

4. **The implementer and the validator are the same role.** Fettler/ReGauge write the checks they then pass. There is no access-control wall that hides validation cases from the implementer principal.

   Main already records the cause in code, not just the symptom: `packages/pipeline/src/lesson-routing.ts:37-38` and `:234-237` state that both production producers feed the attribution deriver a constant `not_verified` because **Warden’s independent verifier is unsatisfiable and ReGauge’s `passed` flag is tautological and has no verifier**. That is an already-merged, in-repo finding that today’s “verification passed” signal is not an independent definition of done — it is the strongest evidence for this finding and for §B.8’s `none`-attribution symptom.

5. **Do not duplicate what already works.** Snapshot-bound verification standing, content-addressed artifacts, Policy Envelope admission, job leases, MissionTask handoffs, and the advisory AgentVerifier must be reused. Inventing a second “is this evidence still valid” algorithm, a second scheduler, or a second policy engine is a defect.

---

## Part A — Named Completion Assurance vocabulary

| Concept | Reachability | Spec class |
|---|---|---|
| CompletionStandard | ABSENT | MISSING |
| CompletionRequirement | ABSENT | MISSING |
| ValidationProcedure | ABSENT | MISSING |
| ValidationCase (hidden) | ABSENT | MISSING |
| ValidationRun / Result / Finding | ABSENT | MISSING |
| RemediationDirective | ABSENT | MISSING |
| ValidationRelaxation | ABSENT | MISSING |
| CompletionGate | ABSENT | MISSING |
| Validator wall / hidden instrument | ABSENT | MISSING |
| `COMPLETION_VALIDATOR` principal | ABSENT | MISSING |

`principals.kind` is only `human | service | api_key | webhook` (`packages/db/src/trust.ts:13`, schema `packages/db/src/index.ts` principals CHECK). Roles for the wall are a **scope on artifacts + callers**, not a fifth principal kind, unless a later ADR proves otherwise.

---

## Part B — Reusable Mission Space (do not rebuild)

### B.1 Mission join point — LIVE (partial lifecycle)

Table `mission` (`packages/db/src/index.ts:1047-1065`) carries product, twelve states, objective, nullable repository/snapshot, Fettler/ReGauge campaign links, `graph_version_id`, `policy_envelope_version`.

State machine (`packages/db/src/mission.ts:32-36`, transitions `:104-117`):

```text
created → discovering → scoped → planning → executing → verifying
  → awaiting_review → accepted | rejected | partial | failed | cancelled
```

`createMission` is LIVE:

- Fettler enrollment: `apps/api/src/warden-campaign-enrollment.ts:501-512` — **no** `repositoryId` / `snapshotId`
- ReGauge control-plane create: `apps/api/src/transformer-control-plane.ts`
- ReGauge launch bind: `apps/api/src/regauge-production-bootstrap-runtime.ts`

`transitionMission` has **one** production caller: ReGauge launch (`apps/api/src/regauge-production-bootstrap-runtime.ts:259`). It advances only through `executing` (`REGAUGE_MISSION_LAUNCH_ORDER` at `apps/api/src/regauge-production-bootstrap-runtime.ts:105-111`). The comment at `apps/api/src/regauge-production-bootstrap-runtime.ts:99-104` states that `verifying` → `awaiting_review` → terminal states are **deliberately unreachable** because the launch seam does not observe the async attempt.

`transitionMission` itself (`packages/db/src/mission.ts:178-189`) checks only legal transitions and revision CAS. **No verification standing. No CompletionGate.**

**Spec:** Mission as the persist-under join — PARTIAL (join exists; completion records do not). Mission `awaiting_review` as the human-review gate — MISSING (state is BUILT UNCALLED).

### B.2 Verification standing — LIVE write (Fettler only); not a gate

`mission_verifications` is append-only and snapshot-bound (`packages/db/src/index.ts` mission_verifications DDL). Status is `passed | failed | inconclusive` (`packages/db/src/mission-verification.ts:42`).

`classifyMissionVerificationEvidence` (`:310-339`) is the **only** constructor of `current_evidence`. It distinguishes:

- `current_evidence` — passing row whose snapshot identity equals current
- `stale_evidence` — passing row against a different snapshot
- `no_current_evidence` — never recorded / current failed / current inconclusive / only stale non-pass

Identity is `snapshotId + resolvedSha + manifestSha256` (`packages/db/src/mission-verification.ts:44-47`). Candidate digest is folded into scope so a later attempt cannot reuse the row (`packages/pipeline/src/warden-campaign-executor.ts:385-387`, `:421-429`).

**Sole production writer:** `tryRecordFettlerCampaignMissionVerification` (`packages/pipeline/src/warden-campaign-executor.ts:389-434`), after the Warden target is in stage `review`. Best-effort; unbound campaigns skip; store faults do not fail execute. Status `passed` only when every post-edit check is `passed`; otherwise `inconclusive` (`packages/pipeline/src/warden-campaign-executor.ts:374-380`).

**Read path:** Mission context compiler (`apps/worker/src/mission-context.ts` via `classifyMissionVerificationEvidence`). Informs inherited context. Does not block `transitionMission`.

ReGauge does **not** write `mission_verifications` in production.

**Spec §4.4 / §14 / §18:** PARTIAL for freshness; MISSING for CompletionGate; CONFLICTING if anyone widens `mission_verifications.status` to carry UNKNOWN as `passed`.

### B.3 Artifacts and evidence — LIVE; no visibility class

`artifact_manifests` + `evidence_records` (`packages/db/src/index.ts:681-711`) are content-addressed. Verdicts: `passed | failed | unknown | waived`.

`mission_artifacts` roles (`index.ts` mission_artifacts CHECK): `impact_report`, `migration_plan`, `candidate_patch`, `pull_request`, `test_run`, `verification_report`, `architecture_report`, `rollback_plan`, `graph_diff`. References, not copies.

`tryRegisterFettlerCampaignMissionArtifacts` is LIVE after campaign-execute (`warden-campaign-executor.ts` post-review). ReGauge complete-attempt registration is **not on this HEAD** (open #542).

**No `visibility` / hidden column** on manifests or mission_artifacts.

**Spec §8 / §18:** PARTIAL (immutable evidence exists); MISSING (hidden instrument isolation).

### B.4 Policy Envelope — LIVE admission, not completion

`policy_envelopes` is versioned and immutable (`packages/db/src/index.ts` policy_envelopes). Missions pin `policy_envelope_version`.

`evaluateMissionTaskPolicy` (`packages/pipeline/src/mission-policy-enforcement.ts`) is LIVE from:

- `assertCampaignExecutePolicy` (`warden-campaign-executor.ts`)
- `assertAgentRunMissionPolicy` (`apps/worker/src/agent-run-policy.ts` → `cli.ts` `agent.run`)
- ReGauge pilot policy (`apps/worker/src/regauge-pilot-policy.ts`)

A deny raises a blocking `policy_exception`. **#524 (merged)** binds Fettler `agent.run` exceptions to the **caller execution snapshot** and **caller `observedAt`**, not `mission.snapshotId` (`apps/worker/src/agent-run-policy.ts:39-49`). `bindMissionScope` remains a ReGauge-launch-only production call (`apps/api/src/regauge-production-bootstrap-runtime.ts:187`; definition `packages/db/src/mission.ts:212`).

**Spec §20:** PARTIAL (reference-system access can later use the envelope); MISSING (hidden-instrument policy, validator wall).

### B.5 MissionTask and handoffs — LIVE at task level

`mission_task` statuses include `human_review_required` and `complete` (`packages/db/src/index.ts` mission_task CHECK).

`openTaskHandoff` / `resolveTaskHandoff` (`packages/db/src/mission-handoff.ts`) are LIVE. Fettler review handoff after campaign-execute (`apps/worker/src/fettler-mission-task-claim.ts`). ReGauge review handoff from the pilot-lane `completeAttempt` wrapper (`apps/worker/src/transformer-pilot-lane.ts`). Human review API `POST /agent/runs/:id/candidate/review` (`apps/api/src/warden-candidate-review.ts`) resolves on approve/regenerate; reject records `recordReviewerDirective` and does not resolve the handoff.

MissionTask `complete` has no production transition found.

Handoffs do **not** advance Mission state.

**Spec §13 / implementer continuation:** PARTIAL (directive-shaped work can become a task); MISSING (RemediationDirective object and validator→implementer wall).

### B.6 Jobs / leases — LIVE scheduler

`jobs.lease_owner`, `lease_expires_at`, `lease_generation` (`packages/db/src/index.ts:118-136`). `claimNextJob` / `completeJob` / `failJob` are LIVE in `apps/worker/src/cli.ts`.

No `validation.run` job type.

**Spec §19:** PARTIAL (durability primitives exist); MISSING (resumable ValidationRun).

### B.7 Soft verifier — LIVE advisory only

`@mendpoint/verifier` / ADR-0007. Rollout modes include `off | offline | shadow | advisory | selective | automated`. Production advisory job sets `advisoryOnly: true`, `behaviorChanged: false` (`apps/worker/src/verifier-advisory-job.ts:135-136`).

**Spec §21:** PARTIAL (soft verifier exists); SATISFIED as a *constraint* (it does not override deterministic results today). Do not promote it to a gate.

### B.8 Governed learning — LIVE admission, unrouted sinks

`LearningDestination` (`packages/pipeline/src/learning-event.ts:51-71`) includes `graph`, `deterministic_recipe`, `calibration`, `no_action`, `organization_memory`.

`LESSON_DESTINATION_DISPOSITIONS` (`packages/pipeline/src/lesson-routing.ts:81`; the drop is described at `packages/pipeline/src/lesson-routing.ts:8-19`): production lessons are attributed `none` and route to `no_action`. `model_weight` and `retrieval` have sinks that are **fed nothing**. The other destinations are unrouted. `organization_memory` is vocabulary; `classify` never emits it.

**Spec §22:** PARTIAL (admission exists); DEFERRED to invent GRAPH / H4 `organization_memory` / FET-015 write-back sinks. Completion Assurance may admit events; it must not build those sinks.

### B.9 Graph coverage — LIVE in compiler, not a gate

Mission graph projection carries `impact: impact | no_impact | unknown_impact` and `coverageBasis: complete | partial | target_absent` (`packages/pipeline/src/mission-context-compiler.ts`). Structural epistemics `observed | inferred | ambiguous` (`packages/structural-graph`) are **not** projected into the mission envelope.

ADR-0002 (evidence sequencing) is still Proposed: router `coverage` often has no production source.

**Spec §16:** PARTIAL. A missing graph version must be `INSUFFICIENT_COVERAGE` / UNKNOWN, never COMPLETE. Do not treat `getGraphLearnDb()` as a production graph.

### B.10 Eval mutations — BUILT UNCALLED (prod)

`evals/mutations/engine.ts`: seeded API renames, counterfactual no-rename, ambiguous rename, Node runtime bump. In-memory, reversible, self-describing answer keys.

**Spec §15 / §28.6:** PARTIAL (engine exists); MISSING (completion-instrument eval and hidden holdout).

### B.11 ReGauge completeAttempt — LIVE unit, not Mission

`TransformerPilotStore.completeAttempt` requires `verificationPassed === true` and sets unit `executed` (`packages/transformer/src/pilot-execution.ts`). The worker wrapper (`transformer-pilot-lane.ts`) then `handoffRegaugeMissionTaskOnReview`. No `recordMissionVerification`. No Mission artifact register on this HEAD. No `transitionMission`.

Checkpoint complete (`completeAttemptWithCheckpointHead`) can bypass the coordinator wrapper (ADR `2026-08-25-regauge-pilot-mission-task-review.md`).

---

## Part C — Spec requirement classification

> **Classified against an out-of-repo document. Re-derive before acting.**
> The § numbers below key to the uploaded *Mendpoint Completion Assurance Product Spec for Cursor* v1.0, which is **not in this repository** — `git grep -il "Completion Assurance"` on `origin/main` returns zero files. No reader of this repository can check what any § requires, so the SATISFIED / PARTIAL / MISSING verdicts in this Part are **unauditable here** and must not be treated as reviewed. Part B (repository archaeology) is auditable and stands on its own; Part C does not. Vendoring the spec into `docs/completion-assurance/SPEC.md` is the fix and is owed before Wave A.

Classifications below are against Completion Assurance spec sections. “SATISFIED” is reserved for production paths.

### §2 Product goals (1–15)

All MISSING as a system. Adjacent PARTIAL notes: (5) evidence vs volume — verification standing exists but is unused as completion; (6) graph incompleteness — `coverageBasis` exists, not gated; (11) Mission persist — Mission records exist, completion entities do not; (14) ready-for-review gate — MISSING; (15) human exceptions — `mission_exceptions` LIVE, not bound to a CompletionGate.

### §4 Principles

| Principle | Class | Evidence |
|---|---|---|
| Requirements ≠ procedures | MISSING | No split types |
| Completion external to implementer | MISSING | Implementer writes and passes its own checks |
| Evidence > confidence | PARTIAL | ADR-0007 + verification standing; no gate uses them |
| Unknown is valid | CONFLICTING | `mission_verifications.status` has no UNKNOWN; `evidence_records.verdict` has `unknown`; do not collapse |
| Standards strengthen, not collapse | MISSING | No standard |
| Evidence-monotonic, not work-monotonic | MISSING | Task/campaign progress is the implicit done signal |

### §5 Actors

Orchestrator, Validator, Implementer-as-separate-role: MISSING. Human reviewer: PARTIAL (`warden-candidate-review.ts`). Implementer (Fettler/ReGauge): LIVE.

### §6–§7 Domain model

Every entity in §7: MISSING. Mission is the intended parent (PARTIAL join).

### §8 Validator wall

MISSING. Leak-test matrix does not exist. Artifact lookup is tenant-scoped but not role-scoped for hidden cases.

### §9 Standard creation before implementation

MISSING. Fettler enrollment and ReGauge launch can start material work with no CompletionStandard. `created_before_execution` is unenforceable until the table exists.

### §10 Fettler categories

PARTIAL inventory exists as impact analysis + campaign-execute verification + counterfactual *eval* mutations. Not a Mission CompletionStandard. Impact completeness is the Fettler product promise; it is not an independent validator.

### §11 ReGauge categories

MISSING as a Mission-level standard. Pilot stages exist in the transformer control plane; they are not completion requirements.

### §12 Differential validation

MISSING as a Completion Assurance procedure. Local baseline vs post-edit comparison in Fettler campaign-execute is same-repo deterministic verification, not a versioned reference-system oracle.

### §13 Finding triage / directives

PARTIAL: reviewer reject → `recordReviewerDirective` / `persistRejectedApproachDecisions`. MISSING: validator-owned root-cause grouping and leak-free RemediationDirective.

### §14 CompletionGate

MISSING. Blocking conditions cannot fire. `READY_FOR_HUMAN_REVIEW` is not a stored decision. Warden target `review` and MissionTask `human_review_required` are not this gate.

### §15 Validator eval / mutation benchmark

PARTIAL: `evals/mutations`. MISSING: instrument recall/precision, hidden holdout, mutation_detection_rate as an activation input.

### §16 Change Graph integration

PARTIAL: projection + coverage basis. MISSING: gate integration, graph-learning loop from validator findings (and DEFERRED to invent graph write-back).

### §17 Mission infrastructure integration

PARTIAL: Mission timeline/events via `appendDomainEvent`. MISSING: replay of active standard / findings / gates (those rows do not exist).

### §18 Evidence substrate

PARTIAL: manifests + evidence_records + snapshot identity. MISSING: gate bound to exact evidence digests of a ValidationRun.

### §19 Execution substrate

PARTIAL: jobs/leases. MISSING: ValidationRun resume, “60% complete then crash” scenario for the instrument.

### §20 Security

PARTIAL: tenant isolation on Mission records; Policy Envelope. MISSING: hidden-case deny for implementer; reference-system sandbox policy for differential; prompt-injection tests for “reveal hidden cases”.

### §21 Verifier platform

PARTIAL / constraint SATISFIED: DeepSeek remains advisory (`behaviorChanged: false`). Do not let a future wave override deterministic mismatch.

### §22 Governed learning

PARTIAL admission; DEFERRED sinks. Do not train on infrastructure failures. Do not invent `organization_memory` routing.

### §23 Test-time compute

MISSING. No cost_per_closed_requirement. Existing MCU/cost ledgers are not completion-driven.

### §24 UX

MISSING. No Mission Completion panel. Do not expose hidden cases through existing review consoles (open #526 is impact lineage, not this panel).

### §25 APIs

MISSING. No completion-standard / validation-run / gate routes. Future paths must follow existing `/missions/:id/...` conventions and fail closed for hidden GETs.

### §26 Observability

MISSING for completion-specific metrics. Some adjacent counters exist (verification rows, policy evaluations).

### §27 Failure taxonomy

MISSING as named Completion Assurance codes. Adjacent: `mission_transition_invalid`, policy exception categories, verification absence reasons.

### §28 Test matrix

MISSING for Completion Assurance. Adjacent suites: `mission-verification.test.ts`, policy exception tests (including #524 caller-snapshot mutation), leak tests do not exist.

### §29–§30 Vertical slices A/B

MISSING.

### §31 Rollout phases 0–5

Phase 0 (this document + IMPLEMENTATION_PLAN) is the first wave. Phases 1–5 MISSING.

### §37 Product acceptance (1–22)

All unmet. Closest PARTIAL items: (6) some evidence is snapshot-bound; (16) jobs are idempotent for *other* work; (18) DeepSeek is still soft.

### §38 Truth boundary

SATISFIED as a *documentation* constraint in this file: we do not claim Fettler/ReGauge complete because Mission tables exist. The four tracked claims (`COMPLETION_ASSURANCE_FOUNDATION` … `CUSTOMER_OUTCOME_PROVEN`) are unset.

### §39 Open product decisions

All 15 remain unresolved. Foundation waves store fields; they do not pick activation thresholds. See IMPLEMENTATION_PLAN.

---

## Part D — Bind-from-caller-snapshot (house lesson)

Live Fettler Missions are created without `snapshotId` (`apps/api/src/warden-campaign-enrollment.ts:501-512`). `bindMissionScope` has one production caller: ReGauge launch (`apps/api/src/regauge-production-bootstrap-runtime.ts:187`).

Any Completion Assurance writer that binds `observedAgainst`, candidate identity, or a ValidationRun to `mission.snapshotId` on the Fettler path will raise unbound / permanently blocking state. Bind from the **caller’s execution snapshot**. Require `observedAt` from the caller clock — no `new Date()` fallback (#524).

Tests must not call `bindMissionScope` to fake a Fettler path the live caller never takes.

---

## Part E — Collision / do-not-edit while open

Re-check at each wave. As of this archaeology:

| Surface | Why |
|---|---|
| `apps/api/src/warden-candidate-review.ts` | Open #516 / #499 |
| `apps/worker/src/mission-context.ts`, `packages/pipeline/src/mission-context-compiler.ts` | Open #533 (review blockers), #543 |
| `apps/worker/src/transformer-pilot-lane.ts` | Open #542 (ReGauge artifacts) |
| `apps/worker/src/cli.ts` | Many open branches |
| Root `package.json`, claims (#461), authority/matrix PRs | Not this program |
| `scripts/production-closure-*.ts`, `config/production-closure-*.json`, `docs/PRODUCTION_CLOSURE_MATRIX.json` | Cursor does not reseal except on an owned bootstrap PR |

#523 (ReGauge pilot policy exception) and #524 (Fettler agent.run policy exception) are **merged**. Their conventions are now main: caller snapshot + caller `observedAt`.

Wave 0 (this PR) touches only `docs/completion-assurance/*`.

---

## Part F — What this document authorizes

**Authorized:** start Wave 0b ADRs and Phase A schema *after* this archaeology is reviewed, following [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

**Not authorized:** live ValidationRuns, product-gate bind of `verifying` → `awaiting_review`, customer UX, learning sinks, Graphify production, H2 training, `MENDPOINT_CUSTOMER_READY=1`, or the sentence “Fettler/ReGauge migrations are complete.”
