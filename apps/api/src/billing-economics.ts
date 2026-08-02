import { createHash } from "node:crypto";
import {
  listActualExecutionCosts,
  reconcileGrossMargin,
  recordActualExecutionCost,
  type ActualExecutionCostEntry,
  type ActualExecutionCostInput,
  type AppDb,
  type GrossMarginReconciliation,
} from "@mendpoint/db";
import { Hono, type Context, type Next } from "hono";
import type { ApiEnv } from "./auth.js";

export type BillingEconomicsRouteDeps = Readonly<{
  db: AppDb;
  now?: () => string;
}>;

type JsonRecord = Record<string, unknown>;

function errorResponse(c: Context<ApiEnv>, code: string, message: string, status: 400 | 401 | 403 | 409) {
  return c.json({ error: { code, message } }, status);
}

function authenticatedPrincipal(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  const actorPrincipalId = c.get("trustPrincipalId");
  if (!principal || !actorPrincipalId) return null;
  return { tenantId: principal.tenantId, actorPrincipalId };
}

async function requireAuthenticatedPrincipal(c: Context<ApiEnv>, next: Next) {
  if (!authenticatedPrincipal(c)) {
    return errorResponse(c, "unauthorized", "Authentication is required", 401);
  }
  return next();
}

function requestId(c: Context<ApiEnv>): string | null {
  const value = c.get("requestId")?.trim();
  return value && value.length <= 200 ? value : null;
}

