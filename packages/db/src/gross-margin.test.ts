import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createUsageEntitlement,
  createUsagePriceVersion,
  creditUsage,
  enqueueJob,
  ensureMissionTaskForJob,
  insertPrincipal,
  insertTenant,
  listActualExecutionCosts,
  reconcileGrossMargin,
  recordActualExecutionCost,
  reserveUsage,
  settleUsageReservation,
  verifyExecutionCostIntegrity,
  type ActualExecutionCostInput,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const at = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setupDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-gross-margin-"));
  dirs.push(dir);
  const db = createDb(join(dir, "margin.sqlite"));
  dbs.push(db);
  setupTenant(db, "tenant_default", "a");
  return db;
}

function setupTenant(db: AppDb, tenantId: string, suffix: string) {
  if (tenantId !== "tenant_default") {
    insertTenant(db, {
      id: tenantId,
      slug: `tenant-${suffix}`,
      name: `Tenant ${suffix}`,
      createdAt: at,
    });
  }
  insertPrincipal(db, {
    id: `principal-${suffix}`,
    tenantId,
    kind: "service",
    subject: `cost-recorder-${suffix}`,
    displayName: `Cost recorder ${suffix}`,
    createdAt: at,
  });
  createUsagePriceVersion(db, {
    id: `price-${suffix}`,
    tenantId,
    formulaVersion: "mcu-v1",
    currency: "USD",
    pricePerMcuMoneyMicros: 20_000,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    contractReference: `contract-${suffix}`,
    createdAt: at,
  });
  createUsageEntitlement(db, {
    id: `entitlement-${suffix}`,
    tenantId,
    priceVersionId: `price-${suffix}`,
    quotaMcuMicros: 20_000_000,
    features: ["warden"],
    contractReference: `contract-${suffix}`,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    createdAt: at,
  });
}

function settle(
  db: AppDb,
  input: {
    tenantId?: string;
    suffix?: string;
    taskId?: string;
    campaignId?: string | null;
    actualMcuMicros?: number;
    actorPrincipalId?: string;
  } = {},
) {
  const tenantId = input.tenantId ?? "tenant_default";
  const suffix = input.suffix ?? "a";
  const taskId = input.taskId ?? "task-a";
  const reservation = reserveUsage(db, {
    id: `reservation-${suffix}`,
    tenantId,
    idempotencyKey: `reserve-${suffix}`,
    taskId,
    campaignId: input.campaignId === undefined ? "campaign-a" : input.campaignId,
    mcuMicros: 5_000_000,
    reason: "task ceiling",
    actorPrincipalId: input.actorPrincipalId ?? `principal-${suffix}`,
    createdAt: at,
  });
  return settleUsageReservation(db, {
    id: `settlement-${suffix}`,
    tenantId,
    idempotencyKey: `settle-${suffix}`,
    reservationId: reservation.id,
    actualMcuMicros: input.actualMcuMicros ?? 4_000_000,
    invoiceReference: `invoice-${suffix}`,
    reason: "actual accepted work",
    actorPrincipalId: input.actorPrincipalId ?? `principal-${suffix}`,
    createdAt: "2026-08-01T12:01:00.000Z",
  });
}

function costInput(
  overrides: Partial<ActualExecutionCostInput> = {},
): ActualExecutionCostInput {
  return {
    id: "cost-a",
    tenantId: "tenant_default",
    idempotencyKey: "cost-a",
    executionId: "execution-a",
    taskId: "task-a",
    campaignId: "campaign-a",
    taskClass: "api-migration",
    route: "frontier-primary",
    attemptNumber: 1,
    retryNumber: 0,
    fallbackFromExecutionId: null,
    outcomeStatus: "accepted",
    acceptedOutcomeId: "pull-request-a",
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    modelId: "model-a",
    modelPriceVersion: "model-price-v1",
    modelCostMoneyMicros: 1_000,
    cacheCostMoneyMicros: 100,
    gpuMillis: 500,
    gpuCostMoneyMicros: 200,
    graphCostMoneyMicros: 300,
    sandboxCostMoneyMicros: 400,
    verificationCostMoneyMicros: 500,
    currency: "USD",
    actorPrincipalId: "principal-a",
    createdAt: "2026-08-01T12:02:00.000Z",
    ...overrides,
  };
}

