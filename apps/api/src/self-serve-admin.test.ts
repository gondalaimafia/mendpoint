import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  listAudit,
  putTenantMembership,
  type AppDb,
} from "@mendpoint/db";
import { permissionsFor } from "@mendpoint/platform";
import { resolveEffectiveConfig, parseMendpointConfig } from "@mendpoint/transformer";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import {
  createSelfServeAdminRoutes,
  resolveMemberAccess,
  computeSecurityPosture,
} from "./self-serve-admin.js";

const NOW = "2026-08-12T12:00:00.000Z";
const ISSUER = "https://identity.example.com";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedRepo(db: AppDb, tenantId: string, owner: string, name: string, environment: string) {
  const connId = `conn-${tenantId}`;
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO scm_connections
       (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
       VALUES (?, ?, 'github', 'ref', ?, ?, ?, ?)`,
    )
    .run(connId, tenantId, `${tenantId}-acct`, `${tenantId} conn`, NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO connected_repositories
       (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
        environment, retention_days, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'main', 'main', ?, 30, 'ready', ?, ?)`,
    )
    .run(`repo-${tenantId}-${owner}-${name}`, tenantId, connId, `${owner}/${name}`, owner, name, environment, NOW, NOW);
}

function fixture(env: NodeJS.ProcessEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-admin-scopes-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  for (const id of ["tenant-a", "tenant-b"]) {
    db.raw
      .prepare(
        `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
         VALUES (?, ?, ?, 'team', 'active', 10, ?)`,
      )
      .run(id, id, id, NOW);
  }
  for (const [tenantId, subject, role] of [
    ["tenant-a", "owner-a", "owner"],
    ["tenant-a", "admin-a", "admin"],
    ["tenant-a", "engineer-a", "engineer"],
    ["tenant-a", "member-1", "engineer"],
    ["tenant-b", "owner-b", "owner"],
  ] as const) {
    putTenantMembership(db, {
      tenantId,
      issuer: ISSUER,
      subject,
      email: `${subject}@example.com`,
      displayName: subject,
      role,
      status: "active",
      updatedAt: NOW,
    });
  }
  seedRepo(db, "tenant-a", "acme", "api", "production");
  seedRepo(db, "tenant-a", "acme", "web", "staging");
  seedRepo(db, "tenant-b", "acme", "secret", "production");

  const identities: Record<string, { id: string; tenantId: string; role: "owner" | "admin" | "engineer"; trust: string }> = {
    "owner-a": { id: "human:owner-a", tenantId: "tenant-a", role: "owner", trust: "trust-owner-a" },
    "admin-a": { id: "human:admin-a", tenantId: "tenant-a", role: "admin", trust: "trust-admin-a" },
    "engineer-a": { id: "human:engineer-a", tenantId: "tenant-a", role: "engineer", trust: "trust-engineer-a" },
    "owner-b": { id: "human:owner-b", tenantId: "tenant-b", role: "owner", trust: "trust-owner-b" },
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
      c.set("requestId", `request-${token}`);
    }
    return next();
  });
  app.route(
    "/self-serve/admin",
    createSelfServeAdminRoutes({
      db,
      enabled: true,
      env,
      now: () => new Date(Date.parse(NOW) + sequence * 1_000),
      createId: () => `admin-audit-${++sequence}`,
    }),
  );
  return { app, db };
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("self-serve admin — flag gating", () => {
  it("is byte-identical (404 on every path) when the flag is off", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-admin-off-"));
    const db = createDb(join(directory, "api.sqlite"));
    opened.push({ db, directory });
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "human:owner-a", tenantId: "tenant-a", role: "owner" });
      c.set("trustPrincipalId", "trust-owner-a");
      return next();
    });
    app.route("/self-serve/admin", createSelfServeAdminRoutes({ db, enabled: false }));
    for (const path of ["/self-serve/admin/scopes", "/self-serve/admin/posture", "/self-serve/admin/audit"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "not_found" });
    }
    const post = await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    expect(post.status).toBe(404);
  });
});

