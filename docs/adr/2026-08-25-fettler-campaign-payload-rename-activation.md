# Carry the diff's field renames in the Fettler campaign job payload

- **Status:** Accepted
- **Date:** 2026-08-25
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The deterministic field-rename recipe (ADR 2026-08-24) assembles executor
dependencies from an injected `deriveRename` adapter, and the loop routing (ADR
2026-08-24) reaches the executor from a `warden.campaign.execute-target` job. The
remaining gap was **where the correct rename comes from**.

The recipe's follow-on proposed a production `deriveRename` that reads the change
**source artifact** and extracts a rename signal. That is a correctness hazard:
the persisted `UnifiedSourceArtifact` carries only a lossy `taxonomySignals`
list, which cannot reliably distinguish a field **rename** (`amount_cents` ->
`amount`, edit both sites) from a **type change** on the same field (do not
rename). Guessing here would generate wrong edits — unacceptable for a
high-risk remediation path.

The unambiguous rename source is the OpenAPI diff itself: `DiffEntry` with op
`request_field_renamed` / `response_field_renamed` carries explicit
`fromField -> toField`. That diff is in hand at **enqueue** time (both spec
versions are compared to build the campaign), not at execute time.

## Decision

Carry the renames the diff proved in the **campaign job payload**, and build the
recipe from that payload — never from the lossy artifact taxonomy.

- `extractFieldRenames(entries)` — pure. Keeps only explicit `*_field_renamed`
  ops with both `fromField` and `toField` present, differing, and valid
  identifiers; deduplicates; preserves order. Refuses removals, no-op renames,
  and dotted/non-identifier fields (fail closed rather than mis-generate). This
  runs at enqueue, when the diff is available.
- The execute-target payload gains an optional `renames: {from,to}[]`, parsed and
  shape-checked by `parseWardenCampaignExecuteJob` (absent -> `[]`).
- `runWardenCampaignExecuteTarget` now takes `resolveDependencies(renames)`
  instead of a static `dependencies`, so the loop builds the executor
  dependencies **per job** from that job's renames. The loop option
  `wardenCampaignExecution` carries the resolver.
- `payloadRenameDeriver(renames)` — a `DeriveFieldRename` that returns the
  carried rename independent of the envelope (or `null` when none was carried,
  so the executor fails closed on an empty edit set).

An end-to-end **loop** test enqueues a real `warden.campaign.execute-target` job
whose payload carries `amount_cents -> amount` (and whose artifact taxonomy is
deliberately empty), drains it through the real `processJobsOnce` with
`resolveDependencies = (renames) => fieldRenameRecipeDependencies({ deriveRename:
payloadRenameDeriver(renames), graphDb })`, and asserts the job completes and the
target lands in `review` with the applied typed edit — the snapshot on disk
untouched. A companion case proves an empty payload fails closed (no review).

## Alternatives considered

- **Production `deriveRename` that reads the source artifact taxonomy.**
  Rejected: `taxonomySignals` cannot separate a rename from a type change, so it
  would mis-generate edits. The diff is the only authoritative rename source.
- **Persist renames in a side table keyed by source id and load in `deriveRename`.**
  Rejected as heavier and redundant: the renames belong to the specific campaign
  target's change, which the job payload already scopes exactly; a table adds a
  write/read and a tenant-isolation surface for no gain.
- **Keep the static `dependencies` param and thread renames another way.**
  Rejected: renames are per-target, so the dependency build must be per-job; a
  `resolveDependencies(renames)` resolver is the minimal honest shape.

## Security impact

None beyond the executor's own fail-closed checks. Renames are shape-validated on
parse; an invalid `renames` shape fails the job closed. No new model or network
call. The recipe still writes only into an isolated candidate directory and the
executor still enforces approvals, snapshot validity, graph gates, and
baseline/post verification.

## Data and compatibility impact

Additive and backward compatible. The `renames` payload field is optional
(absent -> `[]`), so existing enqueuers keep working (they simply produce no
edit and fail closed, unchanged from before). The dispatch's `resolveDependencies`
replaces the not-yet-shipped static `dependencies` option; there is no external
caller. No schema or wire-format change.

## Migration plan

1. Add `extractFieldRenames` + `payloadRenameDeriver` (recipe module).
2. Parse optional `renames` in the execute-target payload; switch the dispatch and
   loop option to `resolveDependencies(renames)`.
3. Prove the full path with a loop-level end-to-end test.
4. Remaining production toggle (out of scope here, deliberately): the enqueuer
   populates `renames` via `extractFieldRenames(diff.entries)` at campaign
   approval, and `run-service`/`run-jobs` pass `wardenCampaignExecution` under
   `GITHUB_MODE=mock`. That step must supply the **real per-tenant Change Graph**
   handle to `resolveDependencies` (the executor reads repository evidence from
   it and fails closed when empty), which the worker does not open today; wiring
   an empty/ephemeral graph would make every target uselessly fail the graph
   gate, so it is left for a dedicated change rather than shipped subtly wrong.

## Rollback

Revert the commit. The `renames` field is optional and unread by any shipped
enqueuer, and no service command passes `wardenCampaignExecution` yet, so removal
is clean.

## Evaluation plan

Success is the unit tests (`extractFieldRenames`, `payloadRenameDeriver`, payload
parse) and the end-to-end loop test passing: a queued target with a payload
rename drains to `review` with the applied typed edit, and a queued target with
no payload rename fails closed. The remaining toggle's success will be a
`run-service` worker driving a queued, diff-derived rename to `review` end to end
under `GITHUB_MODE=mock` against the real Change Graph.
