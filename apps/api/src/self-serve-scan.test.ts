/**
 * Self-serve Warden scan trigger (S1.2).
 *
 * Drives the flag-gated /self-serve/scan route with two tenants and asserts:
 *  - the route is inert (404) unless MENDPOINT_SELF_SERVE_WARDEN=1;
 *  - a customer can enqueue one pipeline.fanout run for THEIR own tenant and gets
 *    back the job id + resolved provider + status;
 *  - the Idempotency-Key collapses a double-click to a single job (replayed);
 *  - a customer can never trigger a run on another tenant's provider.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMonitoredApi,
  insertProvider,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createSelfServeScanRoutes, selfServeWardenEnabled } from "./self-serve-scan.js";

const NOW = "2026-08-13T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Seed a provider (shared catalog), a change, plus a tenant consumer monitoring it. */
function seedMonitored(
  db: AppDb,
  tenantId: string,
  slug: string,
  opts: { changeAt?: string } = {},
): void {
  insertProvider(db, { id: `provider-${slug}`, slug, name: `Provider ${slug}`, createdAt: NOW });
  insertApiVersion(db, {
    id: `version-${slug}-1`,
    providerId: `provider-${slug}`,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: `version-${slug}-2`,
    providerId: `provider-${slug}`,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "2" } }),
    publishedAt: NOW,
  });
  if (opts.changeAt) {
    insertApiChange(db, {
      id: `change-${slug}`,
      providerId: `provider-${slug}`,
      fromVersionId: `version-${slug}-1`,
      toVersionId: `version-${slug}-2`,
      risk: "breaking",
      summary: `Change ${slug}`,
      diffJson: "[]",
      createdAt: opts.changeAt,
    });
  }
  insertConsumer(db, {
    id: `consumer-${tenantId}-${slug}`,
    name: `Consumer ${slug}`,
    githubOwner: "customer",
    githubRepo: `repo-${slug}`,
    tenantId,
    createdAt: NOW,
  });
  insertMonitoredApi(db, {
    id: `mon-${tenantId}-${slug}`,
    consumerId: `consumer-${tenantId}-${slug}`,
    providerId: `provider-${slug}`,
  });
}

const identities = {
  "owner-a": { id: "human:owner-a@example.com", tenantId: "tenant-a", role: "owner" as const },
  "owner-b": { id: "human:owner-b@example.com", tenantId: "tenant-b", role: "owner" as const },
} as const;

function fixture(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-scan-api-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  // tenant-a monitors two providers; alpha has the more recent change so it is auto-picked.
  seedMonitored(db, "tenant-a", "alpha", { changeAt: "2026-08-13T10:00:00.000Z" });
  seedMonitored(db, "tenant-a", "gamma", { changeAt: "2026-08-10T10:00:00.000Z" });
  // tenant-b monitors its own provider only.
  seedMonitored(db, "tenant-b", "beta", { changeAt: "2026-08-13T09:00:00.000Z" });

  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as
      | keyof typeof identities
      | undefined;
    const principal = token ? identities[token] : undefined;
    if (principal) {
      c.set("principal", principal);
      c.set("requestId", `request-${token}`);
    }
    return next();
  });
  app.route("/self-serve/scan", createSelfServeScanRoutes({ db, enabled, now: () => NOW }));
  return { app, db };
}

function headers(token: string, key?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (key) h["Idempotency-Key"] = key;
  return h;
}

function countJobs(db: AppDb, tenantId: string): number {
  return (
    db.raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = ?").get(tenantId) as {
      n: number;
    }
  ).n;
}

describe("self-serve Warden scan trigger", () => {
  it("is inert (404) unless the exact flag is set", async () => {
    expect(selfServeWardenEnabled({})).toBe(false);
    expect(selfServeWardenEnabled({ MENDPOINT_SELF_SERVE_WARDEN: "true" })).toBe(false);
    expect(selfServeWardenEnabled({ MENDPOINT_SELF_SERVE_WARDEN: "1" })).toBe(true);

    const { app, db } = fixture(false);
    const res = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-a", "scan-key-00000001"),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    // Flag OFF enqueues nothing.
    expect(countJobs(db, "tenant-a")).toBe(0);
  });

  it("enqueues one pipeline.fanout run for the caller's own tenant (auto-picks latest change)", async () => {
    const { app, db } = fixture();
    const res = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-a", "scan-key-00000001"),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      jobId: string;
      providerSlug: string;
      type: string;
      status: string;
      replayed: boolean;
    };
    expect(body.providerSlug).toBe("alpha");
    expect(body.type).toBe("pipeline.fanout");
    expect(body.status).toBe("pending");
    expect(body.replayed).toBe(false);
    expect(body.jobId).toMatch(/^scan-job-/);

    // Exactly one job, owned by tenant-a, targeting the tenant's own provider.
    expect(countJobs(db, "tenant-a")).toBe(1);
    const job = db.raw
      .prepare("SELECT tenant_id, type, payload_json FROM jobs WHERE id = ?")
      .get(body.jobId) as { tenant_id: string; type: string; payload_json: string };
    expect(job.tenant_id).toBe("tenant-a");
    expect(job.type).toBe("pipeline.fanout");
    expect(JSON.parse(job.payload_json)).toMatchObject({ providerSlug: "alpha", tenantId: "tenant-a" });
  });

  it("is idempotent: the same key collapses a double-click to one job", async () => {
    const { app, db } = fixture();
    const first = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-a", "scan-key-double-click"),
      body: JSON.stringify({}),
    });
    const second = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-a", "scan-key-double-click"),
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = (await first.json()) as { jobId: string; replayed: boolean };
    const secondBody = (await second.json()) as { jobId: string; replayed: boolean };
    expect(firstBody.replayed).toBe(false);
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    // No double-run.
    expect(countJobs(db, "tenant-a")).toBe(1);
  });

  it("accepts an explicit provider the tenant monitors", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-a", "scan-key-explicit1"),
      body: JSON.stringify({ providerSlug: "gamma" }),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { providerSlug: string }).providerSlug).toBe("gamma");
  });

  it("refuses to scan another tenant's provider (tenant-scoped)", async () => {
    const { app, db } = fixture();
    // tenant-b tries to trigger a run on tenant-a's provider "alpha".
    const res = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-b", "scan-key-crosstenant"),
      body: JSON.stringify({ providerSlug: "alpha" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "provider not monitored by tenant" });
    // Nothing was enqueued for either tenant on tenant-b's behalf.
    expect(countJobs(db, "tenant-b")).toBe(0);
  });

  it("rejects a request without a valid Idempotency-Key", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/scan", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
