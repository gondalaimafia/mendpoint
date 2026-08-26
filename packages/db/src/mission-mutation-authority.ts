import type { AppDb } from "./index.js";
import { evaluateMissionExceptions } from "./mission-exceptions.js";
import { fettlerCampaignMissionTaskId, getMissionTask, type MissionTask } from "./mission-task.js";
import { getMission, type Mission, type MissionState } from "./mission.js";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ACTIVE_MISSION_STATES = new Set<MissionState>([
  "created", "discovering", "scoped", "planning", "executing", "verifying", "awaiting_review",
]);

export type MissionMutationAuthorityV1 = Readonly<{
  schemaVersion: 1;
  missionId: string;
  missionRevision: number;
  missionState: MissionState;
  taskId: string | null;
  taskRevision: number | null;
  taskStatus: MissionTask["status"] | null;
  repositoryId: string;
  snapshotId: string;
  resolvedSha: string;
}>;

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(code);
  }
  return value;
}

export function parseMissionMutationAuthority(value: unknown): MissionMutationAuthorityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mission_mutation_authority_invalid");
  }
  const record = value as Record<string, unknown>;
  const missionStates = new Set<MissionState>([
    "created", "discovering", "scoped", "planning", "executing", "verifying", "awaiting_review",
    "accepted", "rejected", "partial", "failed", "cancelled",
  ]);
  const taskStatuses = new Set<MissionTask["status"]>([
    "unassigned", "agent_assigned", "agent_working", "human_review_required", "human_assigned",
    "human_working", "agent_resume", "complete", "blocked", "failed", "cancelled", "escalated",
  ]);
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.missionRevision) ||
      Number(record.missionRevision) < 1 || !missionStates.has(record.missionState as MissionState) ||
      typeof record.resolvedSha !== "string" || !SHA.test(record.resolvedSha)) {
    throw new Error("mission_mutation_authority_invalid");
  }
  const taskId = record.taskId === null ? null : identifier(record.taskId, "mission_mutation_authority_invalid");
  const taskRevision = record.taskRevision;
  const taskStatus = record.taskStatus;
  if ((taskId === null && (taskRevision !== null || taskStatus !== null)) ||
      (taskId !== null && (!Number.isSafeInteger(taskRevision) || Number(taskRevision) < 1 ||
        !taskStatuses.has(taskStatus as MissionTask["status"])))) {
    throw new Error("mission_mutation_authority_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    missionId: identifier(record.missionId, "mission_mutation_authority_invalid"),
    missionRevision: Number(record.missionRevision),
    missionState: record.missionState as MissionState,
    taskId,
    taskRevision: taskId === null ? null : Number(taskRevision),
    taskStatus: taskId === null ? null : taskStatus as MissionTask["status"],
    repositoryId: identifier(record.repositoryId, "mission_mutation_authority_invalid"),
    snapshotId: identifier(record.snapshotId, "mission_mutation_authority_invalid"),
    resolvedSha: record.resolvedSha,
  });
}

export function createMissionMutationAuthority(input: Readonly<{
  mission: Mission;
  task: MissionTask | null;
  repositoryId: string;
  snapshotId: string;
  resolvedSha: string;
}>): MissionMutationAuthorityV1 {
  return parseMissionMutationAuthority({
    schemaVersion: 1,
    missionId: input.mission.id,
    missionRevision: input.mission.revision,
    missionState: input.mission.state,
    taskId: input.task?.id ?? null,
    taskRevision: input.task?.revision ?? null,
    taskStatus: input.task?.status ?? null,
    repositoryId: input.repositoryId,
    snapshotId: input.snapshotId,
    resolvedSha: input.resolvedSha,
  });
}

export function assertMissionMutationAuthority(
  db: AppDb,
  tenantId: string,
  value: MissionMutationAuthorityV1,
  options: Readonly<{ requireNoBlocking?: boolean; allowClaimedTask?: boolean; allowSettledTask?: boolean }> = {},
): Readonly<{ mission: Mission; task: MissionTask | null }> {
  const authority = parseMissionMutationAuthority(value);
  const mission = getMission(db, tenantId, authority.missionId);
  if (!mission || mission.product !== "fettler" || !ACTIVE_MISSION_STATES.has(mission.state) ||
      mission.revision !== authority.missionRevision || mission.state !== authority.missionState ||
      mission.repositoryId !== authority.repositoryId || mission.snapshotId !== authority.snapshotId) {
    throw new Error("mission_mutation_authority_stale");
  }
  const snapshot = db.raw.prepare(`SELECT resolved_sha FROM repository_snapshots
    WHERE id = ? AND tenant_id = ? AND repository_id = ?`).get(
    authority.snapshotId, tenantId, authority.repositoryId,
  ) as { resolved_sha: string } | undefined;
  if (!snapshot || snapshot.resolved_sha !== authority.resolvedSha) {
    throw new Error("mission_mutation_authority_stale");
  }
  const task = authority.taskId ? getMissionTask(db, tenantId, authority.taskId) ?? null : null;
  if (!authority.taskId && getMissionTask(db, tenantId,
    fettlerCampaignMissionTaskId(authority.missionId, authority.repositoryId))) {
    throw new Error("mission_mutation_authority_stale");
  }
  const exactTask = task && task.missionId === mission.id && task.revision === authority.taskRevision &&
    task.status === authority.taskStatus;
  const claimedTask = options.allowClaimedTask && task && authority.taskStatus === "agent_resume" &&
    task.missionId === mission.id && task.revision === Number(authority.taskRevision) + 1 &&
    task.status === "agent_working";
  const settledTask = options.allowSettledTask && task && task.missionId === mission.id &&
    task.status === "complete" && (
      (authority.taskStatus === "agent_resume" && task.revision === Number(authority.taskRevision) + 2) ||
      (authority.taskStatus === "agent_working" && task.revision === Number(authority.taskRevision) + 1)
    );
  if (authority.taskId && !exactTask && !claimedTask && !settledTask) {
    throw new Error("mission_mutation_authority_stale");
  }
  if (options.requireNoBlocking && evaluateMissionExceptions(db, tenantId, mission.id, {
    snapshotId: authority.snapshotId,
    resolvedSha: authority.resolvedSha,
  }).missionBlocked) {
    throw new Error("mission_mutation_authority_blocked");
  }
  return Object.freeze({ mission, task });
}

export function refreshMissionMutationAuthority(
  db: AppDb,
  tenantId: string,
  value: MissionMutationAuthorityV1,
  options: Readonly<{
    requireNoBlocking?: boolean; allowClaimedTask?: boolean; allowSettledTask?: boolean;
  }> = {},
): MissionMutationAuthorityV1 {
  const prior = parseMissionMutationAuthority(value);
  const current = assertMissionMutationAuthority(db, tenantId, prior, options);
  return createMissionMutationAuthority({
    mission: current.mission,
    task: current.task,
    repositoryId: prior.repositoryId,
    snapshotId: prior.snapshotId,
    resolvedSha: prior.resolvedSha,
  });
}