describe("self-serve admin — authorization", () => {
  it("requires authentication and owner/admin authority for every route", async () => {
    const { app } = fixture();
    expect((await app.request("/self-serve/admin/scopes")).status).toBe(401);
    // An engineer is authenticated but not a manager.
    for (const path of ["/self-serve/admin/scopes", "/self-serve/admin/posture", "/self-serve/admin/audit", "/self-serve/admin/access?issuer=x&subject=y"]) {
      const res = await app.request(path, { headers: headers("engineer-a") });
      expect(res.status).toBe(403);
    }
    const grant = await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("engineer-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    expect(grant.status).toBe(403);
  });
});

describe("self-serve admin — repository/environment scoping", () => {
  it("lets an admin grant, list and revoke a repository scope, each mutation audited", async () => {
    const { app, db } = fixture();
    const grant = await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    expect(grant.status).toBe(201);

    const listed = await app.request("/self-serve/admin/scopes?issuer=" + encodeURIComponent(ISSUER) + "&subject=member-1", {
      headers: headers("admin-a"),
    });
    const listedBody = await listed.json() as { data: Array<{ scopeValue: string }> };
    expect(listedBody.data.map((s) => s.scopeValue)).toEqual(["acme/api"]);

    const removed = await app.request("/self-serve/admin/scopes", {
      method: "DELETE",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    expect(removed.status).toBe(200);

    const actions = listAudit(db, "tenant-a").map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member_scope.grant", "member_scope.revoke"]));
    const grantEvent = listAudit(db, "tenant-a").find((e) => e.action === "member_scope.grant");
    expect(grantEvent?.resource_id).toMatch(/^member_scope:[a-f0-9]{64}$/);
    expect(grantEvent?.metadata_json).not.toContain("member-1"); // member identity is hashed, not stored raw
    expect(grantEvent?.metadata_json).toContain("acme/api");
  });

  it("refuses to scope a member to a repository the tenant does not have (no widening)", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/secret" }),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "admin_repository_not_found" });
  });

  it("refuses to scope an unknown member", async () => {
    const { app } = fixture();
    const res = await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "ghost", scopeType: "repository", scopeValue: "acme/api" }),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "admin_member_not_found" });
  });
});

describe("self-serve admin — effective access", () => {
  it("returns full tenant reach with no scopes and a narrowed intersection with scopes", async () => {
    const { app } = fixture();
    const unscoped = await app.request(
      "/self-serve/admin/access?issuer=" + encodeURIComponent(ISSUER) + "&subject=member-1",
      { headers: headers("admin-a") },
    );
    const unscopedBody = await unscoped.json() as {
      data: { repositories: { mode: string; allowed: string[] }; environments: { mode: string; allowed: string[] } };
    };
    expect(unscopedBody.data.repositories.mode).toBe("all");
    expect(unscopedBody.data.repositories.allowed).toEqual(["acme/api", "acme/web"]);
    expect(unscopedBody.data.environments.allowed).toEqual(["production", "staging"]);

    await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    const scoped = await app.request(
      "/self-serve/admin/access?issuer=" + encodeURIComponent(ISSUER) + "&subject=member-1",
      { headers: headers("admin-a") },
    );
    const scopedBody = await scoped.json() as {
      data: { repositories: { mode: string; allowed: string[] }; permissions: { trigger: string[] } };
    };
    expect(scopedBody.data.repositories.mode).toBe("scoped");
    expect(scopedBody.data.repositories.allowed).toEqual(["acme/api"]);
    // Permissions never exceed the role's RBAC grants.
    for (const perm of scopedBody.data.permissions.trigger) {
      expect(permissionsFor("engineer")).toContain(perm);
    }
  });
});

describe("self-serve admin — cross-tenant isolation", () => {
  it("never reads or writes another tenant's scopes or audit", async () => {
    const { app, db } = fixture();
    // owner-b (tenant-b) cannot see tenant-a scopes.
    await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    const bList = await app.request("/self-serve/admin/scopes", { headers: headers("owner-b") });
    await expect(bList.json()).resolves.toEqual({ data: [] });

    // owner-b cannot grant against a tenant-a repository (it is not tenant-b's).
    const bGrant = await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("owner-b"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    // member-1 is not a tenant-b member, so it fails closed before repo resolution.
    expect(bGrant.status).toBe(404);

    // Audit for tenant-b is empty; tenant-a has the grant.
    const bAudit = await app.request("/self-serve/admin/audit", { headers: headers("owner-b") });
    const bAuditBody = await bAudit.json() as { data: unknown[]; total: number };
    expect(bAuditBody.total).toBe(0);
    expect(listAudit(db, "tenant-a").length).toBeGreaterThan(0);
  });
});

describe("self-serve admin — audit view + export", () => {
  it("returns tenant-scoped events with chain status, filters, and CSV export", async () => {
    const { app } = fixture();
    await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "environment", scopeValue: "production" }),
    });
    const view = await app.request("/self-serve/admin/audit", { headers: headers("owner-a") });
    const viewBody = await view.json() as {
      data: Array<{ action: string; actor: string }>;
      total: number;
      chain: { ok: boolean; checked: number };
    };
    expect(viewBody.chain.ok).toBe(true);
    expect(viewBody.total).toBeGreaterThanOrEqual(1);
    expect(viewBody.data[0].action).toBe("member_scope.grant");

    const filtered = await app.request("/self-serve/admin/audit?action=member_scope.grant", { headers: headers("owner-a") });
    const filteredBody = await filtered.json() as { data: unknown[]; total: number };
    expect(filteredBody.total).toBe(1);

    const csv = await app.request("/self-serve/admin/audit/export", { headers: headers("owner-a") });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("mendpoint-audit.csv");
    const text = await csv.text();
    expect(text.split("\n")[0]).toContain("created_at,event_sequence,actor");
    expect(text).toContain("member_scope.grant");
  });
});

