# Learning Capture (opt-in enrichment purposes)

The Regauge learning loop admits one governed record per human-approved
adaptive outcome under the base purpose `transformer-adaptive-repair`
(see `docs/TRANSFORMER_LEARNING_LOOP.md`). That base record carries only the
redacted **change specification** (paths, per-edit semantic category, risk,
rationale, and the passing verification) — never raw file bodies, and never a
negative signal.

Two **separate, opt-in consent purposes** enrich what post-training can consume.
Each is governed independently, so a tenant can grant the base purpose only, base
+ content, base + negatives, or all three, in any combination:

| Purpose | What it captures | Where it originates |
| --- | --- | --- |
| `transformer-adaptive-training-content` | Redacted accepted **after-content** (real before/after file bodies) of an approved outcome | Worker delivery-success seam |
| `transformer-adaptive-rejected-outcomes` | **Rejected** candidates as negative records (change-spec + reviewer rejection rationale), labeled `decision: "rejected"` | API review REJECT decision |

**Default-off and byte-identical.** With neither new purpose granted (the
default), nothing new is captured: no new records, no new artifacts, and the base
corpus is byte-for-byte identical to what it was before this capability existed.
The two enrichments are strictly additive and separately gated.

## `transformer-adaptive-training-content` (after-content)

- **What it stores.** A superset of the approved-outcome document: the same
  change-spec, plus an `afterContent` array with, per accepted edit, the
  `path`, `changeType`, exact **before** bytes, and exact **after** bytes. This
  is what supervised diff-generation training needs.
- **A separate record, not a field on the base record.** The after-content is
  admitted as its own learning record under its own consent. This is deliberate:
  it means revoking (or never granting) the content consent removes exactly the
  after-content via the same eligibility gate that governs every learning record,
  while the base change-spec record and the base corpus stay untouched. Embedding
  the after-content in the base record would tie its lifecycle to the base
  consent, so a content-only revocation could not actually delete it — a
  consent-guarantee violation. Independent revocation is why it is a separate
  record.
- **Redaction.** The entire serialized document (including both file bodies) is
  scrubbed by the same `redactSourceForModel` machinery used before any model
  call, then re-parsed. Fail-closed: if the scrub is excluded (ambiguous),
  truncated, or would no longer be valid JSON, the record is **not stored**
  (`redaction_unparseable` / `redaction_excluded` / `redaction_truncated`) rather
  than stored with a weaker scrub. The redaction cap is the redactor's own hard
  ceiling (1,000,000 chars); a document that would exceed it fails closed.
- **Residency.** Inherited from the content consent (its own
  `residency_region`), independent of the base consent's residency.
- **Fail-closed / default-off.** Disabled flag, not an approval, or an
  absent/ambiguous content consent all yield no record. It runs strictly
  best-effort after the draft PR is durably delivered and never affects delivery.

## `transformer-adaptive-rejected-outcomes` (negatives)

- **What it stores.** The approved-outcome change-spec shape, labeled
  `decision: "rejected"` and carrying the reviewer's `rejectionRationale`. This
  enables preference / negative training (accepted vs rejected change-specs). A
  rejected candidate may still have a passing objective verification (a human
  rejected it for other reasons); that verification result is captured honestly.
- **Origin.** The API review **REJECT** decision. The sealed candidate artifact
  is discarded immediately after a reject, so the negative record is captured by
  reading the bound artifact **before** the discard. Capture is best-effort and
  never affects the reject or discard flow.
- **`admitLearningRecord` is not weakened.** Admission still requires an
  `approve` governance review of the **redacted artifact** (meaning "this redacted
  record is admitted to the corpus"). The accepted-vs-rejected label lives inside
  the redacted document, never in the `review_decisions` row, so the approve-review
  requirement, the append-only triggers, and the residency/consent guards all
  still apply exactly as for the approved path. A distinct evidence/review
  `subject_type` keeps the negative record's governance review isolated.
- **Redaction / residency / fail-closed.** Same as above: the whole document
  (rationale included) is scrubbed fail-closed; residency inherits from the
  rejected-outcome consent; disabled flag, absent consent, or a candidate that is
  not actually rejected yield no record.

## What the corpus exporter emits

`buildLearningCorpus({ purpose })` (see `docs/LEARNING_CORPUS.md`) is unchanged
for the base purpose and byte-identical for accepted-only datasets. It reads each
sealed, eligible, redacted record and shapes the example per its document:

- Base / approved examples: `labels.decision = "accepted"`,
  `labels.verificationPassed = true`, no `output.afterContent`, no
  `output.rejectionRationale` (identical to before).
- After-content examples (content purpose dataset): additionally carry
  `output.afterContent`.
- Negative examples (rejected purpose dataset): `labels.decision = "rejected"`
  and `output.rejectionRationale`; `stats.byDecision` reports the `rejected`
  count.

Each purpose is exported and residency-partitioned on its own, so a training
pipeline joins a content or negative example back to its approved counterpart via
the shared source candidate id in `provenance`, never by crossing residency or
consent boundaries.

## Privacy invariants (unchanged, applied to the new fields)

Every guarantee the base loop makes holds for both new purposes: consent-gated
(each by its own purpose), redacted (fail-closed, never a partial scrub),
residency-scoped (inherited from the governing consent), tenant-isolated,
append-only, and human-anchored (an approval for after-content, a rejection for
negatives). Nothing new is captured without its explicit, separate consent.
