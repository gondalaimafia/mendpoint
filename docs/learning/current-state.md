# MendPoint Learning Flywheel Current State

Verified against repository commit `1f83b4a` on 2026-08-14.

## Existing flow

ReGauge has the only production joined outcome producer. Successful adaptive draft delivery admits an approved structured outcome and, under a separate consent purpose, redacted accepted file content. Rejected adaptive reviews can admit a separately consented negative outcome. Admission is disabled unless `MENDPOINT_REGAUGE_LEARNING_ENABLED=1`, and missing consent, unsafe redaction, future observations, or incomplete evidence produce no learning record.

The latest sealed ReGauge dataset can be read as bounded precedent by the adaptive planner. The planner never sees a draft dataset or an ineligible member.

Fettler produces authenticated candidate, review, verification, delivery, and post pull request evidence, but it is not joined to the learning record system. There is no common Fettler and ReGauge learning event envelope today.

There is no durable lesson entity or destination classifier. The current corpus parser turns a narrow approved or rejected ReGauge outcome document directly into examples. It cannot distinguish a parser defect, retrieval miss, graph defect, deterministic recipe opportunity, router policy error, calibration lesson, or true weight learning lesson.

The existing records preserve provenance digests and source object classes, but there is no canonical product level provenance enum that separates synthetic ground truth, design partner verified evidence, and production verified evidence. That separation must be present before Claude's synthetic scenarios can share the same pipeline safely.

## Existing schemas and storage

The application uses SQLite and existing trust records rather than a separate learning database:

- `learning_consents`: append only grant and revocation history by tenant, purpose, residency, effective time, expiry, and principal.
- `learning_records`: append only admitted records bound to source and redacted artifacts, redaction evidence, verification evidence, contamination evidence, accepted review, consent, provenance digest, and observation time.
- `learning_dataset_versions`: `draft` or `sealed` datasets with an exact temporal cutoff and content digest. Sealed rows cannot be changed or deleted.
- `learning_dataset_members`: immutable content addressed membership.
- `learning_deletion_events`: append only removal authority that makes a record ineligible without rewriting history.
- `artifact_manifests`: corpus, adapter, evaluation, and other immutable content plus digest and storage reference.
- `evidence_records`, `review_decisions`, and hash chained `domain_events`: provenance, human authority, and lifecycle evidence.
- `post_trained_training_effects`: dynamically created durable training dispatch lease, generation, phase, and authenticated receipt state.

There is no separate model registry table. A durable post trained adapter manifest is stored as an immutable artifact and registered by a hash chained domain event.

## Existing APIs

All advanced AI routes are mounted below `/advanced-ai` and return 404 unless `MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED=1`.

Implemented post trained routes are:

- `POST /advanced-ai/post-trained/training-jobs`
- `GET /advanced-ai/post-trained/training-jobs/:jobId`
- `POST /advanced-ai/post-trained/adapters`
- `GET /advanced-ai/post-trained/adapters/:adapterId`
- `POST /advanced-ai/post-trained/adapters/:adapterId/eligibility`
- `POST /advanced-ai/post-trained/adapters/:adapterId/route-dry-run`

The route layer requires an authenticated tenant principal, durable trust principal, tenant administration for mutations, idempotency keys, bounded request bodies, durable consent, and authoritative evidence. Training returns 503 unless every trainer dependency is configured.

There are no API routes for learning consent, learning event inspection, dataset sealing, corpus materialization, lifecycle transitions, canary allocation, rollback, or learning observability.

## Existing workers and jobs

ReGauge learning admission runs synchronously inside reviewed delivery and rejection flows. It is best effort and cannot make delivery fail.

Dataset sealing exists as `sealApprovedLearningOutcomes`, but it has no non-test scheduler or API call site. Corpus export exists as the read-only `buildLearningCorpus` function, but no production operation materializes that deterministic output as the authoritative `learning_dataset_corpus` artifact expected by training.

Training dispatch is API initiated, not a queue job. It uses database time leases and an in-process active-effect guard, dispatches through an injected external trainer, authenticates reconciliation receipts, and prevents duplicate completion after crashes or response loss.

## Trainer contract

The current trainer port supports `train` and `reconcile`. The HTTP adapter is configured by:

- `MENDPOINT_POST_TRAINED_TRAINER_URL`
- `MENDPOINT_POST_TRAINED_TRAINER_TOKEN`
- `MENDPOINT_POST_TRAINED_RECEIPT_HMAC_SECRET`
- `MENDPOINT_POST_TRAINED_WORKER_ID`
- `MENDPOINT_POST_TRAINED_EXTERNAL_PROCESSING_APPROVED=1`
- bounded timeout and lease configuration