describe("self-serve admin — security posture", () => {
  it("reflects real settings (scopes, routing, microVM, audit chain)", async () => {
    const { app } = fixture({
      MENDPOINT_CUSTOMER_MODEL_ROUTING: "on",
      MENDPOINT_SANDBOX_FLY_APP: "mendpoint-sbx",
      FLY_API_TOKEN: "tok",
      MENDPOINT_SANDBOX_FLY_MODE: "live",
    });
    // Before any scope: least-privilege not yet applied.
    const before = await app.request("/self-serve/admin/posture", { headers: headers("owner-a") });
    const beforeBody = await before.json() as { data: { controls: Array<{ id: string; status: string }> } };
    const scopeControl = () => beforeBody.data.controls.find((c) => c.id === "least_privilege_scopes")!;
    expect(scopeControl().status).toBe("not_configured");
    expect(beforeBody.data.controls.find((c) => c.id === "microvm_isolation")!.status).toBe("configured");
    expect(beforeBody.data.controls.find((c) => c.id === "non_training_model_routing")!.status).toBe("enforced");
    expect(beforeBody.data.controls.find((c) => c.id === "audit_chain")!.status).toBe("enforced");

    await app.request("/self-serve/admin/scopes", {
      method: "POST",
      headers: headers("admin-a"),
      body: JSON.stringify({ issuer: ISSUER, subject: "member-1", scopeType: "repository", scopeValue: "acme/api" }),
    });
    const after = await app.request("/self-serve/admin/posture", { headers: headers("owner-a") });
    const afterBody = await after.json() as { data: { controls: Array<{ id: string; status: string }> } };
    expect(afterBody.data.controls.find((c) => c.id === "least_privilege_scopes")!.status).toBe("enforced");
  });

  it("reports microVM not_configured and routing not_configured when the deployment lacks them", () => {
    const { db } = fixture({});
    const posture = computeSecurityPosture(db, { tenantId: "tenant-a", env: {}, now: () => NOW });
    expect(posture.controls.find((c) => c.id === "microvm_isolation")!.status).toBe("not_configured");
    expect(posture.controls.find((c) => c.id === "non_training_model_routing")!.status).toBe("not_configured");
    // Structural controls are always enforced.
    expect(posture.controls.find((c) => c.id === "tenant_isolation")!.status).toBe("enforced");
    expect(posture.controls.find((c) => c.id === "secret_redaction")!.status).toBe("enforced");
  });
});

describe("resolveMemberAccess — invariants (no widening, config narrowing)", () => {
  const universeRepos = ["acme/api", "acme/web"];
  const universeEnvs = ["production", "staging"];

  it("never exceeds the role's RBAC grants and drops bogus scope values", () => {
    const access = resolveMemberAccess({
      role: "engineer",
      scopes: { repositories: ["acme/api", "acme/ghost"], environments: ["prod-ghost"] },
      tenantRepositories: universeRepos,
      tenantEnvironments: universeEnvs,
      effective: resolveEffectiveConfig({}),
    });
    // Permissions are exactly the RBAC grants when config does not narrow.
    expect([...access.permissions.trigger].sort()).toEqual([...permissionsFor("engineer")].sort());
    // Bogus repo/env values are advisory, never allowed (no widening).
    expect(access.repositories.allowed).toEqual(["acme/api"]);
    expect(access.repositories.advisory).toEqual(["acme/ghost"]);
    expect(access.environments.allowed).toEqual([]);
    expect(access.environments.advisory).toEqual(["prod-ghost"]);
  });

  it("respects config-as-code narrowing of a role's permissions", () => {
    const config = parseMendpointConfig({
      version: 1,
      permissions: { roles: { engineer: { trigger: ["plan:read"], approve: [] } } },
    });
    const effective = resolveEffectiveConfig({ fileConfig: config });
    const access = resolveMemberAccess({
      role: "engineer",
      scopes: { repositories: [], environments: [] },
      tenantRepositories: universeRepos,
      tenantEnvironments: universeEnvs,
      effective,
    });
    // Config narrowed trigger to just plan:read; the result is a subset of RBAC grants.
    expect(access.permissions.trigger).toEqual(["plan:read"]);
    expect(access.permissions.approve).toEqual([]);
    for (const perm of access.permissions.trigger) {
      expect(permissionsFor("engineer")).toContain(perm);
    }
  });
});
