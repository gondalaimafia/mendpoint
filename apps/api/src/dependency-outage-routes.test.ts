import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, createDependencyOutageQueue, type AppDb } from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { createDependencyOutageRoutes } from "./dependency-outage-routes.js";

const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(tenantId: string) {
  const directory = mkdtempSync(join(tmpdir(), "dependency-outage-api-"));
  const db = createDb(join(directory, "app.sqlite"));
  opened.push({ db, directory });
  // Distinct updated_at per tenant so ordering is deterministic rather than a
  // tie broken by operation_id. The foreign tenant is written LAST (most recent
  // updated_at) and with the highest-priority standing, so any missing tenant
  // scope on the row query or the standing probe surfaces its data first.
  let now = "2026-09-02T12:00:00.000Z";
  const queue = createDependencyOutageQueue(db.raw, {
    now: () => now,
  });
  queue.enqueue({
    tenantId,
    dependencyKind: "model",
    providerId: "muse-spark",
    operationId: `${tenantId}:private-operation`,
    operationDigest: "a".repeat(64),
    retryBudget: 3,
    expiresAt: "2026-09-02T14:00:00.000Z",
    nextAttemptAt: "2026-09-02T12:01:00.000Z",
    standing: "degraded_retrying",
    authorityVersion: "authority-v1",
  });
  now = "2026-09-02T12:05:00.000Z";
  queue.enqueue({
    tenantId: "tenant-foreign",
    dependencyKind: "model",
    providerId: "muse-spark",
    operationId: "tenant-foreign:private-operation",
    operationDigest: "b".repeat(64),
    retryBudget: 3,
    expiresAt: "2026-09-02T14:00:00.000Z",
    nextAttemptAt: "2026-09-02T12:01:00.000Z",
    standing: "degraded_blocked",
    authorityVersion: "authority-v1",
  });
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "human:owner", tenantId, role: "owner" });
    c.set("requestId", "request-1");
    await next();
  });
  app.route("/dependency-outages", createDependencyOutageRoutes({ db }));
  return app;
}

describe("dependency outage routes", () => {
  it("returns only bounded digest-only health for the authenticated tenant", async () => {
    const response = await fixture("tenant-a").request("/dependency-outages?limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      tenantId: string;
      total: number;
      returned: number;
      operations: Array<{ operationIdentityDigest: string }>;
    };
    expect(body).toMatchObject({ tenantId: "tenant-a", total: 1, returned: 1 });
    expect(body.operations[0]?.operationIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("tenant-foreign");
    expect(encoded).not.toContain("private-operation");
  });

  it("never returns a foreign tenant's rows or borrows its standing", async () => {
    const response = await fixture("tenant-a").request("/dependency-outages?limit=100");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      tenantId: string;
      standing: string;
      total: number;
      returned: number;
      operations: Array<{ standing: string }>;
    };
    // The foreign tenant owns a more recent row with a higher-priority
    // (degraded_blocked) standing. If the row query or the standing probe
    // dropped its tenant scope, that row would be counted and its standing
    // borrowed here.
    expect(body.tenantId).toBe("tenant-a");
    expect(body.total).toBe(1);
    expect(body.returned).toBe(1);
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0]?.standing).toBe("degraded_retrying");
    expect(body.standing).toBe("degraded_retrying");
  });

  it("rejects malformed and excessive bounds", async () => {
    const app = fixture("tenant-a");
    for (const limit of ["0", "101", "1.5", "all"]) {
      const response = await app.request(`/dependency-outages?limit=${limit}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "dependency_outage_list_limit_invalid" });
    }
  });

  it("redacts internal database failures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dependency-outage-api-failed-"));
    const db = createDb(join(directory, "app.sqlite"));
    const routes = createDependencyOutageRoutes({ db });
    db.raw.close();
    try {
      const app = new Hono<ApiEnv>();
      app.use("*", async (c, next) => {
        c.set("principal", { id: "human:owner", tenantId: "tenant-a", role: "owner" });
        c.set("requestId", "request-failed");
        await next();
      });
      app.route("/dependency-outages", routes);
      const response = await app.request("/dependency-outages");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "dependency_outage_query_failed" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
