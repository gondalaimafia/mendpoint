import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  createDb,
  createMission,
  createMissionTask,
  createWardenCampaign,
  enqueueJob,
  fettlerCampaignMissionTaskId,
  getMissionTask,
  insertConnectedRepository,
  insertPrincipal,
  insertRepositorySnapshot,
  linkFettlerCampaignToMission,
  listMissionTasks,
  transitionMissionTask,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import type { WardenCampaignExecutionDependencies } from "@mendpoint/pipeline";
import { assignFettlerMissionTaskOnClaim, handoffFettlerMissionTaskOnReview } from "./fettler-mission-task-claim.js";
import { WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE, type WardenCampaignExecutor } from "./warden-campaign-execute-dispatch.js";
import { processJobsOnce } from "./cli.js";

const at = "2026-08-25T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(opts: { withTarget?: boolean } = { withTarget: true }) {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-fettler-claim-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?)`).run(at);
  insertPrincipal(db, {
    id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: at,
  });
  createWardenCampaign(db, {
    id: "camp-1", tenantId: "t1", name: "Stripe upgrade", ownerPrincipalId: "p1",
    concurrencyLimit: 1, completionPolicy: "all", eventId: "e-camp",
    idempotencyKey: "c-camp", correlationId: "camp-1", createdAt: at,
  });
  const mission = createMission(db, {
    id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Remediate", ownerPrincipalId: "p1", eventId: "e-m1",
    idempotencyKey: "c-m1", correlationId: "camp-1", createdAt: at,
  });
  linkFettlerCampaignToMission(db, {
    tenantId: "t1", campaignId: "camp-1", missionId: mission.id,
    actorPrincipalId: "p1", eventId: "e-link", idempotencyKey: "c-link",
    correlationId: "camp-1", createdAt: at,
  });
  if (opts.withTarget !== false) {
    upsertScmConnection(db, {
      id: "conn", tenantId: "t1", provider: "local_git", credentialRef: "vault://c",
      externalAccountId: "acct", displayName: "Local", createdAt: at, updatedAt: at,
    });
    mkdirSync(join(dir, "snap"));
    insertConnectedRepository(db, {
      id: "repo-a", tenantId: "t1", connectionId: "conn", remoteId: "1",
      owner: "acme", name: "shop", defaultBranch: "main", status: "ready",
      createdAt: at, updatedAt: at,
    });
    insertRepositorySnapshot(db, {
      id: "snap-a", tenantId: "t1", repositoryId: "repo-a", requestedRef: "main",
      resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64),
      storagePath: join(dir, "snap"), createdAt: at, expiresAt: "2026-09-01T00:00:00.000Z",
    });
    addWardenCampaignTarget(db, {
      id: "tgt-1", tenantId: "t1", campaignId: "camp-1", repositoryId: "repo-a",
      snapshotId: "snap-a", ownerPrincipalId: "p1", eventId: "e-tgt",
      idempotencyKey: "c-tgt", correlationId: "camp-1", createdAt: at,
    });
  }
  return { db, missionId: mission.id };
}

function enrollTask(db: AppDb, missionId: string, repositoryId?: string) {
  const id = fettlerCampaignMissionTaskId(missionId, repositoryId);
  return createMissionTask(db, {
    id, tenantId: "t1", missionId, taskType: "code_migration",
    acceptanceCriteria: "migrate", risk: "medium", actorPrincipalId: "p1",
    eventId: `${id}-created`, idempotencyKey: `create-${id}`,
    correlationId: "camp-1", createdAt: at,
  });
}

