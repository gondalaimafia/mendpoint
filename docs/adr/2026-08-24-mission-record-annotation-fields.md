# Add §8.19–8.21 annotation columns without rewriting content digests

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

v4.0 §8.19–8.21 name annotation fields that the existing append-only Mission
record stores did not persist: `decision_type` on a MissionDecision, `task_id`
and `category` on a MissionException, and `task_id` and `source_snapshot` on a
MissionArtifact. Those stores already exist (`packages/db/src/mission-decisions.ts`,
`mission-exceptions.ts`, `mission-artifacts.ts`) with tenant-bound content-addressed
primary keys. Changing a digest formula would rewrite historical ids and break
supersession chains. The columns must therefore be added without becoming part of
the digested body.

## Decision

Add five nullable TEXT columns and keep them **out of the content digest**.

- Schema: `mission_decisions.decision_type`, `mission_exceptions.task_id`,
  `mission_exceptions.category`, `mission_artifacts.task_id`,
  `mission_artifacts.source_snapshot`. Present in the fresh `CREATE TABLE`
  DDL and in the idempotent `additiveColumns` ALTER path. ALTER ADD COLUMN
  does not fire the append-only UPDATE triggers, so existing rows keep their
  ids.
- Closed sets: `MISSION_DECISION_TYPES` (architecture | migration | policy |
  verification | exception_resolution | preference | other) and
  `MISSION_EXCEPTION_CATEGORIES` (graph_incomplete | high_risk_change |
  ambiguous_requirement | policy_exception | verification_failure |
  architecture_decision_required | other). Unknown values fail closed;
  omitted values persist as NULL.
- Writers accept the annotations optionally. Content-addressed replay of an
  identical logical body returns the original row and does **not** overwrite
  annotations (the tables remain append-only).
- Digest bodies are unchanged. The annotations are labels for later query and
  handoff, not identity.

## Alternatives considered

- **Fold the annotations into the digest.** Rejected: existing rows would
  become a different identity, supersession FKs would dangle, and replay
  semantics would fork.
- **Side tables for annotations.** Rejected: one nullable column per field is
  the smallest coherent change and matches how `graph_version_id` /
  `policy_envelope_version` were added to `mission`.
- **Free-form strings with no closed set.** Rejected for `decision_type` and
  `category`: the spec enumerates the kinds later tasks consult; an open
  string recreates the "reconstruct from prose" failure the registers exist
  to prevent. `task_id` and `source_snapshot` remain free-form references.

## Security impact

None beyond existing tenant isolation. Columns are tenant-scoped through the
parent row's composite FK. No new authentication, authorization, or secret
surface. Closed-set validators reject unknown types rather than storing
attacker-shaped labels as first-class categories.

## Data and compatibility impact

Additive, backward-compatible schema change. Existing rows read NULL for every
new column. Fresh and migrated databases converge via CREATE TABLE plus
`additiveColumns`. No wire-format break; read types gain nullable fields.
Content digests and primary keys of existing rows are unchanged.

## Migration plan

1. Add the columns to the DDL and `additiveColumns`.
2. Extend row types, hydrate, and INSERT writers.
3. Add closed-set normalizers and optional writer inputs.
4. Cover digest stability, replay, closed-set rejection, and ADD COLUMN
   convergence with tests.

## Rollback

Revert the commit. Existing volumes keep the extra nullable columns (SQLite
cannot drop a column without a rebuild); they become unused. No digest or id
is rewritten, so rollback does not orphan historical rows.

## Evaluation plan

Success is the db annotation, decision, exception, and artifact suites
passing, with digest-stable replay and closed-set rejection covered. The
signal to revisit is a later requirement that an annotation participate in
identity — that would need a new row kind, not a digest rewrite.
