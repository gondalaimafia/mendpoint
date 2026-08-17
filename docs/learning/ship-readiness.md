# Learning Flywheel Ship Readiness

Reviewed: 2026-08-17

Status values:

- **Ready**: implemented in this branch with direct automated evidence.
- **Ship blocker**: required for a complete live learning flywheel but not proven.
- **Explicitly deferred**: intentionally outside this branch and not represented as shipped.

## Master prompt acceptance matrix

| Area | Status | Evidence or remaining requirement |
| --- | --- | --- |
| One versioned Fettler and ReGauge event | Ready | `packages/pipeline/src/learning-event.ts` and its tests validate canonical bounded events and reject private reasoning. |
| Synthetic ground-truth provenance | Ready | The event contract and authority validation preserve synthetic, design-partner, and production source classes without blending them. |
| Automatic Fettler production capture | Ship blocker | Fettler completion and review paths do not yet invoke the common admission operation. |
| Automatic ReGauge production capture | Ship blocker | The existing ReGauge-specific learning producer is preserved, but it is not migrated to emit the common event. |
| Verified lesson extraction | Ready | `extractGovernedLesson` creates a deterministic lesson only after exact event verification. |
| Destination classification | Ready | Model weights, router, retrieval, graph, parser, tooling, deterministic recipe, prompt, product logic, calibration, and no-action destinations are represented. |
| Authoritative attribution and provenance | Ready | Admission derives and compares these claims against durable source, verification, review, and correction authority. |
| Purpose-specific consent and revocation | Ready | Tenant-admin APIs and append-only storage are implemented and tested. |
| Deletion and post-seal reauthorization | Ready | Corpus dispatch recomputes member eligibility, consent revision, and deletion watermark. |
| Immutable capability dataset | Ready | Materialization seals exact eligible members, cutoff, purpose, residency, and lineage. |
| Disjoint train, validation, and holdout | Ready | Stable split groups and a signed manifest prevent family leakage; evaluation rejects overlap and empty holdout. |
| Cross-tenant and residency isolation | Ready | Corpus, training, evaluation, canary, and lifecycle tests fail closed on mismatches. |
| Exactly-once external training | Ready | Database-time leases, generation fences, active-effect ownership, authenticated receipts, and response-loss reconciliation are implemented. |
| Live external trainer | Ship blocker | No protected provider configuration or completed real training receipt is proven. |
| Independent unseen evaluation | Ready in code | A separate authority consumes candidate bytes and exact holdout with zero-overlap proof. |
| Synthetic hidden holdout integration | Ship blocker | The harness is checked in under `evals/`, but all current ground-truth scenarios are development data and no candidate-adapter evaluator is joined. |
| Live independent evaluator | Ship blocker | No protected independent provider, credential, cohort, or evaluation receipt is proven. |
| Human candidate promotion | Ready | Registration requires an authorized independent human and exact training, evaluation, canary, consent, infrastructure, and evidence bindings. |
| Selective router eligibility | Ready | Eligibility and route dry-run bind tenant, capability, risk, privacy, region, health, quality, latency, cost, and lifecycle. |
| Actual adapter model invocation | Ship blocker | The branch authorizes selection but does not invoke a post-trained serving endpoint. |
| Shadow and bounded canary | Ready in code | A separate canary authority, signed receipt, exact policy, durable evidence, and failure settlement are implemented. |
| Live canary traffic | Ship blocker | No serving revision, protected provider, traffic allocation, or live observation is proven. |
| Monitoring and circuit breaking | Explicitly deferred | Lifecycle health is checked at authorization, but a continuous traffic monitor and automatic breaker are not part of this branch. |
| Human rollback | Ready | Exact adapter rollback is durable and immediately removes eligibility. |
| Router and production outcomes feed the next generation | Ship blocker | The current operations do not automatically create a new governed event after invocation, canary, rollback, or production observation. |
| Threshold-based dataset and training scheduling | Explicitly deferred | Corpus and training are tenant-admin initiated. No automatic scheduler is claimed. |
| Tenant-scoped observability | Ready in part | The status route reports durable event, lesson, dataset, job, evaluation, canary, and adapter counts. A full operator dashboard is deferred. |
| Public API documentation | Ready | The product catalog and generated website upload bundle list the implemented guarded routes and limitations. |

## Release decision

The branch is ready to merge as a **disabled, fail-closed governed learning backend** after the full repository gate and protected pull-request checks pass. It is not ready to activate as a complete production learning flywheel.

Activation requires, at minimum:

1. automatic Fettler and ReGauge event producers;
2. a protected external trainer with a real authenticated receipt;
3. an independent sealed holdout and evaluator with zero-overlap evidence;
4. a protected post-trained serving handle and actual invocation path;
5. a live bounded canary with monitoring and rollback evidence; and
6. next-generation capture from router, canary, rollback, and production outcomes.

Until those conditions are met, missing configuration must continue returning 404 or 503 and no post-trained adapter may receive production traffic.

## Rollback

This branch adds no database migration. The operations use existing append-only trust tables plus lazily created effect tables. Rollback disables the advanced AI application surface and stops new effects. Already dispatched external effects must be reconciled read-only by their exact request digest and receipt. Immutable evidence remains available for audit, and any registered adapter remains ineligible unless current consent, lifecycle, and human authority all still pass.
