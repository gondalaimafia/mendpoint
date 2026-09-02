import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKey,
  createDb,
  insertAgentRun,
  insertConsumer,
  insertMonitoredApi,
  insertProvider,
  insertTenant,
  provisionEntitlementForPlan,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createDiagnosticsRoutes, type DiagnosticsReport } from "./diagnostics-routes.js";
import { registerScmConnection } from "./repository-connections.js";
import { requestIdMiddleware } from "./production.js";

const NOW = "2026-08-13T00:00:00.000Z";
const directories: string[] = [];
const databases: AppDb[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  for (const db of databases.splice(0)) db.raw.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-diagnostics-api-"));
  directories.push(directory);
  const db = createDb(join(directory, "auth.sqlite"));
  databases.push(db);
  const tenantA = createApiKey(db, {
    id: "key-a",
    name: "Tenant A",
    tenantId: "tenant-a",
    scopes: ["*"],
    createdAt: NOW,
  });
  const tenantB = createApiKey(db, {
    id: "key-b",
    name: "Tenant B",
    tenantId: "tenant-b",
    scopes: ["*"],
    createdAt: NOW,
  });
  const tenantC = createApiKey(db, {
    id: "key-c",
    name: "Tenant C",
    tenantId: "tenant-c",
    scopes: ["*"],
    createdAt: NOW,
  });
  return { db, tenantA: tenantA.token, tenantB: tenantB.token, tenantC: tenantC.token };
}

function appFor(db: AppDb) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db, { now: () => new Date(NOW) }));
  app.route("/diagnostics", createDiagnosticsRoutes({ db, now: () => NOW }));
  return app;
}

function seedMonitoredProvider(db: AppDb, tenantId: string, slug: string) {
  const providerId = `provider-${slug}`;
  const consumerId = `consumer-${tenantId}-${slug}`;
  insertProvider(db, { id: providerId, slug, name: `${slug} API`, createdAt: NOW });
  insertConsumer(db, {
    id: consumerId,
    name: `${tenantId} app`,
    githubOwner: tenantId,
    githubRepo: "app",
    tenantId,
    createdAt: NOW,
  });
  insertMonitoredApi(db, {
    id: `monitored-${tenantId}-${slug}`,
    consumerId,
    providerId,
  });
}

function report(res: Response): Promise<DiagnosticsReport> {
  return res.json() as Promise<DiagnosticsReport>;
}

function checkById(body: DiagnosticsReport, id: string) {
  const found = body.checks.find((check) => check.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

describe("diagnostics API route", () => {
  it("requires authentication", async () => {
    const { db } = fixture();
    const res = await appFor(db).request("/diagnostics");
    expect(res.status).toBe(401);
  });

  it("reports specific failing checks with actionable fixes for an unconfigured tenant", async () => {
    const { db, tenantC } = fixture();
    const res = await appFor(db).request("/diagnostics", {
      headers: { Authorization: `Bearer ${tenantC}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await report(res);

    expect(body.tenantId).toBe("tenant-c");
    expect(body.status).toBe("fail");

    // No workspace row, no connection, no checkout, no entitlement: every one of
    // these derives from real (absent) state and must fail with guidance.
    for (const id of [
      "workspace",
      "repository_connected",
      "checkout_materialized",
      "quota_entitlement",
    ]) {
      const check = checkById(body, id);
      expect(check.status).toBe("fail");
      expect(check.guidance).not.toBeNull();
      expect(check.guidance?.howToFix.length ?? 0).toBeGreaterThan(0);
      expect(check.guidance?.title.length ?? 0).toBeGreaterThan(0);
    }

    // No monitored provider is a soft warning with its own fix.
    const provider = checkById(body, "provider_monitored");
    expect(provider.status).toBe("warn");
    expect(provider.guidance?.howToFix.length ?? 0).toBeGreaterThan(0);

    // Authentication succeeded (they reached the endpoint), so it passes.
    expect(checkById(body, "authentication").status).toBe("pass");
  });

  it("passes checks that derive from real configured state and flags a real failed run", async () => {
    const { db, tenantA } = fixture();
    insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Acme", plan: "free", createdAt: NOW });
    registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "local_git",
      externalAccountId: "acct-a",
      displayName: "Local A",
    });
    seedMonitoredProvider(db, "tenant-a", "stripe");
    provisionEntitlementForPlan(db, {
      tenantId: "tenant-a",
      plan: "free",
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      now: NOW,
    });
    insertAgentRun(db, {
      id: "run-failed-a",
      tenantId: "tenant-a",
      goal: "migrate",
      repoPath: "/repo",
      status: "failed",
      ok: false,
      steps: 1,
      createdAt: NOW,
    });

    const res = await appFor(db).request("/diagnostics", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    const body = await report(res);

    expect(checkById(body, "workspace").status).toBe("pass");
    expect(checkById(body, "repository_connected").status).toBe("pass");
    expect(checkById(body, "provider_monitored").status).toBe("pass");
    expect(checkById(body, "provider_monitored").detail).toContain("stripe");
    expect(checkById(body, "quota_entitlement").status).toBe("pass");

    // The failed run is real state; the check fails and carries guidance.
    const runs = checkById(body, "recent_runs");
    expect(runs.status).toBe("fail");
    expect(runs.detail).toContain("run-failed-a");
    expect(runs.guidance?.howToFix.length ?? 0).toBeGreaterThan(0);
    expect(body.status).toBe("fail");
  });

  it("scopes diagnostics to the calling tenant and never leaks another tenant's state", async () => {
    const { db, tenantA, tenantC } = fixture();
    // Tenant B is fully configured; tenant C is bare. Tenant C must not inherit
    // tenant B's connection or monitored provider.
    insertTenant(db, { id: "tenant-b", slug: "tenant-b", name: "Beta", plan: "free", createdAt: NOW });
    registerScmConnection(db, {
      tenantId: "tenant-b",
      provider: "local_git",
      externalAccountId: "acct-b",
      displayName: "Local B",
    });
    seedMonitoredProvider(db, "tenant-b", "twilio");

    // Tenant A monitors only its own provider.
    insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Acme", plan: "free", createdAt: NOW });
    seedMonitoredProvider(db, "tenant-a", "stripe");

    const cRes = await appFor(db).request("/diagnostics", {
      headers: { Authorization: `Bearer ${tenantC}` },
    });
    const cBody = await report(cRes);
    expect(cBody.tenantId).toBe("tenant-c");
    // No cross-tenant leakage: tenant C has no connection and no provider.
    expect(checkById(cBody, "repository_connected").status).toBe("fail");
    expect(checkById(cBody, "provider_monitored").status).toBe("warn");

    const aRes = await appFor(db).request("/diagnostics", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    const aBody = await report(aRes);
    expect(aBody.tenantId).toBe("tenant-a");
    const aProvider = checkById(aBody, "provider_monitored");
    expect(aProvider.detail).toContain("stripe");
    // Tenant B's provider must not appear in tenant A's report.
    expect(aProvider.detail).not.toContain("twilio");
  });
});
