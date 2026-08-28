/**
 * Live-path bridge from `jobs` / `agent_runs` onto MissionTask (D3) and from a
 * settled Fettler run onto execution-cost `mission_id` (MCU rollup).
 *
 * A job without a bound mission is a no-op — the Fettler → mission enrollment
 * gap stays visible rather than being papered over with a fabricated mission.
 * When a mission id is claimed on the payload but the row is missing, fail
 * closed. Usage-ledger hashes are untouched; attribution uses the existing
 * execution-cost `mission_id` column.
 */
import { createHash } from "node:crypto";
import {
  ensureMissionTaskForJob,
  getMissionTask,
  getMission,
  insertPrincipal,
  listRepositorySnapshots,
  missionTaskIdForJob,
  openTaskHandoff,
  recordExecutionCostFromRoutingLedger,
  resolveMissionForFettlerCampaign,
  resolveMissionForRegaugeCampaign,
  transitionMissionTask,
  type ActualExecutionCostEntry,
  type AppDb,
  type Mission,
  type MissionTask,
  type MissionTaskRisk,
} from "@mendpoint/db";

export type BridgedJob = Readonly<{
  id: string;
  tenant_id: string;
  type: string;
  payload_json: string;
}>;

function payloadRecord(job: BridgedJob): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(job.payload_json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function textField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseRisk(value: unknown): MissionTaskRisk {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  return "medium";
}

function resumeTaskEvent(jobId: string, revision: number): { eventId: string; idempotencyKey: string } {
  const digest = createHash("sha256")
    .update(`mission-task:job:${jobId}:agent_working_from_resume:r${revision}`)
    .digest("hex")
    .slice(0, 32);
  return {
    eventId: `e-mtask-${digest}`,
    idempotencyKey: `mission-task-job:${jobId}:agent_working_from_resume:r${revision}`,
  };
}
function missionTaskAgentPrincipal(db: AppDb, tenantId: string, createdAt: string) {
  const id = `principal-mtask-agent-${createHash("sha256").update(tenantId).digest("hex").slice(0, 24)}`;
  return insertPrincipal(db, {
    id,
    tenantId,
    kind: "service",
    subject: "mission-task-agent",
    displayName: "Mission task agent",
    createdAt,
  });
}

/**
 * Resolve the mission a job is bound to, if any. `missionId` on the payload is
 * a claimed binding (missing row fails closed). A `campaignId` is only a hint:
 * resolve through the Fettler/ReGauge campaign FK and skip when nothing is
 * linked — that is the enrollment gap, not a fabricated mission.
 */
export function resolveBoundMissionForJob(db: AppDb, job: BridgedJob): Mission | undefined {
  const payload = payloadRecord(job);
  const missionId = textField(payload, "missionId");
  if (missionId) {
    const mission = getMission(db, job.tenant_id, missionId);
    if (!mission) throw new Error("mission_task_job_mission_not_found");
    return mission;
  }
  const campaignId = textField(payload, "campaignId")
    ?? textField(payload, "fettlerCampaignId")
    ?? textField(payload, "regaugeCampaignId");
  if (!campaignId) return undefined;
  return resolveMissionForFettlerCampaign(db, job.tenant_id, campaignId)
    ?? resolveMissionForRegaugeCampaign(db, job.tenant_id, campaignId);
}

/** Create-or-drive the MissionTask for a claimed job. No-op when unbound. */
export function bridgeClaimedJobToMissionTask(
  db: AppDb,
  job: BridgedJob,
  createdAt: string,
): MissionTask | undefined {
  const mission = resolveBoundMissionForJob(db, job);
  if (!mission) return undefined;
  const agent = missionTaskAgentPrincipal(db, job.tenant_id, createdAt);
  const payload = payloadRecord(job);
  const task = ensureMissionTaskForJob(db, {
    tenantId: job.tenant_id,
    jobId: job.id,
    missionId: mission.id,
    taskType: job.type,
    acceptanceCriteria: `Complete job ${job.id} (${job.type}) under mission ${mission.id}.`,
    risk: parseRisk(payload?.risk),
    actorPrincipalId: mission.ownerPrincipalId,
    assignedPrincipalId: agent.id,
    createdAt,
    correlationId: job.id,
  });
  if (task.status !== "agent_resume") return task;
  return transitionMissionTask(db, {
    tenantId: job.tenant_id,
    taskId: task.id,
    expectedRevision: task.revision,
    to: "agent_working",
    actorPrincipalId: agent.id,
    assignedPrincipalId: agent.id,
    ...resumeTaskEvent(job.id, task.revision),
    correlationId: job.id,
    createdAt,
  });
}

/**
 * Hand a successfully settled review-first job to a human without leaving its
 * durable MissionTask in agent_working. Call this in the same transaction as
 * job completion so a crash cannot commit only one side of the lifecycle.
 */
export function handoffCompletedJobToMissionReview(
  db: AppDb,
  job: BridgedJob,
  createdAt: string,
): MissionTask | undefined {
  const mission = resolveBoundMissionForJob(db, job);
  if (!mission) return undefined;
  const task = bridgeClaimedJobToMissionTask(db, job, createdAt)
    ?? getMissionTask(db, job.tenant_id, missionTaskIdForJob(job.id));
  if (!task) throw new Error("mission_task_job_review_task_missing");
  if (task.status === "human_review_required") return task;
  if (task.status !== "agent_working" || !task.assignedPrincipalId) {
    throw new Error("mission_task_job_review_transition_invalid");
  }
  const snapshot = mission.snapshotId && mission.repositoryId
    ? listRepositorySnapshots(db, job.tenant_id, mission.repositoryId)
      .find((row) => row.id === mission.snapshotId)
    : undefined;
  openTaskHandoff(db, {
    tenantId: job.tenant_id,
    missionId: mission.id,
    taskId: task.id,
    reason: "architecture_decision_required",
    question:
      `Should job ${job.id} (${job.type}) under mission ${mission.id}` +
      ` proceed after advisory verification passed?`,
    context:
      `Review-first job ${job.id} settled successfully. ` +
      `Human approval is required before treating verification as delivery.`,
    ownerPrincipalId: task.assignedPrincipalId,
    ...(snapshot ? { observedAgainst: { snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha } } : {}),
    correlationId: job.id,
    createdAt,
  });
  return getMissionTask(db, job.tenant_id, task.id);
}

/**
 * Attribute a settled run's routing-ledger cost to its bound mission. No-op
 * when unbound. Best-effort at the call site: a completed job must not be
 * un-completed because cost rollup failed. Does not write the usage ledger.
 */
export function recordBoundMissionExecutionCost(
  db: AppDb,
  input: Readonly<{
    job: BridgedJob;
    sourceRunId: string;
    createdAt: string;
    outcomeStatus?: "accepted" | "rejected" | "unresolved";
  }>,
): ActualExecutionCostEntry | undefined {
  const mission = resolveBoundMissionForJob(db, input.job);
  if (!mission) return undefined;
  const payload = payloadRecord(input.job);
  return recordExecutionCostFromRoutingLedger(db, {
    tenantId: input.job.tenant_id,
    sourceRunId: input.sourceRunId,
    executionId: input.job.id,
    taskId: missionTaskIdForJob(input.job.id),
    taskClass: input.job.type,
    route: mission.product,
    campaignId: mission.fettlerCampaignId ?? mission.regaugeCampaignId
      ?? textField(payload, "campaignId") ?? null,
    missionId: mission.id,
    actorPrincipalId: mission.ownerPrincipalId,
    createdAt: input.createdAt,
    outcomeStatus: input.outcomeStatus ?? "unresolved",
  });
}
