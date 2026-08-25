import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { appendDomainEvent } from "./trust.js";

// Shared Mission Task engine (spec §6.8). A MissionTask is the single work
// primitive agents and humans share, so work can move agent -> human -> agent
// without reconstructing Mission state. The task TRANSITIONS in place under
// optimistic concurrency (revision) — a change is fenced on the caller's expected
// revision, never a silent last-write-wins — and every transition appends a
// hash-chained domain event (the audit trail), mirroring the `mission` row.

export type MissionTaskOwner = "agent" | "human";
export type MissionTaskRisk = "low" | "medium" | "high" | "critical";

export type MissionTaskStatus =
  | "unassigned" | "agent_assigned" | "agent_working" | "human_review_required"
  | "human_assigned" | "human_working" | "agent_resume" | "complete"
  | "blocked" | "failed" | "cancelled" | "escalated";

export type MissionTask = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  taskType: string;
  acceptanceCriteria: string;
  risk: MissionTaskRisk;
  status: MissionTaskStatus;
  ownerType: MissionTaskOwner | null;
  assignedPrincipalId: string | null;
  handoffReason: string | null;
  retryCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

/**
 * Deterministic MissionTask id for a launched ReGauge Mission (or one of its
 * repos). Shared by the launch writer (API) and the claim driver (worker) so
 * both sides resolve the same row without the worker importing `apps/api`.
 */
export function regaugeLaunchMissionTaskId(missionId: string, repositoryId?: string): string {
  const material = repositoryId ? `${missionId}\0${repositoryId}` : missionId;
  return `mt-regauge-${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * Deterministic MissionTask id for a Fettler campaign Mission (or one of its
 * enrolled repositories). Shared by the enrollment writer and a later claim
 * driver so both sides resolve the same row.
 */
export function fettlerCampaignMissionTaskId(missionId: string, repositoryId?: string): string {
  const material = repositoryId ? `${missionId}\0${repositoryId}` : missionId;
  return `mt-fettler-${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24)}`;
}

type MissionTaskRow = {
  id: string; tenant_id: string; mission_id: string; task_type: string;
  acceptance_criteria: string; risk: MissionTaskRisk; status: MissionTaskStatus;
  owner_type: MissionTaskOwner | null; assigned_principal_id: string | null;
  handoff_reason: string | null; retry_count: number; revision: number;
  created_at: string; updated_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}
function all<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}
function required(name: string, value: string): string {
  const result = value.trim();
  if (!result || result.length > 2_000) throw new Error(`${name}_invalid`);
  return result;
}
function assertPrincipal(db: AppDb, tenantId: string, principalId: string) {
  if (!one(db, `SELECT id FROM principals WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`, [principalId, tenantId])) {
    throw new Error("mission_task_principal_tenant_mismatch");
  }
}
function hydrate(row: MissionTaskRow): MissionTask {
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, missionId: row.mission_id, taskType: row.task_type,
    acceptanceCriteria: row.acceptance_criteria, risk: row.risk, status: row.status,
    ownerType: row.owner_type, assignedPrincipalId: row.assigned_principal_id,
    handoffReason: row.handoff_reason, retryCount: row.retry_count, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}
function event(db: AppDb, input: { tenantId: string; taskId: string; actorPrincipalId: string;
  eventId: string; eventType: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; payload: unknown; createdAt: string }) {
  appendDomainEvent(db, { id: input.eventId, tenantId: input.tenantId, schemaVersion: 1,
    eventType: input.eventType, aggregateType: "mission_task", aggregateId: input.taskId,
    actorPrincipalId: input.actorPrincipalId, correlationId: input.correlationId,
    causationId: input.causationId ?? null, idempotencyKey: input.idempotencyKey,
    payload: input.payload, createdAt: input.createdAt });
}

// Legal transition table (spec §6.8). The nominal path is
// unassigned -> agent_assigned -> agent_working -> human_review_required ->
// human_assigned -> human_working -> agent_resume -> complete, with BLOCKED,
// FAILED, CANCELLED, and ESCALATED as branch/terminal states. CANCELLED is
// reachable from every non-terminal state; COMPLETE/FAILED/CANCELLED are terminal.
const transitions: Record<MissionTaskStatus, MissionTaskStatus[]> = {
  unassigned: ["agent_assigned", "human_assigned", "cancelled"],
  agent_assigned: ["agent_working", "blocked", "cancelled", "escalated"],
  agent_working: ["human_review_required", "complete", "blocked", "failed", "cancelled", "escalated"],
  human_review_required: ["human_assigned", "agent_resume", "cancelled", "escalated"],
  human_assigned: ["human_working", "agent_resume", "cancelled", "escalated"],
  human_working: ["agent_resume", "complete", "blocked", "cancelled", "escalated"],
  agent_resume: ["agent_working", "complete", "blocked", "cancelled"],
  blocked: ["agent_working", "human_assigned", "cancelled", "escalated"],
  escalated: ["human_assigned", "cancelled"],
  complete: [],
  failed: [],
  cancelled: [],
};

/** The owner implied by a status; terminal/unassigned states retain the prior owner. */
function ownerForStatus(status: MissionTaskStatus, prior: MissionTaskOwner | null): MissionTaskOwner | null {
  if (status.startsWith("agent")) return "agent";
  if (status.startsWith("human")) return "human";
  return prior;
}

/** A transition INTO agent_working from a re-entry state is a replan; count it. */
function isRetry(from: MissionTaskStatus, to: MissionTaskStatus): boolean {
  return to === "agent_working" && (from === "blocked" || from === "agent_resume");
}

export function createMissionTask(db: AppDb, input: {
  id: string; tenantId: string; missionId: string; taskType: string; acceptanceCriteria: string;
  risk: MissionTaskRisk; actorPrincipalId: string; eventId: string; idempotencyKey: string;
  correlationId: string; causationId?: string | null; createdAt: string;
}): MissionTask {
  required("mission_task_id", input.id);
  required("mission_task_type", input.taskType);
  const acceptanceCriteria = required("mission_task_acceptance_criteria", input.acceptanceCriteria);
  if (!["low", "medium", "high", "critical"].includes(input.risk)) throw new Error("mission_task_risk_invalid");
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<MissionTaskRow>(db, `SELECT * FROM mission_task WHERE id = ?`, [input.id]);
    if (existing) {
      const value = hydrate(existing);
      if (value.tenantId !== input.tenantId || value.missionId !== input.missionId ||
        value.taskType !== input.taskType || value.acceptanceCriteria !== acceptanceCriteria ||
        value.risk !== input.risk) {
        throw new Error("mission_task_id_conflict");
      }
      if (owns) db.raw.exec("COMMIT");
      return value;
    }
    if (!one(db, `SELECT id FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId])) {
      throw new Error("mission_task_mission_not_found");
    }
    db.raw.prepare(`INSERT INTO mission_task
      (id, tenant_id, mission_id, task_type, acceptance_criteria, risk, status, owner_type,
       assigned_principal_id, handoff_reason, retry_count, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'unassigned', NULL, NULL, NULL, 0, 1, ?, ?)`).run(
      input.id, input.tenantId, input.missionId, input.taskType, acceptanceCriteria, input.risk,
      input.createdAt, input.createdAt);
    event(db, { tenantId: input.tenantId, taskId: input.id, actorPrincipalId: input.actorPrincipalId,
      eventId: input.eventId, eventType: "mission_task.created", idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId, causationId: input.causationId,
      payload: { missionId: input.missionId, taskType: input.taskType, risk: input.risk, status: "unassigned" },
      createdAt: input.createdAt });
    const value = hydrate(one<MissionTaskRow>(db, `SELECT * FROM mission_task WHERE id = ? AND tenant_id = ?`, [input.id, input.tenantId])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) { if (owns) db.raw.exec("ROLLBACK"); throw error; }
}

