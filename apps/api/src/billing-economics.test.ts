import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKey,
  createDb,
  createUsageEntitlement,
  createUsagePriceVersion,
  getPrincipalBySubject,
  insertTenant,
  listActualExecutionCosts,
  reserveUsage,
  settleUsageReservation,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createBillingEconomicsRoutes } from "./billing-economics.js";
import { requestIdMiddleware } from "./production.js";

const NOW = "2026-08-01T15:00:00.000Z";
const directories: string[] = [];
const databases: AppDb[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  while (databases.length) databases.pop()?.raw.close();
  while (directories.length) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-billing-api-"));
  directories.push(directory);
  const db = createDb(join(directory, "billing.sqlite"));
  databases.push(db);
  insertTenant(db, {
    id: "billing-tenant-a",
    slug: "billing-tenant-a",
    name: "Billing tenant A",
    createdAt: NOW,
  });
  insertTenant(db, {
    id: "billing-tenant-b",
    slug: "billing-tenant-b",
    name: "Billing tenant B",
    createdAt: NOW,
  });
  const tenantA = createApiKey(db, {
    id: "billing-key-a",
    name: "Billing tenant A",
    tenantId: "billing-tenant-a",
    scopes: ["*"],
    createdAt: NOW,
  });
  const tenantB = createApiKey(db, {
    id: "billing-key-b",
    name: "Billing tenant B",
    tenantId: "billing-tenant-b",
    scopes: ["*"],
    createdAt: NOW,
  });
  return { db, tenantA: tenantA.token, tenantB: tenantB.token };
}

function appFor(db: AppDb, now: () => string = () => NOW) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db));
  app.route("/billing", createBillingEconomicsRoutes({ db, now }));
  return app;
}

function headers(token: string, requestId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  };
}

function executionCostBody(overrides: Record<string, unknown> = {}) {
  return {
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
    createdAt: NOW,
    ...overrides,
  };
}

async function postCost(app: Hono<ApiEnv>, token: string, requestId: string, body: unknown) {
  return app.request("/billing/execution-costs", {
    method: "POST",
    headers: headers(token, requestId),
    body: JSON.stringify(body),
  });
}

