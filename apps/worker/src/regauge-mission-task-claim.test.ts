import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createMissionTask,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  listMissionTasks,
  regaugeLaunchMissionTaskId,
  transitionMissionTask,
  type AppDb,
} from "@mendpoint/db";
import { assignRegaugeMissionTaskOnClaim } from "./regauge-mission-task-claim.js";

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

  it("falls back to the mission-level launch task when no repo task exists", () => {
    const { db, missionId } = fixture();
    const created = launchTask(db, missionId);
    const driven = assignRegaugeMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-missing", createdAt: at,
    });
    expect(driven).toMatchObject({ id: created.id, status: "agent_working" });
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
