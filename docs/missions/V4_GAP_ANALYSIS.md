# v4 persistent-context gap analysis (re-run)

Performed against `origin/main` @ `8df0580` (2026-08-25), after the Mission Space wiring wave that landed between the 2026-08-21 archaeology and this tip (`#341`, `#343`/`#415`/`#416`, `#344`/`#365`/`#414`, `#383`/`#390`/`#402`/`#418`/`#419`/`#420`/`#421`/`#427`).

Every claim was checked against code. Where the v4.0 spec and the code disagree, the code is reported. The v4-platform register still records all eight requirements as `partial` / `internal_only`; this document does **not** flip those statuses.

The 2026-08-21 sweep is retained at [`docs/missions/CURRENT_STATE.md`](CURRENT_STATE.md). That document is historical: many of its "built, uncalled" findings are now live. Use this file for current v4 gap status.

Throughout, four states are distinguished and never collapsed:

- **live** — exists and is called on a real (non-test) path
- **built, uncalled** — exists, may be tested, has zero non-test callers
- **partial** — live on some required seams, missing required semantics or other seams
- **absent** — does not exist under any name

Do not invent: Graphify production adoption, H2 training, H4 `organization_memory` learning routing, FET-015/018 graph write-back, REG-015/016, a user-preference store, or `getGraphLearnDb()` as a production graph.

Canonical spec: `docs/product/mendpoint-product-platform-specification-v4.md` §§6.5–6.10, 11.22–11.26, 28.1.0. Enrolled as register set `v4-platform` (`docs/adr/2026-08-22-enroll-v4-persistent-context-register.md`).

---

## What changed since 2026-08-21

The 2026-08-21 finding was "most of what a Mission Space needs is already written and simply never invoked." That is no longer the headline. The primitives are now load-bearing on **some** live seams. The remaining gaps are incomplete coverage, not missing tables.

| Then (2f914cb) | Now (8df0580) |
|---|---|
| Mission is a write-once ReGauge correlation key; snapshot/graph/policy columns unused or absent | Mission is created on Fettler enroll and ReGauge launch; default Policy Envelope is bound; graph version is pinned for **single-repo** campaigns; ReGauge launch binds repository/snapshot |
| `transitionMission` built, uncalled | Live on ReGauge launch (and related bind helpers) |
| No MissionTask / handoff | MissionTask claim/review live on Fettler campaign execute, ReGauge pilot, and job bridge. `openTaskHandoff` / `resolveTaskHandoff` still **built, uncalled** |
| No context compiler; prompt is a constant playbook | Compiler + `resolveResumeContext` + `inheritedContextShouldCompile({ missionBound })` **live** on bound Fettler `agent.run` |
| Policy envelope synthesized per call from hardcoded literals | Versioned envelope persisted and bound at mission create; enforced on bound `agent.run` and ReGauge pilot; **not** on campaign execute |
| No Organization Memory | Tenant-scoped store + HTTP inspect/disable **live**; compiler and ReGauge plan consult **live**; H4 learning route still blocked |
| Artifact registry unwired | Fettler campaign execute registers candidate_patch / verification_report / pull_request **live**; ReGauge register seam absent |
| `context_refs_json` zero writers | Written when inherited context compiles and injects on bound Fettler runs |
| No graph/policy version on the mission row | Columns + set-once bind helpers **live** on single-repo enroll/launch |

Register locators for ME-MSN-002 now include `packages/pipeline/src/mission-artifact-register.ts` and its unit tests (`#418` + `#421`). FET-017/FET-018 impact coverage (`#395`, `#401`, `#427`) is a Fettler epistemics close, not a v4-platform row.

---

## v4-platform requirements

### ME-MSN-001 — Persistent Mission Space (§6.5)

**Register status:** `partial`. **This re-run:** **partial**.

