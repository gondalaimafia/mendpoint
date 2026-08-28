# Production closure execution ledger

This is the Wave 0 exhaustive 101-row ledger. It does not replace the approved eleven-phase plan or change any requirement status.

- Observed main: `96801a319fc3d355cb2b28b4167b83023a192042`
- Observed at: 2026-08-28T23:50:00.000Z
- Rows: 101
- Status mix: 28 verified, 53 partial, 10 documented, 6 unimplemented, 3 scaffold, 1 blocked_external

Machine-readable source: `docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json`.
Regenerate with `npx tsx scripts/generate-production-closure-execution-ledger.ts`.

Wave 0 control-plane work (not a requirement row): Claude owns the #515 authority repair. Cursor does not push to `fix-open-pr-head-oracle` or other authority files.

## Wave 1: Drain the built queue

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-ING-007` | verified | Register is verified, but production readback on 5ba70419 shows releasePollingConfigured:false. #507 is the drain; not merged or deployed. | 431 | Drain and deploy #507 (release-dispatch), then prove a configured customer consumer on mendpoint-talal. |
| `ME-ENT-005` | partial | Partial observability exists; #507's tenant-bound dispatch traces are not on the deployed revision. | 438 | Same as #507: tenant-bound dispatch events must appear in production health after deploy. |
| `ME-ENT-006` | partial | SQLite single-node works; #507's fenced multi-worker drain is not deployed. | 438 | Same as #507: fenced leases and shutdown boundaries on the live worker. |
| `ME-ENT-007` | partial | Backup workflows exist; #513's authenticated release-ingestion restore authority is not merged. Customer backup issue #429 remains open. | 351 | Rebase and deploy #513 after #507; boot against a pre-change database and restore a signed receipt. |
| `ME-ENT-008` | partial | Router circuit breakers exist; #507's durable dispatch outage/backlog path is not deployed. | 438 | Same as #507: backlog health and retryable provider failure on the live worker. |
| `ME-FET-015` | partial | Partial on main via #514: tenant-authorized Fettler indexes persist. Smallest gap is exact-revision production evidence that materialization is used by a live impact caller. Do not mark verified. | 431 | Deploy the #514 revision; keep this row partial. Do not mark verified. |
| `ME-REG-017` | unimplemented | #512 binds ReGauge dependency certainty to sealed workspace authority; main still risks empty dependsOn reading as 'no dependency'. After #512, remaining unknown-vs-absent cases stay Wave 7. | 434 | Ship semantic package-lock authority, then rebase and deploy #512. Keep incomplete coverage as unknown. |

## Wave 3: Dedicated ReGauge and DeepSeek advisory production

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-TRN-005` | partial | Real-repository execution is partial; dedicated ReGauge production app has no image (Wave 3). | 350 | from current main after dependencies |
| `ME-TRN-010` | partial | Workspace authority exists in #512; production ReGauge is disabled/inactive on 5ba70419. | 434 | from current main after dependencies |

