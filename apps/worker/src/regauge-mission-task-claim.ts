/**
 * Live-path driver from a ReGauge pilot-lane claim onto the MissionTask the
 * launch seam created (spec §6.8). The worker never imports `apps/api`; both
 * sides share `regaugeLaunchMissionTaskId` from `@mendpoint/db`.
 *
 * Unbound campaigns and pre-launch tasks are a no-op — the enrollment gap
 * stays visible rather than being papered over with a fabricated Mission.
 * A claimed lease must still run if the task is missing or already driven.
 * A completed attempt must still stay completed if the review handoff misses.
 */
import { createHash } from "node:crypto";
import {
  getMission,
  getMissionTask,
  insertPrincipal,
  listRepositorySnapshots,
  openTaskHandoff,
  regaugeLaunchMissionTaskId,
  resolveMissionForRegaugeCampaign,
  transitionMissionTask,
  type AppDb,
  type MissionTask,
} from "@mendpoint/db";

export type RegaugeMissionTaskClaimInput = Readonly<{
  tenantId: string;
  campaignId: string;
  repositoryId: string;
  createdAt: string;
}>;

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
 * Resolve the launch task for a claimed repo-scoped unit, scoped to that
 * repository only. A repo-scoped claim must never fall back to the mission-level
 * catch-all: launch writes that catch-all only when the campaign had no
 * repository scope, so falling back would funnel every repository onto the same
 * single row — the first complete would hand the whole Mission to review while
 * its siblings are still `agent_working`. A missing repo task stays a visible
 * launch gap, never a silently shared row.
 */
function resolveLaunchTask(
  db: AppDb,
  tenantId: string,
  missionId: string,
  repositoryId: string,
): MissionTask | undefined {
  return getMissionTask(db, tenantId, regaugeLaunchMissionTaskId(missionId, repositoryId));
}

function resolveClaimedTask(
  db: AppDb,
  input: RegaugeMissionTaskClaimInput,
): MissionTask | undefined {
  const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
  if (!mission) return undefined;
  return resolveLaunchTask(db, input.tenantId, mission.id, input.repositoryId);
}

/**
 * Assign and start the launch-created MissionTask for a claimed ReGauge unit.
 * No-op when the campaign has no Mission or the launch task does not exist.
 * Idempotent once the task is already `agent_assigned` / `agent_working`.
 */
export function assignRegaugeMissionTaskOnClaim(
  db: AppDb,
  input: RegaugeMissionTaskClaimInput,
): MissionTask | undefined {
  const task = resolveClaimedTask(db, input);
  if (!task) return undefined;
  if (task.status === "agent_working") return task;
  const agent = missionTaskAgentPrincipal(db, input.tenantId, input.createdAt);
  if (task.status === "agent_resume") {
    return transitionMissionTask(db, {
      tenantId: input.tenantId,
      taskId: task.id,
      expectedRevision: task.revision,
      to: "agent_working",
      actorPrincipalId: agent.id,
      assignedPrincipalId: agent.id,
      eventId: `${task.id}-claim-resume`,
      idempotencyKey: `mission-task-claim-resume-${task.id}`,
      correlationId: input.campaignId,
      createdAt: input.createdAt,
    });
  }
  if (task.status !== "unassigned" && task.status !== "agent_assigned") return undefined;
  let current = task;
  if (current.status === "unassigned") {
    current = transitionMissionTask(db, {
      tenantId: input.tenantId,
      taskId: current.id,
      expectedRevision: current.revision,
      to: "agent_assigned",
      actorPrincipalId: agent.id,
      assignedPrincipalId: agent.id,
      eventId: `${current.id}-claim-assigned`,
      idempotencyKey: `mission-task-claim-assigned-${current.id}`,
      correlationId: input.campaignId,
      createdAt: input.createdAt,
    });
  }
  if (current.status === "agent_assigned") {
    current = transitionMissionTask(db, {
      tenantId: input.tenantId,
      taskId: current.id,
      expectedRevision: current.revision,
      to: "agent_working",
      actorPrincipalId: agent.id,
      assignedPrincipalId: agent.id,
      eventId: `${current.id}-claim-working`,
      idempotencyKey: `mission-task-claim-working-${current.id}`,
      correlationId: input.campaignId,
      createdAt: input.createdAt,
    });
  }
  return current;
}

/**
 * After a successful pilot-lane complete, hand the MissionTask to humans
 * through `openTaskHandoff` (blocking exception + MissionTask in one
 * transaction). The live ReGauge path is review-first: verification passing
 * is not delivery. No-op when unbound or the task is not on the claimed
 * working path. A generic "please review" is refused by the store.
 */
export function handoffRegaugeMissionTaskOnReview(
  db: AppDb,
  input: RegaugeMissionTaskClaimInput,
): MissionTask | undefined {
  const task = resolveClaimedTask(db, input);
  if (!task) return undefined;
  if (task.status === "human_review_required") return task;
  if (task.status !== "agent_working") return undefined;
  if (!task.assignedPrincipalId) throw new Error("mission_task_review_actor_unknown");
  const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
  const snapshot = mission?.snapshotId && mission.repositoryId
    ? listRepositorySnapshots(db, input.tenantId, mission.repositoryId)
      .find((row) => row.id === mission.snapshotId)
    : undefined;
  openTaskHandoff(db, {
    tenantId: input.tenantId,
    missionId: task.missionId,
    taskId: task.id,
    reason: "architecture_decision_required",
    question:
      `Should ReGauge campaign ${input.campaignId} repository ${input.repositoryId}` +
      `${mission?.snapshotId ? ` snapshot ${mission.snapshotId}` : ""}` +
      ` proceed after the pilot attempt passed verification?`,
    context:
      `ReGauge pilot-lane completeAttempt reached review for campaign ${input.campaignId}` +
      ` repository ${input.repositoryId}. Verification passing is not delivery.`,
    ownerPrincipalId: task.assignedPrincipalId,
    ...(snapshot ? { observedAgainst: { snapshotId: snapshot.id, resolvedSha: snapshot.resolved_sha } } : {}),
    correlationId: input.campaignId,
    createdAt: input.createdAt,
  });
  return getMissionTask(db, input.tenantId, task.id);
}