| Required retention | State | Live seam |
|---|---|---|
| Objective / trigger, tenant | **live** | `createMission` on Fettler enroll (`apps/api/src/warden-campaign-enrollment.ts`) and ReGauge control-plane / launch |
| Repository + immutable snapshot on the mission row | **partial** | `bindMissionScope` is **live** only from `apps/api/src/regauge-production-bootstrap-runtime.ts`. Fettler missions keep `repository_id` / `snapshot_id` null; snapshots live on campaign targets |
| Change Graph version | **partial** | `bindMissionGraphVersion` via `pinPublishedGraphVersionForSingleRepository` at Fettler enroll, ReGauge launch, and post-publication in `packages/pipeline/src/index.ts`. Multi-repo / missing graph file stay unbound; enroll/launch swallow pin failures |
| Policy envelope version | **live** | `ensureDefaultPolicyEnvelopeBinding` at Fettler enroll, ReGauge control-plane POST, ReGauge launch |
| Decisions / exceptions / artifacts / verification / cost | see ME-MSN-002 / ME-MSN-003 | Mixed |
| Conversational transcript is not the durable store | **live** (intent) | Bound Fettler runs compile from Mission rows, not chat history. Unbound Fettler `agent.run` still has no Mission |

**Remaining:** Fettler snapshot pin on the mission row; multi-repo graph bind; fail-closed pin instead of best-effort swallow.

### ME-MSN-002 — Decisions, exceptions, artifacts (§6.9)

**Register status:** `partial`. **This re-run:** **partial**.

| Primitive | Store | Live writer |
|---|---|---|
| `MissionDecision` persist | **live** (library) | `recordReviewerDirective` on **regenerate only** (`apps/api/src/warden-candidate-review.ts`, `decisionType: "verification"`) |
| Supersession / retract | **built, uncalled** | `supersedeMissionDecision` / `reviseDecisionOnNewEvidence` — tests + handoff module only |
| `MissionException` raise/resolve | **built, uncalled** | Only `openTaskHandoff` / `resolveTaskHandoff` (tests). Compiler **reads** `evaluateMissionExceptions` on live bound runs (usually empty) |
| `MissionArtifact` by-reference register | **partial** | `tryRegisterFettlerCampaignMissionArtifacts` **live** from `executeWardenCampaignTarget`. No ReGauge register seam. Roles such as impact_report / graph_diff unused on live paths |
| Reviewer **reject** → durable decision (FET-021) | **absent** on live path | Reject branch updates the agent run + audit only. Open PR `#381` |

### ME-MSN-003 — §28.1.0 acceptance (see checklist below)

**Register status:** `partial`. **This re-run:** **partial**. The acceptance list is not uniformly live; several items are live on one product seam and missing on the other.

### ME-MTE-001 — Shared Mission Task Engine (§6.8)

**Register status:** `partial`. **This re-run:** **partial**.

| §6.8 MUST | State |
|---|---|
| Task type, status, owner, risk, handoff reason | **live** on claim/review |
| Claim → `agent_working` | **live** — Fettler campaign execute, ReGauge pilot, job bridge (`bridgeClaimedJobToMissionTask`) |
| Review → `human_review_required` | **live** — same seams, via `transitionMissionTask` (string `handoffReason`) |
| `openTaskHandoff` / `resolveTaskHandoff` (exception + MissionTask in one transaction) | **built, uncalled** — `taskId` **does** transition MissionTask when present; nothing in worker/API calls these functions |
| `agent_resume` → `agent_working` | **built, uncalled** |
| `complete` | **built, uncalled** |
| Dependency DAG / `missionTaskReady` | **built, uncalled** |
| Input/output artifact refs and required-approval on the task row | **absent** (those live on other stores) |

Live handoff and the §6.9 exception-driven handoff API are **not unified**. Bound Fettler resume reconstructs context via the compiler, not via `resolveTaskHandoff`.

### ME-OMM-001 — Organization Memory (§6.6)

**Register status:** `partial`. **This re-run:** **partial**.

| Capability | State |
|---|---|
| Tenant-scoped store, provenance, inspect, disable/delete/edit | **live** — `packages/db/src/organization-memory.ts`, HTTP `/organization-memory` |
| Precedence vs hard policy and current Mission decisions | **live** on the context compiler and ReGauge plan consult (`consultRegaugeOrganizationMemory`) |
| Spec lifecycle starting at `OBSERVATION` | **partial** — first write inserts `MEMORY_CANDIDATE`; `OBSERVATION` is in the enum but unused |
| Automated observation from Fettler/ReGauge runs | **absent** — HTTP + tests only |
| H4 learning destination `organization_memory` | **blocked** — taxonomy exists; `classify()` never emits it; `lesson-routing.ts` marks it `unrouted`. Do not invent a sink |
| User-preference store (precedence slot below org memory) | **absent** — compiler always `{ consulted: false, reason: "store_not_available" }` |

