import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  createDb,
  createMission,
  createMissionTask,
  createWardenCampaign,
  fettlerCampaignMissionTaskId,
  getMissionTask,
  insertPrincipal,
  insertRepositorySnapshot,
  linkFettlerCampaignToMission,
  listActualExecutionCosts,
  missionTaskIdForJob,
  recordRoutingDecision,
  recordRoutingOutcome,
  type AppDb,
} from "@mendpoint/db";
import {
  bridgeClaimedJobToMissionTask,
  recordBoundMissionExecutionCost,
  resolveBoundMissionForJob,
} from "./mission-task-job-bridge.js";

const at = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mtask-job-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?),('t2','two','Two','team','active',10,?)`).run(at, at);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: at });
  createMission(db, {
    id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate", ownerPrincipalId: "p1", eventId: "e-m1", idempotencyKey: "c-m1",
    correlationId: "corr", createdAt: at,
  });
  return db;
}

function job(
  payload: Record<string, unknown>,
  extra: { id?: string; type?: string; tenantId?: string } = {},
) {
  return {
    id: extra.id ?? "job-1",
    tenant_id: extra.tenantId ?? "t1",
    type: extra.type ?? "agent.run",
    payload_json: JSON.stringify(payload),
  };
}

function seedRouting(db: AppDb, runId: string, jobId: string) {
  const envelopeId = `envelope-${runId}`;
  recordRoutingDecision(db, {
    tenantId: "t1",
    jobId,
    runId,
    taskKind: "agent.run",
    envelopeId,
    policySnapshotId: `policy-${runId}`,
    taskSnapshotId: `task-${runId}`,
    action: "route",
    selectedExecutorId: "executor-frontier",
    providerId: "provider-frontier",
    eliminated: [],
    fallback: [],
    breaker: [],
    handoffRequired: false,
    decision: {},
    createdAt: at,
  });
  recordRoutingOutcome(db, {
    tenantId: "t1",
    jobId,
    envelopeId,
    action: "route",
    outcome: "succeeded",
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    costUsd: 0.05,
    observedAt: at,
  });
}

describe("mission-task job bridge", () => {
  it("is a no-op when the job has no bound mission", () => {
    const db = fixture();
    const unbound = job({ goal: "repair", consumerId: "c1" });
    expect(resolveBoundMissionForJob(db, unbound)).toBeUndefined();
    expect(bridgeClaimedJobToMissionTask(db, unbound, at)).toBeUndefined();
    expect(recordBoundMissionExecutionCost(db, { job: unbound, sourceRunId: "run-1", createdAt: at })).toBeUndefined();
    expect(getMissionTask(db, "t1", missionTaskIdForJob("job-1"))).toBeUndefined();
  });

  it("fails closed when missionId is claimed but the mission is missing", () => {
    const db = fixture();
    expect(() => resolveBoundMissionForJob(db, job({ missionId: "does-not-exist" })))
      .toThrow("mission_task_job_mission_not_found");
  });

  it("creates an agent_working MissionTask for a bound agent.run and records MCU against the mission", () => {
    const db = fixture();
    const claimed = job({ missionId: "m1", goal: "repair", consumerId: "c1" });
    const task = bridgeClaimedJobToMissionTask(db, claimed, at);
    expect(task).toMatchObject({
      id: missionTaskIdForJob("job-1"),
      missionId: "m1",
      status: "agent_working",
      ownerType: "agent",
      taskType: "agent.run",
    });
    expect(bridgeClaimedJobToMissionTask(db, claimed, at)?.revision).toBe(task!.revision);

    seedRouting(db, "session-1", "job-1");
    const cost = recordBoundMissionExecutionCost(db, {
      job: claimed,
      sourceRunId: "session-1",
      createdAt: at,
    });
    expect(cost).toMatchObject({
      missionId: "m1",
      taskId: missionTaskIdForJob("job-1"),
      executionId: "job-1",
      route: "fettler",
      taskClass: "agent.run",
      modelCostMeasured: true,
      modelCostMoneyMicros: 50_000,
    });
    expect(recordBoundMissionExecutionCost(db, {
      job: claimed,
      sourceRunId: "session-1",
      createdAt: at,
    })?.id).toBe(cost!.id);
    expect(listActualExecutionCosts(db, "t1")).toHaveLength(1);
  });

  it("resolves a Fettler campaignId to the linked mission and skips an unlinked campaign", () => {
    const db = fixture();
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('connection', 't1', 'local_git', 'vault://connection', 'account', 'Local', ?, ?)`)
      .run(at, at);
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-1', 't1', 'connection', 'repo-1', 'acme', 'payments', 'main', 'main',
       'test', 30, 'ready', ?, ?)`).run(at, at);
    insertRepositorySnapshot(db, {
      id: "snapshot-1", tenantId: "t1", repositoryId: "repo-1", requestedRef: "main",
      resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64),
      storagePath: join(tmpdir(), "mendpoint-bridge-snapshot-1"),
      createdAt: at, expiresAt: "2027-01-01T00:00:00.000Z",
    });
    createWardenCampaign(db, {
      id: "campaign", tenantId: "t1", name: "Payments", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "wc-1", idempotencyKey: "wc-1",
      correlationId: "corr", createdAt: at,
    });
    addWardenCampaignTarget(db, {
      id: "target-1", tenantId: "t1", campaignId: "campaign", repositoryId: "repo-1",
      snapshotId: "snapshot-1", ownerPrincipalId: "p1", eventId: "target-1-created",
      idempotencyKey: "target-1-created", correlationId: "corr", createdAt: at,
    });
    expect(resolveBoundMissionForJob(db, job({ campaignId: "campaign" }))).toBeUndefined();
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign", missionId: "m1", actorPrincipalId: "p1",
      eventId: "link-f", idempotencyKey: "link-f", correlationId: "corr", createdAt: at,
    });
    const campaignTaskId = fettlerCampaignMissionTaskId("m1", "repo-1");
    createMissionTask(db, {
      id: campaignTaskId, tenantId: "t1", missionId: "m1", taskType: "code_migration",
      acceptanceCriteria: "Complete the enrolled Fettler unit for repository repo-1.", risk: "medium",
      actorPrincipalId: "p1", eventId: "campaign-task-created", idempotencyKey: "campaign-task-created",
      correlationId: "corr", createdAt: at,
    });
    const execute = job(
      {
        campaignId: "campaign", targetId: "target-1", repositoryId: "repo-1",
        snapshotId: "snapshot-1", runId: "run-camp",
      },
      { id: "job-execute", type: "warden.campaign.execute-target" },
    );
    expect(resolveBoundMissionForJob(db, execute)?.id).toBe("m1");
    const task = bridgeClaimedJobToMissionTask(db, execute, at);
    expect(task).toMatchObject({
      id: campaignTaskId,
      missionId: "m1",
      status: "unassigned",
      taskType: "code_migration",
    });
    expect(getMissionTask(db, "t1", missionTaskIdForJob("job-execute"))).toBeUndefined();
    seedRouting(db, "run-camp", "job-execute");
    expect(recordBoundMissionExecutionCost(db, {
      job: execute,
      sourceRunId: "run-camp",
      createdAt: at,
    })).toMatchObject({ taskId: campaignTaskId, missionId: "m1" });
  });

  it("fails closed when a campaign job claims target scope that differs from durable authority", () => {
    const db = fixture();
    createWardenCampaign(db, {
      id: "campaign", tenantId: "t1", name: "Payments", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "wc-1", idempotencyKey: "wc-1",
      correlationId: "corr", createdAt: at,
    });
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign", missionId: "m1", actorPrincipalId: "p1",
      eventId: "link-f", idempotencyKey: "link-f", correlationId: "corr", createdAt: at,
    });
    const execute = job(
      { campaignId: "campaign", targetId: "missing", repositoryId: "foreign", snapshotId: "foreign" },
      { id: "job-execute", type: "warden.campaign.execute-target" },
    );
    expect(() => bridgeClaimedJobToMissionTask(db, execute, at))
      .toThrow("mission_task_job_target_not_found");
    expect(getMissionTask(db, "t1", missionTaskIdForJob("job-execute"))).toBeUndefined();
  });
});
