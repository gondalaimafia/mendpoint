import { createHash } from "node:crypto";
import {
  authorizeWardenCiUpdateIntent,
  beginMissionMutationRemoteCall,
  completeJob,
  completeWardenCiUpdate,
  assertMissionMutationAuthority,
  getAgentRun,
  getJob,
  getWardenCiCycle,
  getWardenCiUpdate,
  markWardenCiUpdateUncertain,
  markMissionMutationDispatchUncertain,
  parseMissionMutationAuthority,
  reconcileWardenCiUpdateNotApplied,
  refreshMissionMutationAuthority,
  settleMissionMutationDispatch,
  type AppDb,
  type JobRow,
  type MissionMutationAuthorityV1,
} from "@mendpoint/db";
import type { ExactDraftObservation, ExactDraftObservationInput, ExactDraftUpdateInput,
  ExactDraftUpdateReconciliation, ExactDraftUpdateResult } from "@mendpoint/github";
import { wardenReviewFeedbackDigest } from "./warden-candidate-observation.js";

const JOB_TYPE = "warden.candidate.update";

class WardenCandidateUpdateOutcomeUncertainError extends Error {
  readonly remoteSideEffectUncertain = true;

  constructor(readonly cause: unknown, message?: string) {
    super(message ?? (cause instanceof Error ? cause.message : String(cause)));
    this.name = "WardenCandidateUpdateOutcomeUncertainError";
  }
}

export type WardenCandidateUpdateInput = Readonly<{
  db: AppDb;
  job: JobRow;
  updateExactDraft: (input: ExactDraftUpdateInput) => Promise<ExactDraftUpdateResult>;
  reconcileExactDraftUpdate: (input: ExactDraftUpdateInput) => Promise<ExactDraftUpdateReconciliation>;
  observeExactDraft?: (input: ExactDraftObservationInput) => Promise<ExactDraftObservation>;
  readApprovalArtifact: (input: Readonly<{ tenantId: string; path: string; sha256: string }>) => Record<string, unknown>;
  resolveRepository: (input: Readonly<{ tenantId: string; repositoryId: string; installationId: number;
    remoteRepositoryId: number }>) => Readonly<{ owner: string; repo: string }> |
      Promise<Readonly<{ owner: string; repo: string }>>;
  now?: () => string;
  beforeRemoteDispatch?: () => void;
}>;

function payload(job: JobRow): Readonly<{
  cycleId: string; updateId: string; missionId: string | null;
  missionAuthority: MissionMutationAuthorityV1 | null;
}> {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); } catch { throw new Error("warden_ci_update_payload_invalid"); }
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).cycleId !== "string" ||
      typeof (value as Record<string, unknown>).updateId !== "string") throw new Error("warden_ci_update_payload_invalid");
  return Object.freeze({ cycleId: String((value as Record<string, unknown>).cycleId),
    updateId: String((value as Record<string, unknown>).updateId),
    missionId: typeof (value as Record<string, unknown>).missionId === "string" &&
        String((value as Record<string, unknown>).missionId).trim()
      ? String((value as Record<string, unknown>).missionId)
      : null,
    missionAuthority: (value as Record<string, unknown>).missionAuthority === undefined ? null
      : parseMissionMutationAuthority((value as Record<string, unknown>).missionAuthority) });
}