describe("billing economics API routes", () => {
  it("requires authentication and forces tenant and actor from the authenticated principal", async () => {
    const { db, tenantA, tenantB } = fixture();
    const app = appFor(db);
    const unauthenticated = await app.request("/billing/execution-costs", {
      headers: { "X-Request-Id": "anonymous-list" },
    });
    expect(unauthenticated.status).toBe(401);

    const created = await postCost(app, tenantA, "cost-create-a", executionCostBody({
      id: "client-controlled-id",
      tenantId: "billing-tenant-b",
      actorPrincipalId: "principal-attacker",
      idempotencyKey: "client-controlled-key",
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    expect(created.status).toBe(201);
    const response = await created.json() as { data: Record<string, unknown> };
    expect(response.data).toMatchObject({
      executionId: "execution-a",
      totalCostMoneyMicros: 2_500,
      currency: "USD",
    });
    for (const privateField of [
      "tenantId",
      "actorPrincipalId",
      "idempotencyKey",
      "entrySequence",
      "previousHash",
      "entryHash",
    ]) {
      expect(response.data).not.toHaveProperty(privateField);
    }

    const stored = listActualExecutionCosts(db, "billing-tenant-a");
    const actor = getPrincipalBySubject(db, "billing-tenant-a", "api_key", "billing-key-a");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      tenantId: "billing-tenant-a",
      actorPrincipalId: actor?.id,
      idempotencyKey: "cost-create-a",
      createdAt: NOW,
    });
    expect(stored[0]?.id).not.toBe("client-controlled-id");
    expect(listActualExecutionCosts(db, "billing-tenant-b")).toEqual([]);

    const tenantBList = await app.request("/billing/execution-costs", {
      headers: { ...headers(tenantB, "cost-list-b"), "X-Tenant-Id": "billing-tenant-a" },
    });
    expect(tenantBList.status).toBe(200);
    await expect(tenantBList.json()).resolves.toEqual({ data: [], meta: { count: 0 } });
  });

  it("replays the same request ID exactly once and rejects changed replay input", async () => {
    const { db, tenantA } = fixture();
    let currentTime = NOW;
    const app = appFor(db, () => currentTime);
    const body = executionCostBody();
    const created = await postCost(app, tenantA, "stable-cost-request", body);
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    currentTime = "2026-08-01T15:05:00.000Z";
    const replay = await postCost(app, tenantA, "stable-cost-request", body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(createdBody);
    expect(listActualExecutionCosts(db, "billing-tenant-a")).toHaveLength(1);

    const conflict = await postCost(app, tenantA, "stable-cost-request", executionCostBody({
      modelCostMoneyMicros: 1_001,
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "execution_cost_idempotency_conflict" },
    });
    expect(listActualExecutionCosts(db, "billing-tenant-a")).toHaveLength(1);
  });

  it("keeps margin fields closed when recognized revenue has no actual cost", async () => {
    const { db, tenantA, tenantB } = fixture();
    const app = appFor(db);
    await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "initialize-principal-a"),
    });
    const actor = getPrincipalBySubject(db, "billing-tenant-a", "api_key", "billing-key-a");
    expect(actor).not.toBeNull();
    createUsagePriceVersion(db, {
      id: "billing-price-a",
      tenantId: "billing-tenant-a",
      formulaVersion: "mcu-v1",
      currency: "USD",
      pricePerMcuMoneyMicros: 20_000,
      effectiveAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      contractReference: "contract-a",
      createdAt: NOW,
    });
    createUsageEntitlement(db, {
      id: "billing-entitlement-a",
      tenantId: "billing-tenant-a",
      priceVersionId: "billing-price-a",
      quotaMcuMicros: 20_000_000,
      features: ["warden"],
      contractReference: "contract-a",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      createdAt: NOW,
    });
    const reservation = reserveUsage(db, {
      id: "billing-reservation-a",
      tenantId: "billing-tenant-a",
      idempotencyKey: "billing-reserve-a",
      taskId: "task-without-cost",
      campaignId: "campaign-a",
      mcuMicros: 5_000_000,
      reason: "task ceiling",
      actorPrincipalId: actor!.id,
      createdAt: NOW,
    });
    settleUsageReservation(db, {
      id: "billing-settlement-a",
      tenantId: "billing-tenant-a",
      idempotencyKey: "billing-settle-a",
      reservationId: reservation.id,
      actualMcuMicros: 4_000_000,
      invoiceReference: "invoice-a",
      reason: "actual accepted work",
      actorPrincipalId: actor!.id,
      createdAt: "2026-08-01T15:01:00.000Z",
    });

    const margin = await app.request("/billing/gross-margin", {
      headers: headers(tenantA, "margin-a"),
    });
    expect(margin.status).toBe(200);
    const marginBody = await margin.json() as { data: Record<string, unknown> };
    expect(marginBody).toMatchObject({
      data: {
        complete: false,
        netRevenueMoneyMicros: 80_000,
        actualCostMoneyMicros: 0,
        exactGrossMarginMoneyMicros: null,
        attributedGrossMarginMoneyMicros: null,
        unattributedRevenueMoneyMicros: 80_000,
        incompleteAttributions: [
          { code: "accepted_outcome_missing", taskId: "task-without-cost" },
          { code: "actual_cost_missing", taskId: "task-without-cost" },
        ],
      },
    });
    expect(marginBody.data).not.toHaveProperty("tenantId");
    expect(JSON.stringify(marginBody)).not.toContain("sourceId");

    const tenantBMargin = await app.request("/billing/gross-margin", {
      headers: { ...headers(tenantB, "margin-b"), "X-Tenant-Id": "billing-tenant-a" },
    });
    expect(tenantBMargin.status).toBe(200);
    await expect(tenantBMargin.json()).resolves.toMatchObject({
      data: { netRevenueMoneyMicros: 0, actualCostMoneyMicros: 0 },
    });
  });
});
