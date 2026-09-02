import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey, createDb, insertAgentRun, type AppDb } from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createOutcomeMetricsRoutes } from "./outcome-metrics-routes.js";
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
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-outcome-api-"));
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
  return { db, tenantA: tenantA.token, tenantB: tenantB.token };
}

function appFor(db: AppDb) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db, { now: () => new Date(NOW) }));
  app.route("/metrics/outcomes", createOutcomeMetricsRoutes({ db }));
  return app;
}

function seedRun(db: AppDb, id: string, tenantId: string, status: string) {
  insertAgentRun(db, {
    id,
    tenantId,
    goal: "fix",
    repoPath: "/repo",
    status,
    ok: status === "candidate_approved",
    steps: 1,
    createdAt: NOW,
    finishedAt: "2026-08-01T01:00:00.000Z",
  });
}

describe("outcome metrics API route", () => {
  it("requires authentication", async () => {
    const { db } = fixture();
    const res = await appFor(db).request("/metrics/outcomes");
    expect(res.status).toBe(401);
  });

  it("returns tenant-scoped metrics with no-store caching", async () => {
    const { db, tenantA } = fixture();
    seedRun(db, "a1", "tenant-a", "candidate_approved");
    seedRun(db, "a2", "tenant-a", "candidate_rejected");
    seedRun(db, "b1", "tenant-b", "candidate_approved");

    const res = await appFor(db).request("/metrics/outcomes", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      tenantId: string;
      totalRuns: number;
      candidateProducingRuns: number;
      acceptedCandidateRate: { value: number | null };
      externalBaseline: { headToHeadMeasured: boolean };
    };
    expect(body.tenantId).toBe("tenant-a");
    expect(body.totalRuns).toBe(2);
    expect(body.candidateProducingRuns).toBe(2);
    expect(body.acceptedCandidateRate.value).toBeCloseTo(0.5, 10);
    expect(body.externalBaseline.headToHeadMeasured).toBe(false);
  });

  it("rejects an invalid time window with 400", async () => {
    const { db, tenantA } = fixture();
    const res = await appFor(db).request(
      "/metrics/outcomes?since=2026-08-10T00:00:00.000Z&until=2026-08-01T00:00:00.000Z",
      { headers: { Authorization: `Bearer ${tenantA}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("outcome_window_invalid");
  });

  it("requires authentication for the retrieval-gaps surface", async () => {
    const { db } = fixture();
    const res = await appFor(db).request("/metrics/outcomes/retrieval-gaps");
    expect(res.status).toBe(401);
  });

  it("serves the tenant-scoped retrieval context-gap summary with no-store caching", async () => {
    const { db, tenantA } = fixture();
    const res = await appFor(db).request("/metrics/outcomes/retrieval-gaps", {
      headers: { Authorization: `Bearer ${tenantA}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      tenantId: string;
      totalGaps: number;
      byCapability: unknown[];
      recent: unknown[];
    };
    expect(body.tenantId).toBe("tenant-a");
    // No gaps recorded in this fixture: an honest zero, not a placeholder.
    expect(body.totalGaps).toBe(0);
    expect(body.byCapability).toEqual([]);
    expect(body.recent).toEqual([]);
  });

  it("rejects an invalid retrieval-gaps time window with 400", async () => {
    const { db, tenantA } = fixture();
    const res = await appFor(db).request(
      "/metrics/outcomes/retrieval-gaps?since=2026-08-10T00:00:00.000Z&until=2026-08-01T00:00:00.000Z",
      { headers: { Authorization: `Bearer ${tenantA}` } },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("retrieval_gap_window_invalid");
  });
});