function sourceMissionId(db: AppDb, tenantId: string, jobId: string | null): string | null {
  const sourceJob = jobId ? getJob(db, jobId, tenantId) : undefined;
  if (!sourceJob) return null;
  let value: unknown;
  try { value = JSON.parse(sourceJob.payload_json); } catch { throw new Error("warden_ci_update_source_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("warden_ci_update_source_invalid");
  return typeof (value as Record<string, unknown>).missionId === "string"
    ? String((value as Record<string, unknown>).missionId)
    : null;
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
    if (typeof file.path !== "string") throw new Error("warden_ci_update_artifact_invalid");
    const entry = byPath.get(file.path);
    if (file.after === null && file.afterSha256 === null) {
      if (entry || typeof file.before !== "string" || typeof file.beforeSha256 !== "string") {
        throw new Error("warden_ci_update_artifact_invalid");
      }
      const before = Buffer.from(file.before, "base64");
      const beforeDigest = `sha256:${createHash("sha256").update(before).digest("hex")}`;
      if (before.toString("base64") !== file.before || beforeDigest !== file.beforeSha256 || before.includes(0)) {
        throw new Error("warden_ci_update_artifact_digest_mismatch");
      }
      return Object.freeze({ path: file.path, delete: true as const });
    }
    if (typeof file.after !== "string" || typeof file.afterSha256 !== "string") {
      throw new Error("warden_ci_update_artifact_invalid");
    }
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

function intentDigest(intent: ExactDraftUpdateInput, feedbackDigest: string | null): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ intent, feedbackDigest }), "utf8").digest("hex")}`;
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
  const claimedMissionId = sourceMissionId(input.db, cycle.tenantId, run.job_id);
  const authorityBindings = [parsed.missionId, claimedMissionId, update.missionAuthority?.missionId,
    cycle.missionAuthority?.missionId].filter((value): value is string => value !== null && value !== undefined);
  if (authorityBindings.length > 0 && !parsed.missionAuthority) {
    throw new Error("warden_ci_update_mission_authority_upgrade_required");
  }
  if (parsed.missionAuthority && (!parsed.missionId ||
      authorityBindings.some((missionId) => missionId !== parsed.missionAuthority!.missionId) ||
      (update.missionAuthority && JSON.stringify(update.missionAuthority) !== JSON.stringify(parsed.missionAuthority)) ||
      (cycle.missionAuthority && JSON.stringify(cycle.missionAuthority) !== JSON.stringify(parsed.missionAuthority)))) {
    throw new Error("warden_ci_update_mission_authority_required");
  }
  const assertMutationAuthority = () => {
    if (parsed.missionAuthority) assertMissionMutationAuthority(input.db, cycle.tenantId,
      parsed.missionAuthority, { allowClaimedTask: true, requireNoBlocking: true });
  };
  assertMutationAuthority();
  const artifact = input.readApprovalArtifact({ tenantId: cycle.tenantId, path: update.sealedPath,
    sha256: update.sealedSha256 });
  assertArtifact(artifact, { tenantId: cycle.tenantId, repositoryId: cycle.repositoryId,
    snapshotId: source.snapshotId, baseBranch: cycle.baseBranch, expectedHeadSha: cycle.currentHeadSha,
    reviewerPrincipalId: update.reviewerPrincipalId, rationale: update.rationale });
  const repository = await input.resolveRepository({ tenantId: cycle.tenantId, repositoryId: cycle.repositoryId,
    installationId: cycle.installationId, remoteRepositoryId: cycle.remoteRepositoryId });
  assertMutationAuthority();
  const intent = Object.freeze({ owner: repository.owner, repo: repository.repo,
    expectedRepositoryId: cycle.remoteRepositoryId, pullRequestNumber: cycle.pullRequestNumber,
    baseBranch: cycle.baseBranch, branch: cycle.branchName, expectedHeadSha: cycle.currentHeadSha,
    commitMessage: `Apply approved Fettler CI repair ${update.repairRunId}`,
    commitDate: update.requestedAt, files: files(artifact) }) satisfies ExactDraftUpdateInput;
  const now = input.now ?? (() => new Date().toISOString());
  const preflightAt = now();
  const currentCycle = getWardenCiCycle(input.db, cycle.tenantId, cycle.id);
  const fence = input.db.raw.prepare(`SELECT status, lease_owner, lease_generation, lease_expires_at FROM jobs
    WHERE id = ? AND tenant_id = ?`).get(input.job.id, cycle.tenantId) as Record<string, unknown> | undefined;
  if (!currentCycle || (currentCycle.status !== "update_pending" && !reconciliationOnly) ||
      currentCycle.currentHeadSha !== update.expectedHeadSha ||
      fence?.status !== "running" || fence.lease_owner !== input.job.lease_owner ||
      fence.lease_generation !== input.job.lease_generation || typeof fence.lease_expires_at !== "string" ||
      fence.lease_expires_at <= preflightAt) throw new Error("warden_ci_update_not_authorized");
  const digest = intentDigest(intent, update.expectedFeedbackDigest);
  const markRemoteOutcomeUncertain = (error: unknown, message?: string) => {
    const owns = !input.db.raw.isTransaction;
    if (owns) input.db.raw.exec("BEGIN IMMEDIATE");
    try {
      const observedAt = now();
      if (parsed.missionAuthority) {
        const mutation = input.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
          WHERE tenant_id = ? AND job_id = ?`).get(cycle.tenantId, input.job.id) as { state: string } | undefined;
        if (mutation?.state === "dispatching") markMissionMutationDispatchUncertain(input.db, {
          tenantId: cycle.tenantId, jobId: input.job.id, intentDigest: digest, observedAt,
        });
      }
      const current = getWardenCiUpdate(input.db, cycle.tenantId, update.id);
      if (current?.status === "intent_bound") markWardenCiUpdateUncertain(input.db, {
        tenantId: cycle.tenantId, updateId: update.id, intentDigest: digest, observedAt,
      });
      if (owns) input.db.raw.exec("COMMIT");
      return new WardenCandidateUpdateOutcomeUncertainError(error, message);
    } catch (markError) {
      if (owns && input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
      return new WardenCandidateUpdateOutcomeUncertainError(markError, message);
    }
  };
  const assertCurrentFeedback = async () => {
    if (!update.expectedFeedbackDigest) return;
    if (!input.observeExactDraft) throw new Error("warden_ci_review_observer_required");
    const observed = await input.observeExactDraft({ owner: repository.owner, repo: repository.repo,
      pullRequestNumber: cycle.pullRequestNumber, expectedBaseBranch: cycle.baseBranch,
      expectedBaseSha: cycle.baseRevision, expectedHeadBranch: cycle.branchName,
      expectedHeadSha: cycle.currentHeadSha, expectedRepositoryId: cycle.remoteRepositoryId,
      requireExactDraft: true, includeCommitStatuses: false });
    if (observed.state !== "draft" || observed.headRevision !== cycle.currentHeadSha ||
        wardenReviewFeedbackDigest(observed) !== update.expectedFeedbackDigest) {
      throw new Error("warden_ci_review_feedback_drift");
    }
  };
  const dispatchFreshUpdate = async (): Promise<ExactDraftUpdateResult> => {
    await assertCurrentFeedback();
    assertMutationAuthority();
    const authorizationAt = now();
    authorizeWardenCiUpdateIntent(input.db, {
      tenantId: cycle.tenantId,
      updateId: update.id,
      intentDigest: digest,
      workerId: input.job.lease_owner!,
      leaseGeneration: input.job.lease_generation,
      observedAt: authorizationAt,
      missionAuthority: parsed.missionAuthority,
    });
    input.beforeRemoteDispatch?.();
    if (parsed.missionAuthority) beginMissionMutationRemoteCall(input.db, {
      tenantId: cycle.tenantId,
      jobId: input.job.id,
      authority: parsed.missionAuthority,
      intentDigest: digest,
      workerId: input.job.lease_owner!,
      leaseGeneration: input.job.lease_generation,
      observedAt: now(),
    });
    try { return await input.updateExactDraft(intent); }
    catch (error) { throw markRemoteOutcomeUncertain(error); }
  };
  let remote: ExactDraftUpdateResult;
  if (reconciliationRequired) {
    const dispatch = parsed.missionAuthority
      ? input.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
          WHERE tenant_id = ? AND job_id = ?`).get(cycle.tenantId, input.job.id) as { state: string } | undefined
      : undefined;
    // `intent_bound` is written before the durable remote-begin marker. When a
    // Mission-bound retry still has an authorized dispatch, the prior worker
    // provably crashed before GitHub could be called. Re-arm and dispatch the
    // same exact intent; do not manufacture uncertainty or perform a needless
    // remote reconciliation for work that never began.
    if (update.status === "intent_bound" && dispatch?.state === "authorized") {
      remote = await dispatchFreshUpdate();
    } else {
      if (update.status === "intent_bound") {
        markWardenCiUpdateUncertain(input.db, { tenantId: cycle.tenantId, updateId: update.id,
          intentDigest: digest, observedAt: preflightAt });
        if (parsed.missionAuthority && dispatch?.state === "dispatching") {
          markMissionMutationDispatchUncertain(input.db, {
            tenantId: cycle.tenantId, jobId: input.job.id, intentDigest: digest, observedAt: preflightAt,
          });
        }
      }
      let reconciliation: ExactDraftUpdateReconciliation;
      try { reconciliation = await input.reconcileExactDraftUpdate(intent); }
      catch (error) { throw markRemoteOutcomeUncertain(error); }
      if (reconciliation.status === "unknown") {
        throw markRemoteOutcomeUncertain(null, "warden_ci_update_outcome_uncertain");
      }
      if (reconciliation.status === "applied") {
        remote = reconciliation.result;
      } else {
        reconcileWardenCiUpdateNotApplied(input.db, {
          tenantId: cycle.tenantId,
          updateId: update.id,
          jobId: input.job.id,
          intentDigest: digest,
          observedAt: now(),
        });
        remote = await dispatchFreshUpdate();
      }
    }
  } else {
    remote = await dispatchFreshUpdate();
  }
  if (!remote.draft || remote.number !== cycle.pullRequestNumber || remote.branch !== cycle.branchName ||
      remote.previousHeadSha !== cycle.currentHeadSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remote.commitSha)) {
    throw markRemoteOutcomeUncertain(null, "warden_ci_update_result_invalid");
  }
  const completedAt = now();
  input.db.raw.exec("BEGIN IMMEDIATE");
  try {
    const freshMissionAuthority = parsed.missionAuthority
      ? refreshMissionMutationAuthority(input.db, cycle.tenantId, parsed.missionAuthority,
        { allowClaimedTask: true, requireNoBlocking: true })
      : null;
    completeWardenCiUpdate(input.db, { tenantId: cycle.tenantId, updateId: update.id,
      expectedHeadSha: cycle.currentHeadSha, commitSha: remote.commitSha, observedAt: completedAt,
      ...(freshMissionAuthority ? { missionAuthority: freshMissionAuthority } : {}) });
    if (!completeJob(input.db, input.job.id, { updateId: update.id, cycleId: cycle.id, commitSha: remote.commitSha,
      pullRequestNumber: remote.number, pullRequestUrl: remote.url }, completedAt,
    { workerId: input.job.lease_owner, leaseGeneration: input.job.lease_generation })) {
      throw new Error("warden_ci_update_lease_lost");
    }
    if (parsed.missionAuthority) settleMissionMutationDispatch(input.db, {
      tenantId: cycle.tenantId, jobId: input.job.id, intentDigest: digest, observedAt: completedAt,
    });
    input.db.raw.exec("COMMIT");
  } catch (error) {
    if (input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw markRemoteOutcomeUncertain(error);
  }
  return Object.freeze({ status: "updated" as const, updateId: update.id, cycleId: cycle.id,
    commitSha: remote.commitSha, pullRequestNumber: remote.number, pullRequestUrl: remote.url });
}
