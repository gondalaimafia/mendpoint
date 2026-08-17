# Post-trained models

Govern external adapter training, evaluation, consent, canary admission, routing, monitoring, and rollback as one evidence-bound lifecycle.

Status: Configured integration preview
Availability: Implemented control plane; no first-party trainer or shipped Mendpoint-trained model
Last verified: 2026-08-14

## Start here

Enable the advanced AI application surface only after an approved external trainer, dataset consent, receipt authority, and signing evidence are configured.

1. Seal an eligible consented corpus export.
2. Submit an idempotent training job under a durable worker lease.
3. Verify the authenticated trainer receipt and adapter artifact.
4. Register the exact lifecycle, evaluations, canary evidence, monitoring, and rollback target.
5. Admit the adapter to the model router only while fresh authority remains valid.

## What it does

- Durable single-dispatch external training jobs with leases and authenticated receipts
- Canonical adapter artifact hashing and exact training-to-registration binding
- Consent, held-out evaluation, canary, infrastructure, approval, monitoring, and rollback lifecycle
- Fresh pre-dispatch revocation and consent checks
- Router admission as an adapter executor

## When to use it

- A tenant has a governed corpus and approved external trainer.
- An adapter must be evaluated and monitored before routing.
- Consent withdrawal or rollback must stop dispatch immediately.

## How it works

1. Eligible redacted records produce a sealed dataset lineage artifact.
2. One leased worker submits the exact training request and reconciles an authenticated receipt.
3. The returned artifact is bound to dataset, adapter, base model, evaluation, and canary evidence.
4. Lifecycle authority moves through registered, evaluated, canary, promoted, monitored, rolled-back, and retired states.
5. The router rechecks current consent and lifecycle immediately before dispatch.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| POST /advanced-ai/post-trained/training-jobs | API | Run or reconcile an external training job when enabled. |
| POST /advanced-ai/post-trained/evaluations | API | Evaluate an exact candidate against a disjoint holdout through an independent authority. |
| POST /advanced-ai/post-trained/canaries | API | Run an evidence-bound shadow or bounded canary. |
| POST /advanced-ai/post-trained/adapters | API | Register an exact completed adapter lifecycle after human approval. |
| POST /advanced-ai/post-trained/adapters/:adapterId/route-dry-run | API | Evaluate router eligibility without invoking a model. |
| POST /advanced-ai/post-trained/adapters/:adapterId/rollback | API | Remove a bound adapter from eligibility under human rollback authority. |
| Authenticated trainer receipt | Artifact | Job, request, artifact, evaluation, canary, and receipt MAC binding. |

## Evidence and verification

- Training execution: `packages/pipeline/src/post-trained-training.test.ts`
- Lifecycle registration: `packages/pipeline/src/post-trained-application.test.ts`
- Router admission: `packages/platform/src/post-trained-runtime.test.ts`

## Safety model

- Training requires active dataset consent and explicit external-processing authority.
- Concurrent workers cannot dispatch the same training job twice.
- Evaluation and canary claims must exactly match the durable completion event.
- Rollback, revocation, expired consent, or stale monitoring blocks routing.

## Limitations

- Mendpoint does not ship a trainer, model weights, or a post-trained production endpoint in this repository.
- The surface requires MENDPOINT_ADVANCED_AI_APPLICATIONS_ENABLED and complete external authority.
- A production-shaped lifecycle is not evidence that a model has been trained or deployed.

## See also

- [Model router](./model-router.md)
- [Learning system](./learning-system.md)
- [Verification and attestations](./verification-attestations.md)
