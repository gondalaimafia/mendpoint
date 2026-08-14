import { createHash } from "node:crypto";
import {
  bindWardenCiUpdateIntent,
  completeJob,
  completeWardenCiUpdate,
  getAgentRun,
  getWardenCiCycle,
  getWardenCiUpdate,
  markWardenCiUpdateUncertain,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import type { ExactDraftUpdateInput, ExactDraftUpdateReconciliation, ExactDraftUpdateResult } from "@mendpoint/github";

const JOB_TYPE = "warden.candidate.update";

export type WardenCandidateUpdateInput = Readonly<{
  db: AppDb;
  job: JobRow;
  updateExactDraft: (input: ExactDraftUpdateInput) => Promise<ExactDraftUpdateResult>;
  reconcileExactDraftUpdate: (input: ExactDraftUpdateInput) => Promise<ExactDraftUpdateReconciliation>;
  readApprovalArtifact: (input: Readonly<{ tenantId: string; path: string; sha256: string }>) => Record<string, unknown>;
  resolveRepository: (input: Readonly<{ tenantId: string; repositoryId: string; installationId: number;
    remoteRepositoryId: number }>) => Readonly<{ owner: string; repo: string }> |
      Promise<Readonly<{ owner: string; repo: string }>>;
  now?: () => string;
}>;

function payload(job: JobRow): Readonly<{ cycleId: string; updateId: string }> {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); } catch { throw new Error("warden_ci_update_payload_invalid"); }
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).cycleId !== "string" ||
      typeof (value as Record<string, unknown>).updateId !== "string") throw new Error("warden_ci_update_payload_invalid");
  return Object.freeze({ cycleId: String((value as Record<string, unknown>).cycleId),
    updateId: String((value as Record<string, unknown>).updateId) });
}

function files(artifact: Record<string, unknown>): ExactDraftUpdateInput["files"] {
  const entries = (artifact.candidate as Record<string, unknown> | undefined)?.entries;
  if (!Array.isArray(entries) || !Array.isArray(artifact.files)) throw new Error("warden_ci_update_artifact_invalid");
  const byPath = new Map(entries.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("warden_ci_update_artifact_invalid");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || typeof entry.sha256 !== "string" ||
        typeof entry.executable !== "boolean" || typeof entry.size !== "number") {
      throw new Error("warden_ci_update_artifact_invalid");
    }
    return [entry.path, entry] as const;
  }));
  return Object.freeze(artifact.files.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("warden_ci_update_artifact_invalid");
    const file = raw as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.after !== "string" || typeof file.afterSha256 !== "string") {
      throw new Error("warden_ci_update_file_deletion_unsupported");
    }
    const entry = byPath.get(file.path);
    const bytes = Buffer.from(file.after, "base64");
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (!entry || actual !== file.afterSha256 || actual !== entry.sha256 || bytes.byteLength !== entry.size ||
        bytes.includes(0)) throw new Error("warden_ci_update_artifact_digest_mismatch");
    return Object.freeze({ path: file.path, content: bytes.toString("utf8"),
      mode: entry.executable ? "100755" as const : "100644" as const });
  }));
}

function assertArtifact(artifact: Record<string, unknown>, input: Readonly<{
  tenantId: string; repositoryId: string; snapshotId: string; baseBranch: string; expectedHeadSha: string;
  reviewerPrincipalId: string; rationale: string;
}>): void {
  if (artifact.tenantId !== input.tenantId || artifact.repositoryId !== input.repositoryId ||
      artifact.snapshotId !== input.snapshotId || artifact.baseBranch !== input.baseBranch ||
      artifact.expectedBaseRevision !== input.expectedHeadSha ||
      artifact.reviewerPrincipalId !== input.reviewerPrincipalId || artifact.rationale !== input.rationale) {
    throw new Error("warden_ci_update_artifact_binding_mismatch");
  }
}

