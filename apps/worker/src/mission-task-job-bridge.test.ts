import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createWardenCampaign,
  claimNextJob,
  completeJob,
  enqueueJob,
  getJob,
  getMissionTask,
  insertPrincipal,
  linkFettlerCampaignToMission,
  listActualExecutionCosts,
  missionTaskIdForJob,
  openTaskHandoff,
  recordRoutingDecision,
  recordRoutingOutcome,
  resolveTaskHandoff,
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
    expect(recordBoundMissionExecutionCost(db, {
      job: unbound,
      sourceRunId: "run-1",
      createdAt: at,
      outcomeStatus: "accepted",
    })).toBeUndefined();
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
      outcomeStatus: "accepted",
    });
    expect(cost).toMatchObject({
      missionId: "m1",
      taskId: missionTaskIdForJob("job-1"),
      executionId: "job-1",
      route: "fettler",
      taskClass: "agent.run",
      outcomeStatus: "accepted",
      acceptedOutcomeId: "job-1",
      modelCostMeasured: true,
      modelCostMoneyMicros: 50_000,
    });
    expect(recordBoundMissionExecutionCost(db, {
      job: claimed,
      sourceRunId: "session-1",
      createdAt: at,
      outcomeStatus: "accepted",
    })?.id).toBe(cost!.id);
    expect(listActualExecutionCosts(db, "t1")).toHaveLength(1);
  });

  it("joins the terminal job transaction so accounting failures remain retryable", () => {
    const db = fixture();
    const failed = job(
      { missionId: "m1", goal: "repair", consumerId: "c1" },
      { id: "job-rejected" },
    );
    bridgeClaimedJobToMissionTask(db, failed, at);
    seedRouting(db, "session-rejected", "job-rejected");

    db.raw.exec("BEGIN IMMEDIATE");
    const rejected = recordBoundMissionExecutionCost(db, {
      job: failed,
      sourceRunId: "session-rejected",
      createdAt: at,
      outcomeStatus: "rejected",
    });
    expect(rejected).toMatchObject({
      outcomeStatus: "rejected",
      acceptedOutcomeId: null,
    });
    db.raw.exec("ROLLBACK");
    expect(listActualExecutionCosts(db, "t1")).toEqual([]);

    expect(recordBoundMissionExecutionCost(db, {
      job: failed,
      sourceRunId: "session-rejected",
      createdAt: at,
      outcomeStatus: "rejected",
    })).toMatchObject({ outcomeStatus: "rejected" });
  });

  it("rolls back terminal job state when immutable cost persistence fails", () => {
    const db = fixture();
    const claimedJob = job(
      { missionId: "m1", goal: "repair", consumerId: "c1" },
      { id: "job-atomic" },
    );
    bridgeClaimedJobToMissionTask(db, claimedJob, at);
    seedRouting(db, "session-atomic", "job-atomic");
    enqueueJob(db, {
      id: "job-atomic",
      tenantId: "t1",
      type: "agent.run",
      payload: { missionId: "m1", goal: "repair", consumerId: "c1" },
      createdAt: at,
    });
    const lease = claimNextJob(db, ["agent.run"], {
      tenantId: "t1",
      workerId: "worker-atomic",
      leaseMs: 60_000,
      now: at,
    })!;

    db.raw.exec("BEGIN IMMEDIATE");
    db.raw.prepare("UPDATE principals SET revoked_at = ? WHERE id = 'p1'").run(at);
    expect(completeJob(db, "job-atomic", { ok: true }, at, {
      workerId: lease.lease_owner!,
      leaseGeneration: lease.lease_generation,
    })).toBe(true);
    expect(() => recordBoundMissionExecutionCost(db, {
      job: getJob(db, "job-atomic", "t1")!,
      sourceRunId: "session-atomic",
      createdAt: at,
      outcomeStatus: "accepted",
    })).toThrow("execution_cost_actor_tenant_mismatch");
    db.raw.exec("ROLLBACK");

    expect(getJob(db, "job-atomic", "t1")).toMatchObject({ status: "running" });
    expect(listActualExecutionCosts(db, "t1")).toEqual([]);
  });

  it("resolves a Fettler campaignId to the linked mission and skips an unlinked campaign", () => {
    const db = fixture();
    createWardenCampaign(db, {
      id: "campaign", tenantId: "t1", name: "Payments", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "wc-1", idempotencyKey: "wc-1",
      correlationId: "corr", createdAt: at,
    });
    expect(resolveBoundMissionForJob(db, job({ campaignId: "campaign" }))).toBeUndefined();
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign", missionId: "m1", actorPrincipalId: "p1",
      eventId: "link-f", idempotencyKey: "link-f", correlationId: "corr", createdAt: at,
    });
    const execute = job(
      { campaignId: "campaign", runId: "run-camp" },
      { id: "job-execute", type: "warden.campaign.execute-target" },
    );
    expect(resolveBoundMissionForJob(db, execute)?.id).toBe("m1");
    const task = bridgeClaimedJobToMissionTask(db, execute, at);
    expect(task).toMatchObject({
      missionId: "m1",
      status: "agent_working",
      taskType: "warden.campaign.execute-target",
    });
  });

  it("returns an agent_resume job task to agent_working on the next claim", () => {
    const db = fixture();
    const claimed = job({ missionId: "m1", goal: "repair", consumerId: "c1" });
    const working = bridgeClaimedJobToMissionTask(db, claimed, at)!;
    const exception = openTaskHandoff(db, {
      tenantId: "t1",
      missionId: "m1",
      taskId: working.id,
      reason: "architecture_decision_required",
      question: "Proceed?",
      context: "Advisory verification passed.",
      ownerPrincipalId: "p1",
      correlationId: "job-1",
      createdAt: at,
    });
    resolveTaskHandoff(db, {
      tenantId: "t1",
      priorExceptionId: exception.id,
      taskId: working.id,
      resolutionNote: "Yes.",
      decision: "Proceed",
      scope: "handoff_resolution:job-1",
      authorPrincipalId: "p1",
      correlationId: "job-1",
      createdAt: at,
    });
    expect(getMissionTask(db, "t1", working.id)?.status).toBe("agent_resume");
    const resumed = bridgeClaimedJobToMissionTask(db, claimed, at);
    expect(resumed).toMatchObject({ status: "agent_working", ownerType: "agent" });
  });
});
