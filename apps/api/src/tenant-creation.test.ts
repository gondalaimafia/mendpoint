import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb, getTenantBySlug, insertTenant } from "@mendpoint/db";
import { createTopLevelTenant } from "./tenant-creation.js";
import { createTenantCreationRoutes } from "./tenant-creation-routes.js";
import type { ApiEnv } from "./auth.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tenant-create-"));
  dirs.push(dir);
  return createDb(join(dir, "db.sqlite"));
}

describe("createTopLevelTenant", () => {
  it("requires system catalog authority", () => {
    const db = fixture();
    insertTenant(db, { id: "tenant-customer", slug: "customer", name: "Customer", createdAt: "2026-08-24T00:00:00.000Z" });
    expect(() => createTopLevelTenant(db, {
      principal: { id: "owner", tenantId: "tenant-customer", role: "owner" },
      input: { slug: "victim", name: "Victim", plan: "free" },
      id: "tenant-victim",
      createdAt: "2026-08-24T00:00:00.000Z",
    })).toThrow(/catalog authority required/i);
    expect(getTenantBySlug(db, "victim")).toBeUndefined();
    db.raw.close();
  });

  it("rejects unknown plans before inserting a tenant", () => {
    const db = fixture();
    expect(() => createTopLevelTenant(db, {
      principal: { id: "system", tenantId: "tenant_default", role: "owner" },
      input: { slug: "bad-plan", name: "Bad Plan", plan: "made-up" },
      id: "tenant-bad-plan",
      createdAt: "2026-08-24T00:00:00.000Z",
    })).toThrow(/invalid plan/i);
    expect(getTenantBySlug(db, "bad-plan")).toBeUndefined();
    db.raw.close();
  });

  it("enforces catalog authority and plan validation at the endpoint", async () => {
    const db = fixture();
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", {
        id: "caller",
        tenantId: c.req.header("x-test-tenant") ?? "tenant-customer",
        role: "owner",
      });
      c.set("requestId", "request-tenant-create");
      await next();
    });
    app.route("/tenants", createTenantCreationRoutes({
      db,
      id: () => "tenant-created",
      now: () => "2026-08-24T00:00:00.000Z",
    }));

    const customer = await app.request("/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "customer-created", name: "Customer Created", plan: "free" }),
    });
    expect(customer.status).toBe(403);
    expect(getTenantBySlug(db, "customer-created")).toBeUndefined();

    const invalidPlan = await app.request("/tenants", {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-tenant": "tenant_default" },
      body: JSON.stringify({ slug: "bad-plan", name: "Bad Plan", plan: "made-up" }),
    });
    expect(invalidPlan.status).toBe(400);
    expect(getTenantBySlug(db, "bad-plan")).toBeUndefined();
    db.raw.close();
  });
});