/**
 * Transition a task, fencing on `expectedRevision` (optimistic concurrency). A
 * re-transition to the SAME status at the same expected revision is an idempotent
 * replay (returns unchanged). Assigning a human/agent owner is set on the row;
 * a handoff reason is recorded when crossing an agent<->human boundary; a replan
 * back to agent_working increments the retry counter. Illegal transitions and
 * stale revisions fail closed.
 */
export function transitionMissionTask(db: AppDb, input: {
  tenantId: string; taskId: string; expectedRevision: number; to: MissionTaskStatus;
  actorPrincipalId: string; assignedPrincipalId?: string | null; handoffReason?: string | null;
  eventId: string; idempotencyKey: string; correlationId: string; causationId?: string | null; createdAt: string;
}): MissionTask {
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  if (input.assignedPrincipalId) assertPrincipal(db, input.tenantId, input.assignedPrincipalId);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = one<MissionTaskRow>(db, `SELECT * FROM mission_task WHERE id = ? AND tenant_id = ?`, [input.taskId, input.tenantId]);
    if (!current) throw new Error("mission_task_not_found");
    if (current.revision !== input.expectedRevision) throw new Error("mission_task_revision_conflict");
    if (current.status === input.to) { if (owns) db.raw.exec("COMMIT"); return hydrate(current); }
    if (!transitions[current.status].includes(input.to)) throw new Error("mission_task_transition_invalid");
    const ownerType = ownerForStatus(input.to, current.owner_type);
    const assigned = input.assignedPrincipalId ?? current.assigned_principal_id;
    const handoffReason = input.handoffReason ?? current.handoff_reason;
    const retryCount = current.retry_count + (isRetry(current.status, input.to) ? 1 : 0);
    const changed = db.raw.prepare(`UPDATE mission_task
      SET status = ?, owner_type = ?, assigned_principal_id = ?, handoff_reason = ?, retry_count = ?,
          revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND revision = ?`).run(
      input.to, ownerType, assigned, handoffReason, retryCount, input.createdAt,
      input.taskId, input.tenantId, input.expectedRevision);
    if (Number(changed.changes) !== 1) throw new Error("mission_task_revision_conflict");
    event(db, { tenantId: input.tenantId, taskId: input.taskId, actorPrincipalId: input.actorPrincipalId,
      eventId: input.eventId, eventType: "mission_task.transitioned", idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId, causationId: input.causationId,
      payload: { from: current.status, to: input.to, ownerType, retryCount,
        previousRevision: current.revision, revision: current.revision + 1 }, createdAt: input.createdAt });
    const value = hydrate(one<MissionTaskRow>(db, `SELECT * FROM mission_task WHERE id = ? AND tenant_id = ?`, [input.taskId, input.tenantId])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) { if (owns) db.raw.exec("ROLLBACK"); throw error; }
}

