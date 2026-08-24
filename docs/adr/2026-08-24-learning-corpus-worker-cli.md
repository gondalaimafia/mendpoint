# Worker CLI seals governed learning corpus versions

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

`materializeGovernedLearningCorpus` / `sealLearningDatasetVersion` already exist
in `packages/pipeline/src/learning-operations.ts` and are covered by tests, but
no worker command called them. Dataset version/seal was therefore latent: the
governed flywheel could admit records and never produce an immutable corpus
version on the live operator path. Inventing a training stack, or forcing
lessons into `organization_memory`, would manufacture a destination the
classifier cannot honestly emit today (see
`docs/learning/LESSON_DESTINATION_ROUTING.md`).

## Decision

Add `worker learning-corpus`, a thin CLI that calls the existing sealer with
explicit tenant, purpose, temporal cutoff, actor principal, and idempotency
key. Missing flags fail closed. A missing active consent throws
`learning_corpus_active_consent_required`. An empty consented set reaches the
real sealer and fails `learning_dataset_empty` — we do not mint a fake member
so a zero-record tenant looks trained. Replay of a successful seal with the
same idempotency key is the existing pipeline contract.

This is H3 (dataset version/seal) only. It does not train, promote, canary, or
route lessons to organization memory.

## Alternatives considered

- **Leave the sealer test-only.** Rejected: that keeps "we can seal a corpus"
  indistinguishable from "nothing seals in production."
- **Force `organization_memory` routing so the CLI has lessons to seal.**
  Rejected: that destination has a three-part upstream blocker (no convention
  attribution, no producer of repeated non-defect corrections, corrections
  don't accumulate). Forcing it would manufacture conventions.

## Security impact

Sealing still requires an active learning consent for the purpose and a
tenant-scoped actor principal. No new training boundary. No cross-tenant
read: the sealer already filters by tenant/purpose/residency.

## Data and compatibility impact

No schema change. The CLI is a new caller of an existing write path.

## Migration plan

1. Add the worker command + tests (this PR).
2. Operators run `worker learning-corpus` against a consented tenant.
3. Training/canary remain later work (H4), gated on a real `model_weight`
   lesson flow.

## Rollback

Revert the commit. The sealer remains in pipeline tests; nothing else called it.

## Evaluation plan

Success is the CLI parse fail-closed tests plus the worker command reaching
the real sealer (consent-required, then empty-dataset refusal). Member-full
seal/idempotency remains covered by `packages/pipeline` learning-operations
tests. Reconsideration is a training stack, which this ADR explicitly refuses
to invent.
