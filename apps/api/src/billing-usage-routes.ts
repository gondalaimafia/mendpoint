import { Hono, type Context } from "hono";
import {
  adjustUsage,
  createUsageFinanceAuthorization,
  creditUsage,
  releaseUsageReservation,
  reserveUsage,
  settleUsageReservation,
  type AppDb,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { requestTenantId, type ApiEnv } from "./auth.js";
import { parseUsageFinanceEntryType } from "./billing-usage-input.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";

export type BillingUsageAuditInput = Readonly<{
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}>;

export type BillingUsageRouteOptions = Readonly<{
  db: AppDb;
  errors: readonly PublicErrorRule[];
  audit: (context: Context<ApiEnv>, input: BillingUsageAuditInput) => void;
  id?: () => string;
  now?: () => string;
}>;

function commitWithAudit<T>(db: AppDb, operation: () => T): T {
  const ownsTransaction = !db.raw.isTransaction;
  const savepoint = "billing_usage_audit";
  db.raw.exec(ownsTransaction ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    db.raw.exec(ownsTransaction ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (db.raw.isTransaction) {
      if (ownsTransaction) {
        db.raw.exec("ROLLBACK");
      } else {
        db.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
    }
    throw error;
  }
}

export function createBillingUsageFinanceRoutes(
  options: BillingUsageRouteOptions,
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const makeId = options.id ?? newId;
  const clock = options.now ?? nowIso;

  routes.post("/finance-authorizations", async (context) => {
    const principal = context.get("principal");
    if (!principal) return context.json({ error: "unauthorized" }, 401);
    if (principal.role !== "owner") return context.json({ error: "forbidden" }, 403);
    const body = await context.req.json<{
      entryType?: unknown;
      invoiceReference?: string;
      idempotencyKey?: string;
      mcuMicrosDelta?: number;
      reason?: string;
      allocationEntitlementId?: string;
      allocationPriceVersion?: string;
    }>().catch(() => ({} as {
      entryType?: unknown;
      invoiceReference?: string;
      idempotencyKey?: string;
      mcuMicrosDelta?: number;
      reason?: string;
      allocationEntitlementId?: string;
      allocationPriceVersion?: string;
    }));
    const approvedAt = clock();
    const approvedAtMs = Date.parse(approvedAt);
    try {
      const actorPrincipalId = context.get("trustPrincipalId");
      if (!actorPrincipalId) return context.json({ error: "forbidden" }, 403);
      const entryType = parseUsageFinanceEntryType(body.entryType);
      const authorization = commitWithAudit(options.db, () => {
        const created = createUsageFinanceAuthorization(options.db, {
          id: makeId(),
          tenantId: requestTenantId(context),
          approvedByPrincipalId: actorPrincipalId,
          actorPrincipalId,
          entryType,
          invoiceReference: body.invoiceReference ?? "",
          entryIdempotencyKey: body.idempotencyKey ?? "",
          mcuMicrosDelta: body.mcuMicrosDelta ?? 0,
          reason: body.reason ?? "",
          allocationEntitlementId: body.allocationEntitlementId,
          allocationPriceVersion: body.allocationPriceVersion,
          approvedAt,
          expiresAt: new Date(approvedAtMs + 5 * 60_000).toISOString(),
        });
        options.audit(context, {
          actor: principal.id,
          action: "billing.usage_finance_authorized",
          resourceType: "usage_finance_authorization",
          resourceId: created.id,
          metadata: {
            entryType: created.entryType,
            invoiceReference: created.invoiceReference,
            entryIdempotencyKey: created.entryIdempotencyKey,
          },
        });
        return created;
      });
      return context.json(authorization, 201);
    } catch (error) {
      return mappedErrorResponse(context, error, options.errors);
    }
  });

  routes.post("/:kind", async (context) => {
    const kind = context.req.param("kind");
    if (kind !== "adjustments" && kind !== "credits") {
      return context.json({ error: "usage_entry_kind_invalid" }, 404);
    }
    const body = await context.req.json<{
      idempotencyKey?: string;
      taskId?: string;
      campaignId?: string | null;
      mcuMicrosDelta?: number;
      invoiceReference?: string | null;
      reason?: string;
      financeAuthorizationId?: string;
      financeAuthorizationDigest?: string;
    }>().catch(() => ({} as {
      idempotencyKey?: string;
      taskId?: string;
      campaignId?: string | null;
      mcuMicrosDelta?: number;
      invoiceReference?: string | null;
      reason?: string;
      financeAuthorizationId?: string;
      financeAuthorizationDigest?: string;
    }));
    try {
      const operation = kind === "credits" ? creditUsage : adjustUsage;
      const entry = commitWithAudit(options.db, () => {
        const committed = operation(options.db, {
          id: makeId(),
          tenantId: requestTenantId(context),
          idempotencyKey: body.idempotencyKey ?? "",
          taskId: body.taskId ?? "",
          campaignId: body.campaignId,
          mcuMicrosDelta: body.mcuMicrosDelta ?? 0,
          invoiceReference: body.invoiceReference,
          reason: body.reason ?? "",
          financeAuthorizationId: body.financeAuthorizationId,
          financeAuthorizationDigest: body.financeAuthorizationDigest,
          actorPrincipalId: context.get("trustPrincipalId"),
          createdAt: clock(),
        });
        options.audit(context, {
          actor: context.get("principal")!.id,
          action: `billing.usage_${committed.entryType}`,
          resourceType: "usage_ledger_entry",
          resourceId: committed.id,
          metadata: {
            taskId: committed.taskId,
            mcuMicros: committed.consumedMcuMicrosDelta,
          },
        });
        return committed;
      });
      return context.json(entry, 201);
    } catch (error) {
      return mappedErrorResponse(context, error, options.errors);
    }
  });

  return routes;
}

export type BillingUsageReservationRouteOptions = Readonly<{
  db: AppDb;
  errors: readonly PublicErrorRule[];
  audit: (context: Context<ApiEnv>, input: BillingUsageAuditInput) => void;
  id?: () => string;
  now?: () => string;
}>;

/**
 * Reserve / settle / release routes for the tenant MCU ledger, extracted from the
 * server so the money path has an isolated HTTP harness. The settle route records
 * `not_measured:client_declared`: a figure a client declares over the API is not a
 * measurement, so reconcile treats it as unmeasured and invoice export refuses it
 * until a measured settlement exists.
 */
export function createBillingUsageReservationRoutes(
  options: BillingUsageReservationRouteOptions,
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const makeId = options.id ?? newId;
  const clock = options.now ?? nowIso;

  routes.post("/reservations", async (context) => {
    const body = await context.req.json<{
      idempotencyKey?: string;
      taskId?: string;
      campaignId?: string | null;
      mcuMicros?: number;
      reason?: string;
    }>().catch(() => ({} as {
      idempotencyKey?: string;
      taskId?: string;
      campaignId?: string | null;
      mcuMicros?: number;
      reason?: string;
    }));
    try {
      const entry = reserveUsage(options.db, {
        id: makeId(),
        tenantId: requestTenantId(context),
        idempotencyKey: body.idempotencyKey ?? "",
        taskId: body.taskId ?? "",
        campaignId: body.campaignId,
        mcuMicros: body.mcuMicros ?? -1,
        reason: body.reason ?? "",
        actorPrincipalId: context.get("trustPrincipalId"),
        createdAt: clock(),
      });
      options.audit(context, {
        actor: context.get("principal")!.id,
        action: "billing.usage_reserved",
        resourceType: "usage_ledger_entry",
        resourceId: entry.id,
        metadata: { taskId: entry.taskId, mcuMicros: entry.reservedMcuMicrosDelta },
      });
      return context.json(entry, 201);
    } catch (error) {
      return mappedErrorResponse(context, error, options.errors);
    }
  });

  routes.post("/reservations/:id/settle", async (context) => {
    const body = await context.req.json<{
      idempotencyKey?: string;
      actualMcuMicros?: number;
      invoiceReference?: string | null;
      reason?: string;
    }>().catch(() => ({} as {
      idempotencyKey?: string;
      actualMcuMicros?: number;
      invoiceReference?: string | null;
      reason?: string;
    }));
    try {
      const entry = settleUsageReservation(options.db, {
        id: makeId(),
        tenantId: requestTenantId(context),
        idempotencyKey: body.idempotencyKey ?? "",
        reservationId: context.req.param("id"),
        actualMcuMicros: body.actualMcuMicros ?? -1,
        invoiceReference: body.invoiceReference,
        reason: body.reason ?? "",
        actorPrincipalId: context.get("trustPrincipalId"),
        // A figure a client declares over the API is not a measurement.
        consumption: { kind: "not_measured", reason: "client_declared" },
        createdAt: clock(),
      });
      options.audit(context, {
        actor: context.get("principal")!.id,
        action: "billing.usage_settled",
        resourceType: "usage_ledger_entry",
        resourceId: entry.id,
        metadata: { reservationId: entry.reservationId, mcuMicros: entry.consumedMcuMicrosDelta },
      });
      return context.json(entry, 201);
    } catch (error) {
      return mappedErrorResponse(context, error, options.errors);
    }
  });

  routes.post("/reservations/:id/release", async (context) => {
    const body = await context.req.json<{ idempotencyKey?: string; reason?: string }>()
      .catch(() => ({} as { idempotencyKey?: string; reason?: string }));
    try {
      const entry = releaseUsageReservation(options.db, {
        id: makeId(),
        tenantId: requestTenantId(context),
        idempotencyKey: body.idempotencyKey ?? "",
        reservationId: context.req.param("id"),
        reason: body.reason ?? "",
        actorPrincipalId: context.get("trustPrincipalId"),
        createdAt: clock(),
      });
      options.audit(context, {
        actor: context.get("principal")!.id,
        action: "billing.usage_released",
        resourceType: "usage_ledger_entry",
        resourceId: entry.id,
        metadata: { reservationId: entry.reservationId },
      });
      return context.json(entry, 201);
    } catch (error) {
      return mappedErrorResponse(context, error, options.errors);
    }
  });

  return routes;
}

/**
 * Mount the billing-usage routes on an app under `/billing/usage`. The order is
 * load-bearing: the reservation routes MUST mount before the finance routes, because
 * the finance sub-app's `/:kind` param route would otherwise shadow the static
 * `/reservations` path and turn `POST /billing/usage/reservations` into a
 * `usage_entry_kind_invalid` 404. Kept in one place so the server and its tests agree
 * on the order.
 */
export function mountBillingUsageRoutes(
  app: Hono<ApiEnv>,
  options: BillingUsageRouteOptions,
): void {
  app.route("/billing/usage", createBillingUsageReservationRoutes(options));
  app.route("/billing/usage", createBillingUsageFinanceRoutes(options));
}