export function getMissionTask(db: AppDb, tenantId: string, taskId: string): MissionTask | undefined {
  const row = one<MissionTaskRow>(db, `SELECT * FROM mission_task WHERE id = ? AND tenant_id = ?`, [taskId, tenantId]);
  return row ? hydrate(row) : undefined;
}

/** Stable MissionTask id for a jobs-row. Derived from the job id so a retry of
 * the same job reuses the task instead of minting a second work primitive. */
export function missionTaskIdForJob(jobId: string): string {
  return `mtask-job-${createHash("sha256").update(`mission-task:job:${jobId}`).digest("hex").slice(0, 32)}`;
}

function jobTaskEvent(jobId: string, kind: string): { eventId: string; idempotencyKey: string } {
  const digest = createHash("sha256").update(`mission-task:job:${jobId}:${kind}`).digest("hex").slice(0, 32);
  return { eventId: `e-mtask-${digest}`, idempotencyKey: `mission-task-job:${jobId}:${kind}` };
}

/**
 * Bridge a claimed `jobs` row onto the shared MissionTask engine (D3). Creates
 * the task (id derived from the job) if needed and drives
 * `unassigned → agent_assigned → agent_working` with owner=agent. Already-past
 * those states (handoff, terminal) are left alone — this never rewinds. Joins
 * an open transaction like `createMissionTask`.
 *
 * Callers must pass a real bound mission; this function does not invent one.
 */
export function ensureMissionTaskForJob(db: AppDb, input: {
  tenantId: string;
  jobId: string;
  missionId: string;
  taskType: string;
  acceptanceCriteria: string;
  risk: MissionTaskRisk;
  actorPrincipalId: string;
  assignedPrincipalId: string;
  createdAt: string;
  correlationId?: string;
}): MissionTask {
  required("mission_task_job_id", input.jobId);
  const id = missionTaskIdForJob(input.jobId);
  const correlationId = input.correlationId ?? input.jobId;
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    let task = getMissionTask(db, input.tenantId, id);
    if (!task) {
      task = createMissionTask(db, {
        id,
        tenantId: input.tenantId,
        missionId: input.missionId,
        taskType: input.taskType,
        acceptanceCriteria: input.acceptanceCriteria,
        risk: input.risk,
        actorPrincipalId: input.actorPrincipalId,
        ...jobTaskEvent(input.jobId, "created"),
        correlationId,
        createdAt: input.createdAt,
      });
    } else if (task.missionId !== input.missionId) {
      throw new Error("mission_task_job_mission_mismatch");
    }
    if (task.status === "unassigned") {
      // Dependency edges freeze when work leaves unassigned. Check readiness
      // while this IMMEDIATE transaction owns the write lock so an edge cannot
      // race between admission and the first transition.
      if (!missionTaskReady(db, input.tenantId, task.id)) {
        throw new Error("mission_task_dependencies_incomplete");
      }
      task = transitionMissionTask(db, {
        tenantId: input.tenantId,
        taskId: id,
        expectedRevision: task.revision,
        to: "agent_assigned",
        actorPrincipalId: input.actorPrincipalId,
        assignedPrincipalId: input.assignedPrincipalId,
        ...jobTaskEvent(input.jobId, "agent_assigned"),
        correlationId,
        createdAt: input.createdAt,
      });
    }
    if (task.status === "agent_assigned") {
      task = transitionMissionTask(db, {
        tenantId: input.tenantId,
        taskId: id,
        expectedRevision: task.revision,
        to: "agent_working",
        actorPrincipalId: input.actorPrincipalId,
        assignedPrincipalId: input.assignedPrincipalId,
        ...jobTaskEvent(input.jobId, "agent_working"),
        correlationId,
        createdAt: input.createdAt,
      });
    }
    if (owns) db.raw.exec("COMMIT");
    return task;
  } catch (error) { if (owns) db.raw.exec("ROLLBACK"); throw error; }
}