## Wave 4: Shared Mission intelligence foundation

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-MSN-001` | partial | Mission rows bind repo/snapshot/graph version on some live paths; Fettler repair jobs can still run with no mission id, and restart/handoff does not yet prove the same Mission without transcript reconstruction. | 430 | from current main after dependencies |
| `ME-MSN-002` | partial | Typed decisions/exceptions/artifacts/handoffs exist. Open PRs #457/#466/#467 still carry compiler/handoff/artifact leftovers; do not collide. Decisions can be superseded in store; production caller coverage is incomplete. | 430 | from current main after dependencies |
| `ME-MSN-003` | partial | Compiler, resume, and policy inheritance exist. Exit proof (process restart + human handoff resume of the same Mission, inspectable lineage) is not production-proven. | 430 | from current main after dependencies |
| `ME-MTE-001` | partial | openTaskHandoff and job-bridge exist on merged Fettler/ReGauge review paths. #516 binds review resolution to the job task; #465/#499 are contended. Resume after human review is not proven across a process restart. | 435 | from current main after dependencies |
| `ME-OMM-001` | partial | Governed store and precedence resolver exist and are consulted on ReGauge plan and Mission compile. Memory is not yet emitted from both products' production outcome events (Wave 8). | 436 | from current main after dependencies |
| `ME-PEV-001` | partial | Versioned envelopes bind at Mission creation and compile into hard policy. Policy-evaluation evidence is not durably attached to the decision that used that envelope version. | 350 | from current main after dependencies |
| `ME-MCC-001` | partial | Compiler and worker producer exist. Leftover after #449: require mission.repositoryId === fallback.repositoryId; treat store_not_available/graph_projection_failed with a live endpointKey as context_not_loaded; gate published versions on gl_software_versions_v1, not gl_nodes. Blocked on #517 file overlap for mission-context.ts. | 430 | from current main after dependencies |

## Wave 5: Fettler production activation

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-ING-001` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-ING-003` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-ING-004` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-ING-006` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-ING-009` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-SCM-003` | partial | GitHub App lifecycle tests exist; production customer profile (real App, no seed, approved polling) is not the primary app configuration. | 432 | from current main after dependencies |
| `ME-SCM-004` | partial | GitLab adapters exist; an approved disposable private project and credentials do not. | 432 | from current main after dependencies |
| `ME-WAR-001` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-WAR-002` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-WAR-004` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 433 | from current main after dependencies |
| `ME-WAR-005` | scaffold | Policy enforcement on Fettler campaigns is scaffold; inherited Policy Envelope is not the live campaign gate. | 431 | from current main after dependencies |
| `ME-WAR-006` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 433 | from current main after dependencies |
| `ME-WAR-009` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 433 | from current main after dependencies |
| `ME-WAR-010` | blocked_external | Externally blocked: consented private customer repository and observed design-partner acceptance are missing. | 433 | Blocked until an approved Fettler design-partner repository and observed acceptance exist. |
| `ME-FET-016` | partial | Impact paths exist in graph-learn/code-impact; the live Fettler UI/review package does not always expose provider→code→verification lineage on a customer campaign. | 431 | from current main after dependencies |
| `ME-FET-017` | partial | queryFettlerEndpointImpact distinguishes no_impact vs unknown_impact; some producers still treat store_not_available / missing graph version as absence rather than unknown. | 431 | from current main after dependencies |
| `ME-FET-018` | unimplemented | No production raw-retrieval fallback. Do not invent one that writes unverified edges into the current graph version. | 431 | New Fettler Wave 5 PR after Mission foundation: targeted raw retrieval when graph coverage is insufficient. |

## Wave 6: Change Graph production maturity

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-GRF-001` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-GRF-002` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-GRF-004` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-GRF-005` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-GRF-006` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-GRF-007` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-GRF-008` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 431 | from current main after dependencies |
| `ME-CGR-001` | unimplemented | Change Graph pieces exist (versions, tenant views, impact query, MissionGraphProjection compiler). Production-grade acceptance — holdouts, Graphify qualification, temporal reconstruction, publication failure — is unimplemented. | 431 | New Change Graph Wave 6 PR after Waves 4 and 5 tracer. Do not invent Graphify production. |
| `ME-SXT-001` | partial | Mendpoint-owned extractor contract exists. Graphify remains internal and unqualified; product APIs must not leak extractor types. | 431 | from current main after dependencies |

## Wave 7: Complete the ReGauge product experience

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-SCM-006` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 432 | from current main after dependencies |
| `ME-TRN-001` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 434 | from current main after dependencies |
| `ME-TRN-002` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 434 | from current main after dependencies |
| `ME-TRN-006` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 435 | from current main after dependencies |
| `ME-TRN-008` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 435 | from current main after dependencies |
| `ME-TRN-009` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 434 | from current main after dependencies |
| `ME-REG-015` | unimplemented | DEPENDS_ON ingest and invariants exist; hybrid runtime/config/job/test relationship evidence is unimplemented. | 434 | New ReGauge Wave 7 PR: hybrid relationship evidence (static/runtime/config/jobs/tests). |
| `ME-REG-016` | unimplemented | Planner hypotheses are not persisted as distinct from observed MUST_PRECEDE / BLOCKS constraints. | 434 | New ReGauge Wave 7 PR: MUST_PRECEDE / BLOCKS provenance distinct from planner hypotheses. |
| `ME-REG-018` | unimplemented | ReGauge plan consults graph when a file-backed GRAPH_LEARN_DB exists; it does not require a MissionGraphProjection before raw exploration. | 434 | New ReGauge Wave 7 PR: plan from MissionGraphProjection before broad raw exploration. |

## Wave 8: Governed learning and model lifecycle

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-FND-004` | documented | Training remains unshipped; the documented boundary is not yet backed by a promotion/canary/rollback ceremony on a consented dataset (Wave 8). | 430 | from current main after dependencies |
| `ME-FND-009` | documented | Default tenant-isolated learning is coded; shared-training opt-in, contamination, and deletion proofs are not production-live. | 430 | from current main after dependencies |
| `ME-RTR-006` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 350 | from current main after dependencies |
| `ME-RTR-007` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 436 | from current main after dependencies |
| `ME-RTR-008` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 436 | from current main after dependencies |
| `ME-RTR-009` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 350 | from current main after dependencies |

