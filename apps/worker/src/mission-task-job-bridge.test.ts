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
  failJob,
  getJob,
  getMissionTask,
  getRoutingLedgerForJob,
  getWardenModelReservation,
  insertPrincipal,
  linkFettlerCampaignToMission,
  listActualExecutionCosts,
  missionTaskIdForJob,
  openTaskHandoff,
  recordRoutingDecision,
  recordRoutingOutcome,
  reserveWardenModelCall,
  resolveTaskHandoff,
  settleWardenModelCall,
  type AppDb,
} from "@mendpoint/db";
import {
  bridgeClaimedJobToMissionTask,
  reconcilePriorPaidWardenAttempts,
  recordBoundMissionExecutionCost,
  resolveBoundMissionForJob,
} from "./mission-task-job-bridge.js";

const at = "2026-01-01T00:00:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
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
  extra: { id?: string; type?: string; tenantId?: string; attempts?: number; resultJson?: string } = {},
) {
  return {
    id: extra.id ?? "job-1",
    tenant_id: extra.tenantId ?? "t1",
    type: extra.type ?? "agent.run",
    payload_json: JSON.stringify(payload),
    attempts: extra.attempts ?? 1,
    result_json: extra.resultJson ?? null,
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
    executorId: "executor-frontier",
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    costUsd: 0.05,
    completedAt: at,
    observedAt: at,
  });
  return envelopeId;
}