describe("assignFettlerMissionTaskOnClaim", () => {
  it("is a no-op when the campaign has no Mission", () => {
    const { db } = fixture();
    expect(assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "missing", targetId: "tgt-1", createdAt: at,
    })).toBeUndefined();
  });

  it("is a no-op when the target does not exist", () => {
    const { db, missionId } = fixture({ withTarget: false });
    enrollTask(db, missionId, "repo-a");
    expect(assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-missing", createdAt: at,
    })).toBeUndefined();
  });

  it("is a no-op when the enrollment task does not exist", () => {
    const { db } = fixture();
    expect(assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", "m1")).toEqual([]);
  });

  it("drives unassigned -> agent_assigned -> agent_working for a repo task", () => {
    const { db, missionId } = fixture();
    const created = enrollTask(db, missionId, "repo-a");
    const driven = assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    });
    expect(driven).toMatchObject({
      id: created.id,
      status: "agent_working",
      ownerType: "agent",
    });
    expect(driven?.assignedPrincipalId).toMatch(/^principal-mtask-agent-/);
  });

  it("falls back to the mission-level enrollment task when no repo task exists", () => {
    const { db, missionId } = fixture();
    const created = enrollTask(db, missionId);
    const driven = assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    });
    expect(driven).toMatchObject({ id: created.id, status: "agent_working" });
  });

  it("is idempotent once the task is already agent_working", () => {
    const { db, missionId } = fixture();
    enrollTask(db, missionId, "repo-a");
    const first = assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    });
    const second = assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    });
    expect(second).toEqual(first);
  });

  it("does not rewind a task that has already left the claim path", () => {
    const { db, missionId } = fixture();
    const created = enrollTask(db, missionId, "repo-a");
    const assigned = transitionMissionTask(db, {
      tenantId: "t1", taskId: created.id, expectedRevision: created.revision,
      to: "agent_assigned", actorPrincipalId: "p1", assignedPrincipalId: "p1",
      eventId: "e-assigned", idempotencyKey: "c-assigned", correlationId: "camp-1",
      createdAt: at,
    });
    const working = transitionMissionTask(db, {
      tenantId: "t1", taskId: assigned.id, expectedRevision: assigned.revision,
      to: "agent_working", actorPrincipalId: "p1", eventId: "e-working",
      idempotencyKey: "c-working", correlationId: "camp-1", createdAt: at,
    });
    const handed = transitionMissionTask(db, {
      tenantId: "t1", taskId: working.id, expectedRevision: working.revision,
      to: "human_review_required", actorPrincipalId: "p1",
      handoffReason: "needs staff", eventId: "e-handoff",
      idempotencyKey: "c-handoff", correlationId: "camp-1", createdAt: at,
    });
    expect(assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", missionId)[0]).toMatchObject({
      id: handed.id,
      status: "human_review_required",
      revision: handed.revision,
    });
  });

  it("does not invent a Mission for a different tenant's campaign id", () => {
    const { db, missionId } = fixture();
    enrollTask(db, missionId, "repo-a");
    db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('t2','two','Two','team','active',10,?)`).run(at);
    expect(assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t2", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    })).toBeUndefined();
    expect(listMissionTasks(db, "t1", missionId)[0]?.status).toBe("unassigned");
  });
});

describe("campaign execute claim drives MissionTask", () => {
  it("assigns the enrollment task when the live loop claims the execute job", async () => {
    const { db, missionId } = fixture();
    const created = enrollTask(db, missionId, "repo-a");
    enqueueJob(db, {
      id: "job-exec-1",
      tenantId: "t1",
      type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE,
      createdAt: at,
      payload: {
        campaignId: "camp-1",
        targetId: "tgt-1",
        rolloutDecisionId: "rd-1",
        actorPrincipalId: "p1",
        runId: "run-1",
        createdAt: at,
        source: { sourceArtifactId: "src-1" },
        rolloutApproval: {
          decisionSha256: "a".repeat(64),
          approvedByPrincipalId: "p1",
          approvedAt: at,
        },
        ownerApproval: { ownerPrincipalId: "p1", ownerHandle: "@team", approvedAt: at },
      },
    });
    const execute = (async () => ({ stage: "review" }) as Awaited<ReturnType<WardenCampaignExecutor>>) as WardenCampaignExecutor;
    const result = await processJobsOnce(db, {
      allTenants: true,
      runWardenMaintenance: false,
      wardenCampaignExecution: {
        resolveDependencies: () => ({} as WardenCampaignExecutionDependencies),
        execute,
      },
    });
    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(getMissionTask(db, "t1", created.id)).toMatchObject({
      status: "human_review_required",
      ownerType: "human",
      handoffReason: "campaign_execute_review",
    });
  });

  it("does not advance the MissionTask to review when the execute lease is lost", async () => {
    const { db, missionId } = fixture();
    const created = enrollTask(db, missionId, "repo-a");
    enqueueJob(db, {
      id: "job-exec-lost",
      tenantId: "t1",
      type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE,
      createdAt: at,
      payload: {
        campaignId: "camp-1",
        targetId: "tgt-1",
        rolloutDecisionId: "rd-1",
        actorPrincipalId: "p1",
        runId: "run-1",
        createdAt: at,
        source: { sourceArtifactId: "src-1" },
        rolloutApproval: {
          decisionSha256: "a".repeat(64),
          approvedByPrincipalId: "p1",
          approvedAt: at,
        },
        ownerApproval: { ownerPrincipalId: "p1", ownerHandle: "@team", approvedAt: at },
      },
    });
    // The target lands in review, but the lease is stolen (new generation) mid
    // execute, so completeJob's fence rejects the settlement.
    const execute = (async () => {
      db.raw
        .prepare(`UPDATE jobs SET lease_generation = lease_generation + 1 WHERE id = 'job-exec-lost'`)
        .run();
      return { stage: "review" } as Awaited<ReturnType<WardenCampaignExecutor>>;
    }) as WardenCampaignExecutor;
    const result = await processJobsOnce(db, {
      allTenants: true,
      runWardenMaintenance: false,
      wardenCampaignExecution: {
        resolveDependencies: () => ({} as WardenCampaignExecutionDependencies),
        execute,
      },
    });
    // The job did not complete; the outcome is unowned.
    expect(result).toMatchObject({ claimed: 1, succeeded: 0 });
    // The MissionTask must NOT be at human_review_required on the strength of an
    // outcome the system disowned: it stays where the claim left it.
    expect(getMissionTask(db, "t1", created.id)).toMatchObject({
      status: "agent_working",
    });
  });
});

describe("handoffFettlerMissionTaskOnReview", () => {
  it("is a no-op when the task is not agent_working", () => {
    const { db, missionId } = fixture();
    enrollTask(db, missionId, "repo-a");
    expect(handoffFettlerMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    })).toBeUndefined();
  });

  it("hands an agent_working task to human_review_required", () => {
    const { db, missionId } = fixture();
    enrollTask(db, missionId, "repo-a");
    assignFettlerMissionTaskOnClaim(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    });
    const handed = handoffFettlerMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    });
    expect(handed).toMatchObject({
      status: "human_review_required",
      ownerType: "human",
      handoffReason: "campaign_execute_review",
    });
    expect(handoffFettlerMissionTaskOnReview(db, {
      tenantId: "t1", campaignId: "camp-1", targetId: "tgt-1", createdAt: at,
    })).toEqual(handed);
  });
});
