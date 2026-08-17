# MendPoint Learning Flywheel Implementation Plan

Updated: 2026-08-14

## Must Have

### 1. Common governed learning event

Problem: ReGauge stores product-specific outcome documents and Fettler is not connected. Raw telemetry has no explicit lesson classification.

Existing implementation: ReGauge outcome builders, redaction, evidence admission, consent, and append-only learning records.

Proposed change: add a versioned common envelope with product, mission, repository, task, capability, model and adapter, router decision and fallback, graph and input references, prediction, proposed action, observed outcome, correction, verification, reviewer decision, confidence, cost, latency, tenant, residency, consent reference, provenance, and source class. Canonical provenance includes synthetic ground truth, design partner verified, and production verified, with optional human corrected, deterministically verified, reviewer accepted, and merged verified qualifiers. Preserve product-specific payloads. Continue reading existing ReGauge outcome version one documents.

Files: a shared contract, narrow Fettler and ReGauge producers, corpus parser, tests.

Migration: none. Store the new envelope as redacted immutable artifacts referenced by existing learning records.

Tests: schema limits, deterministic digest, positive, negative, corrected, and abstention events, unsafe redaction, duplicate identity, cross tenant and residency rejection.

Rollout and rollback: dual read existing ReGauge documents and new envelopes. Capture remains feature gated and consent gated. Rollback disables new capture without invalidating existing records.

Claude risk: medium at product producer call sites; low in the shared envelope and learning modules. Reconcile product files before edit.

### 2. Verified lesson extraction and destination classification

Problem: current records flow directly toward a model corpus, so product defects can be mislabeled as weight learning.

Existing implementation: evidence, review, verification, redaction, contamination, consent, and provenance checks exist at learning admission.

Proposed change: deterministically extract a bounded lesson that states the observable belief, actual outcome, truth authority, correction, evidence strength, data boundary, and applicable destinations. Supported destinations are model weight, router policy, retrieval, graph, parser, tooling, deterministic recipe, prompt, product logic, calibration, and no action. Multiple destinations are allowed only with independent rationales. Private model reasoning is never accepted.

Files: shared learning contracts, a pipeline extractor and classifier, narrow product adapters, tests.

Schema and migration: no new table for the first vertical. Persist immutable lesson artifacts and evidence using current trust storage. Add a table only if operational queries require an atomic state not representable by artifacts and domain events.

Tests: product signal taxonomy, broken parser, missing retrieval, wrong router choice, recipe opportunity, substantive correction versus style edit, correct abstention, unsafe content, unsupported verdict, contradictory evidence, duplicate identity, cross tenant reference, and deterministic replay.

Rollout and rollback: lesson generation is independently gated. Invalid or unclassified lessons are quarantined and never enter a model corpus. Disabling extraction leaves source evidence intact.

Claude risk: low. Synthetic outcomes enter through the versioned evaluation adapter only.

### 3. Dataset families, splits, and corpus operation

Problem: sealing is ReGauge specific and corpus generation is read only, so training cannot receive an authoritative generated corpus.

Existing implementation: append-only consent and learning records, versioned draft or sealed datasets, deterministic corpus exporter.

Proposed change: generalize the sealer by purpose, provenance, product, capability family, provider or framework, language, runtime, risk, and residency. Select eligible records at an exact cutoff, seal atomically, assign deterministic train, validation, or holdout splits before export, materialize bounded immutable corpus artifacts, and attach evidence to the exact dataset. Synthetic development, synthetic hidden, design partner holdout, and production holdout remain distinct. Add quarantine outcomes for contradictory or invalid events rather than weakening inclusion.

Files: `packages/pipeline/src/learning-operations.ts`, existing DB exports only if required, advanced AI API.

Migration: none for the first vertical. Lifecycle beyond draft and sealed is represented by domain events and artifacts so sealed data remains immutable.

Tests: exact replay, tenant and residency isolation, provenance isolation, revocation, deletion, temporal leakage, empty input, duplicate content, partition leakage, family leakage, artifact tamper, and concurrent seal.

Rollout and rollback: tenant admin initiated first. Scheduler follows only after manual end to end proof. Rollback disables route while immutable evidence remains readable.

Claude risk: low.

### 4. Trainer and candidate evaluation join

Problem: the trainer port supports safe dispatch but production configuration and complete status, cancellation, and holdout evaluation are absent.

Existing implementation: `train` and `reconcile`, durable leases, authenticated receipts, exact adapter bytes, evaluation and canary result binding.

Proposed change: retain the existing port and add vendor-neutral status and cancellation capabilities without weakening train and reconcile. Require the trainer to identify the training partition. Remove promotion authority from trainer supplied evaluation and canary claims. Join candidate evaluation through a narrow independent benchmark port that consumes an exact sealed holdout reference and proves zero overlap with the training manifest. A trainer completion can return diagnostic metrics, but it cannot self-assert unseen evaluation, canary evidence, or router eligibility.

Files: post trained training contracts, HTTP adapter, a new evaluation orchestrator, API tests, benchmark adapter only after its interface lands.

Migration: effect records remain compatible; new optional request fields are versioned and included in request digests.

Tests: timeout, crash, response loss, reconciliation, cancellation race, invalid artifacts, train and holdout overlap, evaluation regression, and stale writer.

Rollout and rollback: external processing stays explicitly approved. Missing trainer or evaluator remains 503. Rollback stops new jobs and reconciles already dispatched effects read only.

Claude risk: high only at the benchmark adapter. Do not modify benchmark internals.

Governance consequence: a deletion or consent revocation that affects a dataset already used for training must identify every derived candidate. Those candidates are quarantined or rolled back until policy chooses exclusion, retraining, or retirement. Runtime consent rechecks alone are not sufficient once weights have been derived.

