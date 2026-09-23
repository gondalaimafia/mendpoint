import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createUsageEntitlement,
  createUsagePriceVersion,
  listUsageLedger,
  putTenantMembership,
  reconcileUsageLedger,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import { createAuthMiddleware, createRbacMiddleware, type ApiEnv, type OidcVerifier } from "./auth.js";
import { createBillingUsageReservationRoutes } from "./billing-usage-routes.js";

const opened: AppDb[] = [];
const directories: string[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  while (opened.length) opened.pop()?.raw.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

const errors = [
  { internalCode: "usage_reservation_empty", status: 409 },
  { internalCode: "usage_entitlement_required", status: 409 },
  { internalCode: "usage_quota_exceeded", status: 409 },
  { internalCode: "usage_reservation_not_found", status: 404 },
  { internalCode: "usage_settlement_exceeds_reservation", status: 409 },
  { internalCode: "tenant_scope_required", status: 403 },
] as const;

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-billing-usage-reservation-"));
  directories.push(directory);
  const db = createDb(join(directory, "billing.sqlite"));
  opened.push(db);
  for (const tenant of ["tenant-a", "tenant-b"] as const) {
    db.raw.prepare(`INSERT OR IGNORE INTO tenants
      (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`)
      .run(tenant, tenant, tenant, "2026-09-02T11:00:00.000Z");
  }
  const issuer = "https://identity.example.test";
  for (const member of [
    { tenantId: "tenant-a", subject: "admin-a", role: "admin" as const },
    { tenantId: "tenant-b", subject: "admin-b", role: "admin" as const },
  ]) {
    putTenantMembership(db, {
      tenantId: member.tenantId,
      issuer,
      subject: member.subject,
      email: `${member.subject}@example.test`,
      displayName: member.subject,
      role: member.role,
      status: "active",
      updatedAt: "2026-09-02T11:00:00.000Z",
    });
  }
  for (const tenant of ["tenant-a", "tenant-b"] as const) {
    createUsagePriceVersion(db, {
      id: `price-${tenant}`,
      tenantId: tenant,
      formulaVersion: "mcu-v1",
      currency: "USD",
      pricePerMcuMoneyMicros: 20_000,
      effectiveAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      contractReference: `contract-${tenant}`,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    createUsageEntitlement(db, {
      id: `entitlement-${tenant}`,
      tenantId: tenant,
      priceVersionId: `price-${tenant}`,
      quotaMcuMicros: 10_000,
      features: ["fettler"],
      contractReference: `contract-${tenant}`,
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  }
  const observedAt = "2026-09-02T12:00:00.000Z";
  let identifier = 0;
  const identities = new Map([
    ["admin.a.jwt", { issuer, subject: "admin-a", tenantId: "tenant-a" }],
    ["admin.b.jwt", { issuer, subject: "admin-b", tenantId: "tenant-b" }],
  ]);
  const oidc: OidcVerifier = {
    async verify(token) {
      const identity = identities.get(token);
      if (!identity) throw new Error("oidc_token_invalid");
      return identity;
    },
  };
  const app = new Hono<ApiEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", context.req.header("X-Request-Id") ?? "reservation-route-test");
    await next();
  });
  app.use("*", createAuthMiddleware(db, { oidc, now: () => new Date(observedAt) }));
  app.use("*", createRbacMiddleware());
  app.route("/billing/usage", createBillingUsageReservationRoutes({
    db,
    errors,
    id: () => `reservation-route-${++identifier}`,
    now: () => observedAt,
    audit: (context, input) => {
      const principal = context.get("principal")!;
      recordAudit(db, {
        ...input,
        tenantId: principal.tenantId,
        principalId: context.get("trustPrincipalId") ?? null,
        apiKeyId: context.get("apiKeyId") ?? null,
        requestId: context.get("requestId") ?? null,
      });
    },
  }));
  return { app, db };
}

function post(token: string | null, path: string, body: Record<string, unknown>) {
  return {
    path,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  } as const;
}

describe("billing usage reservation routes", () => {
  it("records a client-declared settlement as not_measured and reconciles unmeasured", async () => {
    const { app, db } = fixture();

    const reserve = post("admin.a.jwt", "/billing/usage/reservations", {
      idempotencyKey: "reserve-1",
      taskId: "task-1",
      mcuMicros: 1_000,
      reason: "admitted run",
    });
    const reserveResponse = await app.request(reserve.path, reserve.init);
    expect(reserveResponse.status).toBe(201);
    const reservation = await reserveResponse.json() as { id: string };

    const settle = post("admin.a.jwt", `/billing/usage/reservations/${reservation.id}/settle`, {
      idempotencyKey: "settle-1",
      actualMcuMicros: 1_000,
      invoiceReference: "invoice-1",
      reason: "run completed",
    });
    const settleResponse = await app.request(settle.path, settle.init);
    expect(settleResponse.status).toBe(201);
    const settlement = await settleResponse.json() as { consumptionProvenance: string };

    // The route must record a client-declared figure as NOT measured. If it declared
    // measured instead, provenance would be "measured" and reconcile would be verified,
    // so both of these assertions die.
    expect(settlement.consumptionProvenance).toBe("not_measured:client_declared");
    const ledger = listUsageLedger(db, "tenant-a");
    expect(ledger.find((entry) => entry.entryType === "settlement")?.consumptionProvenance)
      .toBe("not_measured:client_declared");
    expect(reconcileUsageLedger(db, "tenant-a")).toMatchObject({
      ok: false,
      error: "usage_consumption_unmeasured",
      measurementStatus: "unmeasured",
    });
  });

  it("scopes reserve to the caller's tenant and rejects the unauthenticated caller", async () => {
    const { app, db } = fixture();

    const unauthenticated = post(null, "/billing/usage/reservations", {
      idempotencyKey: "reserve-anon",
      taskId: "task-anon",
      mcuMicros: 1_000,
      reason: "anon",
    });
    expect((await app.request(unauthenticated.path, unauthenticated.init)).status).toBe(401);
    expect(listUsageLedger(db, "tenant-a")).toEqual([]);

    // admin-b reserving lands under tenant-b (the route's requestTenantId), never a
    // tenant named in the request body. If the route dropped tenant scoping this would
    // land elsewhere; tenant-b sees its own reservation and tenant-a stays empty.
    const reserveB = post("admin.b.jwt", "/billing/usage/reservations", {
      idempotencyKey: "reserve-b",
      taskId: "task-b",
      mcuMicros: 1_000,
      reason: "tenant-b run",
    });
    expect((await app.request(reserveB.path, reserveB.init)).status).toBe(201);
    expect(listUsageLedger(db, "tenant-a")).toEqual([]);
    expect(listUsageLedger(db, "tenant-b")).toHaveLength(1);
  });
});