### ME-PEV-001 — Versioned Policy Envelope (§6.7)

**Register status:** `partial`. **This re-run:** **partial**.

| Capability | State |
|---|---|
| Versioned envelope type + immutable `policy_envelopes` row | **live** |
| Bind at Mission create | **live** — Fettler enroll, ReGauge control-plane POST, ReGauge launch (`ensureDefaultPolicyEnvelopeBinding`) |
| Retain version under which a decision was made | **partial** — mission row pins a version; decisions do not independently record envelope version beyond that pin |
| Deterministic enforcement | **partial** — **live** on bound Fettler `agent.run` (`assertAgentRunMissionPolicy`) and ReGauge pilot (`assertRegaugePilotMissionPolicy`). **Absent** on Fettler campaign execute. Unbound jobs skip. Open PR `#379` |
| Explicit/auditable upgrade mid-mission | **partial** — `advanceMissionPolicyEnvelopeVersion` live on the ReGauge verifier-advisory path only |

Default envelope is permissive on scopes (`externalProcessingAllowed: true`, `riskCeiling: "critical"`, `reviewRequired: true`) per the bind-at-create ADR. Empty allowlists mean unrestricted, not deny-all.

### ME-MCC-001 — Mission Context Compiler (§6.10)

**Register status:** `partial`. **This re-run:** **partial**.

Live chain:

`apps/worker/src/cli.ts` → `inheritedContextShouldCompile({ missionBound })` → `resolveResumeContext` → `buildMissionContext` → `compileAndRenderMissionContext` → `renderInheritedContextSystemBlock` (untrusted-text fence).

Explicit `MENDPOINT_INHERITED_CONTEXT=0`/`false` wins over `missionBound`. Unbound Fettler still requires the env switch.

| Compiler input | Live producer |
|---|---|
| Mission identity, task, active decisions | **live** when mission-bound |
| Organization Memory | **live** (`listOrganizationMemory`) |
| Policy Envelope directives | **live** when envelope pinned |
| Unresolved exceptions | **live** read (register usually empty) |
| Verification history | **live** read (`recordMissionVerification` itself is **built, uncalled**) |
| Trajectories | **live** |
| MissionGraphProjection | **partial** — `compileMissionGraphProjection` exists; worker producer always `{ consulted: false, reason: "endpoint_key_absent" \| "graph_version_absent" }` even when `graphVersionId` is pinned |
| User preferences | **absent** (`store_not_available`) |
| Mission artifacts | **partial** — no live artifact-store read into the producer |
| `trajectories.context_refs_json` | **partial** — populated only when compile+inject succeeds |
| Measurement harness | **built, uncalled** (`mission-context-measure.ts`) |

### ME-SXT-001 — Pluggable structural extractor (§11.22–11.26)

**Register status:** `partial`. **This re-run:** **partial**.

| Clause | State |
|---|---|
| Mendpoint-owned contract, no extractor types in product APIs | **live** (contract) — `packages/structural-graph`, `docs/graph/STRUCTURAL_EXTRACTOR_CONTRACT.md` |
| Production index path uses the contract | **partial** — production still calls `buildCallGraph` (`@mendpoint/call-graph`), not `@mendpoint/structural-graph` |
| Graphify evaluation / adoption ADR | **partial** — ADR-0006 `INTERNAL_TOOL_ONLY`; Codex PR `#331` still open. `GraphifyStructuralExtractor` has **zero** non-test importers. Do not adopt Graphify from this analysis |
| Structural→semantic promotion | **partial** — materializer can carry `structuralSource`; production call-graph path does not feed it |
| Extractor epistemic mapping EXTRACTED/INFERRED/AMBIGUOUS | **live** in the normalizer library |
| §11.26 community/centrality as features | **absent** |

---

## §28.1.0 Mission acceptance checklist

