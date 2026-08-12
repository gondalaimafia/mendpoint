# Learning Corpus Export

The corpus exporter turns Mendpoint's approved-outcome learning data into a
labeled fine-tuning corpus (JSONL). It is the data-preparation stage of the
post-trained-model moat.

**No model is trained here.** This stage produces the labeled dataset a
post-training run would consume. Training runs on an OSS base model (for example
Codestral or StarCoder, via a host such as Fireworks) are a separate, later
infrastructure step.

## What it reads

The exporter is strictly read-only over the learning tables and reuses the exact
consent, residency, and temporal-cutoff eligibility gate that the Transformer
precedent consumer uses (`listEligibleLearningDatasetMembers`). It:

1. Resolves the tenant's single active consent for the purpose
   (`findActiveLearningConsent`). No active consent, no export (fail closed).
2. Resolves the sealed dataset version in that residency (latest sealed, or an
   explicitly named version validated to match tenant + purpose + residency and
   to be sealed).
3. Reads only the currently eligible members of that sealed version, then reads
   each member's redacted artifact content (`getLearningRecordRedactedContent`).

Every learning record admitted upstream is already consent-gated,
residency-scoped, redacted, verified, and human-approved by construction
(`admitLearningRecord`). The exporter never weakens or bypasses those guards.

## Entry points

- Function: `buildLearningCorpus(db, { tenantId, purpose, at, datasetVersionId? })`
  from `@mendpoint/db`, returning `{ examples, stats, reason }`.
- Serialization: `serializeLearningCorpusJsonl(examples)` (deterministic JSONL,
  one example per line, trailing newline).
- Stats: `formatLearningCorpusStats(stats)`.
- CLI: `npm run learning:export-corpus -- --tenant=<id> [--purpose=...]
  [--dataset-version=<id>] [--at=<iso>] [--db=<path>] [--out=<file>]`.
  JSONL goes to `--out` or stdout; the stats summary always goes to stderr.

## Corpus schema (version 1)

`LEARNING_CORPUS_SCHEMA_VERSION = 1`. Each JSONL line is one example:

```json
{
  "schemaVersion": 1,
  "id": "<content_sha256 of the redacted outcome>",
  "input": {
    "task": "<consent purpose>",
    "failingCommandId": "<id or null>",
    "changedPaths": ["src/foo.ts"],
    "targetPaths": ["src/foo.ts"]
  },
  "output": {
    "edits": [
      { "path": "src/foo.ts", "semanticCategory": "behavior", "risk": "low", "rationale": "..." }
    ],
    "verificationSummary": "vitest passed",
    "verificationCommandId": "verify-..."
  },
  "labels": {
    "family": null,
    "provider": null,
    "framework": null,
    "semanticCategories": ["behavior"],
    "overallRisk": "low",
    "confidence": 82,
    "verificationPassed": true,
    "decision": "accepted"
  },
  "provenance": {
    "tenantId": "...",
    "purpose": "...",
    "residencyRegion": "us-east",
    "datasetVersionId": "...",
    "datasetVersion": 1,
    "datasetSha256": "...",
    "learningRecordId": "...",
    "sourceObjectType": "transformer_adaptive_candidate",
    "observedAt": "2026-07-31T12:00:00.000Z",
    "contentSha256": "..."
  }
}
```

- `input`, `output`, and `labels` are the trainable fields.
- `provenance` is audit metadata (tenant, dataset, hashes) for traceability and
  deletion. A post-training pipeline strips it before any bytes reach a model.

The output is deterministic and idempotent: object keys are emitted in
construction order, arrays (`changedPaths`, `targetPaths`, `edits`,
`semanticCategories`) are sorted, and a fixed database state always produces
byte-identical JSONL.

## Privacy invariants (fail closed)

An example is emitted only if every one of these holds; otherwise the record is
EXCLUDED and counted, never exported with weaker evidence:

- **Consent.** The tenant has a single active, granted, unexpired,
  non-revoked consent for the purpose. Revocation removes the active consent, so
  the entire export returns `no_active_consent` and emits nothing.
- **Sealed only.** Only members of a sealed dataset version are read. A draft
  (unsealed) version exports nothing (`no_sealed_dataset` /
  `dataset_not_found_or_unsealed`).
- **Residency-correct.** The dataset residency must equal the active consent's
  residency; an explicitly named version is refused if its purpose or residency
  does not match.
- **Tenant isolation.** Every read is tenant-scoped; one tenant's export can
  never surface another tenant's data.
- **Redacted only.** Only the redacted artifact body is ever read, never the
  raw source (whose content is not persisted). A member whose redacted content
  is missing, unparseable, or not the expected schema is excluded.
- **Eligibility.** Deleted records and records past the temporal cutoff are
  excluded by the same eligibility gate used to seal and to build precedent.

Never exported: unconsented, unsealed, cross-tenant, unredacted, deleted, or
schema-unexpected data. No secrets are emitted; redaction happened at admission
and only the redacted derivative carries stored content.

### Exclusion reasons (in `stats.excludedByReason`)

- `ineligible_membership` — sealed member no longer eligible (revoked consent,
  deletion, or temporal cutoff). Computed as sealed members minus eligible.
- `missing_redacted_content` — no retrievable redacted body.
- `unparseable_content` — redacted body is not valid JSON.
- `unexpected_schema` — parses but is not the redacted approved-outcome shape.

## Stats summary

`stats` reports `sealedMembers`, `eligibleMembers`, `exported`, `excluded`,
`excludedByReason` (the four reasons above, including the excluded-for-lost-
consent/eligibility count), and distributions `byDecision`, `byOverallRisk`, and
`bySemanticCategory`.

## How a post-training run would consume it

1. Export a per-tenant, per-purpose JSONL from the latest sealed dataset version.
2. Strip `provenance`; map each example to the trainer's chat/instruction format
   (`input` -> prompt describing the failing command, changed paths, and target
   paths; `output` -> the accepted change specification and its verification).
3. Fine-tune an OSS base model (Codestral, StarCoder, or similar) on a host such
   as Fireworks, keeping the dataset residency-partitioned so a tenant's data
   never crosses its consented residency.
4. Evaluate against held-out sealed versions; the temporal cutoff on each sealed
   version guards against train/test contamination.

## What is deliberately absent (moat-plan findings)

The sealed learning shape today does not carry three things a richer training
corpus would want, so the exporter emits them honestly rather than fabricating:

1. **No migration `family` / `provider` / `framework` label.** The redacted
   approved-outcome document carries `failingCommandId`, `changedPaths`, per-edit
   `semanticCategory` / `risk` / `rationale`, `overallRisk`, `confidence`, and the
   verification summary — but no discrete family (sdk / framework / runtime /
   internal-api / warden-provider) or provider/framework name. These labels are
   emitted as `null`. The consent `purpose` and `sourceObjectType` (in
   `provenance`) are the only present proxies.
2. **No raw diff / after-content.** Redaction deliberately excludes raw file
   bodies. The `output` is therefore the accepted *change specification*
   (paths, semantic category, risk, rationale, verification), not literal diff
   hunks. Supervised diff-generation fine-tuning would require the accepted
   after-content to be carried through admission, which it is not today.
3. **No negative / preference signal.** `admitLearningRecord` admits only
   verified, human-approved outcomes, so every example is `decision: "accepted"`
   and `verificationPassed: true`. Rejected outcomes and reviewer edits are never
   stored in the learning tables, so preference-style (accepted-vs-rejected)
   training pairs cannot be produced from sealed learning data without a new,
   separately consented rejected-outcome capture path.
