# Activate Fettler campaign execute in production

- **Status:** Accepted
- **Date:** 2026-08-24
- **Author:** Cursor cloud agent (Claude)
- **Supersedes:** none
- **Superseded by:** none

## Context

The campaign executor, loop routing, payload-rename activation (#370), and
tenant graph handle (#375) existed, but `run-service` never passed
`wardenCampaignExecution` and nothing enqueued `warden.campaign.execute-target`
on a live path. The job type was unreachable in production.

## Decision

1. **Enqueuer (E1).** `enqueueReadyWardenCampaignTargets` claims ready queued
   targets on a **running** campaign and inserts one execute-target job per
   target, carrying source + diff-extracted `renames` + approvals. `POST
   /fettler/campaigns/:id/start` plans a conservative rollout, transitions
   draft → running, and calls the enqueuer.
2. **run-service (E2).** Claim execute-target only when
   `productionGraphFilePresent()`. Per job, `productionCampaignResolveDependencies`
   resolves `resolveTenantGraphHandle` for the job's tenant and passes that
   persistent db into `fieldRenameRecipeDependencies`. It never defaults to
   `openGraphLearnMemory()` and never creates a missing graph file. A missing
   handle fails retryable (`warden_tenant_graph_unavailable`).

## Alternatives considered

- **Claim execute jobs with an in-memory graph.** Rejected: an empty graph
  would fail owner/CI/runtime gates or, worse, look authoritative.
- **Static graph handle at process start.** Rejected: run-service is
  multi-tenant; the handle is per job tenant.

## Security impact

Tenant-scoped graph open and job enqueue. Start is the same OIDC human writer
gate as campaign create/enroll. Fail closed on a missing production graph file.

## Data and compatibility impact

No schema change. New job enqueue and a new HTTP route. Workers without
`GRAPH_LEARN_DB` still do not claim execute-target jobs.

## Migration plan

1. Add enqueuer + production dependency resolver.
2. Wire run-service / run-jobs.
3. Add start route.
4. Cover enqueue, not-running deny, and existing rename e2e.

## Rollback

Revert the commit. Execute jobs are again unclaimed and unenqueued.

## Evaluation plan

Success is the activation suite: enqueue writes the rename payload; a paused
campaign cannot enqueue; the existing loop e2e still reaches `review`.
Reconsideration is per-target owner approvals — today's start uses the first
target's owner for the cohort, which matches concurrency 1.
