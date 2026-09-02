import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createUsageEntitlement,
  createUsagePriceVersion,
  listAudit,
  listUsageLedger,
  putTenantMembership,
  recordAudit,
  reserveUsage,
  settleUsageReservation,
  type AppDb,
} from "@mendpoint/db";
import { createAuthMiddleware, createRbacMiddleware, type ApiEnv, type OidcVerifier } from "./auth.js";
import { createBillingUsageFinanceRoutes } from "./billing-usage-routes.js";

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
  { internalCode: "usage_finance_authorization_binding_invalid", status: 409 },
  { internalCode: "usage_finance_authorization_required", status: 409 },
  { internalCode: "usage_finance_authorization_expired", status: 409 },
  { internalCode: "usage_finance_authorization_consumed", status: 409 },
  { internalCode: "usage_finance_owner_required", status: 403 },
  { internalCode: "usage_finance_owner_inactive", status: 403 },
  { internalCode: "usage_finance_actor_inactive", status: 403 },
] as const;

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-billing-usage-routes-"));
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
    { tenantId: "tenant-a", subject: "owner-a", role: "owner" as const },
    { tenantId: "tenant-a", subject: "admin-a", role: "admin" as const },
    { tenantId: "tenant-b", subject: "owner-b", role: "owner" as const },
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
  createUsagePriceVersion(db, {
    id: "price-a",
    tenantId: "tenant-a",
    formulaVersion: "mcu-v1",
    currency: "USD",
    pricePerMcuMoneyMicros: 20_000,
    effectiveAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    contractReference: "contract-a",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  createUsageEntitlement(db, {
    id: "entitlement-a",
    tenantId: "tenant-a",
    priceVersionId: "price-a",
    quotaMcuMicros: 10_000,
    features: ["fettler"],
    contractReference: "contract-a",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const reservation = reserveUsage(db, {
    id: "reservation-a",
    tenantId: "tenant-a",
    idempotencyKey: "reservation-a",
    taskId: "task-a",
    mcuMicros: 100,
    reason: "route integration allocation",
    createdAt: "2026-09-02T11:30:00.000Z",
  });
  settleUsageReservation(db, {
    id: "settlement-a",
    tenantId: "tenant-a",
    idempotencyKey: "settlement-a",
    reservationId: reservation.id,
    actualMcuMicros: 100,
    invoiceReference: "invoice-a",
    reason: "route integration settlement",
    createdAt: "2026-09-02T11:31:00.000Z",
  });

  let observedAt = "2026-09-02T12:00:00.000Z";
  let identifier = 0;
  let failAuditAction: string | null = null;
  const identities = new Map([
    ["owner.a.jwt", { issuer, subject: "owner-a", tenantId: "tenant-a" }],
    ["admin.a.jwt", { issuer, subject: "admin-a", tenantId: "tenant-a" }],
    ["owner.b.jwt", { issuer, subject: "owner-b", tenantId: "tenant-b" }],
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
    context.set("requestId", context.req.header("X-Request-Id") ?? "billing-route-test");
    await next();
  });
  app.use("*", createAuthMiddleware(db, {
    oidc,
    now: () => new Date(observedAt),
  }));
  app.use("*", createRbacMiddleware());
  app.route("/billing/usage", createBillingUsageFinanceRoutes({
    db,
    errors,
    id: () => `billing-route-${++identifier}`,
    now: () => observedAt,
    audit: (context, input) => {
      if (input.action === failAuditAction) throw new Error("injected_audit_failure");
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
  return {
    app,
    db,
    setNow(value: string) { observedAt = value; },
    failAudit(action: string | null) { failAuditAction = action; },
  };
}

function request(token: string | null, path: string, body: Record<string, unknown>) {
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

describe("billing usage finance routes", () => {
  it("rolls back finance authorization and ledger mutations when mandatory audit persistence fails", async () => {
    const { app, db, failAudit } = fixture();
    const authorizationInput = {
      entryType: "credit",
      invoiceReference: "invoice-a",
      idempotencyKey: "credit-audit-atomicity",
      mcuMicrosDelta: -10,
      reason: "audit atomicity credit",
    };
    failAudit("billing.usage_finance_authorized");
    const failedAuthorization = request(
      "owner.a.jwt",
      "/billing/usage/finance-authorizations",
      authorizationInput,
    );
    expect((await app.request(failedAuthorization.path, failedAuthorization.init)).status).toBe(500);
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM usage_finance_authorizations WHERE entry_idempotency_key = ?",
    ).get(authorizationInput.idempotencyKey)).toEqual({ count: 0 });
    expect(listAudit(db, "tenant-a")).toEqual([]);

    failAudit(null);
    const create = request("owner.a.jwt", "/billing/usage/finance-authorizations", authorizationInput);
    const createdResponse = await app.request(create.path, create.init);
    expect(createdResponse.status).toBe(201);
    const authorization = await createdResponse.json() as {
      id: string;
      authorizationDigest: string;
    };
    const beforeLedger = listUsageLedger(db, "tenant-a");
    failAudit("billing.usage_credit");
    const credit = request("owner.a.jwt", "/billing/usage/credits", {
      idempotencyKey: authorizationInput.idempotencyKey,
      taskId: "task-a",
      mcuMicrosDelta: authorizationInput.mcuMicrosDelta,
      invoiceReference: authorizationInput.invoiceReference,
      reason: authorizationInput.reason,
      financeAuthorizationId: authorization.id,
      financeAuthorizationDigest: authorization.authorizationDigest,
    });
    expect((await app.request(credit.path, credit.init)).status).toBe(500);
    expect(listUsageLedger(db, "tenant-a")).toEqual(beforeLedger);
    expect(db.raw.prepare(
      "SELECT consumed_at, consumed_entry_id FROM usage_finance_authorizations WHERE id = ?",
    ).get(authorization.id)).toEqual({ consumed_at: null, consumed_entry_id: null });
    expect(listAudit(db, "tenant-a").map((event) => event.action)).toEqual([
      "billing.usage_finance_authorized",
    ]);
  });

  it("enforces human owner, tenant, digest, expiry, replay, and audit boundaries", async () => {
    const { app, db, setNow } = fixture();
    const authorizationInput = {
      entryType: "credit",
      invoiceReference: "invoice-a",
      idempotencyKey: "credit-expiry",
      mcuMicrosDelta: -10,
      reason: "approved customer credit",
    };
    const initialLedgerCount = listUsageLedger(db, "tenant-a").length;

    const unauthenticated = request(null, "/billing/usage/finance-authorizations", authorizationInput);
    expect((await app.request(unauthenticated.path, unauthenticated.init)).status).toBe(401);
    const nonOwner = request("admin.a.jwt", "/billing/usage/finance-authorizations", authorizationInput);
    expect((await app.request(nonOwner.path, nonOwner.init)).status).toBe(403);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM usage_finance_authorizations").get())
      .toEqual({ count: 0 });
    expect(listUsageLedger(db, "tenant-a")).toHaveLength(initialLedgerCount);

    const create = request("owner.a.jwt", "/billing/usage/finance-authorizations", authorizationInput);
    const createdResponse = await app.request(create.path, create.init);
    expect(createdResponse.status).toBe(201);
    const expiredAuthorization = await createdResponse.json() as {
      id: string;
      authorizationDigest: string;
    };
    const creditInput = {
      idempotencyKey: authorizationInput.idempotencyKey,
      taskId: "task-a",
      mcuMicrosDelta: authorizationInput.mcuMicrosDelta,
      invoiceReference: authorizationInput.invoiceReference,
      reason: authorizationInput.reason,
      financeAuthorizationId: expiredAuthorization.id,
      financeAuthorizationDigest: expiredAuthorization.authorizationDigest,
    };
    const unconsumedState = () => db.raw.prepare(
      "SELECT consumed_at, consumed_entry_id FROM usage_finance_authorizations WHERE id = ?",
    ).get(expiredAuthorization.id);

    const wrongDigest = request("owner.a.jwt", "/billing/usage/credits", {
      ...creditInput,
      financeAuthorizationDigest: `sha256:${"0".repeat(64)}`,
    });
    expect((await app.request(wrongDigest.path, wrongDigest.init)).status).toBe(409);
    expect(unconsumedState()).toEqual({ consumed_at: null, consumed_entry_id: null });
    expect(listUsageLedger(db, "tenant-a")).toHaveLength(initialLedgerCount);

    const crossTenant = request("owner.b.jwt", "/billing/usage/credits", creditInput);
    expect((await app.request(crossTenant.path, crossTenant.init)).status).toBe(409);
    expect(unconsumedState()).toEqual({ consumed_at: null, consumed_entry_id: null });
    expect(listUsageLedger(db, "tenant-a")).toHaveLength(initialLedgerCount);
    expect(listUsageLedger(db, "tenant-b")).toEqual([]);

    setNow("2026-09-02T12:06:00.000Z");
    const expired = request("owner.a.jwt", "/billing/usage/credits", creditInput);
    expect((await app.request(expired.path, expired.init)).status).toBe(409);
    expect(unconsumedState()).toEqual({ consumed_at: null, consumed_entry_id: null });
    expect(listUsageLedger(db, "tenant-a")).toHaveLength(initialLedgerCount);

    const validAuthorizationInput = {
      ...authorizationInput,
      idempotencyKey: "credit-valid",
      reason: "valid customer credit",
    };
    const validCreate = request(
      "owner.a.jwt",
      "/billing/usage/finance-authorizations",
      validAuthorizationInput,
    );
    const validCreateResponse = await app.request(validCreate.path, validCreate.init);
    expect(validCreateResponse.status).toBe(201);
    const validAuthorization = await validCreateResponse.json() as {
      id: string;
      authorizationDigest: string;
    };
    const validCredit = request("owner.a.jwt", "/billing/usage/credits", {
      idempotencyKey: validAuthorizationInput.idempotencyKey,
      taskId: "task-a",
      mcuMicrosDelta: validAuthorizationInput.mcuMicrosDelta,
      invoiceReference: validAuthorizationInput.invoiceReference,
      reason: validAuthorizationInput.reason,
      financeAuthorizationId: validAuthorization.id,
      financeAuthorizationDigest: validAuthorization.authorizationDigest,
    });
    const firstCreditResponse = await app.request(validCredit.path, validCredit.init);
    expect(firstCreditResponse.status).toBe(201);
    const firstCredit = await firstCreditResponse.json() as { id: string };
    const ledgerAfterCredit = listUsageLedger(db, "tenant-a");
    const replayResponse = await app.request(validCredit.path, validCredit.init);
    expect(replayResponse.status).toBe(201);
    expect(await replayResponse.json()).toMatchObject({ id: firstCredit.id });
    expect(listUsageLedger(db, "tenant-a")).toEqual(ledgerAfterCredit);

    expect(listAudit(db, "tenant-a").map((event) => event.action)).toEqual(expect.arrayContaining([
      "billing.usage_finance_authorized",
      "billing.usage_credit",
    ]));
  });
});