describe("mission-task job bridge", () => {
  it("imports one exact paid prior lease when its routing outcome rolled back", () => {
    const db = fixture();
    enqueueJob(db, {
      id: "job-paid-recovery",
      tenantId: "t1",
      type: "agent.run",
      payload: { missionId: "m1", goal: "repair", consumerId: "c1" },
      createdAt: at,
    });
    const first = claimNextJob(db, ["agent.run"], {
      tenantId: "t1",
      workerId: "worker-first",
      leaseMs: 60_000,
      now: at,
    })!;
    bridgeClaimedJobToMissionTask(db, first, at);
    recordRoutingDecision(db, {
      tenantId: "t1",
      jobId: first.id,
      runId: "session-paid:lease-1",
      taskKind: "agent.run",
      envelopeId: "envelope-paid-first",
      policySnapshotId: "policy-paid-first",
      taskSnapshotId: "snapshot-paid-first",
      action: "route",
      selectedExecutorId: "executor-frontier",
      providerId: "provider-frontier",
      eliminated: [], fallback: [], breaker: [], handoffRequired: false,
      decision: { decisionId: "envelope-paid-first" },
      createdAt: at,
    });
    const reservationId = "wdmodel-paid-recovery";
    reserveWardenModelCall(db, {
      id: reservationId,
      tenantId: "t1",
      jobId: first.id,
      runId: "session-paid",
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      callIndex: 1,
      requestDigest: digest("a"),
      provider: "provider-frontier",
      configuredModel: "model-a",
      endpointHost: "models.example",
      maximumInputTokens: 1_000,
      maximumOutputTokens: 200,
      maximumTotalTokens: 1_200,
      maximumCostUsd: 1,
      jobBudgetUsd: 2,
      observedAt: "2026-01-01T00:00:01.000Z",
    });
    settleWardenModelCall(db, {
      tenantId: "t1",
      jobId: first.id,
      reservationId,
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      status: "succeeded",
      actualModel: "model-a-2026",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUsd: 0.5,
      observedAt: "2026-01-01T00:00:02.000Z",
    });
    const settledBeforeRetry = getWardenModelReservation(db, "t1", reservationId)!;
    expect(failJob(db, first.id, "terminal transaction rolled back", "2026-01-01T00:00:03.000Z", {
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      errorCode: "mcu_accounting_persistence_failed",
      retryable: true,
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
    }).status).toBe("pending");
    const retry = claimNextJob(db, ["agent.run"], {
      tenantId: "t1",
      workerId: "worker-retry",
      leaseMs: 60_000,
      now: "2026-01-01T00:00:05.000Z",
    })!;
    expect(retry.lease_generation).toBe(2);

    expect(reconcilePriorPaidWardenAttempts(db, {
      job: retry,
      observedAt: "2026-01-01T00:00:06.000Z",
    })).toBe(1);
    expect(reconcilePriorPaidWardenAttempts(db, {
      job: retry,
      observedAt: "2026-01-01T00:00:07.000Z",
    })).toBe(0);
    expect(getRoutingLedgerForJob(db, retry.id, "t1")).toEqual([
      expect.objectContaining({
        run_id: "session-paid:lease-1",
        outcome: "failed",
        error_code: "warden_routing_outcome_recovered_from_model_reservations",
        input_tokens: 500,
        output_tokens: 100,
        total_tokens: 600,
        cost_usd: 0.5,
      }),
    ]);
    expect(listActualExecutionCosts(db, "t1")).toEqual([
      expect.objectContaining({
        executionId: "job-paid-recovery:lease-1:attempt-1",
        attemptNumber: 1,
        modelCostMoneyMicros: 500_000,
      }),
    ]);
    expect(getWardenModelReservation(db, "t1", reservationId)).toEqual(settledBeforeRetry);
  });

  it("rejects tampered paid-attempt evidence without creating immutable recovery rows", () => {
    const db = fixture();
    enqueueJob(db, {
      id: "job-paid-tampered",
      tenantId: "t1",
      type: "agent.run",
      payload: { missionId: "m1", goal: "repair", consumerId: "c1" },
      createdAt: at,
    });
    const first = claimNextJob(db, ["agent.run"], {
      tenantId: "t1",
      workerId: "worker-first",
      leaseMs: 60_000,
      now: at,
    })!;
    bridgeClaimedJobToMissionTask(db, first, at);
    recordRoutingDecision(db, {
      tenantId: "t1",
      jobId: first.id,
      runId: "session-tampered:lease-1",
      taskKind: "agent.run",
      envelopeId: "envelope-paid-tampered",
      policySnapshotId: "policy-paid-tampered",
      taskSnapshotId: "snapshot-paid-tampered",
      action: "route",
      selectedExecutorId: "executor-frontier",
      providerId: "provider-frontier",
      eliminated: [], fallback: [], breaker: [], handoffRequired: false,
      decision: { decisionId: "envelope-paid-tampered" },
      createdAt: at,
    });
    reserveWardenModelCall(db, {
      id: "wdmodel-paid-tampered",
      tenantId: "t1",
      jobId: first.id,
      runId: "session-tampered",
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      callIndex: 1,
      requestDigest: digest("b"),
      provider: "provider-frontier",
      configuredModel: "model-a",
      endpointHost: "models.example",
      maximumInputTokens: 1_000,
      maximumOutputTokens: 200,
      maximumTotalTokens: 1_200,
      maximumCostUsd: 1,
      jobBudgetUsd: 2,
      observedAt: "2026-01-01T00:00:01.000Z",
    });
    settleWardenModelCall(db, {
      tenantId: "t1",
      jobId: first.id,
      reservationId: "wdmodel-paid-tampered",
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      status: "succeeded",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUsd: 0.5,
      observedAt: "2026-01-01T00:00:02.000Z",
    });
    db.raw.prepare(
      "UPDATE fettler_model_reservations SET charged_cost_usd = ? WHERE id = ?",
    ).run(0.6, "wdmodel-paid-tampered");
    failJob(db, first.id, "terminal transaction rolled back", "2026-01-01T00:00:03.000Z", {
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      errorCode: "mcu_accounting_persistence_failed",
      retryable: true,
      baseDelayMs: 1_000,
      maxDelayMs: 1_000,
    });
    const retry = claimNextJob(db, ["agent.run"], {
      tenantId: "t1",
      workerId: "worker-retry",
      leaseMs: 60_000,
      now: "2026-01-01T00:00:05.000Z",
    })!;

    expect(() => reconcilePriorPaidWardenAttempts(db, {
      job: retry,
      observedAt: "2026-01-01T00:00:06.000Z",
    })).toThrow("warden_paid_attempt_evidence_invalid");
    expect(getRoutingLedgerForJob(db, retry.id, "t1")).toEqual([
      expect.objectContaining({ outcome: null }),
    ]);
    expect(listActualExecutionCosts(db, "t1")).toEqual([]);
  });

  it("is a no-op when the job has no bound mission", () => {
    const db = fixture();
    const unbound = job({ goal: "repair", consumerId: "c1" });
    expect(resolveBoundMissionForJob(db, unbound)).toBeUndefined();
    expect(bridgeClaimedJobToMissionTask(db, unbound, at)).toBeUndefined();
    expect(recordBoundMissionExecutionCost(db, {
      job: unbound,
      routingRunId: "run-1",
      routingEnvelopeId: "envelope-run-1",
      createdAt: at,
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

    const firstEnvelope = seedRouting(db, "session-1", "job-1");
    const cost = recordBoundMissionExecutionCost(db, {
      job: claimed,
      routingRunId: "session-1",
      routingEnvelopeId: firstEnvelope,
      createdAt: at,
    });
    expect(cost).toMatchObject({
      missionId: "m1",
      taskId: missionTaskIdForJob("job-1"),
      executionId: "job-1:lease-1:attempt-1",
      route: "fettler",
      taskClass: "agent.run",
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
      modelCostMeasured: true,
      modelCostMoneyMicros: 50_000,
    });
    expect(recordBoundMissionExecutionCost(db, {
      job: claimed,
      routingRunId: "session-1",
      routingEnvelopeId: firstEnvelope,
      createdAt: at,
    })?.id).toBe(cost!.id);
    const secondEnvelope = seedRouting(db, "session-2", "job-1");
    const retry = recordBoundMissionExecutionCost(db, {
      job: { ...claimed, attempts: 2 },
      routingRunId: "session-2",
      routingEnvelopeId: secondEnvelope,
      createdAt: at,
    });
    expect(retry).toMatchObject({
      executionId: "job-1:lease-2:attempt-2",
      attemptNumber: 2,
      retryNumber: 1,
      fallbackFromExecutionId: "job-1:lease-1:attempt-1",
      outcomeStatus: "unresolved",
    });
    expect(listActualExecutionCosts(db, "t1")).toHaveLength(2);
  });

  it("does not infer acceptance from a review-first no-action completion", () => {
    const db = fixture();
    const noAction = job(
      { missionId: "m1", goal: "review", consumerId: "c1" },
      { resultJson: JSON.stringify({ ok: true, status: "no_action" }) },
    );
    bridgeClaimedJobToMissionTask(db, noAction, at);
    const noActionEnvelope = seedRouting(db, "session-no-action", "job-1");
    expect(recordBoundMissionExecutionCost(db, {
      job: noAction,
      routingRunId: "session-no-action",
      routingEnvelopeId: noActionEnvelope,
      createdAt: at,
    })).toMatchObject({ outcomeStatus: "unresolved", acceptedOutcomeId: null });
  });

  it("joins the terminal job transaction so accounting failures remain retryable", () => {
    const db = fixture();
    const failed = job(
      { missionId: "m1", goal: "repair", consumerId: "c1" },
      { id: "job-rejected" },
    );
    bridgeClaimedJobToMissionTask(db, failed, at);
    const rejectedEnvelope = seedRouting(db, "session-rejected", "job-rejected");

    db.raw.exec("BEGIN IMMEDIATE");
    const rejected = recordBoundMissionExecutionCost(db, {
      job: failed,
      routingRunId: "session-rejected",
      routingEnvelopeId: rejectedEnvelope,
      createdAt: at,
    });
    expect(rejected).toMatchObject({
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
    });
    db.raw.exec("ROLLBACK");
    expect(listActualExecutionCosts(db, "t1")).toEqual([]);

    expect(recordBoundMissionExecutionCost(db, {
      job: failed,
      routingRunId: "session-rejected",
      routingEnvelopeId: rejectedEnvelope,
      createdAt: at,
    })).toMatchObject({ outcomeStatus: "unresolved" });
  });

  it("rolls back terminal job state when immutable cost persistence fails", () => {
    const db = fixture();
    const claimedJob = job(
      { missionId: "m1", goal: "repair", consumerId: "c1" },
      { id: "job-atomic" },
    );
    bridgeClaimedJobToMissionTask(db, claimedJob, at);
    const atomicEnvelope = seedRouting(db, "session-atomic", "job-atomic");
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
      routingRunId: "session-atomic",
      routingEnvelopeId: atomicEnvelope,
      createdAt: at,
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
