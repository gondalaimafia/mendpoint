# Learning system

Capture reviewed outcomes as consented, redacted, lineage-bound evidence for evaluation, ranking, and optional external training.

Status: Governed learning preview
Availability: Capture and corpus export implemented; downstream training requires separate authorization
Last verified: 2026-08-14
Publication evidence: not live; no deployed revision or live evidence digest recorded
Requirements: ME-FND-009, ME-RTR-006, ME-RTR-007
Public claims: None

## Start here

Record one approved outcome with explicit tenant consent, residency, retention, and source lineage.

1. Capture the reviewed candidate and outcome metadata.
2. Apply redaction, consent, temporal cutoff, and residency eligibility.
3. Seal an immutable corpus export for one declared purpose.
4. Use the export for evaluation or a separately authorized training job.

## What it does

- Human-reviewed Fettler and ReGauge outcome capture
- Consent, residency, temporal cutoff, redaction, and lineage gates
- Deterministic sealed corpus exports
- Suppression and rejection evidence
- Graph and router outcome feedback

## When to use it

- A reviewed migration should improve future ranking or evaluation.
- A tenant has explicitly consented to a defined learning purpose.
- An external training job needs an exact eligible dataset lineage.

## How it works

1. The capture layer records approved metadata, evidence references, outcomes, and policy context.
2. Eligibility excludes unconsented, stale, residency-conflicting, unredacted, or incomplete rows.
3. The exporter orders and seals the eligible corpus under a purpose and cutoff.
4. Consumers receive metadata and approved redacted content only; raw secrets and unrestricted repository data are excluded.

## Interfaces

| Name | Kind | Description |
| --- | --- | --- |
| POST /advanced-ai/learning/consents | API | Grant purpose-specific tenant learning consent. |
| POST /advanced-ai/learning/consents/:consentId/revoke | API | Revoke one exact learning grant for future processing. |
| GET /advanced-ai/learning/status | API | Read tenant-scoped learning, dataset, training, evaluation, canary, and adapter counts. |
| POST /advanced-ai/learning/corpora | API | Seal eligible lessons and materialize deterministic train, validation, and holdout artifacts. |
| npm run learning:export-corpus | Command | Export the earlier compatibility corpus format. |
| Learning capture | Artifact | Outcome, consent, lineage, policy, and evidence references. |
| Sealed corpus | Artifact | Purpose-bound deterministic eligible dataset with a split manifest. |

## Evidence and verification

- Learning capture: `packages/db/src/learning.test.ts`
- Corpus eligibility: `packages/db/src/learning-corpus.test.ts`
- ReGauge learning loop: `apps/worker/src/transformer-learning.test.ts`

## Contract sources

- `packages/db/src/learning.ts`
- `packages/db/src/organization-memory.ts`
- `apps/api/src/learning-consent-routes.ts`

## Safety model

- No record is eligible without active consent and purpose authority.
- Redaction and lineage checks run before export.
- Temporal cutoffs prevent future outcome leakage into historical evaluation.
- Export does not invoke a trainer or model.

## Limitations

- Corpus size and outcome diversity depend on real reviewed migrations.
- The current corpus does not imply a trained or promoted adapter.
- Learning activation and external processing remain tenant-specific.

## See also

- [Post-trained models](./post-trained-models.md)
- [Model router](./model-router.md)
- [Security and governance](./security-governance.md)
