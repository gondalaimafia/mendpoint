# Transformer Learning Loop

Stage T3 wires the previously inert learning tables and API to a real producer
and consumer. It turns human-approved adaptive outcomes into governed, consented,
redacted learning records, seals them into immutable dataset versions, and
surfaces those sealed records as reference precedent to the model-sourced adaptive
planner. The whole loop is default-off and changes nothing in a default
deployment.

## Flag

`MENDPOINT_TRANSFORMER_LEARNING_ENABLED` gates the entire loop. Unset or any value
other than `1` is off. When off:

- No learning record is admitted on delivery success.
- No dataset is sealed.
- No precedent is surfaced.
- The promote, approve, and delivery paths behave byte-for-byte as they do today.

This flag composes with, and never replaces, the existing gates:

- `MENDPOINT_TRANSFORMER_GATE` stays DENIED by default and still governs whether
  Transformer runs at all.
- `MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED` still gates the
  model-sourced planner. Precedent is only ever surfaced into that planner, so it
  additionally requires that gate to be on.

## Producer: approved outcome to learning record

Seam: the delivery-success point in
`apps/worker/src/transformer-adaptive-delivery.ts`. This is the single most
authoritative seam because at that point the candidate has passed human review
(status `approved`, `reviewDecision` `approve`, with a reviewer principal,
rationale, and review timestamp, all re-asserted by the delivery binding) and the
approved outcome has materialized as a real draft pull request. The producer runs
after the delivery is durably committed, is strictly best-effort, and never
throws, so a failure to admit can never affect delivery.

`admitApprovedOutcomeLearningRecord`
(`apps/worker/src/transformer-learning-producer.ts`) enforces:

- **Consent.** It admits only under a single active, unrevoked consent for the
  tenant and the `transformer-adaptive-repair` purpose (`findActiveLearningConsent`).
  No consent, or an ambiguous consent spanning more than one residency, means no
  record, silently. The record inherits its purpose and residency from that
  consent, so residency stays correct by construction.
- **Approved-only.** A non-approve decision, or a missing reviewer, rationale, or
  review timestamp, yields no record.
- **Redaction.** The structured outcome (change paths, semantic categories, risk,
  rationale, and the passed verification, never raw file bodies) is scrubbed with
  `redactSourceForModel`, the same secret-redaction machinery the agent and
  adaptive-loop paths use before any model call. If redaction is excluded on
  ambiguity, truncated, or non-parseable, the outcome is not admitted. The raw,
  possibly secret-bearing outcome is content-addressed but never persisted; only
  its redacted derivative carries stored content, and that redacted content is
  what the learning record hashes.
- **Verification evidence.** Grounded in the candidate's own passed verification.
- **Contamination evidence.** A temporal-cutoff attestation: the outcome must have
  been observed no later than admission time. A future-dated observation is not
  admitted.
- **Accepted review.** A `review_decisions` approval bound to the redacted
  artifact, carrying the actual human reviewer and rationale.

Every write goes through the existing append-only admission API. The guards in
`packages/db/src/learning.ts` (`admitLearningRecord` and the append-only triggers)
are unchanged. Admission is idempotent per outcome, so a delivery retry admits at
most once.

## Consumer: sealed datasets to planner precedent

Sealing (`sealApprovedLearningOutcomes` in
`apps/worker/src/transformer-learning-consumer.ts`) creates a draft dataset
version, adds every currently eligible admitted record for the consented purpose
and residency, then seals it. A dataset version is an immutable point-in-time
snapshot: each distinct temporal cutoff produces its own version. Sealing an empty
set is refused, and any member the append-only guards reject (temporal leakage,
duplicate content, policy mismatch, revoked consent) is skipped rather than
blocking the seal.

Surfacing (`buildLearningPrecedent`) reads the tenant's single active consent,
then only the newest sealed dataset in that residency, then only the currently
eligible members via `listEligibleLearningDatasetMembers`, and returns their
redacted content as precedent entries. It is consent-gated and residency-correct
and returns nothing when the loop is off, when there is no consent, or when no
sealed dataset exists.

That precedent reaches the model through
`apps/worker/src/transformer-adaptive-planner.ts`:
`enrichPlannerInputWithPrecedent` attaches it to the planner input the adapter
serializes to the model. With no supplier, or when the supplier yields no
precedent, it returns the same input reference, so the request is byte-identical
to the pre-learning path. The production supplier is wired in
`transformerAdaptiveProductionPorts` only when the learning flag is on and a
database handle is available.

This improves the adaptive, model-sourced repair path only. It does not, and
cannot, change the deterministic recipes: a content-addressed recipe is not
something a model learns.

## Residency and consent guarantees

- Records, datasets, and members are tenant-scoped and residency-scoped. Purpose
  and residency are inherited from the consent, never guessed.
- `listEligibleLearningDatasetMembers` already filters out deleted records and
  members whose consent has been revoked or expired, so a revocation before or
  after a seal makes affected data ineligible.
- Surfacing re-checks consent at read time, so revoked consent stops precedent
  from being surfaced.

## What this does NOT do

- It never learns from unapproved, rejected, in-flight, or superseded candidates.
- It never learns from unconsented data, and it fails closed on ambiguous consent.
- It never crosses tenant or residency boundaries.
- It never stores raw credentials or secrets: content is redacted with the
  existing machinery, and unredactable content is dropped rather than admitted.
- It never weakens `admitLearningRecord`, the append-only triggers, the security
  classification, mutation fencing, the human-review and no-auto-merge model, or
  the delivery merge behavior.
- It never fabricates evidence. When a required piece of evidence cannot be
  produced honestly, the outcome is not admitted.
- It does not change the deterministic recipes.
- It does not auto-enable. Nothing in a default deployment behaves differently
  until an operator sets `MENDPOINT_TRANSFORMER_LEARNING_ENABLED=1` and the tenant
  has granted consent.