| Criterion | State | Notes |
|---|---|---|
| Stable repository snapshot binding | **partial** | ReGauge launch yes; Fettler mission row no |
| Stable graph snapshot binding | **partial** | Single-repo pin live; multi-repo / missing graph unbound |
| Decisions persist and can be superseded | **partial** | Persist live on regenerate; supersede **built, uncalled**; reject does not persist |
| Exceptions persist and can be resolved | **built, uncalled** | Store ready; live paths do not raise |
| Verification history scoped to the state it verified | **partial** | Classifier + compiler consume rows; **no live writer** |
| Agent → human → agent without losing context | **partial** | Context: **live** on bound Fettler via compiler. Task: live through `human_review_required`, not back through `agent_resume` / `openTaskHandoff` |
| Compiler includes relevant active state, excludes stale history | **partial** | Decisions/org-memory/policy live; graph projection and artifacts not consulted; stale exceptions folded into unresolved |
| Policy Envelope inherited **and** enforced | **partial** | Inherited at create; enforced on bound `agent.run` + ReGauge pilot; not campaign execute |
| Organization Memory tenant-scoped, inspectable, disableable, subordinate | **partial** | Store + HTTP + compiler precedence live; no automated observation; H4 blocked |
| Duplicate callbacks/task completions idempotent | **partial** | Set-once binds and revision CAS live; job `completeJob` is not replay-safe idempotent |
| Concurrent updates do not silently erase state | **live** | Mission / MissionTask / bind helpers use revision-fenced updates |
| Mission cost/MCU attribution | **partial** | `recordBoundMissionExecutionCost` live when the job is mission-bound; typical unbound Fettler `agent.run` still NULL |

---

## Remaining gaps (priority)

These are the next honest closes. Do not start the blocked items.

1. **Fettler campaign execute does not enforce the inherited Policy Envelope.** Bind exists at enroll; execute uses snapshot verification policy only. Open: `#379`.
2. **`openTaskHandoff` / `resolveTaskHandoff` / `agent_resume` are unwired.** Live claim/review uses `transitionMissionTask` without the exception+decision seam. Dual models.
3. **Reviewer reject does not persist a MissionDecision (FET-021).** Only regenerate writes `recordReviewerDirective`. Open: `#381`.
4. **`recordMissionVerification` has no live writer.** Compiler will keep classifying an empty history.
5. **Fettler mission row does not pin repository/snapshot.** Verification currency and §6.5 snapshot retention depend on it.
6. **MissionGraphProjection is not on the live compile path** even when `graphVersionId` is pinned (`endpoint_key_absent`).
7. **Exception and decision supersession stores are read-ready and almost unwritten** except regenerate directives.
8. **Artifact registry is Fettler-execute-only.** No ReGauge register seam.
9. **H4 `organization_memory` routing remains blocked.** Taxonomy only. Do not add a sink without the classifier + ADR.
10. **Structural extractor contract is not the production indexer.** Graphify stays eval/internal (`#331`). Do not treat community detection as architecture truth.
11. **User-preference store remains absent.** Keep the compiler's `store_not_available`; do not invent one.

MCU attribution, `context_refs_json`, and compiler injection all follow **mission binding**. Unbound Fettler repair jobs are still the common case and will keep looking like the 2026-08-21 world until enroll/claim always stamps `payload.missionId`.

---

## Related Fettler epistemics (not v4-platform rows)

Landed on this tip and relevant to spec §0 item 8 (explicit epistemic state):

- FET-017 `impactCoverage` discriminator on `GET /changes/:id` (`#395`)
- FET-018 `raw_retrieval` stamp when `analyzeImpact` is the impact path (`#401`) and tenant-scoped audit lookup on the change report (`#427`)
- Empty findings are `no_impact` only when every PR `coverage.basis === "analyzed"`
- **No** FET-018 write-back of fallback relationships into a later graph version

---

## Open PRs that address remaining v4 gaps

Do not merge these from this analysis. Do not duplicate their work.

| PR | Intended close |
|---|---|
| `#379` | Policy Envelope enforcement at campaign execute |
| `#381` | FET-021 skip edits a Mission already rejected |
| `#331` | Pinned Graphify process evaluator (eval only; not production adoption) |
| `#388` | `PRESERVES_INVARIANT` ingest (graph; not Mission Space) |

---

## Method

- Read v4.0 §§6.5–6.10, 11.22–11.26, 28.1.0 and the `v4-platform` register rows.
- Classified each required behavior by searching for the symbol and its non-test callers (apps/api, apps/worker, packages/pipeline production modules). Test-only callers count as **built, uncalled**.
- Did not change register `implementationStatus`. Rows stay `partial` until a requirement is load-bearing on the seams the spec names, with live evidence — not primitives plus tests.
