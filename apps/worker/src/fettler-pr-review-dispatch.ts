import { createHash } from "node:crypto";
import {
  completeJob,
  enqueueJob,
  getConsumer,
  getGitHubInstallationByInstallationId,
  getJob,
  insertAgentRun,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";

const JOB_TYPE = "fettler.pr.review";
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;

// Per-run ceilings for a webhook-triggered review. Kept small so a repository
// that opens many pull requests cannot exhaust the tenant's budget through
// webhook volume; the worker additionally clamps model calls (<=100) and bounds
// concurrency per tenant when it claims jobs.
const MAX_MODEL_CALLS = 12;
const MAX_COST_USD = 2;
const MAX_STEPS = 48;

export type MaterializedFettlerPrHead = Readonly<{
  repositoryId: string;
  snapshotId: string;
  revision: string;
  manifestSha256: string;
  root: string;
}>;

export type FettlerPrReviewDispatchInput = Readonly<{
  db: AppDb;
  job: JobRow;
  materializeHead: (input: Readonly<{
    tenantId: string;
    repositoryId: string;
    remoteRepositoryId: number;
    installationId: number;
    headSha: string;
  }>) => Promise<MaterializedFettlerPrHead>;
  now?: () => string;
}>;

type Payload = Readonly<{
  tenantId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  installationId: number;
  consumerId: string;
  pullRequestNumber: number;
  headSha: string;
  headRef: string | null;
  deliveryId: string;
}>;

function parsePayload(job: JobRow): Payload {
  let value: unknown;
  try {
    value = JSON.parse(job.payload_json);
  } catch {
    throw new Error("fettler_pr_review_payload_invalid");
  }
  if (!value || typeof value !== "object") throw new Error("fettler_pr_review_payload_invalid");
  const record = value as Record<string, unknown>;
  const headSha = typeof record.headSha === "string" ? record.headSha.toLowerCase() : "";
  if (
    typeof record.tenantId !== "string" || !record.tenantId ||
    typeof record.repositoryId !== "string" || !record.repositoryId ||
    !Number.isSafeInteger(record.remoteRepositoryId) || Number(record.remoteRepositoryId) < 1 ||
    !Number.isSafeInteger(record.installationId) || Number(record.installationId) < 1 ||
    typeof record.consumerId !== "string" || !record.consumerId ||
    !Number.isSafeInteger(record.pullRequestNumber) || Number(record.pullRequestNumber) < 1 ||
    !SHA.test(headSha)
  ) {
    throw new Error("fettler_pr_review_payload_invalid");
  }
  return Object.freeze({
    tenantId: record.tenantId,
    repositoryId: record.repositoryId,
    remoteRepositoryId: Number(record.remoteRepositoryId),
    installationId: Number(record.installationId),
    consumerId: record.consumerId,
    pullRequestNumber: Number(record.pullRequestNumber),
    headSha,
    headRef: typeof record.headRef === "string" ? record.headRef : null,
    deliveryId: typeof record.deliveryId === "string" ? record.deliveryId : "",
  });
}

function stableIds(payload: Payload) {
  const hash = createHash("sha256")
    .update(
      [payload.tenantId, payload.repositoryId, String(payload.pullRequestNumber), payload.headSha, "review"].join("\0"),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({
    runId: `fettler-pr-run-${hash.slice(0, 32)}`,
    jobId: `fettler-pr-agent-${hash.slice(32)}`,
  });
}

/**
 * Materializes the exact pull request head into an immutable snapshot and
 * enqueues one standard `agent.run` bound to it. Re-verifies the installation
 * binding before acting (defense in depth over the webhook check) and never
 * approves, merges, or pushes anything. Idempotent: a second dispatch for the
 * same PR head returns the existing run without enqueueing a second one.
 */
export async function runFettlerPrReviewDispatch(input: FettlerPrReviewDispatchInput) {
  if (
    input.job.type !== JOB_TYPE ||
    input.job.status !== "running" ||
    !input.job.lease_owner ||
    input.job.lease_generation < 1
  ) {
    throw new Error("fettler_pr_review_job_invalid");
  }
  const payload = parsePayload(input.job);
  if (payload.tenantId !== input.job.tenant_id) {
    throw new Error("fettler_pr_review_tenant_mismatch");
  }

  // Re-verify the installation is still authoritative for this tenant.
  const installation = getGitHubInstallationByInstallationId(input.db, String(payload.installationId));
  if (
    !installation ||
    installation.deleted_at ||
    installation.suspended_at ||
    installation.tenant_id !== payload.tenantId
  ) {
    throw new Error("fettler_pr_review_installation_not_authorized");
  }

  const consumer = getConsumer(input.db, payload.consumerId, payload.tenantId);
  if (!consumer) throw new Error("fettler_pr_review_consumer_not_found");

  const now = input.now ?? (() => new Date().toISOString());
  const ids = stableIds(payload);

  // Idempotent: the review run for this exact head may already exist.
  const existing = getJob(input.db, ids.jobId, payload.tenantId);
  if (existing) {
    const observedAt = now();
    if (
      !completeJob(
        input.db,
        input.job.id,
        { runId: ids.runId, agentJobId: ids.jobId, status: "already_enqueued" },
        observedAt,
        { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation },
      )
    ) {
      throw new Error("fettler_pr_review_lease_lost");
    }
    return Object.freeze({ status: "already_enqueued" as const, runId: ids.runId, agentJobId: ids.jobId });
  }

  const materialized = await input.materializeHead({
    tenantId: payload.tenantId,
    repositoryId: payload.repositoryId,
    remoteRepositoryId: payload.remoteRepositoryId,
    installationId: payload.installationId,
    headSha: payload.headSha,
  });
  if (
    materialized.repositoryId !== payload.repositoryId ||
    materialized.revision !== payload.headSha ||
    !materialized.snapshotId ||
    !SHA.test(materialized.revision) ||
    !SHA256.test(materialized.manifestSha256)
  ) {
    throw new Error("fettler_pr_review_snapshot_binding_mismatch");
  }

  const observedAt = now();
  const prReview = Object.freeze({
    pullRequestNumber: payload.pullRequestNumber,
    headSha: payload.headSha,
    deliveryId: payload.deliveryId,
    source: "github_webhook" as const,
  });
  const agentPayload = Object.freeze({
    goal:
      `Review customer pull request ${payload.pullRequestNumber} at exact head ${payload.headSha}. ` +
      `Report findings only; do not approve, merge, or push.`,
    consumerId: payload.consumerId,
    maxSteps: MAX_STEPS,
    maxModelCalls: MAX_MODEL_CALLS,
    maximumCostUsd: MAX_COST_USD,
    useLlm: true,
    allowNetwork: false,
    sessionId: ids.runId,
    snapshotBinding: Object.freeze({
      repositoryId: materialized.repositoryId,
      snapshotId: materialized.snapshotId,
      revision: materialized.revision,
      manifestSha256: materialized.manifestSha256,
    }),
    prReview,
  });

  input.db.raw.exec("BEGIN IMMEDIATE");
  try {
    enqueueJob(input.db, {
      id: ids.jobId,
      tenantId: payload.tenantId,
      type: "agent.run",
      payload: agentPayload,
      createdAt: observedAt,
    });
    insertAgentRun(input.db, {
      id: ids.runId,
      tenantId: payload.tenantId,
      jobId: ids.jobId,
      goal: agentPayload.goal,
      repoPath: materialized.root,
      status: "queued",
      ok: false,
      steps: 0,
      filesChanged: [],
      reportMd: null,
      resultJson: JSON.stringify({
        jobId: ids.jobId,
        product: "fettler",
        sourceKind: "immutable_snapshot",
        source: agentPayload.snapshotBinding,
        prReview,
      }),
      createdAt: observedAt,
      finishedAt: null,
    });
    if (
      !completeJob(
        input.db,
        input.job.id,
        { runId: ids.runId, agentJobId: ids.jobId, status: "review_enqueued" },
        observedAt,
        { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation },
      )
    ) {
      throw new Error("fettler_pr_review_lease_lost");
    }
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw error;
  }
  return Object.freeze({ status: "review_enqueued" as const, runId: ids.runId, agentJobId: ids.jobId });
}
