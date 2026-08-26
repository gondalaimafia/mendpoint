import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMissionTaskDependency,
  createDb,
  createMission,
  createMissionTask,
  ensureMissionTaskForJob,
  getMissionTask,
  insertPrincipal,
  listMissionTasks,
  fettlerCampaignMissionTaskId,
  missionTaskIdForJob,
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

function insertDispatch(
  db: AppDb,
  state: "authorized" | "dispatching" | "uncertain",
  suffix: string,
  taskId: string | null,
) {
  db.raw.prepare(`INSERT INTO mission_mutation_dispatches
    (id, tenant_id, mission_id, job_id, mutation_kind, aggregate_id, authority_json,
     intent_digest, state, lease_owner, lease_generation, authorized_at, dispatching_at,
     uncertain_at, updated_at)
    VALUES (?, 't1', 'm1', ?, 'fettler_candidate_delivery', ?, ?, ?, ?, 'worker-1', 1, ?, ?, ?, ?)`)
    .run(`dispatch-${suffix}`, `job-${suffix}`, `aggregate-${suffix}`, JSON.stringify({ taskId }),
      `sha256:${suffix.padEnd(64, "a")}`,
      state, at, state === "dispatching" ? at : null, state === "uncertain" ? at : null, at);
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

  it("derives a stable Fettler campaign task id from mission and optional repository", () => {
    expect(fettlerCampaignMissionTaskId("mission-a")).toBe(fettlerCampaignMissionTaskId("mission-a"));
    expect(fettlerCampaignMissionTaskId("mission-a", "repo-a")).toBe(
      fettlerCampaignMissionTaskId("mission-a", "repo-a"),
    );
    expect(fettlerCampaignMissionTaskId("mission-a")).not.toBe(
      fettlerCampaignMissionTaskId("mission-a", "repo-a"),
    );
    expect(fettlerCampaignMissionTaskId("mission-a", "repo-a")).not.toBe(
      fettlerCampaignMissionTaskId("mission-a", "repo-b"),
    );
    expect(fettlerCampaignMissionTaskId("mission-a")).toMatch(/^mt-fettler-[0-9a-f]{24}$/);
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

  it.each(["dispatching", "uncertain"] as const)(
    "atomically blocks task cancellation, blocking, handoff, and completion while a mutation is %s",
    (state) => {
      for (const target of ["cancelled", "blocked", "human_review_required", "complete"] as const) {
        const db = fixture();
        let current = task(db, `task-${state}-${target}`);
        current = move(db, current, "agent_assigned");
        current = move(db, current, "agent_working");
        insertDispatch(db, state, `${state}-${target}`, current.id);
        expect(() => move(db, current, target)).toThrow("mission_mutation_dispatch_in_flight");
        expect(getMissionTask(db, "t1", current.id)).toMatchObject({
          status: "agent_working",
          revision: current.revision,
        });
      }
    },
  );

  it("revokes authorized mutation intent with a task transition but preserves same-status replay", () => {
    const db = fixture();
    let current = task(db, "task-fence-replay");
    current = move(db, current, "agent_assigned");
    current = move(db, current, "agent_working");
    insertDispatch(db, "authorized", "authorized-task", current.id);
    const cancelled = move(db, current, "cancelled");
    expect(cancelled.status).toBe("cancelled");
    expect((db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
      .get("dispatch-authorized-task") as { state: string }).state).toBe("revoked");

    const replayDb = fixture();
    let replay = task(replayDb, "task-same-replay");
    replay = move(replayDb, replay, "agent_assigned");
    replay = move(replayDb, replay, "agent_working");
    insertDispatch(replayDb, "dispatching", "same-replay", replay.id);
    const unchanged = move(replayDb, replay, "agent_working");
    expect(unchanged.revision).toBe(replay.revision);
    expect((replayDb.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
      .get("dispatch-same-replay") as { state: string }).state).toBe("dispatching");
  });

  it.each(["dispatching", "uncertain"] as const)(
    "blocks authoritative task creation while taskless Mission authority is %s",
    (state) => {
      const db = fixture();
      insertDispatch(db, state, `create-${state}`, null);
      expect(() => task(db, `new-${state}`)).toThrow("mission_mutation_dispatch_in_flight");
      expect(getMissionTask(db, "t1", `new-${state}`)).toBeUndefined();
    },
  );

  it("revokes authorized taskless authority before task creation and keeps replay idempotent", () => {
    const db = fixture();
    insertDispatch(db, "authorized", "create-authorized", null);
    const created = task(db, "new-authorized");
    expect(created.revision).toBe(1);
    expect((db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
      .get("dispatch-create-authorized") as { state: string }).state).toBe("revoked");
    insertDispatch(db, "dispatching", "create-replay", null);
    expect(task(db, "new-authorized").revision).toBe(1);
  });

  it("keeps an existing task dispatch isolated from later task enrollment", () => {
    const db = fixture();
    const existing = task(db, "existing-task");
    insertDispatch(db, "dispatching", "create-sibling", existing.id);
    expect(task(db, "later-task").status).toBe("unassigned");
    expect((db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
      .get("dispatch-create-sibling") as { state: string }).state).toBe("dispatching");
  });

  it.each(["authorized", "dispatching", "uncertain"] as const)(
    "keeps a sibling task %s dispatch isolated from another task transition",
    (state) => {
      const db = fixture();
      let a = task(db, `task-a-${state}`);
      let b = task(db, `task-b-${state}`);
      a = move(db, a, "agent_assigned");
      a = move(db, a, "agent_working");
      b = move(db, b, "agent_assigned");
      b = move(db, b, "agent_working");
      insertDispatch(db, state, `sibling-${state}`, a.id);
      expect(move(db, b, "cancelled").status).toBe("cancelled");
      expect((db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
        .get(`dispatch-sibling-${state}`) as { state: string }).state).toBe(state);
    },
  );

  it.each(["dispatching", "uncertain"] as const)(
    "blocks dependency readiness changes while the dependent task dispatch is %s",
    (state) => {
      const db = fixture();
      task(db, `dep-source-${state}`);
      const target = task(db, `dep-target-${state}`);
      insertDispatch(db, state, `dependency-${state}`, target.id);
      expect(() => addMissionTaskDependency(db, { id: `edge-${state}`, tenantId: "t1", missionId: "m1",
        taskId: target.id, dependsOnTaskId: `dep-source-${state}`, createdAt: at }))
        .toThrow("mission_mutation_dispatch_in_flight");
      expect(getMissionTask(db, "t1", target.id)?.revision).toBe(target.revision);
      expect(missionTaskReady(db, "t1", target.id)).toBe(true);
    },
  );

  it("revokes dependent-task authority and revision-invalidates readiness without touching a sibling", () => {
    const db = fixture();
    const source = task(db, "dependency-source");
    const target = task(db, "dependency-target");
    const sibling = task(db, "dependency-sibling");
    insertDispatch(db, "authorized", "dependency-target", target.id);
    insertDispatch(db, "dispatching", "dependency-sibling", sibling.id);
    addMissionTaskDependency(db, { id: "dependency-edge", tenantId: "t1", missionId: "m1",
      taskId: target.id, dependsOnTaskId: source.id, createdAt: at });
    expect(getMissionTask(db, "t1", target.id)?.revision).toBe(target.revision + 1);
    expect(missionTaskReady(db, "t1", target.id)).toBe(false);
    expect((db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
      .get("dispatch-dependency-target") as { state: string }).state).toBe("revoked");
    expect((db.raw.prepare(`SELECT state FROM mission_mutation_dispatches WHERE id = ?`)
      .get("dispatch-dependency-sibling") as { state: string }).state).toBe("dispatching");
    addMissionTaskDependency(db, { id: "dependency-edge-replay", tenantId: "t1", missionId: "m1",
      taskId: target.id, dependsOnTaskId: source.id, createdAt: at });
    expect(getMissionTask(db, "t1", target.id)?.revision).toBe(target.revision + 1);
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

  it("bridges a job onto a MissionTask in agent_working, and is idempotent", () => {
    const db = fixture();
    const first = ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-1", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "complete the run", risk: "medium",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    });
    expect(first.id).toBe(missionTaskIdForJob("job-1"));
    expect(first).toMatchObject({
      status: "agent_working", ownerType: "agent", assignedPrincipalId: "agent1",
      missionId: "m1", taskType: "agent.run",
    });
    const replay = ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-1", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "complete the run", risk: "medium",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    });
    expect(replay.revision).toBe(first.revision);
    expect(verifyDomainEventIntegrity(db, "t1").ok).toBe(true);
  });

  it("resumes a partially created task and does not rewind a human-owned one", () => {
    const db = fixture();
    const id = missionTaskIdForJob("job-partial");
    createMissionTask(db, {
      id, tenantId: "t1", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "complete the run", risk: "low", actorPrincipalId: "p1",
      eventId: "e-partial", idempotencyKey: "c-partial", correlationId: "corr", createdAt: at,
    });
    const resumed = ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-partial", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "complete the run", risk: "low",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    });
    expect(resumed.status).toBe("agent_working");

    const handed = missionTaskIdForJob("job-handoff");
    let t = createMissionTask(db, {
      id: handed, tenantId: "t1", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "review", risk: "high", actorPrincipalId: "p1",
      eventId: "e-h", idempotencyKey: "c-h", correlationId: "corr", createdAt: at,
    });
    t = move(db, t, "agent_assigned");
    t = move(db, t, "agent_working");
    t = move(db, t, "human_review_required", { handoffReason: "needs staff" });
    const left = ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-handoff", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "review", risk: "high",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    });
    expect(left.status).toBe("human_review_required");
    expect(left.revision).toBe(t.revision);
  });

  it("rejects a job id already bound to a different mission, and joins an open transaction", () => {
    const db = fixture();
    createMission(db, {
      id: "m2", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Other", ownerPrincipalId: "p1", eventId: "e-m2", idempotencyKey: "c-m2",
      correlationId: "corr", createdAt: at,
    });
    ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-x", missionId: "m1", taskType: "agent.run",
      acceptanceCriteria: "x", risk: "medium",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    });
    expect(() => ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-x", missionId: "m2", taskType: "agent.run",
      acceptanceCriteria: "x", risk: "medium",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    })).toThrow("mission_task_job_mission_mismatch");

    db.raw.exec("BEGIN IMMEDIATE");
    const nested = ensureMissionTaskForJob(db, {
      tenantId: "t1", jobId: "job-nested", missionId: "m1", taskType: "pipeline.fanout",
      acceptanceCriteria: "nested", risk: "medium",
      actorPrincipalId: "p1", assignedPrincipalId: "agent1", createdAt: at,
    });
    expect(nested.status).toBe("agent_working");
    db.raw.exec("COMMIT");
  });
});