The trainer receives exact corpus artifacts, base model, adapter identity, recipe, request digest, and lease generation. A completed response must contain canonical adapter bytes, held out evaluation, canary evidence, and an authenticated exact receipt.

The contract does not expose separate status, artifact fetch, or cancel operations. It also has no configured production implementation in this repository.

## Adapter lifecycle and router

The lifecycle model already represents `registered`, `evaluated`, `shadow`, `canary`, `promoted`, `monitored`, `rolled_back`, and `retired`. Promotion validation requires dataset consent and sufficiency, evaluation thresholds, infrastructure approval, human approval, canary evidence, a serving revision, monitoring, and rollback.

Durable adapter registration verifies the exact submitted training job, base model, adapter digest, decoded bytes, dataset, held out evaluation, canary result, and evidence subjects. Runtime admission rechecks consent, lifecycle, health, tenant, task, privacy, region, risk, quality, latency, cost, and executor bindings immediately before dispatch.

The exposed router operation is a dry run. No production caller invokes an admitted adapter or allocates shadow or canary traffic. There is no durable canary percentage, observation accumulator, automatic stop, or rollback controller.

## Evaluation boundary

The stable `@mendpoint/eval` package exports agent scenario grading and a router value proof that compares paired baseline and candidate observations for a declared held out cohort. It does not prove that the cohort is absent from the training dataset.

Claude's active evaluation worktree contains ground truth, scenario, Fettler and ReGauge grader, runner, and reporting interfaces. Its ground truth schema already has development, validation, and holdout split values. As inspected on 2026-08-14, all 21 scenarios are still development examples, the suite runner does not filter by split, candidate adapters are not exercised, and the uncommitted harness has no tests and does not typecheck under its current module configuration. It is therefore an active integration dependency, not current promotion evidence.

The smallest stable join is a Codex owned evaluator port that consumes an exact candidate, baseline, training dataset manifest, and sealed holdout cohort. Its authoritative result must bind candidate digest, baseline revision, cohort revision and digest, grader version, subject repository revisions, and an explicit zero overlap proof. Trainer supplied evaluation remains diagnostic and cannot authorize promotion.

## Existing feature flags and production configuration

- ReGauge lesson capture: `MENDPOINT_REGAUGE_LEARNING_ENABLED=1`, with the legacy Transformer alias accepted.
- Advanced AI routes: `MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED=1`.
- Trainer: the complete variables listed above.

The checked in Fly profiles do not enable the advanced AI route group or learning capture. A live secret-name inspection on 2026-08-14 found no advanced AI or post trained trainer configuration on the main app. The code is fail closed in that state.

## Existing verification

A focused verification run passed 72 of 72 tests:

- 16 database learning and corpus tests
- 12 pipeline learning, training, and adapter application tests
- 35 platform lifecycle, router, and admission tests
- 9 advanced AI API tests

These tests prove individual components and several crash or response loss boundaries. They do not prove a real Fettler outcome, complete corpus artifact, external trainer, held out benchmark, promoted adapter invocation, canary traffic, monitoring, rollback, and next-generation capture in one joined flow.

## Missing links

1. No common learning event envelope or Fettler producer.
2. No automatic or operator-facing generic dataset sealing and corpus artifact operation.
3. No task classification deciding weights, retrieval, prompt, router policy, deterministic tool, or product logic.
4. Corpus output is not split into deterministic training and held out partitions by capability.
5. No production trainer configuration or vendor-neutral status and cancellation surface.
6. No joined synthetic holdout evaluation interface. Claude Code owns the benchmark implementation.
7. No durable human lifecycle transition service; registration consumes a fully formed admissible lifecycle.
8. No real adapter invocation, shadow traffic, canary allocator, monitoring controller, or automatic rollback.
9. No continuous scheduler connecting thresholds to seal, corpus, training, and evaluation.
10. No operator observability surface for capture, eligibility, datasets, training, evaluation, traffic, or rollback.
11. Public documentation lists stale route names for training and adapter registration.
12. No canonical provenance class, preference pair, model economics record, calibration record, or abstention outcome is produced by the learning flow.
13. No deterministic lesson destination classifier prevents model training from compensating for parser, graph, retrieval, tooling, or product defects.
14. No migration native dataset families or reproducible train, validation, and hidden holdout assignments exist.
15. No durable human lifecycle transition, traffic allocation, canary observation, or rollback operation connects the current lifecycle model to serving.

## Naming migration

Customer facing vocabulary is Fettler and ReGauge. Stable database tables, job types, environment variables, API paths, cryptographic domains, and historical fixture identifiers still contain `warden` and `transformer`. Those identifiers are compatibility sensitive and must remain readable. New learning documents use canonical product values `fettler` and `regauge`, while adapters map old persisted values where required. Public documentation and operator copy should use Fettler and ReGauge without rewriting stable wire or storage identities.