export function listMissionTasks(db: AppDb, tenantId: string, missionId: string): MissionTask[] {
  return all<MissionTaskRow>(db,
    `SELECT * FROM mission_task WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at, id`,
    [tenantId, missionId]).map(hydrate);
}

/**
 * Record a dependency (task depends_on prerequisite). Both must be tasks of the
 * same (tenant, mission); a self-edge is rejected, and a would-be cycle
 * (prerequisite already transitively depends on task) fails closed so the DAG
 * stays acyclic. Append-only and idempotent on the exact edge.
 */
export function addMissionTaskDependency(db: AppDb, input: {
  id: string; tenantId: string; missionId: string; taskId: string; dependsOnTaskId: string; createdAt: string;
}): void {
  if (input.taskId === input.dependsOnTaskId) throw new Error("mission_task_dependency_self");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    let dependentStatus: MissionTaskStatus | null = null;
    for (const id of [input.taskId, input.dependsOnTaskId]) {
      const row = one<{ mission_id: string; status: MissionTaskStatus }>(db,
        `SELECT mission_id, status FROM mission_task WHERE id = ? AND tenant_id = ?`,
        [id, input.tenantId]);
      if (!row) throw new Error("mission_task_dependency_task_not_found");
      if (row.mission_id !== input.missionId) throw new Error("mission_task_dependency_mission_mismatch");
      if (id === input.taskId) dependentStatus = row.status;
    }
    const existing = one<{ id: string }>(db,
      `SELECT id FROM mission_task_dependencies WHERE tenant_id = ? AND task_id = ? AND depends_on_task_id = ?`,
      [input.tenantId, input.taskId, input.dependsOnTaskId]);
    if (existing) { if (owns) db.raw.exec("COMMIT"); return; }
    if (dependentStatus !== "unassigned") {
      throw new Error("mission_task_dependency_frozen");
    }
    // Cycle guard: reject if `taskId` is already a (transitive) prerequisite of
    // `dependsOnTaskId`, which would close a cycle.
    if (dependsOnTransitively(db, input.tenantId, input.dependsOnTaskId, input.taskId)) {
      throw new Error("mission_task_dependency_cycle");
    }
    db.raw.prepare(`INSERT INTO mission_task_dependencies
      (id, tenant_id, mission_id, task_id, depends_on_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      input.id, input.tenantId, input.missionId, input.taskId, input.dependsOnTaskId, input.createdAt);
    if (owns) db.raw.exec("COMMIT");
  } catch (error) { if (owns) db.raw.exec("ROLLBACK"); throw error; }
}

/** Whether `fromTaskId` depends (transitively) on `targetTaskId`. */
function dependsOnTransitively(db: AppDb, tenantId: string, fromTaskId: string, targetTaskId: string): boolean {
  const seen = new Set<string>();
  const stack = [fromTaskId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetTaskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const row of all<{ depends_on_task_id: string }>(db,
      `SELECT depends_on_task_id FROM mission_task_dependencies WHERE tenant_id = ? AND task_id = ?`,
      [tenantId, current])) {
      stack.push(row.depends_on_task_id);
    }
  }
  return false;
}

/**
 * A task is READY to start when every prerequisite is COMPLETE. Returns false
 * when the task does not exist or any prerequisite is missing/not complete, so a
 * caller never starts a task ahead of its dependency ordering (spec §6.8).
 */
export function missionTaskReady(db: AppDb, tenantId: string, taskId: string): boolean {
  if (!one(db, `SELECT id FROM mission_task WHERE id = ? AND tenant_id = ?`, [taskId, tenantId])) return false;
  const deps = all<{ depends_on_task_id: string }>(db,
    `SELECT depends_on_task_id FROM mission_task_dependencies WHERE tenant_id = ? AND task_id = ?`, [tenantId, taskId]);
  for (const dep of deps) {
    const prereq = one<{ status: MissionTaskStatus }>(db,
      `SELECT status FROM mission_task WHERE id = ? AND tenant_id = ?`, [dep.depends_on_task_id, tenantId]);
    if (!prereq || prereq.status !== "complete") return false;
  }
  return true;
}
