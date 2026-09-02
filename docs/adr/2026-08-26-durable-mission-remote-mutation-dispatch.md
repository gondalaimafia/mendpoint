# Persist Mission-bound remote mutations as a fenced state machine

- **Status:** Accepted
- **Date:** 2026-08-26
- **Author:** OpenAI Codex
- **Supersedes:** none
- **Superseded by:** none

## Context

Fettler delivery and CI update cross a transaction boundary: SQLite can commit
Mission authority before GitHub is called, but it cannot atomically commit the
remote effect and the local result. A worker can lose its lease or crash after
GitHub accepts a request and before Mendpoint records the response. Treating
that interval as either "not sent" or "completed" permits duplicate mutation or
false success. Mission pause, blocker, handoff, and revision changes also must
not race past an already-authorized remote mutation.

The canonical specification requires durable, idempotent, resumable Mission
work, exact tenant and snapshot authority, and inspectable failure recovery.
The dispatch record therefore needs a third state for an outcome that may exist
remotely but is not proven locally.

## Decision

Persist each Mission-bound remote mutation in `mission_mutation_dispatches`,
uniquely keyed by tenant and job, and drive it through this state machine:

`authorized -> dispatching -> settled`

`authorized -> revoked`

`dispatching -> uncertain -> dispatching` only after the operation-specific
reconciliation or idempotent replay contract permits the exact same intent.

- **authorized:** exact Mission/task authority, intent digest, aggregate,
  mutation kind, active job lease owner, and lease generation are committed.
  No remote call has begun. A new valid lease may re-arm this state.
- **dispatching:** the durable begin marker is committed immediately before the
  remote call. Mission and task writers may no longer revoke or overwrite the
  authority lane.
- **uncertain:** the call threw, its response was lost, or another lease found a
  predecessor in `dispatching`. The caller must reconcile the exact remote
  intent. Unknown remains uncertain; proven not-applied may retry; proven
  applied proceeds to local finalization.
- **settled:** exact remote evidence and local aggregate/job finalization are
  durably accepted. Re-entry is allowed only for the same tenant, job,
  authority, and intent under an explicit reconciliation path.
- **revoked:** Mission, task, dependency, or blocking-exception authority
  changed while the dispatch was still only `authorized`. Revoked work cannot
  begin remotely.

Every transition is tenant scoped. Authorization revalidates the exact Mission
revision/state, task revision/status, repository, snapshot, resolved commit,
absence of current blockers, active lease owner/generation, and immutable
intent digest. A differing aggregate, authority JSON, mutation kind, or intent
on the same job is a conflict, never an update. Mission-wide writers reject
`dispatching` or `uncertain` rows; task writers fence only the exact task lane so
independent sibling tasks remain usable.

The **point of no clean rollback** is the committed transition to
`dispatching`. From then on the remote mutation may exist even when no response
was observed. Recovery must preserve the row and reconcile it; it must not
delete state, reset to `authorized`, or blindly repeat the call.

## Alternatives considered

- **Rely on the jobs lease alone.** Rejected: a lease proves which worker may
  act now, not whether a prior worker already reached GitHub before crashing.
- **Record only pending and completed.** Rejected: timeout and connection loss
  collapse "not applied" and "possibly applied," recreating duplicate mutation.
- **Use an in-memory mutex.** Rejected: it is lost on restart, cannot fence a
  second process, and provides no audit or recovery evidence.
- **Write the Mission transition after the remote call without a begin marker.**
  Rejected: a pause or blocker can win locally while the unauthorized remote
  effect is already in flight.
- **Make every remote API globally idempotent and omit local state.** Rejected:
  provider guarantees differ, and provider idempotency does not preserve the
  exact Mission, task, lease, snapshot, and intent authority Mendpoint requires.

## Security impact

This narrows remote mutation authority. Cross-tenant rows, stale Mission/task
revisions, changed snapshots, current blockers, lost leases, and changed intent
digests fail closed before dispatch. The table contains identifiers, digests,
and the already-internal authority document; it stores no repository content or
credentials. `uncertain` is deliberately non-successful and cannot be treated
as permission to merge or deploy.

## Data and compatibility impact

`mission_mutation_dispatches` is an additive SQLite table with a closed state
set and a unique `(tenant_id, job_id)` key. Existing historical rows are not
backfilled or assigned guessed authority. Unbound compatibility work remains
unchanged; Mission-bound delivery and CI update require the exact authority and
dispatch record. State and timestamp columns are retained as operational and
audit evidence even after settlement or revocation.

## Migration plan

1. Create the table and tenant/Mission/state index through the normal
   idempotent database bootstrap; prove both fresh and upgrade convergence.
2. Persist exact Mission mutation authority on new review successors,
   deliveries, CI cycles, and CI updates. Do not infer it for historical work.
3. Authorize the exact intent under the active lease, then write `dispatching`
   immediately before each remote call.
4. Mark transport and finalization ambiguity `uncertain`; reconcile provider
   state on retry before permitting an operation-specific exact replay.
5. Settle the dispatch in the same local transaction as aggregate/job success,
   and fence Mission/task/blocker writers against in-flight rows.
6. Observe uncertain age, reconciliation outcomes, conflicts, and revoked work
   before expanding the mechanism to another remote mutation kind.

## Rollback

Before any row reaches `dispatching`, the callers can be reverted and unused
`authorized` rows revoked; leaving the additive table in place is harmless.
After any row reaches `dispatching` or `uncertain`, rollback is not a code-only
revert: retain the table and a compatible reconciliation worker until every
such row is proven applied and settled or proven not applied and safely
revoked/retried. Never drop or rewrite an uncertain row. Settled and revoked
history remains immutable even after callers are rolled back. Removing the
table requires a separate evidence-backed migration after no in-flight or
uncertain rows remain.

## Evaluation plan

Regression suites must prove exact authority and lease fencing, one-use
authorization, task-sibling independence, pause/blocker revocation before the
point of no return, rejection while dispatching/uncertain, worker takeover,
timeout ambiguity, exact reconciliation of applied/not-applied/unknown, restart
recovery, idempotent settlement, and fresh/upgrade database convergence.
Mutation tests must fail when the durable begin marker, intent comparison,
third-state handling, or tenant/task predicate is removed. Production evidence
must expose the count and age of uncertain rows; any unexplained persistent
uncertain row or duplicate remote mutation triggers reconsideration.
