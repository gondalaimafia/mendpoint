# Avoid re-proposing Mission-rejected Fettler edits

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

FET-021 requires Fettler not to repeatedly propose an approach the same Mission
has already rejected unless new evidence or a superseding decision justifies
revisiting it. `planEdits` is injected and stateless; the durable rejected
approaches live in `mission_decisions`. After planning, the executor must
consult the active decision log before applying.

## Decision

After `validateTypedEdits`, filter the planned set with
`rejectEditsSupersededByDecisions` against `getActiveMissionDecisions` for the
campaign's Mission. A decision **scope** matching an edit's `targetPath`,
`targetSymbol`, `id`, or `kind:<kind>` drops that edit. If none remain, fail
closed with terminal `warden_edits_previously_rejected`.

Matching on scope is deterministic and avoids parsing prose. A retracted or
superseded decision is omitted by `getActiveMissionDecisions`, which is how a
later decision revisits an approach.

## Alternatives considered

- **NLP over `decision` text.** Rejected: non-deterministic and untestable as
  an authorization-adjacent filter.
- **Filter inside `planEdits`.** Rejected: recipes must stay pure; the Mission
  store is the executor's concern.

## Security impact

Tenant-scoped decision read only. No new write. Filtering cannot add edits.

## Data and compatibility impact

No schema change. Campaigns without a Mission skip the filter (E3 already
fails closed on unbound campaigns at this seam).

## Migration plan

1. Add the filter and call it after planEdits.
2. Cover a path-scoped rejection that blocks review.

## Rollback

Revert the commit. Rejected approaches can be re-proposed.

## Evaluation plan

Success is the executor suite: a `scope` equal to the planned path fails
closed; the happy path is unchanged. Reconsideration is a richer rejection
record (edit-id evidence) — extend the match keys, do not parse prose.
