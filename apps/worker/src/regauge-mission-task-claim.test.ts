import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createMissionTask,
  getMissionTask,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  listMissionTasks,
  listMissionExceptions,
  openTaskHandoff,
  regaugeLaunchMissionTaskId,
  resolveTaskHandoff,
  transitionMissionTask,
  type AppDb,
} from "@mendpoint/db";
import {
  assignRegaugeMissionTaskOnClaim,
  handoffRegaugeMissionTaskOnReview,
} from "./regauge-mission-task-claim.js";

const at = "2026-08-25T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-regauge-claim-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?)`).run(at);
  insertPrincipal(db, {
    id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: at,
  });
  const mission = createMission(db, {
    id: "m1", tenantId: "t1", product: "regauge", triggerKind: "migration_objective",
    objective: "Upgrade", ownerPrincipalId: "p1", eventId: "e-m1",
    idempotencyKey: "c-m1", correlationId: "campaign-a", createdAt: at,
  });
  linkRegaugeCampaignToMission(db, {
    tenantId: "t1", missionId: mission.id, regaugeCampaignId: "campaign-a",
    actorPrincipalId: "p1", eventId: "e-link", idempotencyKey: "c-link",
    correlationId: "campaign-a", createdAt: at,
  });
  return { db, missionId: mission.id };
}

function launchTask(db: AppDb, missionId: string, repositoryId?: string) {
  const id = regaugeLaunchMissionTaskId(missionId, repositoryId);
  return createMissionTask(db, {
    id, tenantId: "t1", missionId, taskType: "code_migration",
    acceptanceCriteria: "migrate", risk: "medium", actorPrincipalId: "p1",
    eventId: `${id}-created`, idempotencyKey: `create-${id}`,
    correlationId: "campaign-a", createdAt: at,
  });
}

