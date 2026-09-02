import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  appendDomainEvent,
  createMission,
  createUsageEntitlement,
  createUsageFinanceAuthorization,
  createUsagePriceVersion,
  creditUsage,
  enqueueJob,
  ensureMissionTaskForJob,
  insertPrincipal,
  insertTenant,
  insertArtifactManifest,
  insertReviewDecision,
  listActualExecutionCosts,
  listExecutionCostOutcomes,
  reconcileGrossMargin,
  recordActualExecutionCost,
  recordExecutionCostOutcome,
  reserveUsage,
  settleUsageReservation,
  verifyExecutionCostIntegrity,
  verifyExecutionOutcomeIntegrity,
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

function financeAuthorization(db: AppDb, input: {
  tenantId: string;
  actorPrincipalId: string;
  idempotencyKey: string;
  mcuMicrosDelta: number;
  invoiceReference: string;
  reason: string;
}) {
  const authorization = createUsageFinanceAuthorization(db, {
    id: `finance-${input.idempotencyKey}`,
    tenantId: input.tenantId,
    approvedByPrincipalId: input.actorPrincipalId,
    actorPrincipalId: input.actorPrincipalId,
    entryType: "credit",
    invoiceReference: input.invoiceReference,
    entryIdempotencyKey: input.idempotencyKey,
    mcuMicrosDelta: input.mcuMicrosDelta,
    reason: input.reason,
    approvedAt: "2026-08-01T12:02:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
  });
  return {
    financeAuthorizationId: authorization.id,
    financeAuthorizationDigest: authorization.authorizationDigest,
  };
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
    const creditInput = {
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
    } as const;
    creditUsage(db, { ...creditInput, ...financeAuthorization(db, creditInput) });
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

  it("preserves rejected, corrected, and rolled-back outcomes as append-only authority", () => {
    const db = setupDb();
    settle(db);
    const recordedCost = recordActualExecutionCost(db, costInput({
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
    }));
    const outcome = (suffix: string, input: {
      outcomeStatus: "rejected" | "corrected" | "rolled_back";
      acceptedOutcomeId?: string | null;
      authorityKind: "reviewer" | "rollback";
      authorityDigest: string;
    }) => {
      let authorityDigest: string;
      let authorityEvidenceId: string;
      if (input.authorityKind === "reviewer") {
        authorityEvidenceId = `review-${suffix}`;
        const artifactId = input.acceptedOutcomeId ?? `rejected-artifact-${suffix}`;
        const content = JSON.stringify({
          suffix,
          decision: input.outcomeStatus,
          costEntryId: recordedCost.id,
          costEntryHash: recordedCost.entryHash,
        });
        authorityDigest = createHash("sha256").update(content).digest("hex");
        insertArtifactManifest(db, { id: artifactId, tenantId: "tenant_default",
          kind: "review-evidence", schemaVersion: 1, sha256: authorityDigest,
          mediaType: "application/json", sizeBytes: Buffer.byteLength(content),
          storageRef: `evidence://${artifactId}`, content, producerPrincipalId: "principal-a",
          createdAt: `2026-08-01T12:0${3 + listExecutionCostOutcomes(db, "tenant_default").length}:00.000Z` });
        insertReviewDecision(db, { id: authorityEvidenceId, tenantId: "tenant_default",
          subjectType: "execution_cost", subjectId: "execution-a", candidateArtifactId: artifactId,
          reviewerPrincipalId: "principal-a",
          decision: input.outcomeStatus === "rejected" ? "reject" : "approve",
          rationale: "Durable test outcome", createdAt: `2026-08-01T12:0${3 + listExecutionCostOutcomes(db, "tenant_default").length}:00.000Z` });
      } else {
        authorityEvidenceId = `rollback-${suffix}`;
        const event = appendDomainEvent(db, { id: authorityEvidenceId, tenantId: "tenant_default",
          schemaVersion: 1, eventType: "execution_cost.rolled_back", aggregateType: "execution_cost",
          aggregateId: "execution-a", actorPrincipalId: "principal-a", correlationId: "execution-a",
          idempotencyKey: `rollback-${suffix}`, payload: {
            costEntryId: recordedCost.id,
            costEntryHash: recordedCost.entryHash,
          },
          createdAt: `2026-08-01T12:0${3 + listExecutionCostOutcomes(db, "tenant_default").length}:00.000Z` });
        authorityDigest = event.row.event_hash;
      }
      return recordExecutionCostOutcome(db, {
      id: `outcome-${suffix}`,
      tenantId: "tenant_default",
      idempotencyKey: `outcome-${suffix}`,
      executionId: "execution-a",
      actorPrincipalId: "principal-a",
      createdAt: `2026-08-01T12:0${3 + listExecutionCostOutcomes(db, "tenant_default").length}:00.000Z`,
      ...input,
      authorityEvidenceId,
      authorityDigest,
    });
    };

    outcome("rejected", {
      outcomeStatus: "rejected",
      authorityKind: "reviewer",
      authorityDigest: "a".repeat(64),
    });
    outcome("rejected-again", {
      outcomeStatus: "rejected",
      authorityKind: "reviewer",
      authorityDigest: "a".repeat(64),
    });
    expect(verifyExecutionOutcomeIntegrity(db, "tenant_default")).toEqual({ ok: true, checked: 2 });
    expect(reconcileGrossMargin(db, "tenant_default").complete).toBe(false);
    outcome("corrected", {
      outcomeStatus: "corrected",
      acceptedOutcomeId: "pull-request-corrected",
      authorityKind: "reviewer",
      authorityDigest: "b".repeat(64),
    });
    outcome("corrected-again", {
      outcomeStatus: "corrected",
      acceptedOutcomeId: "pull-request-corrected-again",
      authorityKind: "reviewer",
      authorityDigest: "b".repeat(64),
    });
    expect(reconcileGrossMargin(db, "tenant_default")).toMatchObject({
      complete: true,
      exactGrossMarginMoneyMicros: 77_500,
      attributions: [{ outcomeStatus: "corrected", acceptedOutcomeId: "pull-request-corrected-again" }],
    });
    outcome("rolled-back", {
      outcomeStatus: "rolled_back",
      authorityKind: "rollback",
      authorityDigest: "c".repeat(64),
    });
    outcome("rolled-back-again", {
      outcomeStatus: "rolled_back",
      authorityKind: "rollback",
      authorityDigest: "c".repeat(64),
    });
    expect(reconcileGrossMargin(db, "tenant_default")).toMatchObject({
      complete: false,
      exactGrossMarginMoneyMicros: null,
      attributions: [{ outcomeStatus: "rolled_back", acceptedOutcomeId: null }],
    });
    expect(listExecutionCostOutcomes(db, "tenant_default", "execution-a").map((row) => row.outcomeStatus))
      .toEqual(["rejected", "rejected", "corrected", "corrected", "rolled_back", "rolled_back"]);
    expect(verifyExecutionOutcomeIntegrity(db, "tenant_default")).toEqual({ ok: true, checked: 6 });
    expect(() => db.raw.prepare(
      "UPDATE actual_execution_cost_outcomes SET outcome_status = 'accepted' WHERE id = 'outcome-rejected'",
    ).run()).toThrow("actual_execution_cost_outcomes_append_only");

    db.raw.exec("DROP TRIGGER actual_execution_cost_outcomes_append_only_update");
    db.raw.prepare(
      "UPDATE actual_execution_cost_outcomes SET authority_digest = ? WHERE id = ?",
    ).run("d".repeat(64), "outcome-corrected");
    expect(verifyExecutionOutcomeIntegrity(db, "tenant_default")).toMatchObject({
      ok: false,
      error: "execution_outcome_chain_integrity:outcome-corrected",
    });
    expect(reconcileGrossMargin(db, "tenant_default")).toMatchObject({
      complete: false,
      exactGrossMarginMoneyMicros: null,
    });
  });

  it("rejects reused authority and withdraws attribution when newer authority supersedes it", () => {
    const db = setupDb();
    settle(db);
    const cost = recordActualExecutionCost(db, costInput({
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
    }));
    const approvedContent = JSON.stringify({
      costEntryId: cost.id,
      costEntryHash: cost.entryHash,
      decision: "approve",
    });
    const approvedDigest = createHash("sha256").update(approvedContent).digest("hex");
    insertArtifactManifest(db, {
      id: "approved-artifact",
      tenantId: "tenant_default",
      kind: "review-evidence",
      schemaVersion: 1,
      sha256: approvedDigest,
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(approvedContent),
      storageRef: "evidence://approved-artifact",
      content: approvedContent,
      producerPrincipalId: "principal-a",
      createdAt: "2026-08-01T12:03:00.000Z",
    });
    insertReviewDecision(db, {
      id: "review-approved",
      tenantId: "tenant_default",
      subjectType: "execution_cost",
      subjectId: cost.executionId,
      candidateArtifactId: "approved-artifact",
      reviewerPrincipalId: "principal-a",
      decision: "approve",
      rationale: "Approved exact cost outcome",
      createdAt: "2026-08-01T12:03:00.000Z",
    });
    const input = {
      tenantId: "tenant_default",
      executionId: cost.executionId,
      outcomeStatus: "accepted" as const,
      acceptedOutcomeId: "approved-artifact",
      authorityKind: "reviewer" as const,
      authorityEvidenceId: "review-approved",
      authorityDigest: approvedDigest,
      actorPrincipalId: "principal-a",
      createdAt: "2026-08-01T12:03:00.000Z",
    };
    recordExecutionCostOutcome(db, {
      ...input,
      id: "outcome-approved",
      idempotencyKey: "outcome-approved",
    });
    expect(() => recordExecutionCostOutcome(db, {
      ...input,
      id: "outcome-approved-reused",
      idempotencyKey: "outcome-approved-reused",
    })).toThrow("execution_cost_outcome_authority_reused");

    const rejectedContent = JSON.stringify({
      costEntryId: cost.id,
      costEntryHash: cost.entryHash,
      decision: "reject",
    });
    insertArtifactManifest(db, {
      id: "rejected-artifact-current",
      tenantId: "tenant_default",
      kind: "review-evidence",
      schemaVersion: 1,
      sha256: createHash("sha256").update(rejectedContent).digest("hex"),
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(rejectedContent),
      storageRef: "evidence://rejected-artifact-current",
      content: rejectedContent,
      producerPrincipalId: "principal-a",
      createdAt: "2026-08-01T12:04:00.000Z",
    });
    insertReviewDecision(db, {
      id: "review-rejected-current",
      tenantId: "tenant_default",
      subjectType: "execution_cost",
      subjectId: cost.executionId,
      candidateArtifactId: "rejected-artifact-current",
      reviewerPrincipalId: "principal-a",
      decision: "reject",
      rationale: "Supersede prior approval",
      createdAt: "2026-08-01T12:04:00.000Z",
    });
    expect(verifyExecutionOutcomeIntegrity(db, "tenant_default")).toMatchObject({
      ok: false,
      error: "execution_outcome_authority_not_current:outcome-approved",
    });
    expect(reconcileGrossMargin(db, "tenant_default")).toMatchObject({
      complete: false,
      exactGrossMarginMoneyMicros: null,
      attributions: [{
        attributedNetRevenueMoneyMicros: null,
        attributedGrossMarginMoneyMicros: null,
      }],
    });
  });

  it("rejects malformed delivered outcome IDs and a corrupted domain-event chain before append", () => {
    const malformedDb = setupDb();
    const malformedCost = recordActualExecutionCost(malformedDb, costInput({
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
    }));
    const malformed = appendDomainEvent(malformedDb, {
      id: "delivery-malformed",
      tenantId: "tenant_default",
      schemaVersion: 1,
      eventType: "execution_cost.delivered",
      aggregateType: "execution_cost",
      aggregateId: malformedCost.executionId,
      actorPrincipalId: "principal-a",
      correlationId: malformedCost.executionId,
      idempotencyKey: "delivery-malformed",
      payload: {
        outcomeId: 42,
        costEntryId: malformedCost.id,
        costEntryHash: malformedCost.entryHash,
      },
      createdAt: "2026-08-01T12:03:00.000Z",
    });
    expect(() => recordExecutionCostOutcome(malformedDb, {
      id: "outcome-malformed",
      tenantId: "tenant_default",
      idempotencyKey: "outcome-malformed",
      executionId: malformedCost.executionId,
      outcomeStatus: "accepted",
      acceptedOutcomeId: "42",
      authorityKind: "delivery",
      authorityEvidenceId: malformed.row.id,
      authorityDigest: malformed.row.event_hash,
      actorPrincipalId: "principal-a",
      createdAt: malformed.row.created_at,
    })).toThrow("execution_cost_outcome_authority_outcome_invalid");
    expect(listExecutionCostOutcomes(malformedDb, "tenant_default")).toEqual([]);

    const corruptDb = setupDb();
    const corruptCost = recordActualExecutionCost(corruptDb, costInput({
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
    }));
    const delivered = appendDomainEvent(corruptDb, {
      id: "delivery-corrupt",
      tenantId: "tenant_default",
      schemaVersion: 1,
      eventType: "execution_cost.delivered",
      aggregateType: "execution_cost",
      aggregateId: corruptCost.executionId,
      actorPrincipalId: "principal-a",
      correlationId: corruptCost.executionId,
      idempotencyKey: "delivery-corrupt",
      payload: {
        outcomeId: "pull-request-corrupt",
        costEntryId: corruptCost.id,
        costEntryHash: corruptCost.entryHash,
      },
      createdAt: "2026-08-01T12:03:00.000Z",
    });
    corruptDb.raw.exec("DROP TRIGGER domain_events_append_only_update");
    corruptDb.raw.prepare("UPDATE domain_events SET payload_json = '{}' WHERE id = ?")
      .run(delivered.row.id);
    expect(() => recordExecutionCostOutcome(corruptDb, {
      id: "outcome-corrupt",
      tenantId: "tenant_default",
      idempotencyKey: "outcome-corrupt",
      executionId: corruptCost.executionId,
      outcomeStatus: "accepted",
      acceptedOutcomeId: "pull-request-corrupt",
      authorityKind: "delivery",
      authorityEvidenceId: delivered.row.id,
      authorityDigest: delivered.row.event_hash,
      actorPrincipalId: "principal-a",
      createdAt: delivered.row.created_at,
    })).toThrow("execution_cost_outcome_domain_event_integrity_invalid");
    expect(listExecutionCostOutcomes(corruptDb, "tenant_default")).toEqual([]);
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

  it("scopes execution-cost outcome reads and writes to the requesting tenant", () => {
    const db = setupDb();
    setupTenant(db, "tenant-b", "b");
    // Both tenants carry the SAME execution id. A cost lookup or outcome read
    // that loses its tenant predicate resolves the other tenant's row, and this
    // feeds the customer-facing GET /execution-costs and the revenue
    // attribution in reconcileGrossMargin.
    const costA = recordActualExecutionCost(db, costInput({
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
    }));
    const costB = recordActualExecutionCost(db, costInput({
      id: "cost-b",
      tenantId: "tenant-b",
      idempotencyKey: "cost-b",
      executionId: "execution-a",
      taskId: "task-b",
      campaignId: "campaign-b",
      outcomeStatus: "unresolved",
      acceptedOutcomeId: null,
      actorPrincipalId: "principal-b",
    }));
    expect(costA.id).not.toBe(costB.id);
    expect(costA.entryHash).not.toBe(costB.entryHash);

    const reject = (tenantId: string, suffix: string, cost: { id: string; entryHash: string }) => {
      const createdAt = "2026-08-01T12:03:00.000Z";
      const artifactId = `rejected-artifact-${suffix}`;
      const content = JSON.stringify({ costEntryId: cost.id, costEntryHash: cost.entryHash });
      const authorityDigest = createHash("sha256").update(content).digest("hex");
      insertArtifactManifest(db, {
        id: artifactId, tenantId, kind: "review-evidence", schemaVersion: 1,
        sha256: authorityDigest, mediaType: "application/json",
        sizeBytes: Buffer.byteLength(content), storageRef: `evidence://${artifactId}`,
        content, producerPrincipalId: `principal-${suffix}`, createdAt,
      });
      insertReviewDecision(db, {
        id: `review-${suffix}`, tenantId, subjectType: "execution_cost",
        subjectId: "execution-a", candidateArtifactId: artifactId,
        reviewerPrincipalId: `principal-${suffix}`, decision: "reject",
        rationale: "Tenant-scope test outcome", createdAt,
      });
      return recordExecutionCostOutcome(db, {
        id: `outcome-${suffix}`,
        tenantId,
        idempotencyKey: `outcome-${suffix}`,
        executionId: "execution-a",
        outcomeStatus: "rejected",
        authorityKind: "reviewer",
        authorityEvidenceId: `review-${suffix}`,
        authorityDigest,
        actorPrincipalId: `principal-${suffix}`,
        createdAt,
      });
    };

    // Written second, so an unscoped cost lookup resolves tenant_default's
    // earlier row instead of this tenant's.
    const outcomeB = reject("tenant-b", "b", costB);
    expect(outcomeB.costEntryId).toBe(costB.id);
    expect(outcomeB.tenantId).toBe("tenant-b");
    expect(listExecutionCostOutcomes(db, "tenant-b").map((row) => row.id)).toEqual(["outcome-b"]);
    expect(listExecutionCostOutcomes(db, "tenant_default")).toEqual([]);
    expect(listExecutionCostOutcomes(db, "tenant-b", "execution-a").map((row) => row.costEntryId))
      .toEqual([costB.id]);
    expect(listExecutionCostOutcomes(db, "tenant_default", "execution-a")).toEqual([]);

    const outcomeA = reject("tenant_default", "a", costA);
    expect(outcomeA.costEntryId).toBe(costA.id);
    expect(listExecutionCostOutcomes(db, "tenant_default").map((row) => row.id)).toEqual(["outcome-a"]);
    expect(listExecutionCostOutcomes(db, "tenant-b").map((row) => row.id)).toEqual(["outcome-b"]);
    expect(verifyExecutionOutcomeIntegrity(db, "tenant_default")).toEqual({ ok: true, checked: 1 });
    expect(verifyExecutionOutcomeIntegrity(db, "tenant-b")).toEqual({ ok: true, checked: 1 });
  });
});
