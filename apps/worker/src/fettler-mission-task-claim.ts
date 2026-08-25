/**
 * Live-path driver from a Fettler campaign-execute claim onto the MissionTask
 * enrollment created (spec §6.8). Both sides share `fettlerCampaignMissionTaskId`
 * from `@mendpoint/db`.
 *
 * Unbound campaigns and pre-enrollment tasks are a no-op. A claimed execute
 * job must still run if the task is missing or already driven.
 */
import { createHash } from "node:crypto";
import {
  fettlerCampaignMissionTaskId,
  getMissionTask,
  getWardenCampaignTarget,
  insertPrincipal,
  resolveMissionForFettlerCampaign,
  transitionMissionTask,
  type AppDb,
  type MissionTask,
} from "@mendpoint/db";

export type FettlerMissionTaskClaimInput = Readonly<{
  tenantId: string;
  campaignId: string;
  targetId: string;
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

function resolveEnrollmentTask(
  db: AppDb,
  tenantId: string,
  missionId: string,
  repositoryId: string,
): MissionTask | undefined {
  return getMissionTask(db, tenantId, fettlerCampaignMissionTaskId(missionId, repositoryId))
    ?? getMissionTask(db, tenantId, fettlerCampaignMissionTaskId(missionId));
}

/**
 * Assign and start the enrollment-created MissionTask for a claimed Fettler
 * target. No-op when the campaign has no Mission, target, or launch task.
 * Idempotent once the task is already `agent_assigned` / `agent_working`.
 */
export function assignFettlerMissionTaskOnClaim(
  db: AppDb,
  input: FettlerMissionTaskClaimInput,
): MissionTask | undefined {
  const task = resolveClaimedTask(db, input);
  if (!task) return undefined;
  if (task.status === "agent_working") return task;
  if (task.status !== "unassigned" && task.status !== "agent_assigned") return undefined;

  const agent = missionTaskAgentPrincipal(db, input.tenantId, input.createdAt);
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

function resolveClaimedTask(
  db: AppDb,
  input: FettlerMissionTaskClaimInput,
): MissionTask | undefined {
  const mission = resolveMissionForFettlerCampaign(db, input.tenantId, input.campaignId);
  if (!mission) return undefined;
  const target = getWardenCampaignTarget(db, input.tenantId, input.campaignId, input.targetId);
  if (!target) return undefined;
  return resolveEnrollmentTask(db, input.tenantId, mission.id, target.repositoryId);
}

/**
 * After a review-first campaign execute lands, hand the MissionTask to humans.
 * No-op when unbound or the task is not on the claimed working path.
 */
export function handoffFettlerMissionTaskOnReview(
  db: AppDb,
  input: FettlerMissionTaskClaimInput,
): MissionTask | undefined {
  const task = resolveClaimedTask(db, input);
  if (!task) return undefined;
  if (task.status === "human_review_required") return task;
  if (task.status !== "agent_working") return undefined;
  // A task only reaches agent_working through assignFettlerMissionTaskOnClaim,
  // which records the driving agent as the assignee. A missing assignee here means
  // the owner is unknown; refuse rather than mint a fresh principal that would
  // paper over "I do not know who owned this" and hand off under a fabricated actor.
  if (!task.assignedPrincipalId) throw new Error("mission_task_review_actor_unknown");
  return transitionMissionTask(db, {
    tenantId: input.tenantId,
    taskId: task.id,
    expectedRevision: task.revision,
    to: "human_review_required",
    actorPrincipalId: task.assignedPrincipalId,
    handoffReason: "campaign_execute_review",
    eventId: `${task.id}-claim-review`,
    idempotencyKey: `mission-task-claim-review-${task.id}`,
    correlationId: input.campaignId,
    createdAt: input.createdAt,
  });
}