function intentDigest(intent: ExactDraftUpdateInput): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(intent), "utf8").digest("hex")}`;
}

export async function runWardenCandidateUpdate(input: WardenCandidateUpdateInput) {
  if (input.job.type !== JOB_TYPE || input.job.status !== "running" || !input.job.lease_owner ||
      input.job.lease_generation < 1) throw new Error("warden_ci_update_job_invalid");
  const parsed = payload(input.job);
  const update = getWardenCiUpdate(input.db, input.job.tenant_id, parsed.updateId);
  const cycle = getWardenCiCycle(input.db, input.job.tenant_id, parsed.cycleId);
  const reconciliationRequired = update?.status === "uncertain" || update?.status === "intent_bound";
  const reconciliationOnly = reconciliationRequired && cycle?.status === "paused";
  if (!update || !cycle || update.cycleId !== cycle.id || update.jobId !== input.job.id ||
      (cycle.status !== "update_pending" && !reconciliationOnly) || cycle.currentHeadSha !== update.expectedHeadSha ||
      cycle.repairRunId !== update.repairRunId) throw new Error("warden_ci_update_not_authorized");
  const run = getAgentRun(input.db, update.repairRunId, cycle.tenantId);
  let runResult: Record<string, unknown>;
  try { runResult = JSON.parse(run?.result_json ?? "null") as Record<string, unknown>; }
  catch { throw new Error("warden_ci_update_run_invalid"); }
  const source = runResult?.source && typeof runResult.source === "object"
    ? runResult.source as Record<string, unknown> : null;
  if (!run || run.status !== "candidate_approved" || source?.repositoryId !== cycle.repositoryId ||
      source?.revision !== cycle.currentHeadSha || typeof source.snapshotId !== "string") {
    throw new Error("warden_ci_update_run_invalid");
  }
  const artifact = input.readApprovalArtifact({ tenantId: cycle.tenantId, path: update.sealedPath,
    sha256: update.sealedSha256 });
  assertArtifact(artifact, { tenantId: cycle.tenantId, repositoryId: cycle.repositoryId,
    snapshotId: source.snapshotId, baseBranch: cycle.baseBranch, expectedHeadSha: cycle.currentHeadSha,
    reviewerPrincipalId: update.reviewerPrincipalId, rationale: update.rationale });
  const repository = await input.resolveRepository({ tenantId: cycle.tenantId, repositoryId: cycle.repositoryId,
    installationId: cycle.installationId, remoteRepositoryId: cycle.remoteRepositoryId });
  const intent = Object.freeze({ owner: repository.owner, repo: repository.repo,
    expectedRepositoryId: cycle.remoteRepositoryId, pullRequestNumber: cycle.pullRequestNumber,
    baseBranch: cycle.baseBranch, branch: cycle.branchName, expectedHeadSha: cycle.currentHeadSha,
    commitMessage: `Apply approved Gauge CI repair ${update.repairRunId}`,
    commitDate: update.requestedAt, files: files(artifact) }) satisfies ExactDraftUpdateInput;
  const now = input.now ?? (() => new Date().toISOString());
  const dispatchAt = now();
  const currentCycle = getWardenCiCycle(input.db, cycle.tenantId, cycle.id);
  const fence = input.db.raw.prepare(`SELECT status, lease_owner, lease_generation, lease_expires_at FROM jobs
    WHERE id = ? AND tenant_id = ?`).get(input.job.id, cycle.tenantId) as Record<string, unknown> | undefined;
  if (!currentCycle || (currentCycle.status !== "update_pending" && !reconciliationOnly) ||
      currentCycle.currentHeadSha !== update.expectedHeadSha ||
      fence?.status !== "running" || fence.lease_owner !== input.job.lease_owner ||
      fence.lease_generation !== input.job.lease_generation || typeof fence.lease_expires_at !== "string" ||
      fence.lease_expires_at <= dispatchAt) throw new Error("warden_ci_update_not_authorized");
  const digest = intentDigest(intent);
  let remote: ExactDraftUpdateResult;
  if (reconciliationRequired) {
    if (update.status === "intent_bound") {
      markWardenCiUpdateUncertain(input.db, { tenantId: cycle.tenantId, updateId: update.id,
        intentDigest: digest, observedAt: dispatchAt });
    }
    const reconciliation = await input.reconcileExactDraftUpdate(intent);
    if (reconciliation.status === "unknown") throw new Error("warden_ci_update_outcome_uncertain");
    if (reconciliation.status === "applied") {
      remote = reconciliation.result;
    } else {
      bindWardenCiUpdateIntent(input.db, { tenantId: cycle.tenantId, updateId: update.id,
        intentDigest: digest, workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation,
        observedAt: dispatchAt });
      try { remote = await input.updateExactDraft(intent); }
      catch (error) {
        markWardenCiUpdateUncertain(input.db, { tenantId: cycle.tenantId, updateId: update.id,
          intentDigest: digest, observedAt: now() });
        throw error;
      }
    }
  } else {
    bindWardenCiUpdateIntent(input.db, { tenantId: cycle.tenantId, updateId: update.id,
      intentDigest: digest, workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation,
      observedAt: dispatchAt });
    try { remote = await input.updateExactDraft(intent); }
    catch (error) {
      markWardenCiUpdateUncertain(input.db, { tenantId: cycle.tenantId, updateId: update.id,
        intentDigest: digest, observedAt: now() });
      throw error;
    }
  }
  if (!remote.draft || remote.number !== cycle.pullRequestNumber || remote.branch !== cycle.branchName ||
      remote.previousHeadSha !== cycle.currentHeadSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remote.commitSha)) {
    const current = getWardenCiUpdate(input.db, cycle.tenantId, update.id);
    if (current?.status === "intent_bound") markWardenCiUpdateUncertain(input.db, {
      tenantId: cycle.tenantId, updateId: update.id, intentDigest: digest, observedAt: now(),
    });
    throw new Error("warden_ci_update_result_invalid");
  }
  const completedAt = now();
  input.db.raw.exec("BEGIN IMMEDIATE");
  try {
    completeWardenCiUpdate(input.db, { tenantId: cycle.tenantId, updateId: update.id,
      expectedHeadSha: cycle.currentHeadSha, commitSha: remote.commitSha, observedAt: completedAt });
    if (!completeJob(input.db, input.job.id, { updateId: update.id, cycleId: cycle.id, commitSha: remote.commitSha,
      pullRequestNumber: remote.number, pullRequestUrl: remote.url }, completedAt,
    { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation })) {
      throw new Error("warden_ci_update_lease_lost");
    }
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    const current = getWardenCiUpdate(input.db, cycle.tenantId, update.id);
    if (current?.status === "intent_bound") markWardenCiUpdateUncertain(input.db, {
      tenantId: cycle.tenantId, updateId: update.id, intentDigest: digest, observedAt: now(),
    });
    throw error;
  }
  return Object.freeze({ status: "updated" as const, updateId: update.id, cycleId: cycle.id,
    commitSha: remote.commitSha, pullRequestNumber: remote.number, pullRequestUrl: remote.url });
}
