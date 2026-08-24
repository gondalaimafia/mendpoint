# Route the Fettler campaign executor into the worker job loop

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

`2026-08-23-fettler-campaign-target-worker-executor.md` landed `runWardenCampaignExecuteTarget`, the tested worker-side entrypoint that invokes `executeWardenCampaignTarget` and maps its outcome onto job-status semantics, but deliberately left it out of the fenced `processJobsOnceUnfenced` loop because that loop's per-job-type `completeJob`/`failJob` lease-fence contract is intricate. This ADR wires the routing.

## Decision

Route the `warden.campaign.execute-target` job type through the fenced loop, honoring the same lease-fence completion contract the other Warden handlers use.

- **Conditional claim, fail-safe by absence.** The loop claims `warden.campaign.execute-target` only when `opts.wardenCampaignExecution` is present (the deployment configured the production `WardenCampaignExecutionDependencies`). A worker without those dependencies does not claim the job, so it waits for a configured worker rather than being failed on every drain.
- **Handler.** On a claimed job the loop calls `runWardenCampaignExecuteTarget` and settles under the fence: `executed` → `completeJob` (`succeeded++`); a terminal or retryable outcome → `failJob` inside a `BEGIN IMMEDIATE` transaction with the appropriate `retryable` flag and backoff (`failed++`, and `retried++` when the job is rescheduled). An unexpected (non-executor) throw propagates to the loop's existing generic failure path. This mirrors the `warden.candidate.observe`/`repair` settlement exactly.
- **Review-first.** The executor ends at stage `review` and never delivers, so routing it adds no delivery path.
- Dependencies remain **injected** via `opts.wardenCampaignExecution` (also how the tests supply a stub executor). Constructing the production dependencies (generation `planEdits`/`applyEdits` + sandbox `verify` + draft delivery config) and passing them from the `run-service`/`run-jobs` commands is the final, separate follow-on that turns the job type on in production.

## Alternatives considered

- **Always claim the job and fail it when dependencies are unconfigured.** Rejected: it would dead-letter a legitimately-queued job on any worker that happens to lack the config, instead of leaving it for a capable worker. Conditional claim is the correct fail-safe.
- **Complete/fail the job inside the dispatch module.** Rejected: the lease fence and transaction boundaries belong to the loop, which owns the lease; the dispatch stays loop-agnostic and unit-testable, and the loop owns settlement — matching every other handler.
- **Construct the production dependencies in this change.** Deferred: composing real generation and sandbox verification is a substantive integration with its own risk and review; landing the routing first (tested end to end with a stub executor) de-risks it.

## Security impact

None beyond the executor's own fail-closed checks. Routing is review-first (ends at `review`, never delivers). A worker only claims the job when explicitly configured with dependencies. The executor re-validates human rollout+owner approvals, snapshot validity, rollout cohort/maintenance windows, and tenant scoping; settlement is lease-fenced, so a lost lease never double-processes. No new auth, tenancy, secret, or external surface.

## Data and compatibility impact

Additive. One conditional entry in the loop's `claimedTypes`, one handler branch, and one optional `opts` field. No schema, wire-format, or existing-API change. Existing job types and the full `cli.test.ts` loop suite are unaffected.

## Migration plan

1. Add the `wardenCampaignExecution` option, conditional claim, and handler to `processJobsOnceUnfenced`.
2. Add an end-to-end worker-loop test (enqueue → drain) for completion, retryable reschedule, terminal failure, and no-claim-when-unconfigured, using an injected stub executor.
3. Run the worker typecheck and the worker loop suite.
4. Follow-on: construct the production `WardenCampaignExecutionDependencies` and pass them from the service commands to activate the job type in production.

## Rollback

Revert the commit. The job type returns to unclaimed and the handler is gone; no data is transformed.

## Evaluation plan

Success is the worker typecheck and the routing suite passing — completion sets the job `done`, a retryable outcome reschedules it `pending`, a terminal outcome fails it, and an unconfigured worker does not claim it — with `cli.test.ts` (the loop suite) still green. The follow-on's success will be a service command constructing real dependencies and a mock-delivery end-to-end run driving a queued target to `review`.