### 5. Durable promotion, selective routing, canary, and rollback

Problem: lifecycle validation and dry-run routing exist, but no durable transition service or real invocation path exists.

Existing implementation: full lifecycle state model, threshold validation, evidence checks, pre-dispatch guard, router, circuit breaker, and durable adapter manifest.

Proposed change: add tenant-admin and independent-human lifecycle transitions backed by domain events. Register trained candidates as non-active, evaluate, authorize shadow, record canary observations, approve scoped eligibility, invoke through an injected serving port, monitor, and rollback by revision. Scope eligibility by product, capability, language or stack, difficulty, tenant, risk, and traffic stage. Recheck lifecycle and consent immediately before every invocation.

Files: platform lifecycle and post trained runtime, pipeline application service, advanced AI API, worker model execution join.

Migration: domain event backed in the first vertical. Add a table only if query volume or atomic allocation cannot be satisfied safely.

Tests: failed evaluation, human rejection, canary failure, stale consent, scope mismatch, traffic cap, response loss, circuit breaker, rollback during dispatch, and no global model replacement.

Rollout and rollback: shadow first, then bounded one percent canary. No automatic production promotion. Rollback revokes eligibility before changing traffic.

Claude risk: medium in product router joins, low in lifecycle services.

### 6. Router learning, economics, calibration, graph, and recipe outcomes

Problem: adapter admission can reduce model cost, but the platform does not yet learn when deterministic rules, recipes, retrieval, graph, open models, adapters, or frontier models are appropriate.

Existing implementation: the router records durable decisions and outcomes, includes cost and latency constraints, supports deterministic and model executors, and has circuit breaker feedback.

Proposed change: convert completed router executions into governed events containing task, product, specialization, graph complexity, risk, selected path, fallback, correctness, verification, review, tokens, latency, cost, escalation, and calibration. Extract deterministic recipe candidates and graph or retrieval corrections as non-weight destinations. Keep aggregate outcome scoring versioned and retain constituent metrics.

Files: router outcome join, lesson classifier, learning observability, tests.

Schema and migration: reuse routing ledger plus immutable learning artifacts. No automatic router policy mutation in the first vertical.

Tests: cheapest qualified path, failed cheap path escalation, correct abstention, calibration bins, recipe extraction, graph correction, response loss, duplicate accounting, and no model training for infrastructure failures.

Rollout and rollback: observation first. Policy recommendations require explicit review before activation. Existing router policy remains authoritative until a governed change is approved.

Claude risk: low outside benchmark outcome ingestion.

### 7. Complete joined proof and security review

Problem: component tests do not prove the flywheel.

Proposed change: add a deterministic end to end fixture for Fettler and ReGauge from mission outcome through next-generation learning event. The external trainer and serving transport are authenticated in-process fixtures; production proof later uses the configured provider. Add the negative matrix from the attached brief and a ship-readiness document with explicit yes or no answers.

Files: joined API or deployment tests, security tests, `docs/learning/ship-readiness.md`.

Migration: validate fresh and predecessor database startup when any schema change occurs.

Rollout and rollback: protected CI is mandatory. No test or security gate may be bypassed.

Claude risk: medium because the holdout adapter consumes Claude's framework. Keep the integration interface narrow.

## Should Have

### Continuous scheduling

Reuse the existing job queue to observe per-purpose eligibility thresholds, enqueue a dataset operation, then training and evaluation. Scheduling can automate preparation and training but never promotion. Jobs must inherit tenant, consent revision, cutoff, corpus digest, budget, and idempotency identity.

### Observability

Expose tenant-scoped counts and bounded records for captured, accepted, rejected, unverified, consent blocked, residency blocked, duplicates, quarantined, dataset membership, training jobs, evaluation deltas, canary health, router selections, costs, and rollbacks. Reuse evidence, domain events, routing ledgers, and existing health mechanisms.

### Corpus task taxonomy

Partition by fault detection, architecture understanding, root cause, blast radius, remediation, tool selection, router decision, calibration, preference, and abstention. Use stable hashes to keep training and holdout disjoint and reproducible.

### Preference and composite outcome records

Capture substantive reviewer corrections as chosen and rejected pairs only when verification proves the corrected result. Store correctness, verification, acceptance, merge stability, calibration, false positive cost, regression cost, latency, compute cost, and escalation separately. Any composite score is versioned and configurable.

### Model and adapter registry operations

Expose traceable identity, base model, dataset and corpus lineage, training configuration, artifact digest, specialization, evaluation, approval, serving revision, health, eligibility, and rollback target. Preserve the existing lifecycle rather than creating a second registry.

## Later

- Multiple trainer vendors selected by policy and price.
- Coordinator high availability beyond the current SQLite authority boundary.
- Automated sample quality review suggestions, never automatic admission.
- Cross-tenant aggregate models only under an explicit separate legal and consent design.
- Broader canary percentages after statistically meaningful production evidence.
- Automated retirement and archival policies after operational history exists.

## Execution order

1. Common learning event, provenance classes, lesson extraction, destination classification, and Fettler capture while preserving ReGauge compatibility.
2. Generic capability datasets, deterministic split assignment, corpus materialization, quarantine, and learning APIs.
3. One joined fixture through the existing trainer and candidate registration path.
4. Claude evaluation adapter and unseen holdout comparison without modifying Claude's framework.
5. Durable lifecycle transitions, serving port, shadow, canary, monitoring, and rollback.
6. Router outcome learning, economics, calibration, graph, retrieval, recipe, and preference destinations.
7. Threshold scheduling and tenant scoped observability.
8. Full negative security matrix, ship readiness, protected CI, deployment, live proof, and rollback drill.
