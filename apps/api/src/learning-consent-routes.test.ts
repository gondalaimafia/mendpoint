import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createLearningConsentRoutes } from "./learning-consent-routes.js";
import { requestIdMiddleware } from "./production.js";

const AT = "2026-08-01T00:00:00.000Z";
const directories: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-consent-api-"));
  directories.push(dir);
  const db = createDb(join(dir, "consent.sqlite"));
  databases.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: AT });
    insertPrincipal(db, {
      id: `human-${tenantId}`,
      tenantId,
      kind: "human",
      subject: `user-${tenantId}`,
      displayName: `Human ${tenantId}`,
      createdAt: AT,
    });
    insertPrincipal(db, {
      id: `apikey-${tenantId}`,
      tenantId,
      kind: "api_key",
      subject: `key-${tenantId}`,
      displayName: `Key ${tenantId}`,
      createdAt: AT,
    });
  }
  return db;
}

/**
 * Build a test app whose principal + trust principal are injected server-side,
 * exactly as the auth middleware would. `ctx: null` leaves the request
 * unauthenticated. The tenant is NEVER taken from the request body.
 */
function appWith(
  db: AppDb,
  ctx: { tenantId: string; trustPrincipalId?: string } | null,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  if (ctx) {
    app.use("*", async (c, next) => {
      c.set("principal", { id: `test:${ctx.tenantId}`, tenantId: ctx.tenantId, role: "owner" });
      if (ctx.trustPrincipalId) c.set("trustPrincipalId", ctx.trustPrincipalId);
      await next();
    });
  }
  app.route("/learning", createLearningConsentRoutes({ db }));
  return app;
}

const grantBody = {
  consentVersion: 1,
  purpose: "migration-adapter",
  residencyRegion: "us-east",
  reason: "Authorized adapter improvement",
  idempotencyKey: "grant-1",
};

describe("learning consent API routes", () => {
  it("requires authentication", async () => {
    const db = fixture();
    const res = await appWith(db, null).request("/learning/consent", {
      method: "POST",
      body: JSON.stringify(grantBody),
    });
    expect(res.status).toBe(401);
  });

  it("grants consent for a human principal", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const res = await app.request("/learning/consent", {
      method: "POST",
      body: JSON.stringify(grantBody),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { consent: { action: string; tenant_id: string } };
    expect(body.consent.action).toBe("granted");
    expect(body.consent.tenant_id).toBe("tenant-a");
  });

  it("rejects a non-human principal on grant (§19.5 human-only)", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "apikey-tenant-a" });
    const res = await app.request("/learning/consent", {
      method: "POST",
      body: JSON.stringify(grantBody),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("learning_human_principal_required");
  });

  it("derives tenant from the principal, not the body (cross-tenant revoke is blocked)", async () => {
    const db = fixture();
    // A real granted consent owned by tenant-b.
    const consentB = grantLearningConsent(db, {
      id: "consent-b",
      tenantId: "tenant-b",
      consentVersion: 1,
      purpose: "migration-adapter",
      residencyRegion: "us-east",
      authorizedByPrincipalId: "human-tenant-b",
      effectiveAt: AT,
      reason: "tenant b grant",
      idempotencyKey: "grant-b",
      createdAt: AT,
    });

    // tenant-a caller tries to revoke tenant-b's consent by id. The route scopes
    // to the caller's tenant, so the consent is invisible: 404, not a revoke.
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const res = await app.request("/learning/consent/revoke", {
      method: "POST",
      body: JSON.stringify({
        consentId: consentB.id,
        consentVersion: 2,
        reason: "attempted cross-tenant revoke",
        idempotencyKey: "revoke-cross",
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("learning_consent_tenant_mismatch");
  });

  it("returns 404 lineage for a record outside the caller's tenant", async () => {
    const db = fixture();
    const app = appWith(db, { tenantId: "tenant-a", trustPrincipalId: "human-tenant-a" });
    const res = await app.request("/learning/records/does-not-exist/lineage");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("learning_record_tenant_mismatch");
  });
});
