import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMissionTaskDependency,
  createDb,
  createMission,
  createMissionTask,
  getMissionTask,
  insertPrincipal,
  listMissionTasks,
  missionTaskReady,
  regaugeLaunchMissionTaskId,
  transitionMissionTask,
  verifyDomainEventIntegrity,
  type AppDb,
  type MissionTask,
  type MissionTaskStatus,
} from "./index.js";

const at = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mtask-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?),('t2','two','Two','team','active',10,?)`).run(at, at);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: at });
  insertPrincipal(db, { id: "agent1", tenantId: "t1", kind: "service", subject: "agent", displayName: "Agent", createdAt: at });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate", ownerPrincipalId: "p1", eventId: "e-m1", idempotencyKey: "c-m1", correlationId: "corr", createdAt: at });
  return db;
}

let seq = 0;
function task(db: AppDb, id = "task1") {
  return createMissionTask(db, { id, tenantId: "t1", missionId: "m1", taskType: "code_migration",
    acceptanceCriteria: "tests pass", risk: "medium", actorPrincipalId: "p1",
    eventId: `e-${id}-${seq++}`, idempotencyKey: `c-${id}`, correlationId: "corr", createdAt: at });
}
function move(db: AppDb, current: MissionTask, to: MissionTaskStatus, extra: { assignedPrincipalId?: string; handoffReason?: string } = {}) {
  const n = seq++;
  return transitionMissionTask(db, { tenantId: "t1", taskId: current.id, expectedRevision: current.revision, to,
    actorPrincipalId: "p1", ...extra, eventId: `e-${current.id}-${to}-${n}`, idempotencyKey: `mv-${current.id}-${to}-${n}`,
    correlationId: "corr", createdAt: at });
}

describe("mission task engine", () => {
  it("derives a stable ReGauge launch task id from mission and optional repository", () => {
    expect(regaugeLaunchMissionTaskId("mission-a")).toBe(regaugeLaunchMissionTaskId("mission-a"));
    expect(regaugeLaunchMissionTaskId("mission-a", "repo-a")).toBe(
      regaugeLaunchMissionTaskId("mission-a", "repo-a"),
    );
    expect(regaugeLaunchMissionTaskId("mission-a")).not.toBe(regaugeLaunchMissionTaskId("mission-a", "repo-a"));
    expect(regaugeLaunchMissionTaskId("mission-a", "repo-a")).not.toBe(
      regaugeLaunchMissionTaskId("mission-a", "repo-b"),
    );
    expect(regaugeLaunchMissionTaskId("mission-a")).toMatch(/^mt-regauge-[0-9a-f]{24}$/);
  });

  it("creates an unassigned task, is idempotent on the id, and conflicts on a changed field", () => {
    const db = fixture();
    const t = task(db);
    expect(t).toMatchObject({ status: "unassigned", ownerType: null, retryCount: 0, revision: 1 });
    expect(task(db).revision).toBe(1); // idempotent replay
    expect(() => createMissionTask(db, { id: "task1", tenantId: "t1", missionId: "m1", taskType: "OTHER",
      acceptanceCriteria: "x", risk: "low", actorPrincipalId: "p1", eventId: "e-x", idempotencyKey: "c-x",
      correlationId: "corr", createdAt: at })).toThrow("mission_task_id_conflict");
  });

  it("walks the full agent -> human -> agent -> complete path, deriving owner_type", () => {
    const db = fixture();
    let t = task(db);
    t = move(db, t, "agent_assigned"); expect(t.ownerType).toBe("agent");
    t = move(db, t, "agent_working");
    t = move(db, t, "human_review_required", { handoffReason: "needs staff sign-off" });
    expect(t.ownerType).toBe("human");
    expect(t.handoffReason).toBe("needs staff sign-off");
    t = move(db, t, "human_assigned", { assignedPrincipalId: "p1" });
    expect(t.assignedPrincipalId).toBe("p1");
    t = move(db, t, "human_working");
    t = move(db, t, "agent_resume"); expect(t.ownerType).toBe("agent");
    t = move(db, t, "complete");
    expect(t.status).toBe("complete");
    expect(verifyDomainEventIntegrity(db, "t1").ok).toBe(true);
  });

  it("rejects an illegal transition and a stale-revision transition", () => {
    const db = fixture();
    const t = task(db);
    expect(() => move(db, t, "complete")).toThrow("mission_task_transition_invalid");
    move(db, t, "agent_assigned");
    // t still holds revision 1; the row is now at revision 2.
    expect(() => move(db, t, "agent_working")).toThrow("mission_task_revision_conflict");
  });

  it("is idempotent on a same-status transition and counts a replan on blocked -> agent_working", () => {
    const db = fixture();
    let t = task(db);
    t = move(db, t, "agent_assigned");
    const same = transitionMissionTask(db, { tenantId: "t1", taskId: t.id, expectedRevision: t.revision,
      to: "agent_assigned", actorPrincipalId: "p1", eventId: "e-same", idempotencyKey: "same",
      correlationId: "corr", createdAt: at });
    expect(same.revision).toBe(t.revision); // no-op replay
    t = move(db, t, "agent_working");
    t = move(db, t, "blocked");
    expect(t.retryCount).toBe(0);
    t = move(db, t, "agent_working");
    expect(t.retryCount).toBe(1); // replan counted
  });

  it("orders by dependency: a task is not ready until every prerequisite completes", () => {
    const db = fixture();
    const a = task(db, "task-a");
    const b = task(db, "task-b");
    addMissionTaskDependency(db, { id: "dep-1", tenantId: "t1", missionId: "m1", taskId: "task-b", dependsOnTaskId: "task-a", createdAt: at });
    expect(missionTaskReady(db, "t1", "task-b")).toBe(false);
    expect(missionTaskReady(db, "t1", "task-a")).toBe(true); // no prereqs
    // Drive task-a to complete.
    let ca = a; void b;
    ca = move(db, ca, "agent_assigned");
    ca = move(db, ca, "agent_working");
    ca = move(db, ca, "complete");
    expect(missionTaskReady(db, "t1", "task-b")).toBe(true);
  });

  it("rejects self-edges, cross-mission edges, and cycles", () => {
    const db = fixture();
    task(db, "task-a");
    task(db, "task-b");
    expect(() => addMissionTaskDependency(db, { id: "d0", tenantId: "t1", missionId: "m1", taskId: "task-a", dependsOnTaskId: "task-a", createdAt: at }))
      .toThrow("mission_task_dependency_self");
    addMissionTaskDependency(db, { id: "d1", tenantId: "t1", missionId: "m1", taskId: "task-b", dependsOnTaskId: "task-a", createdAt: at });
    // task-a depends_on task-b would close a cycle (b already depends_on a).
    expect(() => addMissionTaskDependency(db, { id: "d2", tenantId: "t1", missionId: "m1", taskId: "task-a", dependsOnTaskId: "task-b", createdAt: at }))
      .toThrow("mission_task_dependency_cycle");
  });

  it("isolates tasks by tenant", () => {
    const db = fixture();
    task(db, "task-a");
    expect(getMissionTask(db, "t2", "task-a")).toBeUndefined();
    expect(listMissionTasks(db, "t1", "m1").map((t) => t.id)).toEqual(["task-a"]);
    expect(listMissionTasks(db, "t2", "m1")).toEqual([]);
  });

  it("converges the new tables on boot against a pre-change volume, preserving data", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-mtask-conv-"));
    const path = join(dir, "vol.sqlite");
    const first = createDb(path);
    first.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('t1','one','One','team','active',10,?)`).run(at);
    insertPrincipal(first, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: at });
    createMission(first, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Migrate", ownerPrincipalId: "p1", eventId: "e-m1", idempotencyKey: "c-m1", correlationId: "corr", createdAt: at });
    // Simulate a pre-change volume: drop the new tables, keep the mission row.
    first.raw.exec("DROP TABLE mission_task_dependencies");
    first.raw.exec("DROP TABLE mission_task");
    first.raw.close();
    // Re-open (boot current code) -> tables converge via CREATE TABLE IF NOT EXISTS.
    const second = createDb(path);
    opened.push({ db: second, dir });
    const names = (second.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["mission_task", "mission_task_dependencies"]));
    expect(second.raw.prepare(`SELECT objective FROM mission WHERE id='m1'`).get()).toMatchObject({ objective: "Migrate" });
    // Immediately usable again.
    const t = createMissionTask(second, { id: "task-z", tenantId: "t1", missionId: "m1", taskType: "code_migration",
      acceptanceCriteria: "green", risk: "low", actorPrincipalId: "p1", eventId: "e-z", idempotencyKey: "c-z",
      correlationId: "corr", createdAt: at });
    expect(t.status).toBe("unassigned");
  });
});
