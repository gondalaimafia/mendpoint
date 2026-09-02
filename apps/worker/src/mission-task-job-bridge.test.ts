import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createMissionMutationAuthority,
  createMissionTask,
  createWardenCampaign,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  getMissionTask,
  getMission,
  bindMissionScope,
  getRoutingLedgerForJob,
  getWardenModelReservation,
  insertPrincipal,
  linkFettlerCampaignToMission,
  listActualExecutionCosts,
  missionTaskIdForJob,
  openTaskHandoff,
  raiseMissionException,
  recordRoutingDecision,
  recordRoutingOutcome,
  reserveWardenModelCall,
  resolveTaskHandoff,
  transitionMissionTask,
  settleActiveWardenModelReservationsForFence,
  settleWardenModelCall,
  type AppDb,
} from "@mendpoint/db";
import {
  bridgeClaimedJobToMissionTask,
  handoffCompletedJobToMissionReview,
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

function seedRouting(db: AppDb, runId: string, jobId: string, costUsd = 0.05) {
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
    costUsd,
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

  it("recovers a never-observed prior lease as unmeasured instead of the reservation ceiling", () => {
    const db = fixture();
    enqueueJob(db, {
      id: "job-unknown-recovery",
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
      runId: "session-unknown:lease-1",
      taskKind: "agent.run",
      envelopeId: "envelope-unknown-first",
      policySnapshotId: "policy-unknown-first",
      taskSnapshotId: "snapshot-unknown-first",
      action: "route",
      selectedExecutorId: "executor-frontier",
      providerId: "provider-frontier",
      eliminated: [], fallback: [], breaker: [], handoffRequired: false,
      decision: { decisionId: "envelope-unknown-first" },
      createdAt: at,
    });
    const reservationId = "wdmodel-unknown-recovery";
    reserveWardenModelCall(db, {
      id: reservationId,
      tenantId: "t1",
      jobId: first.id,
      runId: "session-unknown",
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      callIndex: 1,
      requestDigest: digest("c"),
      provider: "provider-frontier",
      configuredModel: "model-a",
      endpointHost: "models.example",
      maximumInputTokens: 1_000,
      maximumOutputTokens: 200,
      maximumTotalTokens: 1_200,
      maximumCostUsd: 7,
      jobBudgetUsd: 20,
      observedAt: "2026-01-01T00:00:01.000Z",
    });
    // Process death between reserve and terminal: the fence sweep settles the
    // reservation `unknown` at its ceiling precisely because nothing was ever
    // observed from the provider. reported_cost_usd stays NULL.
    expect(settleActiveWardenModelReservationsForFence(db, {
      jobId: first.id,
      workerId: first.lease_owner!,
      leaseGeneration: first.lease_generation,
      observedAt: "2026-01-01T00:00:02.000Z",
      errorCode: "warden_model_job_failed",
    })).toBe(1);
    const settledBeforeRetry = getWardenModelReservation(db, "t1", reservationId)!;
    expect(settledBeforeRetry).toMatchObject({
      status: "unknown",
      reported_cost_usd: null,
      charged_cost_usd: 7,
    });
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

    // The pending routing row is still closed — the paid attempt is recovered —
    // but it carries no fabricated usage.
    expect(reconcilePriorPaidWardenAttempts(db, {
      job: retry,
      observedAt: "2026-01-01T00:00:06.000Z",
    })).toBe(1);
    expect(getRoutingLedgerForJob(db, retry.id, "t1")).toEqual([
      expect.objectContaining({
        run_id: "session-unknown:lease-1",
        outcome: "failed",
        error_code: "warden_routing_outcome_recovered_from_model_reservations",
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cost_usd: null,
      }),
    ]);
    // The append-only cost entry must not attest a measurement that never
    // happened, and must not charge the reservation ceiling as measured money.
    const costs = listActualExecutionCosts(db, "t1");
    expect(costs).toEqual([
      expect.objectContaining({
        executionId: "job-unknown-recovery:lease-1:attempt-1",
        attemptNumber: 1,
        modelCostMeasured: false,
        modelCostMoneyMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(costs[0]!.measurementProvenance.model).toMatch(/:cost_unmeasured$/);
    expect(getWardenModelReservation(db, "t1", reservationId)).toEqual(settledBeforeRetry);
  });

  it("rejects weak legacy paid-attempt evidence without creating immutable recovery rows", () => {
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
    const legacySettlementDigest = `sha256:${createHash("sha256").update(JSON.stringify({
      errorCode: "warden_model_job_failed",
      jobId: first.id,
      leaseGeneration: first.lease_generation,
      status: "unknown",
      workerId: first.lease_owner,
    })).digest("hex")}`;
    db.raw.prepare(
      `UPDATE fettler_model_reservations
       SET status = 'unknown', settlement_digest = ?, actual_model = NULL,
           body_request_id = NULL, header_request_id = NULL,
           reported_input_tokens = NULL, reported_output_tokens = NULL,
           reported_total_tokens = NULL, reported_cost_usd = NULL,
           charged_input_tokens = maximum_input_tokens,
           charged_output_tokens = maximum_output_tokens,
           charged_total_tokens = maximum_total_tokens,
           charged_cost_usd = maximum_cost_usd,
           error_code = 'warden_model_job_failed'
       WHERE id = ?`,
    ).run(legacySettlementDigest, "wdmodel-paid-tampered");
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

  it.each(["warden.candidate.deliver", "warden.candidate.update"])(
    "quarantines legacy mission-bound %s jobs instead of fabricating task authority",
    (type) => {
      const db = fixture();
      const legacy = job({ missionId: "m1", deliveryId: "delivery-1", updateId: "update-1", cycleId: "cycle-1", runId: "run-1" },
        { id: `legacy-${type}`, type });
      expect(bridgeClaimedJobToMissionTask(db, legacy, at)).toBeUndefined();
      expect(getMissionTask(db, "t1", missionTaskIdForJob(legacy.id))).toBeUndefined();
    },
  );

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

  it("retains retry lineage through a measured zero-cost prior execution", () => {
    const db = fixture();
    const claimed = job({ missionId: "m1", goal: "repair", consumerId: "c1" });
    bridgeClaimedJobToMissionTask(db, claimed, at);

    const unchargedEnvelope = seedRouting(db, "session-uncharged", "job-1", 0);
    expect(recordBoundMissionExecutionCost(db, {
      job: claimed,
      routingRunId: "session-uncharged",
      routingEnvelopeId: unchargedEnvelope,
      createdAt: at,
    })).toMatchObject({ totalCostMoneyMicros: 0, fallbackFromExecutionId: null });

    const paidEnvelope = seedRouting(db, "session-paid-retry", "job-1", 0.05);
    expect(recordBoundMissionExecutionCost(db, {
      job: { ...claimed, attempts: 2 },
      routingRunId: "session-paid-retry",
      routingEnvelopeId: paidEnvelope,
      createdAt: at,
    })).toMatchObject({
      executionId: "job-1:lease-2:attempt-2",
      totalCostMoneyMicros: 50_000,
      fallbackFromExecutionId: "job-1:lease-1:attempt-1",
    });

    const laterEnvelope = seedRouting(db, "session-later-retry", "job-1", 0.04);
    expect(recordBoundMissionExecutionCost(db, {
      job: { ...claimed, attempts: 3 },
      routingRunId: "session-later-retry",
      routingEnvelopeId: laterEnvelope,
      createdAt: at,
    })).toMatchObject({
      executionId: "job-1:lease-3:attempt-3",
      fallbackFromExecutionId: "job-1:lease-2:attempt-2",
    });
  });

  it("does not wedge a later paid lease when no prior cost row exists", () => {
    const db = fixture();
    const claimed = job({ missionId: "m1", goal: "repair", consumerId: "c1" });
    bridgeClaimedJobToMissionTask(db, claimed, at);
    const paidEnvelope = seedRouting(db, "session-paid-without-prior", "job-1", 0.05);

    expect(recordBoundMissionExecutionCost(db, {
      job: { ...claimed, attempts: 2 },
      routingRunId: "session-paid-without-prior",
      routingEnvelopeId: paidEnvelope,
      createdAt: at,
    })).toMatchObject({
      executionId: "job-1:lease-2:attempt-2",
      totalCostMoneyMicros: 50_000,
      fallbackFromExecutionId: null,
    });
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

  // Scope note: this proves the DB primitive participates in the caller's
  // transaction, so a failed cost write leaves no partial row. It does NOT
  // prove the classifier path: in production `recordJobMissionExecutionCost`
  // only ever runs after `applyRoutingOutcome` has set
  // `routingFinalizationStarted`, so `mcu_accounting_persistence_failed` is
  // always wrapped in `WardenAtomicFinalizationError` and rethrown at
  // cli.ts:4423 before `classifyJobFailure` sees it. That failure recovers by
  // lease expiry and `reconcilePriorPaidWardenAttempts`, not by a `failJob`
  // retry with backoff. (`mcu_settlement_persistence_failed` from
  // `settleFanoutRunUsage` does reach the classifier.)
  it("joins the terminal job transaction so a failed cost write leaves no partial row", () => {
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

  // SF-F. The three mission_task_job_authority_mismatch throws in
  // bridgeClaimedJobToMissionTask had no test: neutralising all three left the
  // worker and api suites green. :145 is the CROSS-MISSION authorization check -
  // it is what stops a job from driving a MissionTask under authority minted for
  // a different Mission, or under authority whose Mission was never claimed on
  // the payload at all.
  function scopedMission(db: AppDb) {
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('scm-x', 't1', 'github', 'app://1', '1', 'GitHub', ?, ?)`).run(at, at);
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-x', 't1', 'scm-x', '1', 'acme', 'sdk', 'main', 'main', 'production', 30, 'ready', ?, ?)`)
      .run(at, at);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-x', 't1', 'repo-x', 'main', ?, ?, 'C:\snapshot', 'reject', 'reject', '[]', 1, ?,
       '2099-01-01T00:00:00.000Z')`).run("a".repeat(40), `sha256:${"b".repeat(64)}`, at);
    bindMissionScope(db, { tenantId: "t1", missionId: "m1", repositoryId: "repo-x",
      snapshotId: "snapshot-x", actorPrincipalId: "p1", eventId: "e-scope-x",
      idempotencyKey: "c-scope-x", correlationId: "corr", createdAt: at });
    let task = createMissionTask(db, { id: "mt-x", tenantId: "t1", missionId: "m1",
      taskType: "code_migration", acceptanceCriteria: "Tests pass", risk: "medium",
      actorPrincipalId: "p1", eventId: "e-x-create", idempotencyKey: "c-x-create",
      correlationId: "corr", createdAt: at });
    task = transitionMissionTask(db, { tenantId: "t1", taskId: task.id,
      expectedRevision: task.revision, to: "agent_assigned", actorPrincipalId: "p1",
      eventId: "e-x-assign", idempotencyKey: "c-x-assign", correlationId: "corr", createdAt: at });
    task = transitionMissionTask(db, { tenantId: "t1", taskId: task.id,
      expectedRevision: task.revision, to: "agent_working", actorPrincipalId: "p1",
      eventId: "e-x-work", idempotencyKey: "c-x-work", correlationId: "corr", createdAt: at });
    return { task, authority: createMissionMutationAuthority({
      mission: getMission(db, "t1", "m1")!, task, repositoryId: "repo-x",
      snapshotId: "snapshot-x", resolvedSha: "a".repeat(40) }) };
  }

  it("refuses authority minted for a different Mission than the payload claims", () => {
    const db = fixture();
    const { authority } = scopedMission(db);
    createMission(db, { id: "m2", tenantId: "t1", product: "fettler",
      triggerKind: "provider_change", objective: "Other", ownerPrincipalId: "p1",
      eventId: "e-m2", idempotencyKey: "c-m2", correlationId: "corr", createdAt: at });

    const crossed = job({ missionId: "m2", missionAuthority: authority, goal: "repair", consumerId: "c1" },
      { id: "job-crossed" });
    expect(() => bridgeClaimedJobToMissionTask(db, crossed, at))
      .toThrow("mission_task_job_authority_mismatch");
    expect(getMissionTask(db, "t1", "mt-x")?.status).toBe("agent_working");
  });

  it("refuses authority on a job that never claimed the Mission explicitly", () => {
    const db = fixture();
    const { authority } = scopedMission(db);
    createWardenCampaign(db, { id: "campaign-x", tenantId: "t1", name: "Payments",
      ownerPrincipalId: "p1", concurrencyLimit: 1, completionPolicy: "all",
      eventId: "wc-x", idempotencyKey: "wc-x", correlationId: "corr", createdAt: at });
    linkFettlerCampaignToMission(db, { tenantId: "t1", campaignId: "campaign-x", missionId: "m1",
      actorPrincipalId: "p1", eventId: "link-x", idempotencyKey: "link-x",
      correlationId: "corr", createdAt: at });

    // The campaign resolves to m1, but `missionId` is absent, so the claimed
    // binding does not match the authority being presented.
    const implicit = job({ campaignId: "campaign-x", missionAuthority: authority, runId: "run-x" },
      { id: "job-implicit" });
    expect(() => bridgeClaimedJobToMissionTask(db, implicit, at))
      .toThrow("mission_task_job_authority_mismatch");
  });

  it("refuses to drive a task whose live status is not the one the authority resumes", () => {
    const db = fixture();
    const { task } = scopedMission(db);
    const parked = transitionMissionTask(db, { tenantId: "t1", taskId: task.id,
      expectedRevision: task.revision, to: "human_review_required", actorPrincipalId: "p1",
      handoffReason: "candidate_review_required",
      eventId: "e-x-park", idempotencyKey: "c-x-park", correlationId: "corr", createdAt: at });
    const authority = createMissionMutationAuthority({ mission: getMission(db, "t1", "m1")!,
      task: parked, repositoryId: "repo-x", snapshotId: "snapshot-x", resolvedSha: "a".repeat(40) });

    const claimed = job({ missionId: "m1", missionAuthority: authority, goal: "repair", consumerId: "c1" },
      { id: "job-parked" });
    expect(() => bridgeClaimedJobToMissionTask(db, claimed, at))
      .toThrow("mission_task_job_authority_mismatch");
    expect(getMissionTask(db, "t1", "mt-x")?.status).toBe("human_review_required");
  });

  // PROOF that the third mission_task_job_authority_mismatch throw - the
  // `if (!exactTask)` guard - is UNREACHABLE, not merely untested. Reaching it
  // needs a truthy authority.taskId whose task row is absent, but
  // assertMissionMutationAuthority evaluates exactly that first and throws
  // `mission_mutation_authority_stale`, so the bridge never observes it. This
  // test pins WHICH code a caller gets, so if that ordering ever changes the
  // change is visible here rather than silently making a guard live.
  it("rejects authority naming a task that does not exist, before the bridge can see it", () => {
    const db = fixture();
    const { task, authority } = scopedMission(db);
    const missing = { ...authority, taskId: "mt-does-not-exist" };
    const claimed = job({ missionId: "m1", missionAuthority: missing, goal: "repair", consumerId: "c1" },
      { id: "job-missing-task" });

    expect(() => bridgeClaimedJobToMissionTask(db, claimed, at))
      .toThrow("mission_mutation_authority_stale");
    expect(getMissionTask(db, "t1", task.id)?.status).toBe("agent_working");
  });

  it("drives the exact reviewed enrollment task through two real queued successor claims", () => {
    const db = fixture();
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('scm-1', 't1', 'github', 'app://1', '1', 'GitHub', ?, ?)`)
      .run(at, at);
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-1', 't1', 'scm-1', '1', 'acme', 'sdk', 'main', 'main',
       'production', 30, 'ready', ?, ?)`)
      .run(at, at);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-1', 't1', 'repo-1', 'main', ?, ?, 'C:\\snapshot',
       'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
      .run("a".repeat(40), `sha256:${"b".repeat(64)}`, at);
    bindMissionScope(db, {
      tenantId: "t1", missionId: "m1", repositoryId: "repo-1", snapshotId: "snapshot-1",
      actorPrincipalId: "p1", eventId: "e-scope", idempotencyKey: "c-scope",
      correlationId: "corr", createdAt: at,
    });
    let task = createMissionTask(db, {
      id: "mt-reviewed", tenantId: "t1", missionId: "m1", taskType: "code_migration",
      acceptanceCriteria: "Tests pass", risk: "medium", actorPrincipalId: "p1",
      eventId: "e-reviewed-create", idempotencyKey: "c-reviewed-create", correlationId: "corr", createdAt: at,
    });
    task = transitionMissionTask(db, {
      tenantId: "t1", taskId: task.id, expectedRevision: task.revision, to: "agent_assigned",
      actorPrincipalId: "p1", eventId: "e-reviewed-assign", idempotencyKey: "c-reviewed-assign",
      correlationId: "corr", createdAt: at,
    });
    task = transitionMissionTask(db, {
      tenantId: "t1", taskId: task.id, expectedRevision: task.revision, to: "agent_working",
      actorPrincipalId: "p1", eventId: "e-reviewed-work", idempotencyKey: "c-reviewed-work",
      correlationId: "corr", createdAt: at,
    });
    const firstBlocker = openTaskHandoff(db, {
      tenantId: "t1", missionId: "m1", taskId: task.id, reason: "architecture_decision_required",
      question: "Regenerate?", context: "First candidate needs review.", ownerPrincipalId: "p1",
      correlationId: "review-1", createdAt: at,
    });
    resolveTaskHandoff(db, {
      tenantId: "t1", priorExceptionId: firstBlocker.id, taskId: task.id,
      resolutionNote: "Regenerate", decision: "Regenerate", scope: "handoff_resolution:first",
      authorPrincipalId: "p1", correlationId: "review-1", createdAt: at,
    });

    for (const cycle of [1, 2]) {
      const currentTask = getMissionTask(db, "t1", task.id)!;
      const authority = createMissionMutationAuthority({
        mission: getMission(db, "t1", "m1")!, task: currentTask, repositoryId: "repo-1",
        snapshotId: "snapshot-1", resolvedSha: "a".repeat(40),
      });
      enqueueJob(db, {
        id: `successor-${cycle}`, tenantId: "t1", type: "agent.run", createdAt: at,
        payload: { missionId: "m1", missionAuthority: authority, sessionId: `run-${cycle}`,
          goal: "Regenerate the reviewed candidate", consumerId: "consumer-1" },
      });
      const claimed = claimNextJob(db, ["agent.run"], {
        tenantId: "t1", workerId: `worker-${cycle}`, leaseMs: 60_000, now: at,
      })!;
      expect(bridgeClaimedJobToMissionTask(db, claimed, at)).toMatchObject({
        id: task.id, status: "agent_working",
      });
      const handed = handoffCompletedJobToMissionReview(db, claimed, at)!;
      expect(handed).toMatchObject({ id: task.id, status: "human_review_required" });
      if (cycle === 1) {
        const blocker = db.raw.prepare(`SELECT id FROM mission_exceptions
          WHERE tenant_id = 't1' AND mission_id = 'm1' AND task_id = ? AND status = 'open'
            AND NOT EXISTS (SELECT 1 FROM mission_exceptions successor
              WHERE successor.tenant_id = mission_exceptions.tenant_id
                AND successor.supersedes_id = mission_exceptions.id)
          ORDER BY created_at DESC, id DESC LIMIT 1`).get(task.id) as { id: string };
        resolveTaskHandoff(db, {
          tenantId: "t1", priorExceptionId: blocker.id, taskId: task.id,
          resolutionNote: "Regenerate again", decision: "Regenerate again",
          scope: "handoff_resolution:second", authorPrincipalId: "p1",
          correlationId: "review-2", createdAt: at,
        });
      }
    }
  });
});
