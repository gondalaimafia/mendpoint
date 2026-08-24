# Deterministic field-rename recipe for the Fettler campaign executor

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The Fettler campaign executor (`executeWardenCampaignTarget`) is now reachable from the worker (entrypoint ADR 2026-08-23; loop-routing ADR 2026-08-24), but had **no production `WardenCampaignExecutionDependencies`** — no real `planEdits`/`applyEdits`. There was no existing producer of `WardenTypedEditStrategy` to compose: `@mendpoint/generation` emits unified-diff `MigrationDraft`, a different shape. So the executor's edit-generation was net-new.

Spec §14 prefers deterministic recipes over generative execution "when doing so is safer, cheaper, and more explainable." A field-rename is the simplest such class and a common breaking API change.

## Decision

Implement a deterministic **field-rename recipe** as the first production execution dependency, with no model call.

- `planFieldRenameEdits({ rename, sourceArtifactId, snapshotRoot })` — pure. Walks the snapshot's text files, emits one `typed_recipe` `WardenTypedEditStrategy` per file that references the old identifier as a whole word, sorted by path. Every edit satisfies the executor's `validateTypedEdits` (kind, relative path, symbol, pre/post/rollback, confidence in [0,1], `sourceEvidenceIds` includes the source artifact id).
- `applyFieldRenameEdits({ snapshotRoot, manifestSha256, edits })` — copies the snapshot into an isolated candidate workspace and rewrites the identifier on a whole-word boundary. **Self-contained:** each edit encodes the rename via a canonical `rename:<from>-><to>` postcondition token, so apply shares no mutable state with plan. Returns the shape the executor validates (`baseManifestSha256` echoes the snapshot manifest; `appliedEditIds` mirrors the edit ids).
- `fieldRenameRecipeDependencies({ deriveRename, graphDb? })` — assembles these into executor dependencies. `deriveRename` (which rename a change source implies) is an INJECTED adapter, so the pure plan/apply logic is testable without a database and the production source-parsing adapter can evolve independently. `verify` is left to the executor's default; `graphDb` defaults to an ephemeral in-memory store.

An end-to-end test runs the REAL `executeWardenCampaignTarget` with these dependencies against a controlled campaign fixture (real snapshot source file, rollout decision, human approvals, graph gates): it plans and applies `amount_cents -> amount`, verifies, and lands a review-package artifact carrying the typed edit — with the snapshot on disk untouched (the rename lived only in the candidate copy).

## Alternatives considered

- **Map `@mendpoint/generation`'s unified-diff `MigrationDraft` into typed edits.** Rejected for the first class: the shapes and guarantees differ (a `typed_recipe` names a symbol and carries pre/post/rollback), and a deterministic rename is safer and more explainable than round-tripping diffs.
- **Model-backed generation first.** Rejected as the starting point (§14): a deterministic recipe for one class is cheaper, fully testable, and needs no model; model-backed generation is the later extension for classes recipes cannot express.
- **Carry the rename in shared closure state between plan and apply.** Rejected: encoding the rename on the edit keeps `applyEdits` self-contained and correct even if the two are not called back-to-back, and makes the review package self-describing.

## Security impact

None beyond the executor's own fail-closed checks. No model or network call; the recipe reads snapshot bytes and writes only into an isolated temp candidate directory (the snapshot is never mutated). Path traversal is impossible: planned edits are validated relative paths and apply joins them under the candidate root. The executor still enforces approvals, snapshot validity, graph gates, and baseline/post verification.

## Data and compatibility impact

Additive. New worker module and tests; no schema, wire-format, or existing-API change. Not yet wired into a service command (see follow-on), so no runtime behavior changes.

## Migration plan

1. Add the recipe module (`planFieldRenameEdits`, `applyFieldRenameEdits`, `fieldRenameRecipeDependencies`, rename-postcondition codec).
2. Unit-test the pure plan/apply functions; add an end-to-end test through the real executor.
3. Follow-on (activation): a production `deriveRename` adapter that loads the change source artifact and extracts a field-rename signal (distinguishing a rename from a type change), and passing `fieldRenameRecipeDependencies(...)` from the `run-service`/`run-jobs` commands as `wardenCampaignExecution` under mock delivery first.

## Rollback

Revert the commit. The module has no production caller yet; removal is clean.

## Evaluation plan

Success is the recipe unit tests and the end-to-end executor test passing: the recipe plans one edit per referencing file, applies the rename into an isolated candidate on a whole-word boundary, and the real executor reaches stage `review` with the typed edit in the review package. The activation follow-on's success will be a `run-service` worker driving a queued target to `review` end to end under `GITHUB_MODE=mock`.