function recordId(tenantId: string, idempotencyKey: string): string {
  return `execution-cost-${createHash("sha256")
    .update(`${tenantId}\n${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function publicExecutionCost(entry: ActualExecutionCostEntry) {
  return {
    id: entry.id,
    executionId: entry.executionId,
    taskId: entry.taskId,
    campaignId: entry.campaignId,
    taskClass: entry.taskClass,
    route: entry.route,
    attemptNumber: entry.attemptNumber,
    retryNumber: entry.retryNumber,
    fallbackFromExecutionId: entry.fallbackFromExecutionId,
    outcomeStatus: entry.outcomeStatus,
    acceptedOutcomeId: entry.acceptedOutcomeId,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    modelId: entry.modelId,
    modelPriceVersion: entry.modelPriceVersion,
    modelCostMoneyMicros: entry.modelCostMoneyMicros,
    cacheCostMoneyMicros: entry.cacheCostMoneyMicros,
    gpuMillis: entry.gpuMillis,
    gpuCostMoneyMicros: entry.gpuCostMoneyMicros,
    graphCostMoneyMicros: entry.graphCostMoneyMicros,
    sandboxCostMoneyMicros: entry.sandboxCostMoneyMicros,
    verificationCostMoneyMicros: entry.verificationCostMoneyMicros,
    totalCostMoneyMicros: entry.totalCostMoneyMicros,
    currency: entry.currency,
    createdAt: entry.createdAt,
  };
}

function publicGrossMargin(report: GrossMarginReconciliation) {
  return {
    complete: report.complete,
    currency: report.currency,
    ledgers: {
      usage: { ok: report.usageIntegrity.ok, checked: report.usageIntegrity.checked },
      executionCosts: { ok: report.costIntegrity.ok, checked: report.costIntegrity.checked },
    },
    settledMcuMicros: report.settledMcuMicros,
    creditedMcuMicros: report.creditedMcuMicros,
    adjustedMcuMicros: report.adjustedMcuMicros,
    settledRevenueMoneyMicros: report.settledRevenueMoneyMicros,
    creditMoneyMicros: report.creditMoneyMicros,
    adjustmentMoneyMicros: report.adjustmentMoneyMicros,
    netRevenueMoneyMicros: report.netRevenueMoneyMicros,
    actualCostMoneyMicros: report.actualCostMoneyMicros,
    modelCostMoneyMicros: report.modelCostMoneyMicros,
    cacheCostMoneyMicros: report.cacheCostMoneyMicros,
    gpuCostMoneyMicros: report.gpuCostMoneyMicros,
    graphCostMoneyMicros: report.graphCostMoneyMicros,
    sandboxCostMoneyMicros: report.sandboxCostMoneyMicros,
    verificationCostMoneyMicros: report.verificationCostMoneyMicros,
    exactGrossMarginMoneyMicros: report.exactGrossMarginMoneyMicros,
    attributedGrossMarginMoneyMicros: report.attributedGrossMarginMoneyMicros,
    unattributedRevenueMoneyMicros: report.unattributedRevenueMoneyMicros,
    incompleteAttributions: report.incompleteAttributions.map(({ code, taskId }) => ({ code, taskId })),
    attributions: report.attributions.map(({ tenantId: _tenantId, ...attribution }) => attribution),
  };
}

function executionCostInput(
  body: JsonRecord,
  identity: { tenantId: string; actorPrincipalId: string },
  idempotencyKey: string,
  createdAt: string,
): ActualExecutionCostInput {
  return {
    id: recordId(identity.tenantId, idempotencyKey),
    tenantId: identity.tenantId,
    idempotencyKey,
    executionId: body.executionId as string,
    taskId: body.taskId as string,
    campaignId: body.campaignId as string | null | undefined,
    taskClass: body.taskClass as string,
    route: body.route as string,
    attemptNumber: body.attemptNumber as number,
    retryNumber: body.retryNumber as number,
    fallbackFromExecutionId: body.fallbackFromExecutionId as string | null | undefined,
    outcomeStatus: body.outcomeStatus as ActualExecutionCostInput["outcomeStatus"],
    acceptedOutcomeId: body.acceptedOutcomeId as string | null | undefined,
    inputTokens: body.inputTokens as number,
    outputTokens: body.outputTokens as number,
    cacheReadTokens: body.cacheReadTokens as number,
    cacheWriteTokens: body.cacheWriteTokens as number,
    modelId: body.modelId as string,
    modelPriceVersion: body.modelPriceVersion as string,
    modelCostMoneyMicros: body.modelCostMoneyMicros as number,
    cacheCostMoneyMicros: body.cacheCostMoneyMicros as number,
    gpuMillis: body.gpuMillis as number,
    gpuCostMoneyMicros: body.gpuCostMoneyMicros as number,
    graphCostMoneyMicros: body.graphCostMoneyMicros as number,
    sandboxCostMoneyMicros: body.sandboxCostMoneyMicros as number,
    verificationCostMoneyMicros: body.verificationCostMoneyMicros as number,
    currency: body.currency as string,
    actorPrincipalId: identity.actorPrincipalId,
    createdAt,
  };
}

function handleRecordError(c: Context<ApiEnv>, error: unknown) {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "execution_cost_request_invalid";
  if (code === "execution_cost_idempotency_conflict" || code === "execution_cost_execution_conflict") {
    return errorResponse(c, code, "The request conflicts with an existing execution cost", 409);
  }
  if (code === "execution_cost_actor_tenant_mismatch") {
    return errorResponse(c, code, "The authenticated principal cannot record this execution cost", 403);
  }
  return errorResponse(c, code, "The execution cost request is invalid", 400);
}

export function createBillingEconomicsRoutes({
  db,
  now = () => new Date().toISOString(),
}: BillingEconomicsRouteDeps) {
  const routes = new Hono<ApiEnv>({ strict: false });
  routes.use("*", requireAuthenticatedPrincipal);

  routes.post("/execution-costs", async (c) => {
    const identity = authenticatedPrincipal(c)!;
    const idempotencyKey = requestId(c);
    if (!idempotencyKey) {
      return errorResponse(c, "request_id_invalid", "A valid request ID is required", 400);
    }
    try {
      const body = await c.req.json<unknown>();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return errorResponse(c, "execution_cost_request_invalid", "The execution cost request is invalid", 400);
      }
      const entry = recordActualExecutionCost(
        db,
        executionCostInput(
          body as JsonRecord,
          identity,
          idempotencyKey,
          now(),
        ),
      );
      return c.json({ data: publicExecutionCost(entry) }, 201);
    } catch (error) {
      return handleRecordError(c, error);
    }
  });

  routes.get("/execution-costs", (c) => {
    const identity = authenticatedPrincipal(c)!;
    const requestedLimit = c.req.query("limit");
    const limit = requestedLimit === undefined ? 500 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      return errorResponse(c, "execution_cost_limit_invalid", "Limit must be an integer from 1 to 5000", 400);
    }
    const records = listActualExecutionCosts(db, identity.tenantId, limit).map(publicExecutionCost);
    return c.json({ data: records, meta: { count: records.length } });
  });

  routes.get("/gross-margin", (c) => {
    const identity = authenticatedPrincipal(c)!;
    return c.json({ data: publicGrossMargin(reconcileGrossMargin(db, identity.tenantId)) });
  });

  return routes;
}