## Wave 9: Economics and billing

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-FND-007` | documented | Metric dictionary is documented; it is not the live MCU/billing authority used for customer invoices (Wave 9). | 430 | from current main after dependencies |
| `ME-FND-008` | documented | MCU model exists in code (ME-COM-001) but the documented reservation/settlement/invoice mapping is not finance-activated. | 430 | from current main after dependencies |
| `ME-COM-003` | partial | Invoice-export contract is incomplete; live charging is forbidden without finance authority. | 439 | from current main after dependencies |

## Wave 10: Enterprise trust, reliability, documentation, and public claims

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-FND-001` | documented | Canonical v4 spec is enrolled, but the row is documented-only: no GA promotion and docs/PRODUCT_SPEC.md remains a compressed summary, not the authority. | 430 | from current main after dependencies |
| `ME-FND-002` | documented | GitHub-pilot / GitLab-GA boundary is written; GitLab production proof and the GA tier assignment are still undocumented as enforced release gates. | 430 | from current main after dependencies |
| `ME-FND-003` | documented | ReGauge pilot vs GA tiers exist in docs; the dedicated mendpoint-regauge-production app has no deployed image (Wave 3). | 430 | from current main after dependencies |
| `ME-FND-005` | documented | Self-host is documented as pilot; VPC remains scaffold (ME-ENT-011) with no approved cloud account. | 430 | from current main after dependencies |
| `ME-FND-006` | documented | Performance contract docs exist; production load/soak on the exact deployed revision does not. | 430 | from current main after dependencies |
| `ME-FND-010` | documented | Register rows have targetRelease values; there is no atomic gate that refuses a mixed-tier promotion. | 430 | from current main after dependencies |
| `ME-ENT-001` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 437 | from current main after dependencies |
| `ME-ENT-002` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 437 | from current main after dependencies |
| `ME-ENT-003` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 351 | from current main after dependencies |
| `ME-ENT-004` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 351 | from current main after dependencies |
| `ME-ENT-009` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 438 | from current main after dependencies |
| `ME-ENT-010` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 438 | from current main after dependencies |
| `ME-ENT-011` | scaffold | Scaffold only. Replace with a real production path or keep explicitly scaffolded; do not claim GA. | 438 | from current main after dependencies |
| `ME-ENT-012` | scaffold | Scaffold only. Replace with a real production path or keep explicitly scaffolded; do not claim GA. | 438 | from current main after dependencies |
| `ME-GTM-003` | partial | Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence. | 433 | from current main after dependencies |

## Wave 11: Final 101-of-101 qualification

| ID | Status | Smallest unmet gap | Issue | Next PR |
|---|---|---|---|---|
| `ME-ING-002` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 431 | from current main after dependencies |
| `ME-ING-005` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 431 | from current main after dependencies |
| `ME-ING-008` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 431 | from current main after dependencies |
| `ME-SCM-001` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 432 | from current main after dependencies |
| `ME-SCM-002` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 432 | from current main after dependencies |
| `ME-SCM-005` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 432 | from current main after dependencies |
| `ME-GRF-003` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 431 | from current main after dependencies |
| `ME-WAR-003` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 431 | from current main after dependencies |
| `ME-WAR-007` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 433 | from current main after dependencies |
| `ME-WAR-008` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 431 | from current main after dependencies |
| `ME-TRN-003` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 350 | from current main after dependencies |
| `ME-TRN-004` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 435 | from current main after dependencies |
| `ME-TRN-007` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 435 | from current main after dependencies |
| `ME-TRN-011` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 434 | from current main after dependencies |
| `ME-TRN-012` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 350 | from current main after dependencies |
| `ME-TRN-013` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 434 | from current main after dependencies |
| `ME-RTR-001` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 436 | from current main after dependencies |
| `ME-RTR-002` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 436 | from current main after dependencies |
| `ME-RTR-003` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 436 | from current main after dependencies |
| `ME-RTR-004` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 436 | from current main after dependencies |
| `ME-RTR-005` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 436 | from current main after dependencies |
| `ME-COM-001` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 439 | from current main after dependencies |
| `ME-COM-002` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 439 | from current main after dependencies |
| `ME-COM-004` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 439 | from current main after dependencies |
| `ME-GTM-001` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 433 | from current main after dependencies |
| `ME-GTM-002` | verified | Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote. | 433 | from current main after dependencies |

