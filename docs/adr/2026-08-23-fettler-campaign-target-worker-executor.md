# Worker entrypoint for the Fettler campaign per-target executor

- **Status:** Accepted
- **Date:** 2026-08-23
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The gap-closure evaluation found that Fettler campaign orchestration exists but is not driven end-to-end from the worker: `executeWardenCampaignTarget` (`packages/pipeline/src/warden-campaign-executor.ts`) is comprehensive and well-tested but has **no non-test caller**.

Investigating before wiring surfaced two facts that shape a safe approach:

1. **It is complementary, not a duplicate.** `executeWardenCampaignTarget` drives one approved target `queued -> analyzing -> editing -> verifying -> review`: it analyzes, generates/applies typed edits, runs baseline+post verification, and lands a review-package artifact at stage `review`. It **does not deliver a PR** — delivery remains the separate, review-first `warden.candidate.deliver` job. So wiring it does not create a second delivery path (spec §16.1 review-first, §31.7 one canonical implementation); it fills the missing per-target *execution* stage.
2. **The worker job loop's completion contract is intricate.** `processJobsOnceUnfenced` finalizes jobs per-type under a lease fence, mixing internal `completeJob`/`failJob` calls, a trailing completion, and CI-cycle settlement. Routing a new job type into it correctly — without risking stuck or double-processed jobs on the delivery path — is a careful integration, not a one-line addition.

## Decision

Land the **worker-side entrypoint** for the executor now, and scope the fenced-loop routing and production-dependency construction as an explicit, reviewed follow-on.

- Add `apps/worker/src/warden-campaign-execute-dispatch.ts`: `runWardenCampaignExecuteTarget` parses a `warden.campaign.execute-target` job (a shape guard only — the executor re-validates every authority), invokes the executor, and maps its outcome onto the worker's job-status vocabulary, distinguishing a **retryable** `WardenCampaignExecutionError` (reschedule) from a **terminal** one (fail). It is intentionally free of lease/completion mechanics so it is unit-testable in isolation, and takes an injectable `execute` and `dependencies`.
- Cover it with unit tests for success (executed at `review`, authority passed through), retryable vs terminal executor errors, malformed-payload fail-closed (executor never invoked), and unexpected-error rethrow.

## Alternatives considered

- **Wire the job type into `processJobsOnceUnfenced` in the same change.** Deferred, not rejected: it requires honoring the per-type `completeJob`/`failJob` fence contract exactly and constructing production `WardenCampaignExecutionDependencies` (generation `planEdits`/`applyEdits` + sandbox `verify` + draft delivery config). Both are careful, higher-risk edits to the live worker path that deserve their own review rather than being bundled with the entrypoint they will call.
- **Route the executor through the existing `warden.candidate.*` jobs instead.** Rejected: those are the delivery/observe/repair stages *after* review; the executor is the analyze->verify->review stage *before* them. They are complementary, so folding one into the other would conflate two distinct stages.
- **Do nothing.** Rejected: the owner asked to close this gap, and the executor having a real (if not yet loop-routed) worker caller with tests is the safe first step.

## Security impact

None in this change. The dispatch performs a shape-guard parse and calls an executor that itself re-checks human rollout and owner approvals, snapshot validity, rollout cohort/maintenance windows, and tenant scoping, and fails closed on any mismatch. It is review-first (ends at `review`, never delivers) and touches no authentication, tenancy, secret, or external surface. Malformed payloads fail closed without invoking the executor.

## Data and compatibility impact

None. Additive worker module and tests; no schema, wire-format, or existing-API change. The `warden.campaign.execute-target` job type is not yet enqueued or routed, so no runtime behavior changes until the follow-on wires it.

## Migration plan

1. Add the dispatch module and its tests.
2. Follow-on (separate, reviewed): route `warden.campaign.execute-target` in `processJobsOnceUnfenced`, mapping `executed`/`retry_scheduled`/`failed` onto `completeJob`/`failJob` under the loop fence, and construct the production `WardenCampaignExecutionDependencies`.

## Rollback

Revert the commit. The module has no production caller yet, so removal is clean.

## Evaluation plan

Success is the dispatch unit tests and worker `typecheck` passing. The follow-on's success will be an end-to-end worker test driving a queued target to `review` under mock delivery (`GITHUB_MODE=mock`) with a sandbox-stubbed `verify`, before any real-delivery enablement.