function bindMissionJob(db: AppDb, jobId: string, missionId = "mission-a"): string {
  createMission(db, {
    id: missionId,
    tenantId: "tenant_default",
    product: "fettler",
    triggerKind: "provider_change",
    objective: "Complete the billed work",
    ownerPrincipalId: "principal-a",
    eventId: `event-${missionId}`,
    idempotencyKey: `create-${missionId}`,
    correlationId: jobId,
    createdAt: at,
  });
  enqueueJob(db, {
    id: jobId,
    tenantId: "tenant_default",
    type: "agent.run",
    payload: { missionId },
    createdAt: at,
  });
  return ensureMissionTaskForJob(db, {
    tenantId: "tenant_default",
    jobId,
    missionId,
    taskType: "agent.run",
    acceptanceCriteria: "Produce the verified result.",
    risk: "medium",
    actorPrincipalId: "principal-a",
    assignedPrincipalId: "principal-a",
    createdAt: at,
    correlationId: jobId,
  }).id;
}

describe("actual execution cost and gross margin", () => {
  it("counts every retry and fallback exactly once and ties totals to both ledgers", () => {
    const db = setupDb();
    settle(db);
    const first = recordActualExecutionCost(db, costInput({
      id: "cost-first",
      idempotencyKey: "cost-first",
      executionId: "execution-first",
      outcomeStatus: "rejected",
      acceptedOutcomeId: null,
      modelCostMoneyMicros: 500,
      cacheCostMoneyMicros: 0,
      gpuCostMoneyMicros: 0,
      graphCostMoneyMicros: 0,
      sandboxCostMoneyMicros: 0,
      verificationCostMoneyMicros: 0,
    }));
    recordActualExecutionCost(db, costInput({
      id: "cost-retry",
      idempotencyKey: "cost-retry",
      executionId: "execution-retry",
      route: "frontier-primary",
      attemptNumber: 2,
      retryNumber: 1,
      outcomeStatus: "rejected",
      acceptedOutcomeId: null,
      modelCostMoneyMicros: 700,
      cacheCostMoneyMicros: 0,
      gpuCostMoneyMicros: 0,
      graphCostMoneyMicros: 0,
      sandboxCostMoneyMicros: 0,
      verificationCostMoneyMicros: 0,
    }));
    const fallbackInput = costInput({
      id: "cost-fallback",
      idempotencyKey: "cost-fallback",
      executionId: "execution-fallback",
      route: "adapter-fallback",
      attemptNumber: 3,
      retryNumber: 1,
      fallbackFromExecutionId: "execution-retry",
      modelCostMoneyMicros: 800,
      cacheCostMoneyMicros: 100,
      gpuCostMoneyMicros: 100,
      graphCostMoneyMicros: 100,
      sandboxCostMoneyMicros: 100,
      verificationCostMoneyMicros: 100,
    });
    const fallback = recordActualExecutionCost(db, fallbackInput);
    expect(recordActualExecutionCost(db, fallbackInput)).toEqual(fallback);
    expect(recordActualExecutionCost(db, {
      ...fallbackInput,
      createdAt: "2026-08-01T12:05:00.000Z",
    })).toEqual(fallback);
    expect(() => recordActualExecutionCost(db, {
      ...fallbackInput,
      modelCostMoneyMicros: fallbackInput.modelCostMoneyMicros + 1,
    })).toThrow("execution_cost_idempotency_conflict");
    expect(() => recordActualExecutionCost(db, {
      ...fallbackInput,
      id: "cost-fallback-duplicate",
      idempotencyKey: "cost-fallback-duplicate",
    })).toThrow("execution_cost_execution_conflict");

    const report = reconcileGrossMargin(db, "tenant_default");
    expect(report).toMatchObject({
      complete: true,
      settledMcuMicros: 4_000_000,
      settledRevenueMoneyMicros: 80_000,
      netRevenueMoneyMicros: 80_000,
      actualCostMoneyMicros: 2_500,
      exactGrossMarginMoneyMicros: 77_500,
      attributedGrossMarginMoneyMicros: 77_500,
      unattributedRevenueMoneyMicros: 0,
      usageIntegrity: { ok: true },
      costIntegrity: { ok: true, checked: 3, totalCostMoneyMicros: 2_500 },
    });
    expect(report.attributions.map((entry) => entry.executionId)).toEqual([
      "execution-first",
      "execution-retry",
      "execution-fallback",
    ]);
    expect(report.attributions.map((entry) => entry.attributedNetRevenueMoneyMicros)).toEqual([
      0,
      0,
      80_000,
    ]);
    expect(first.actorPrincipalId).toBe("principal-a");
    expect(verifyExecutionCostIntegrity(db, "tenant_default")).toMatchObject({ ok: true });
  });

  it("reduces recognized revenue by credits without changing actual cost", () => {
    const db = setupDb();
    settle(db);
    creditUsage(db, {
      id: "credit-a",
      tenantId: "tenant_default",
      idempotencyKey: "credit-a",
      taskId: "task-a",
      campaignId: "campaign-a",
      mcuMicrosDelta: -500_000,
      invoiceReference: "invoice-a",
      reason: "service credit",
      actorPrincipalId: "principal-a",
      createdAt: "2026-08-01T12:03:00.000Z",
    });
    recordActualExecutionCost(db, costInput());

    expect(reconcileGrossMargin(db, "tenant_default")).toMatchObject({
      complete: true,
      settledMcuMicros: 4_000_000,
      creditedMcuMicros: 500_000,
      settledRevenueMoneyMicros: 80_000,
      creditMoneyMicros: 10_000,
      netRevenueMoneyMicros: 70_000,
      actualCostMoneyMicros: 2_500,
      exactGrossMarginMoneyMicros: 67_500,
      attributedGrossMarginMoneyMicros: 67_500,
    });
  });

  it("reports missing cost and accepted outcome attribution instead of estimating", () => {
    const db = setupDb();
    settle(db);

    const report = reconcileGrossMargin(db, "tenant_default");
    expect(report.complete).toBe(false);
    expect(report.netRevenueMoneyMicros).toBe(80_000);
    expect(report.actualCostMoneyMicros).toBe(0);
    expect(report.exactGrossMarginMoneyMicros).toBeNull();
    expect(report.attributedGrossMarginMoneyMicros).toBeNull();
    expect(report.unattributedRevenueMoneyMicros).toBe(80_000);
    expect(report.attributions).toEqual([]);
    expect(report.incompleteAttributions.map((issue) => issue.code)).toEqual([
      "accepted_outcome_missing",
      "actual_cost_missing",
    ]);
  });

  it("keeps an execution-ID bridge closed when campaign attribution disagrees", () => {
    const db = setupDb();
    settle(db, { taskId: "job-a", campaignId: "campaign-a" });
    const missionTaskId = bindMissionJob(db, "job-a");
    recordActualExecutionCost(db, costInput({
      executionId: "job-a",
      taskId: missionTaskId,
      campaignId: "campaign-b",
      missionId: "mission-a",
    }));

    const report = reconcileGrossMargin(db, "tenant_default");
    expect(report.complete).toBe(false);
    expect(report.exactGrossMarginMoneyMicros).toBeNull();
    expect(report.attributedGrossMarginMoneyMicros).toBeNull();
    expect(report.unattributedRevenueMoneyMicros).toBe(80_000);
    expect(report.incompleteAttributions).toEqual([
      { code: "campaign_mismatch", taskId: "job-a", sourceId: null },
    ]);
    expect(report.attributions[0]).toMatchObject({
      executionId: "job-a",
      taskId: missionTaskId,
      campaignId: "campaign-b",
      attributedNetRevenueMoneyMicros: null,
      attributedGrossMarginMoneyMicros: null,
    });
  });

  it("does not trust a forged execution ID without durable job and MissionTask lineage", () => {
    const db = setupDb();
    settle(db, { suffix: "a", taskId: "job-a", campaignId: "campaign-a" });
    recordActualExecutionCost(db, costInput({
      executionId: "job-a",
      taskId: "mission-task-forged",
      missionId: null,
    }));

    const report = reconcileGrossMargin(db, "tenant_default");
    expect(report.complete).toBe(false);
    expect(report.exactGrossMarginMoneyMicros).toBeNull();
    expect(report.attributedGrossMarginMoneyMicros).toBeNull();
    expect(report.attributions[0]).toMatchObject({
      executionId: "job-a",
      taskId: "mission-task-forged",
      attributedNetRevenueMoneyMicros: null,
      attributedGrossMarginMoneyMicros: null,
    });
    expect(report.incompleteAttributions.map((issue) => issue.code)).toEqual([
      "accepted_outcome_missing",
      "actual_cost_missing",
      "settlement_missing",
    ]);
  });

  it("marks margin incomplete when any cost component is unmeasured", () => {
    const db = setupDb();
    settle(db);
    recordActualExecutionCost(db, costInput({
      cacheCostMoneyMicros: 0,
      cacheCostMeasured: false,
    }));

    const report = reconcileGrossMargin(db, "tenant_default");
    expect(report.complete).toBe(false);
    expect(report.actualCostMoneyMicros).toBe(2_400);
    expect(report.exactGrossMarginMoneyMicros).toBeNull();
    expect(report.attributedGrossMarginMoneyMicros).toBeNull();
    expect(report.unattributedRevenueMoneyMicros).toBe(80_000);
    expect(report.incompleteAttributions).toContainEqual({
      code: "execution_cost_component_unmeasured",
      taskId: "task-a",
      sourceId: "cost-a",
    });
    expect(report.attributions[0]).toMatchObject({
      attributedNetRevenueMoneyMicros: null,
      attributedGrossMarginMoneyMicros: null,
    });
  });

  it("enforces tenant isolation, actor ownership, idempotency, and append-only rows", () => {
    const db = setupDb();
    setupTenant(db, "tenant-b", "b");
    const entry = recordActualExecutionCost(db, costInput());
    expect(listActualExecutionCosts(db, "tenant_default")).toEqual([entry]);
    expect(listActualExecutionCosts(db, "tenant-b")).toEqual([]);
    expect(() => recordActualExecutionCost(db, costInput({
      id: "cost-wrong-actor",
      idempotencyKey: "cost-wrong-actor",
      executionId: "execution-wrong-actor",
      actorPrincipalId: "principal-b",
    }))).toThrow("execution_cost_actor_tenant_mismatch");

    const tenantB = recordActualExecutionCost(db, costInput({
      id: "cost-b",
      tenantId: "tenant-b",
      idempotencyKey: "cost-a",
      executionId: "execution-a",
      taskId: "task-b",
      campaignId: "campaign-b",
      acceptedOutcomeId: "pull-request-b",
      actorPrincipalId: "principal-b",
    }));
    expect(tenantB.tenantId).toBe("tenant-b");
    expect(reconcileGrossMargin(db, "tenant_default").actualCostMoneyMicros).toBe(2_500);
    expect(reconcileGrossMargin(db, "tenant-b").actualCostMoneyMicros).toBe(2_500);
    expect(() =>
      db.raw.prepare(
        "UPDATE actual_execution_cost_entries SET route = 'changed' WHERE id = 'cost-a'",
      ).run(),
    ).toThrow("actual_execution_cost_entries_append_only");
    expect(() =>
      db.raw.prepare("DELETE FROM actual_execution_cost_entries WHERE id = 'cost-a'").run(),
    ).toThrow("actual_execution_cost_entries_append_only");
  });
});
