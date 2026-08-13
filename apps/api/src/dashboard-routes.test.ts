import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKey,
  createDb,
  insertConsumer,
  insertAgentRun,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createDashboardRoutes } from "./dashboard-routes.js";
import { requestIdMiddleware } from "./production.js";

const NOW = "2026-08-01T00:00:00.000Z";
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
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-dashboard-api-"));
  directories.push(directory);
  const db = createDb(join(directory, "auth.sqlite"));
  databases.push(db);
  const tenantA = createApiKey(db, { id: "key-a", name: "Tenant A", tenantId: "tenant-a", scopes: ["*"], createdAt: NOW });
  const tenantB = createApiKey(db, { id: "key-b", name: "Tenant B", tenantId: "tenant-b", scopes: ["*"], createdAt: NOW });
  return { db, tenantA: tenantA.token, tenantB: tenantB.token };
}

function appFor(db: AppDb) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db));
  app.route("/metrics/dashboard", createDashboardRoutes({ db }));
  return app;
}

function seedTenant(db: AppDb, tenantId: string) {
  insertConsumer(db, {
    id: `${tenantId}-c1`,
    name: "repo",
    githubOwner: "acme",
    githubRepo: "repo",
    tenantId,
    createdAt: NOW,
  });
  insertAgentRun(db, {
    id: `${tenantId}-r1`,
    tenantId,
    goal: "fix",
    repoPath: "/repo",
    status: "candidate_approved",
    ok: true,
    steps: 1,
    createdAt: NOW,
    finishedAt: NOW,
  });
}

describe("self-serve dashboard API route", () => {
  it("requires authentication", async () => {
    const { db } = fixture();
    expect((await appFor(db).request("/metrics/dashboard")).status).toBe(401);
    expect((await appFor(db).request("/metrics/dashboard/export")).status).toBe(401);
  });

  it("returns tenant-scoped numbers and never another tenant's data", async () => {
    const { db, tenantA } = fixture();
    seedTenant(db, "tenant-a");
    insertConsumer(db, {
      id: "tenant-a-c2",
      name: "repo2",
      githubOwner: "acme",
      githubRepo: "repo2",
      tenantId: "tenant-a",
      createdAt: NOW,
    });
    seedTenant(db, "tenant-b"); // must not appear for tenant-a

    const res = await appFor(db).request("/metrics/dashboard", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      tenantId: string;
      adoption: { reposConnected: number; totalRuns: number };
      outcomes: { candidatesApproved: number };
      cost: { mcu: { basis: string } };
    };
    expect(body.tenantId).toBe("tenant-a");
    expect(body.adoption.reposConnected).toBe(2);
    expect(body.adoption.totalRuns).toBe(1);
    expect(body.outcomes.candidatesApproved).toBe(1);
    expect(body.cost.mcu.basis).toBe("unavailable");
  });

  it("rejects an invalid time window with 400", async () => {
    const { db, tenantA } = fixture();
    const res = await appFor(db).request(
      "/metrics/dashboard?since=2026-08-10T00:00:00.000Z&until=2026-08-01T00:00:00.000Z",
      { headers: { Authorization: `Bearer ${tenantA}` } },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("dashboard_window_invalid");
  });

  it("exports CSV whose values match the JSON dashboard", async () => {
    const { db, tenantA } = fixture();
    seedTenant(db, "tenant-a");

    const jsonRes = await appFor(db).request("/metrics/dashboard/export?format=json", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    const dashboard = (await jsonRes.json()) as { adoption: { reposConnected: number } };

    const csvRes = await appFor(db).request("/metrics/dashboard/export", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    const header = csv.split("\n")[0];
    expect(header).toBe("dimension,metric,value,basis,source");
    // reposConnected cell value equals the JSON value.
    const line = csv.split("\n").find((l) => l.startsWith('"adoption","reposConnected"'))!;
    expect(line).toContain(`"${dashboard.adoption.reposConnected}"`);
  });

  it("captures a satisfaction rating that then feeds the dashboard metric", async () => {
    const { db, tenantA, tenantB } = fixture();
    seedTenant(db, "tenant-a");

    // Before any rating the dimension is honestly unavailable.
    const before = (await (
      await appFor(db).request("/metrics/dashboard", { headers: { Authorization: `Bearer ${tenantA}` } })
    ).json()) as { developerSatisfaction: { basis: string } };
    expect(before.developerSatisfaction.basis).toBe("unavailable");

    const post = await appFor(db).request("/metrics/dashboard/satisfaction", {
      method: "POST",
      headers: { Authorization: `Bearer ${tenantA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5, runId: "tenant-a-r1", comment: "clean patch" }),
    });
    expect(post.status).toBe(201);

    // A run that belongs to another tenant cannot be rated.
    const crossTenant = await appFor(db).request("/metrics/dashboard/satisfaction", {
      method: "POST",
      headers: { Authorization: `Bearer ${tenantB}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 5, runId: "tenant-a-r1" }),
    });
    expect(crossTenant.status).toBe(404);

    // An out-of-range rating is rejected.
    const bad = await appFor(db).request("/metrics/dashboard/satisfaction", {
      method: "POST",
      headers: { Authorization: `Bearer ${tenantA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ rating: 9 }),
    });
    expect(bad.status).toBe(400);

    const after = (await (
      await appFor(db).request("/metrics/dashboard", { headers: { Authorization: `Bearer ${tenantA}` } })
    ).json()) as { developerSatisfaction: { basis: string; responses: number; averageRating: number | null } };
    expect(after.developerSatisfaction.basis).toBe("measured");
    expect(after.developerSatisfaction.responses).toBe(1);
    expect(after.developerSatisfaction.averageRating).toBe(5);
  });
});