describe("assignRegaugeMissionTaskOnClaim", () => {
  it("is a no-op when the campaign has no Mission", () => {
    const { db } = fixture();
    expect(assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "unbound", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
  });

  it("is a no-op when the launch task does not exist", () => {
    const { db } = fixture();
    expect(assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", "m1")).toEqual([]);
  });

  it("drives unassigned -> agent_assigned -> agent_working for a repo task", () => {
    const { db, missionId } = fixture();
    const created = launchTask(db, missionId, "repo-a");
    const driven = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    expect(driven).toMatchObject({
      id: created.id,
      status: "agent_working",
      ownerType: "agent",
    });
    expect(driven?.assignedPrincipalId).toMatch(/^principal-mtask-agent-/);
  });

  it("returns an agent_resume task to agent_working on the next claim", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    const exception = openTaskHandoff(db, {
      tenantId: "t1",
      missionId,
      taskId: regaugeLaunchMissionTaskId(missionId, "repo-a"),
      reason: "architecture_decision_required",
      question: "Accept the pilot attempt?",
      context: "Pilot verification passed.",
      ownerPrincipalId: "p1",
      correlationId: "campaign-a",
      createdAt: at,
    });
    resolveTaskHandoff(db, {
      tenantId: "t1",
      priorExceptionId: exception.id,
      taskId: regaugeLaunchMissionTaskId(missionId, "repo-a"),
      resolutionNote: "Yes.",
      decision: "Accept the attempt",
      scope: "handoff_resolution:attempt-1",
      authorPrincipalId: "p1",
      correlationId: "campaign-a",
      createdAt: at,
    });
    const resumed = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    expect(resumed).toMatchObject({ status: "agent_working", ownerType: "agent" });
  });

  it("does not resolve a repo-scoped claim to the mission-level launch task", () => {
    const { db, missionId } = fixture();
    const missionLevel = launchTask(db, missionId);
    expect(assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(getMissionTask(db, "t1", missionLevel.id)?.status).toBe("unassigned");
  });

  it("does not funnel multiple repo-scoped claims onto one mission-level task", () => {
    const { db, missionId } = fixture();
    // Only the mission-level catch-all exists (launch saw no repository scope).
    const missionLevel = launchTask(db, missionId);
    const drivenA = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    const drivenB = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-b", createdAt: at,
    });
    expect(drivenA).toBeUndefined();
    expect(drivenB).toBeUndefined();
    expect(getMissionTask(db, "t1", missionLevel.id)?.status).toBe("unassigned");
  });

  it("keeps two repo-scoped units on their own launch tasks", () => {
    const { db, missionId } = fixture();
    const taskA = launchTask(db, missionId, "repo-a");
    const taskB = launchTask(db, missionId, "repo-b");
    const drivenA = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    expect(drivenA?.id).toBe(taskA.id);
    // Driving repo-a's task must not touch repo-b's sibling.
    expect(getMissionTask(db, "t1", taskB.id)?.status).toBe("unassigned");
    const drivenB = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-b", createdAt: at,
    });
    expect(drivenB?.id).toBe(taskB.id);
    expect(drivenA?.id).not.toBe(drivenB?.id);
  });

  it("is idempotent once the task is already agent_working", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    const first = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    const second = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    expect(second).toEqual(first);
  });

  it("does not rewind a task that has already left the claim path", () => {
    const { db, missionId } = fixture();
    const created = launchTask(db, missionId, "repo-a");
    const assigned = transitionMissionTask(db, {
      tenantId: "t1", taskId: created.id, expectedRevision: created.revision,
      to: "agent_assigned", actorPrincipalId: "p1", assignedPrincipalId: "p1",
      eventId: "e-assigned", idempotencyKey: "c-assigned", correlationId: "campaign-a",
      createdAt: at,
    });
    const working = transitionMissionTask(db, {
      tenantId: "t1", taskId: assigned.id, expectedRevision: assigned.revision,
      to: "agent_working", actorPrincipalId: "p1", eventId: "e-working",
      idempotencyKey: "c-working", correlationId: "campaign-a", createdAt: at,
    });
    const handed = transitionMissionTask(db, {
      tenantId: "t1", taskId: working.id, expectedRevision: working.revision,
      to: "human_review_required", actorPrincipalId: "p1",
      handoffReason: "needs staff", eventId: "e-handoff",
      idempotencyKey: "c-handoff", correlationId: "campaign-a", createdAt: at,
    });
    expect(assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", missionId)[0]).toMatchObject({
      id: handed.id,
      status: "human_review_required",
      revision: handed.revision,
    });
  });

  it("does not invent a Mission for a different tenant's campaign id", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('t2','two','Two','team','active',10,?)`).run(at);
    expect(assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t2", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", missionId)[0]?.status).toBe("unassigned");
  });
});

describe("handoffRegaugeMissionTaskOnReview", () => {
  it("is a no-op when the campaign has no Mission", () => {
    const { db } = fixture();
    expect(handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "unbound", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
  });

  it("is a no-op when the launch task does not exist", () => {
    const { db } = fixture();
    expect(handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
  });

  it("is a no-op when the task is still unassigned", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    expect(handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", missionId)[0]?.status).toBe("unassigned");
  });

  it("hands agent_working -> human_review_required with the pilot-lane reason", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    const handed = handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    expect(handed).toMatchObject({
      status: "human_review_required",
      ownerType: "human",
      handoffReason: "architecture_decision_required",
    });
    const exceptions = listMissionExceptions(db, "t1", missionId);
    expect(exceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        blocking: true,
        category: "architecture_decision_required",
        taskId: handed?.id,
      }),
    ]));
    expect(exceptions[0]?.reason).toContain("proceed after the pilot attempt passed verification");
  });

  it("is idempotent once the task is already human_review_required", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    const first = handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    const second = handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    expect(second).toEqual(first);
  });

  it("does not resolve a repo-scoped handoff to the mission-level launch task", () => {
    const { db, missionId } = fixture();
    const missionLevel = launchTask(db, missionId);
    // A repo-scoped claim on a mission-level-only launch is a no-op, so the
    // handoff has nothing on the working path to hand over.
    expect(assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(getMissionTask(db, "t1", missionLevel.id)?.status).toBe("unassigned");
  });

  it("does not invent a Mission for a different tenant's campaign id", () => {
    const { db, missionId } = fixture();
    launchTask(db, missionId, "repo-a");
    assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    });
    db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('t2','two','Two','team','active',10,?)`).run(at);
    expect(handoffRegaugeMissionTaskOnReview(db, {
      tenantId: "t2", campaignId: "campaign-a", repositoryId: "repo-a", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", missionId)[0]?.status).toBe("agent_working");
  });
});
