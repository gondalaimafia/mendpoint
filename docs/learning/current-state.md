# Mendpoint Learning Flywheel Current State

Verified against `codex/learning-loop-production` on 2026-08-17.

## What this branch implements

The branch implements one governed backend path from an authenticated learning event to an eligible, reversible post-trained adapter. It is disabled unless the advanced AI application surface and all required external authorities are configured.

### Common event and lesson contract

`packages/pipeline/src/learning-event.ts` defines one versioned event for Fettler and ReGauge. The event binds the tenant, repository, mission, task, capability, specialization, model and adapter selection, router decision, input and action artifacts, prediction, observed result, verification, reviewer decision, correction, confidence, economics, residency, consent, source class, and split group. It rejects private reasoning fields, unknown fields, malformed timestamps, unbounded evidence, mutation aliases, and noncanonical data.

Lesson extraction classifies verified outcomes into model weights, router policy, retrieval, graph, parser, tooling, deterministic recipes, prompts, product logic, calibration, or no action. Model training requires a substantive correction, passed verification, active consent, and authoritative evidence. The persistence operation derives attribution and provenance from durable verification and source authority rather than trusting the caller's labels.

The common contract accepts Fettler, ReGauge, and synthetic ground-truth events. The current production Fettler and ReGauge mission paths do not automatically emit this common event yet; the joined integration test calls the governed admission operation directly.

### Governance and corpus materialization

The implementation reuses SQLite trust storage:

- `learning_consents` retains purpose-specific grants and revocations.
- `learning_records` binds source, redacted, verification, review, correction, consent, provenance, and content digests.
- `learning_dataset_versions` and `learning_dataset_members` retain immutable dataset membership and cutoffs.
- `learning_deletion_events` exclude records from future use without rewriting sealed history.
- `artifact_manifests`, `evidence_records`, `review_decisions`, and hash-chained `domain_events` retain exact authority and lineage.

Corpus materialization validates every artifact digest and relationship, recomputes current consent and deletion authority, uses an ambient-transaction savepoint, and produces immutable train, validation, holdout, and split-manifest artifacts. A stable `splitGroupId`, rather than event content, controls deterministic partitioning so related variants cannot move between training and holdout. Empty validation or holdout artifacts are inconclusive and cannot authorize candidate evaluation.

The corpus records whether every member may leave the tenant boundary. External training and evaluation reauthorize the exact sealed member set immediately before dispatch.

### Training, independent evaluation, and canary

Training, evaluation, and canary execution each use a separate injected port, durable database-time lease, request digest, bounded timeout, authenticated receipt, response-loss reconciliation, and generation fence. Completed and failed results are validated for exact identity, canonical timestamps, bounded evidence, and artifact integrity before terminal settlement.

Training receives only the training split. Independent evaluation receives the exact candidate plus a distinct nonempty holdout, checks zero split-group overlap, and persists a sealed report. Canary execution is separately configured and binds the adapter, evaluation artifact, serving revision, mode, allocation, policy, economics, and observed evidence.

Production configuration rejects overlapping trainer, evaluator, and canary authority IDs. When HTTP providers are configured, it also rejects the same normalized endpoint or bearer credential being reused across authorities.

### Registration, routing, and rollback

Adapter registration requires the exact completed training event, adapter bytes and digest, dataset and split manifest, independent evaluation, canary evidence, current consent, infrastructure evidence, and an independent human approver. It rejects mismatched adapter, base model, dataset, evaluation, canary, or evidence subjects.

Eligibility and route dry-run operations use the existing router and post-trained runtime admission. They recheck consent, lifecycle, monitoring, task, tenant, region, risk, quality, health, latency, cost, and evidence immediately before authorization. Human rollback appends durable authority and makes the adapter ineligible.

No operation in this branch automatically promotes a model, merges code, deploys a model, or changes production traffic.

## API surface

All routes are below `/advanced-ai`, pass through the existing authenticated web proxy, and return 404 unless `MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED=1`.

Learning governance:

- `POST /advanced-ai/learning/consents`
- `POST /advanced-ai/learning/consents/:consentId/revoke`
- `GET /advanced-ai/learning/status`
- `POST /advanced-ai/learning/corpora`

Post-trained operations:

- `POST /advanced-ai/post-trained/training-jobs`
- `GET /advanced-ai/post-trained/training-jobs/:jobId`
- `POST /advanced-ai/post-trained/evaluations`
- `GET /advanced-ai/post-trained/evaluations/:evaluationId`
- `POST /advanced-ai/post-trained/canaries`
- `GET /advanced-ai/post-trained/canaries/:canaryId`
- `POST /advanced-ai/post-trained/adapters`
- `GET /advanced-ai/post-trained/adapters/:adapterId`
- `POST /advanced-ai/post-trained/adapters/:adapterId/eligibility`
- `POST /advanced-ai/post-trained/adapters/:adapterId/route-dry-run`
- `POST /advanced-ai/post-trained/adapters/:adapterId/rollback`

Mutations require the existing tenant administration or execution permission, a durable trust principal, and idempotency where an external or durable effect is created. Reads are tenant-scoped and return `Cache-Control: no-store`.

## External configuration

The server builds trainer, evaluator, and canary HTTP adapters only from complete, bounded configuration. Each authority has its own URL, bearer token, receipt secret, worker identity, principal, authority identity, timeout, and lease. Training and evaluation also require explicit processing-boundary approval before corpus content may leave the tenant boundary.

The checked-in Fly profiles do not prove that these external providers, model artifacts, or serving endpoints exist. Code-level support is not production activation evidence.

## Joined proof

`apps/api/src/advanced-ai-applications.test.ts` contains one joined in-process proof that:

1. grants consent;
2. admits authoritative Fettler and ReGauge events;
3. materializes disjoint train, validation, and holdout artifacts;
4. dispatches and reconciles training;
5. evaluates through a separate authority;
6. runs a bounded canary;
7. registers with human approval;
8. becomes router eligible; and
9. rolls back and becomes ineligible.

Focused package tests additionally cover consent revocation, deletion after sealing, tampered artifacts, cross-tenant references, forged provenance, partition leakage, concurrent effects, stale leases, response loss, failed evaluation, failed canary, malformed terminal results, mismatched lifecycle evidence, and stale consent.

## Remaining links

1. Production Fettler and ReGauge completion paths do not automatically call common event admission.
2. Router execution, canary observations, rollback results, and production outcomes do not automatically feed the next learning generation.
3. Claude's synthetic harness is not imported. Its holdout cohort and candidate execution adapter remain a separately owned integration boundary.
4. There is no live trainer, evaluator, canary provider, or post-trained serving endpoint proven by this repository.
5. Route dry-run proves selection authority, not actual adapter invocation.
6. Dataset threshold scheduling, operator cancellation, continuous monitoring, and automatic circuit breaking are not implemented by this branch.
7. The status API reports durable counts, not a complete operations dashboard.

These are explicit ship-readiness boundaries, not implicit capabilities. See `docs/learning/ship-readiness.md`.

## Naming compatibility

Customer-facing vocabulary is Fettler and ReGauge. Stable database tables, environment variables, API compatibility paths, cryptographic domains, historical events, and fixtures may still contain `warden` and `transformer`. Those machine identifiers remain readable until a versioned migration proves dual-read and rollback safety.
