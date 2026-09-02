/**
 * HTTP-level FET-017 + FET-018 composition on GET /changes/:id.
 *
 * The production route in server.ts is a thin wrapper around changeDetailBody
 * after catalog isolation. This file mounts the same body helper behind auth so
 * a shared catalog change cannot leak another tenant's raw_retrieval stamp.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKey,
  createDb,
  getChange,
  getProviderById,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertImpactFinding,
  insertMigrationPr,
  insertProvider,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { changeDetailBody } from "./change-detail.js";
import { requestIdMiddleware } from "./production.js";
import { providerVisibleToTenant } from "./self-serve-catalog.js";

const NOW = "2026-08-25T12:00:00.000Z";
const CHANGE_ID = "chg-shared";
const opened: Array<{ db: AppDb; directory: string }> = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-change-detail-impact-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  insertProvider(db, {
    id: "provider-shared",
    slug: "shared-api",
    name: "Shared API",
    createdAt: NOW,
  });
  insertApiVersion(db, {
    id: "ver-1",
    providerId: "provider-shared",
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: "shared", version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: "ver-2",
    providerId: "provider-shared",
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: "shared", version: "2" } }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: CHANGE_ID,
    providerId: "provider-shared",
    fromVersionId: "ver-1",
    toVersionId: "ver-2",
    risk: "breaking",
    summary: "field renamed",
    diffJson: JSON.stringify({ entries: [] }),
    createdAt: NOW,
  });
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
  app.get("/changes/:id", (c) => {
    const change = getChange(db, c.req.param("id"));
    if (!change) return c.json({ error: "not found" }, 404);
    const changeProvider = getProviderById(db, change.provider_id);
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    if (principal.tenantId.trim() === "") {
      return c.json({ error: "tenant_scope_required" }, 403);
    }
    if (changeProvider && !providerVisibleToTenant(changeProvider, principal.tenantId)) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(changeDetailBody(db, principal.tenantId, change));
  });
  return app;
}

function seedConsumer(
  db: AppDb,
  tenantId: string,
  opts: { fallback?: "raw_retrieval"; findings?: number; coverageBasis?: "analyzed" },
) {
  const suffix = tenantId.replace("tenant-", "");
  insertConsumer(db, {
    id: `consumer-${suffix}`,
    name: `Consumer ${suffix}`,
    githubOwner: "acme",
    githubRepo: `repo-${suffix}`,
    tenantId,
    createdAt: NOW,
  });
  insertMigrationPr(db, {
    id: `pr-${suffix}`,
    changeId: CHANGE_ID,
    consumerId: `consumer-${suffix}`,
    title: `Migration ${suffix}`,
    body: "Candidate.",
    branchName: `mendpoint/${suffix}`,
    status: "draft",
    risk: "breaking",
    patchUnified: "",
    createdAt: NOW,
    coverageJson: JSON.stringify({ basis: opts.coverageBasis ?? "analyzed" }),
  });
  const findingCount = opts.findings ?? 0;
  for (let i = 0; i < findingCount; i += 1) {
    insertImpactFinding(db, {
      id: `finding-${suffix}-${i}`,
      changeId: CHANGE_ID,
      consumerId: `consumer-${suffix}`,
      filePath: "app.ts",
      lineStart: i + 1,
      lineEnd: i + 1,
      symbol: "source",
      confidence: "high",
      evidenceJson: "{}",
    });
  }
  recordAudit(db, {
    tenantId,
    actor: "pipeline",
    action: "impact.analyzed",
    resourceType: "consumer",
    resourceId: `consumer-${suffix}`,
    metadata: {
      changeId: CHANGE_ID,
      findings: findingCount,
      ...(opts.fallback ? { fallback: opts.fallback } : {}),
    },
  });
}

type ChangeDetailResponse = {
  impactCoverage: {
    impact: string;
    coverageBasis: string | null;
    reason: string | null;
    findingCount: number;
    prCount: number;
    fallback: "raw_retrieval" | null;
  };
  findings: unknown[];
  prs: Array<{ id: string }>;
};

async function getChangeJson(app: Hono<ApiEnv>, token: string) {
  const response = await app.request(`/changes/${CHANGE_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as ChangeDetailResponse,
  };
}

describe("GET /changes/:id impact coverage + FET-018 audit", () => {
  it("requires authentication", async () => {
    const { db } = fixture();
    expect((await appFor(db).request(`/changes/${CHANGE_ID}`)).status).toBe(401);
  });

  it("reports raw_retrieval without flipping verified no_impact", async () => {
    const { db, tenantA } = fixture();
    seedConsumer(db, "tenant-a", { fallback: "raw_retrieval", findings: 0 });
    const { status, body } = await getChangeJson(appFor(db), tenantA);
    expect(status).toBe(200);
    expect(body.impactCoverage).toEqual({
      impact: "no_impact",
      coverageBasis: "analyzed",
      reason: null,
      findingCount: 0,
      prCount: 1,
      fallback: "raw_retrieval",
    });
    expect(body.findings).toEqual([]);
  });

  it("leaves graph-authoritative analysis unlabeled", async () => {
    const { db, tenantA } = fixture();
    seedConsumer(db, "tenant-a", { findings: 0 });
    const { status, body } = await getChangeJson(appFor(db), tenantA);
    expect(status).toBe(200);
    expect(body.impactCoverage.impact).toBe("no_impact");
    expect(body.impactCoverage.fallback).toBeNull();
  });

  it("reports fallback null when no impact.analyzed event exists", async () => {
    const { db, tenantA } = fixture();
    const { status, body } = await getChangeJson(appFor(db), tenantA);
    expect(status).toBe(200);
    expect(body.impactCoverage).toMatchObject({
      impact: "unknown_impact",
      reason: "pipeline_not_recorded",
      fallback: null,
    });
  });

  it("keeps impact when findings exist and still reports the stamp", async () => {
    const { db, tenantA } = fixture();
    seedConsumer(db, "tenant-a", { fallback: "raw_retrieval", findings: 1 });
    const { status, body } = await getChangeJson(appFor(db), tenantA);
    expect(status).toBe(200);
    expect(body.impactCoverage.impact).toBe("impact");
    expect(body.impactCoverage.findingCount).toBe(1);
    expect(body.impactCoverage.fallback).toBe("raw_retrieval");
    expect(body.findings).toHaveLength(1);
  });

  it("does not let tenant B observe tenant A's raw_retrieval stamp on the shared change", async () => {
    const { db, tenantA, tenantB } = fixture();
    seedConsumer(db, "tenant-a", { fallback: "raw_retrieval", findings: 1 });
    seedConsumer(db, "tenant-b", { findings: 0 });
    const a = await getChangeJson(appFor(db), tenantA);
    const b = await getChangeJson(appFor(db), tenantB);
    expect(a.body.impactCoverage.fallback).toBe("raw_retrieval");
    expect(a.body.findings).toHaveLength(1);
    expect(b.body.impactCoverage.fallback).toBeNull();
    expect(b.body.impactCoverage.impact).toBe("no_impact");
    expect(b.body.findings).toEqual([]);
    expect(b.body.prs).toHaveLength(1);
    expect(b.body.prs[0].id).toBe("pr-b");
    expect(a.body.prs[0].id).toBe("pr-a");
  });
});
