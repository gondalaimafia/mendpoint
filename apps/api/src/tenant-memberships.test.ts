import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKey,
  createDb,
  getTenantMembership,
  insertPrincipal,
  listAudit,
  putTenantMembership,
  revokeApiKey,
  setTenantMembershipStatus,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { permissionForRoute } from "@mendpoint/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createTenantMembershipRoutes } from "./tenant-memberships.js";

const NOW = "2026-08-10T12:00:00.000Z";
const ISSUER = "https://identity.example.com";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-membership-admin-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
           ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`)
    .run(NOW, NOW);
  for (const [id, tenantId, subject, role] of [
    ["actor-owner-a", "tenant-a", "owner-a", "owner"],
    ["actor-admin-a", "tenant-a", "admin-a", "admin"],
    ["actor-engineer-a", "tenant-a", "engineer-a", "engineer"],
    ["actor-owner-b", "tenant-b", "owner-b", "owner"],
  ]) {
    insertPrincipal(db, {
      id,
      tenantId,
      kind: "human",
      subject: `${ISSUER}|${subject}`,
      displayName: id,
      audience: ISSUER,
      createdAt: NOW,
    });
    createApiKey(db, {
      id: `key-${subject}`,
      name: `${subject} delegated key`,
      tenantId,
      scopes: ["tenant:admin", `role:${role}`],
      createdAt: NOW,
    });
  }

  const identities = {
    "owner-a": { id: `human:${ISSUER}|owner-a`, tenantId: "tenant-a", role: "owner" as const, trust: "actor-owner-a" },
    "admin-a": { id: `human:${ISSUER}|admin-a`, tenantId: "tenant-a", role: "admin" as const, trust: "actor-admin-a" },
    "engineer-a": { id: `human:${ISSUER}|engineer-a`, tenantId: "tenant-a", role: "engineer" as const, trust: "actor-engineer-a" },
    "owner-b": { id: `human:${ISSUER}|owner-b`, tenantId: "tenant-b", role: "owner" as const, trust: "actor-owner-b" },
  };
  let sequence = 0;
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as keyof typeof identities | undefined;
    const identity = token ? identities[token] : undefined;
    if (identity) {
      c.set("principal", { id: identity.id, tenantId: identity.tenantId, role: identity.role });
      c.set("tenantId", identity.tenantId);
      c.set("trustPrincipalId", identity.trust);
      c.set("authMethod", "api_key");
      c.set("apiKeyId", `key-${token}`);
      c.set("authScopes", ["tenant:admin", `role:${identity.role}`]);
      c.set("requestId", c.req.header("X-Request-Id") ?? "request");
    }
    return next();
  });
  app.route("/tenants/memberships", createTenantMembershipRoutes({
    db,
    now: () => new Date(Date.parse(NOW) + sequence * 1_000),
    createId: () => `membership-audit-${++sequence}`,
  }));
  return { app, db };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Request-Id": `request-${token}`,
  };
}

function identity(subject: string, extra: Record<string, unknown> = {}) {
  return {
    issuer: "https://identity.example.com",
    subject,
    email: `${subject}@example.com`,
    displayName: subject,
    ...extra,
  };
}

async function delayedJsonRequest(
  app: Hono<ApiEnv>,
  path: string,
  init: Omit<RequestInit, "body">,
  payload: unknown,
  revoke: () => void,
): Promise<Response> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const pending = app.request(path, { ...init, body, duplex: "half" } as RequestInit & { duplex: "half" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  revoke();
  controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
  controller.close();
  return pending;
}

function seedAdminMembership(db: AppDb): void {
  putTenantMembership(db, {
    tenantId: "tenant-a",
    issuer: ISSUER,
    subject: "admin-a",
    email: "admin-a@example.com",
    displayName: "Admin A",
    role: "admin",
    status: "active",
    updatedAt: NOW,
  });
}

describe("tenant membership administration API", () => {
  it("uses the existing tenant admin permission boundary and allows an admin bootstrap", async () => {
    expect(permissionForRoute("GET", "/tenants/memberships")).toBe("tenant:admin");
    expect(permissionForRoute("POST", "/tenants/memberships/bootstrap")).toBe("tenant:admin");
    expect(permissionForRoute("PATCH", "/tenants/memberships/role")).toBe("tenant:admin");

    const { app } = fixture();
    const response = await app.request("/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify(identity("admin-a")),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: { tenantId: "tenant-a", subject: "admin-a", role: "owner", status: "active" },
    });
  });

  it("bootstraps exactly one tenant owner, rejects cross-tenant input, and audits the mutation", async () => {
    const { app, db } = fixture();
    expect((await app.request("/tenants/memberships")).status).toBe(401);

    const engineer = await app.request("/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("engineer-a"),
      body: JSON.stringify(identity("owner-1")),
    });
    expect(engineer.status).toBe(403);

    const crossTenant = await app.request("/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify(identity("owner-a", { tenantId: "tenant-b" })),
    });
    expect(crossTenant.status).toBe(422);

    const created = await app.request("/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify(identity("owner-a")),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      data: { tenantId: "tenant-a", subject: "owner-a", role: "owner", status: "active" },
    });

    const duplicateBootstrap = await app.request("/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify(identity("owner-2")),
    });
    expect(duplicateBootstrap.status).toBe(409);

    putTenantMembership(db, {
      tenantId: "tenant-b",
      ...identity("owner-b"),
      role: "owner",
      status: "active",
      updatedAt: NOW,
    });
    const listed = await app.request("/tenants/memberships", { headers: headers("owner-a") });
    const body = await listed.json() as { data: Array<{ tenantId: string; subject: string }> };
    expect(body.data).toEqual([expect.objectContaining({ tenantId: "tenant-a", subject: "owner-a" })]);

    const audit = listAudit(db, "tenant-a").find((event) => event.action === "tenant_membership.bootstrap");
    expect(audit).toMatchObject({
      actor: `human:${ISSUER}|owner-a`,
      principal_id: "actor-owner-a",
      request_id: "request-owner-a",
      resource_type: "tenant_membership",
    });
    expect(audit?.resource_id).toMatch(/^membership:[a-f0-9]{64}$/);
    expect(audit?.metadata_json).not.toContain("owner-a");
    expect(audit?.metadata_json).not.toContain("owner-a@example.com");
    expect(listAudit(db, "tenant-b")).toHaveLength(0);
  });

  it("lets owners and admins provision, change, and offboard non-owner memberships with audit evidence", async () => {
    const { app, db } = fixture();
    await app.request("/tenants/memberships/bootstrap", {
      method: "POST", headers: headers("owner-a"), body: JSON.stringify(identity("owner-a")),
    });
    seedAdminMembership(db);
    const provisioned = await app.request("/tenants/memberships", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify(identity("operator-1", { role: "engineer" })),
    });
    expect(provisioned.status).toBe(201);
    const provisionedBody = await provisioned.json() as { data: { updatedAt: string } };

    const roleChanged = await app.request("/tenants/memberships/role", {
      method: "PATCH",
      headers: headers("admin-a"),
      body: JSON.stringify({
        issuer: "https://identity.example.com",
        subject: "operator-1",
        role: "viewer",
        expectedUpdatedAt: provisionedBody.data.updatedAt,
      }),
    });
    expect(roleChanged.status).toBe(200);
    const roleBody = await roleChanged.json() as { data: { updatedAt: string } };

    const offboarded = await app.request("/tenants/memberships/offboard", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({
        issuer: "https://identity.example.com",
        subject: "operator-1",
        expectedUpdatedAt: roleBody.data.updatedAt,
      }),
    });
    expect(offboarded.status).toBe(200);
    await expect(offboarded.json()).resolves.toMatchObject({
      data: { role: "viewer", status: "offboarded" },
    });

    expect(listAudit(db, "tenant-a").map((event) => event.action)).toEqual(expect.arrayContaining([
      "tenant_membership.bootstrap",
      "tenant_membership.provision",
      "tenant_membership.role_change",
      "tenant_membership.offboard",
    ]));
  });

  it("prevents admins from controlling owners and prevents removal of the final active owner", async () => {
    const { app, db } = fixture();
    const bootstrap = await app.request("/tenants/memberships/bootstrap", {
      method: "POST", headers: headers("owner-a"), body: JSON.stringify(identity("owner-a")),
    });
    const bootstrapBody = await bootstrap.json() as { data: { updatedAt: string } };
    seedAdminMembership(db);

    const adminCreatesOwner = await app.request("/tenants/memberships", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify(identity("owner-2", { role: "owner" })),
    });
    expect(adminCreatesOwner.status).toBe(403);

    const adminChangesOwner = await app.request("/tenants/memberships/role", {
      method: "PATCH",
      headers: headers("admin-a"),
      body: JSON.stringify({
        issuer: "https://identity.example.com", subject: "owner-a", role: "admin",
        expectedUpdatedAt: bootstrapBody.data.updatedAt,
      }),
    });
    expect(adminChangesOwner.status).toBe(403);

    const finalOwnerOffboard = await app.request("/tenants/memberships/offboard", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({
        issuer: "https://identity.example.com", subject: "owner-a",
        expectedUpdatedAt: bootstrapBody.data.updatedAt,
      }),
    });
    expect(finalOwnerOffboard.status).toBe(409);
  });

  it("fails stale updates and unknown database exceptions closed without leaking internals", async () => {
    const { app, db } = fixture();
    await app.request("/tenants/memberships/bootstrap", {
      method: "POST", headers: headers("owner-a"), body: JSON.stringify(identity("owner-a")),
    });
    const provisioned = await app.request("/tenants/memberships", {
      method: "POST", headers: headers("owner-a"), body: JSON.stringify(identity("operator-1", { role: "engineer" })),
    });
    const value = await provisioned.json() as { data: { updatedAt: string } };
    const first = await app.request("/tenants/memberships/role", {
      method: "PATCH", headers: headers("owner-a"),
      body: JSON.stringify({
        issuer: "https://identity.example.com", subject: "operator-1", role: "viewer",
        expectedUpdatedAt: value.data.updatedAt,
      }),
    });
    expect(first.status).toBe(200);
    const stale = await app.request("/tenants/memberships/role", {
      method: "PATCH", headers: headers("owner-a"),
      body: JSON.stringify({
        issuer: "https://identity.example.com", subject: "operator-1", role: "engineer",
        expectedUpdatedAt: value.data.updatedAt,
      }),
    });
    expect(stale.status).toBe(409);

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.raw, "prepare").mockImplementation(() => {
      throw new Error("SQLITE_CONSTRAINT at C:\\customers\\private.sqlite");
    });
    const failed = await app.request("/tenants/memberships", { headers: headers("owner-a") });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "internal_error", requestId: "request-owner-a" });
  });

  it("cancels streamed overflow and rejects malformed lengths without mutation or audit", async () => {
    const { app, db } = fixture();
    const auditBefore = listAudit(db, "tenant-a");
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1_024 + 1)); },
      cancel() { cancelled = true; },
    });
    const overflow = await app.request("/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("owner-a"),
      body: oversized,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(overflow.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(listTenantMembershipsForTest(db, "tenant-a")).toEqual([]);
    expect(listAudit(db, "tenant-a")).toEqual(auditBefore);

    for (const declared of ["-1", "+1", "1.5", "not-a-number"]) {
      const malformed = await app.request("/tenants/memberships/bootstrap", {
        method: "POST",
        headers: { ...headers("owner-a"), "Content-Length": declared },
        body: JSON.stringify(identity("owner-a")),
      });
      expect(malformed.status).toBe(422);
      expect(listTenantMembershipsForTest(db, "tenant-a")).toEqual([]);
      expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
    }
  });

  it("revalidates a revoked bootstrap credential inside the mutation transaction", async () => {
    const { app, db } = fixture();
    const auditBefore = listAudit(db, "tenant-a");
    const rejected = await delayedJsonRequest(app, "/tenants/memberships/bootstrap", {
      method: "POST",
      headers: headers("owner-a"),
    }, identity("owner-a"), () => {
      revokeApiKey(db, "key-owner-a", "2026-08-10T12:00:01.000Z", "tenant-a");
    });

    expect(rejected.status).toBe(401);
    expect(listTenantMembershipsForTest(db, "tenant-a")).toEqual([]);
    expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
  });

  it.each(["provision", "role", "offboard"] as const)(
    "revalidates manager offboarding inside the %s mutation transaction",
    async (operation) => {
      const { app, db } = fixture();
      await app.request("/tenants/memberships/bootstrap", {
        method: "POST", headers: headers("owner-a"), body: JSON.stringify(identity("owner-a")),
      });
      let path = "/tenants/memberships";
      let method = "POST";
      let payload: Record<string, unknown> = identity("operator-1", { role: "engineer" });
      if (operation !== "provision") {
        const created = await app.request(path, {
          method: "POST", headers: headers("owner-a"), body: JSON.stringify(payload),
        });
        const createdBody = await created.json() as { data: { updatedAt: string } };
        if (operation === "role") {
          path = "/tenants/memberships/role";
          method = "PATCH";
          payload = { issuer: ISSUER, subject: "operator-1", role: "viewer", expectedUpdatedAt: createdBody.data.updatedAt };
        } else {
          path = "/tenants/memberships/offboard";
          payload = { issuer: ISSUER, subject: "operator-1", expectedUpdatedAt: createdBody.data.updatedAt };
        }
      }
      const targetBefore = getTenantMembership(db, "tenant-a", ISSUER, "operator-1");
      const auditBefore = listAudit(db, "tenant-a");
      const rejected = await delayedJsonRequest(app, path, {
        method,
        headers: headers("owner-a"),
      }, payload, () => {
        setTenantMembershipStatus(db, {
          tenantId: "tenant-a",
          issuer: ISSUER,
          subject: "owner-a",
          status: "offboarded",
          updatedAt: "2026-08-10T12:00:01.000Z",
        });
      });

      expect(rejected.status).toBe(403);
      expect(getTenantMembership(db, "tenant-a", ISSUER, "operator-1")).toEqual(targetBefore);
      expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
    },
  );
});

function listTenantMembershipsForTest(db: AppDb, tenantId: string): unknown[] {
  return db.raw.prepare("SELECT * FROM tenant_memberships WHERE tenant_id = ? ORDER BY issuer, subject").all(tenantId);
}
