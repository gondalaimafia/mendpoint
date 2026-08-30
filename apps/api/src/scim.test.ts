import {
  claimIdentitySession,
  createApiKey,
  createDb,
  getIdentitySession,
  getTenantMembership,
  insertPrincipal,
  listAudit,
  putTenantMembership,
  type AppDb,
} from "@mendpoint/db";
import { permissionForRoute } from "@mendpoint/platform";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, scopeAllows, type ApiEnv } from "./auth.js";
import { createScimRoutes, scimBindingsFromEnv, validateScimBindings } from "./scim.js";

const NOW = "2026-08-30T12:00:00.000Z";
const ISSUER = "https://identity.example";
const opened: Array<{ db: AppDb; directory: string }> = [];
const saved = process.env.API_AUTH;

function fixture(audience = "mendpoint-scim") {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-scim-"));
  const db = createDb(join(directory, "identity.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'enterprise', 'active', 20, ?),
            ('tenant-b', 'tenant-b', 'Tenant B', 'enterprise', 'active', 20, ?)`,
  ).run(NOW, NOW);
  const service = insertPrincipal(db, {
    id: "principal-scim-a",
    tenantId: "tenant-a",
    kind: "service",
    subject: "enterprise-scim",
    displayName: "Enterprise SCIM",
    audience,
    expiresAt: "2026-09-29T12:00:00.000Z",
    createdAt: NOW,
  });
  const key = createApiKey(db, {
    id: "key-scim-a",
    name: "SCIM key",
    tenantId: "tenant-a",
    principalId: service.id,
    scopes: ["identity:provision"],
    createdAt: NOW,
  });
  const bindings = scimBindingsFromEnv({
    OIDC_ISSUER: ISSUER,
    MENDPOINT_SCIM_BINDINGS_JSON: JSON.stringify({
      schemaVersion: 1,
      bindings: [{ tenantId: "tenant-a", principalId: service.id, issuer: ISSUER }],
    }),
  });
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => { c.set("requestId", "request-scim"); await next(); });
  app.use("*", createAuthMiddleware(db, { oidc: null, now: () => new Date(NOW) }));
  app.route("/scim/v2", createScimRoutes({ db, bindings, now: () => new Date(NOW) }));
  process.env.API_AUTH = "required";
  return { app, db, key, bindings, service };
}

afterEach(() => {
  process.env.API_AUTH = saved;
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function headers(token: string, extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, "content-type": "application/scim+json", ...extra };
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    externalId: "idp-user-1",
    userName: "reviewer@example.com",
    displayName: "Reviewer",
    active: true,
    roles: [{ value: "engineer", primary: true }],
    ...overrides,
  };
}

describe("SCIM tenant lifecycle", () => {
  it("binds provisioned identities to the exact configured OIDC issuer", () => {
    const equivalent = scimBindingsFromEnv({
      OIDC_ISSUER: `${ISSUER}/`,
      MENDPOINT_SCIM_BINDINGS_JSON: JSON.stringify({
        schemaVersion: 1,
        bindings: [{ tenantId: "tenant-a", principalId: "principal-scim-a", issuer: ISSUER }],
      }),
    });
    expect(equivalent.get("tenant-a")?.issuer).toBe(`${ISSUER}/`);

    expect(() => scimBindingsFromEnv({
      OIDC_ISSUER: "https://other-identity.example",
      MENDPOINT_SCIM_BINDINGS_JSON: JSON.stringify({
        schemaVersion: 1,
        bindings: [{ tenantId: "tenant-a", principalId: "principal-scim-a", issuer: ISSUER }],
      }),
    })).toThrow("scim_oidc_issuer_mismatch");

    expect(() => scimBindingsFromEnv({
      MENDPOINT_SCIM_BINDINGS_JSON: JSON.stringify({
        schemaVersion: 1,
        bindings: [{ tenantId: "tenant-a", principalId: "principal-scim-a", issuer: ISSUER }],
      }),
    })).toThrow("scim_oidc_issuer_required");
  });

  it("requires an exact bound service principal and an explicit non-wildcard provisioning scope", async () => {
    expect(permissionForRoute("POST", "/scim/v2/Users")).toBe("identity:provision");
    expect(scopeAllows(["*"], "identity:provision")).toBe(false);
    expect(scopeAllows(["identity:provision"], "identity:provision")).toBe(true);

    const wrong = fixture("mendpoint-api");
    const denied = await wrong.app.request("/scim/v2/Users", {
      method: "POST",
      headers: headers(wrong.key.token),
      body: JSON.stringify(user()),
    });
    expect(denied.status).toBe(403);
  });

  it("validates every protected binding against an active SCIM principal and exact credential scope", () => {
    const valid = fixture();
    expect(() => validateScimBindings(valid.db, valid.bindings, NOW)).not.toThrow();

    valid.db.raw.prepare("UPDATE api_keys SET scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["identity:provision", "graph:read"]), valid.key.id);
    expect(() => validateScimBindings(valid.db, valid.bindings, NOW))
      .toThrow("scim_binding_scope_invalid");

    const wrongAudience = fixture("mendpoint-api");
    expect(() => validateScimBindings(wrongAudience.db, wrongAudience.bindings, NOW))
      .toThrow("scim_binding_principal_invalid");
  });

  it("provisions, lists, filters, and exactly replays a user without crossing tenants", async () => {
    const { app, db, key } = fixture();
    const created = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    });
    expect(created.status).toBe(201);
    const payload = await created.json() as { id: string; meta: { version: string } };
    expect(payload.id).toMatch(/^scim-user-/);
    expect(payload.meta.version).toBe(`W/"${NOW}"`);

    const replay = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { id: string }).id).toBe(payload.id);
    expect(getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")).toMatchObject({ role: "engineer", status: "active" });
    expect(getTenantMembership(db, "tenant-b", ISSUER, "idp-user-1")).toBeUndefined();

    const list = await app.request('/scim/v2/Users?filter=userName%20eq%20%22reviewer%40example.com%22', { headers: headers(key.token) });
    await expect(list.json()).resolves.toMatchObject({ totalResults: 1, Resources: [{ id: payload.id }] });
    const azureFilter = await app.request('/scim/v2/Users?filter=USERNAME%20EQ%20%22REVIEWER%40EXAMPLE.COM%22', { headers: headers(key.token) });
    await expect(azureFilter.json()).resolves.toMatchObject({ totalResults: 1, Resources: [{ id: payload.id }] });
    expect(listAudit(db, "tenant-a").filter((row) => row.action === "scim.user.provision")).toHaveLength(1);
  });

  it("accepts Okta and Azure case variants plus pathless Replace while validating schemas", async () => {
    const { app, key } = fixture();
    const created = await app.request("/scim/v2/Users", {
      method: "POST",
      headers: headers(key.token),
      body: JSON.stringify({
        Schemas: ["URN:IETF:PARAMS:SCIM:SCHEMAS:CORE:2.0:USER"],
        ExternalId: "azure-user-1",
        UserName: "Azure.User@example.com",
        DisplayName: "Azure User",
        Active: true,
        Roles: [
          { VALUE: "Viewer" },
          { VALUE: "Engineer", PRIMARY: true },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { id: string; meta: { version: string } };

    const patched = await app.request(`/scim/v2/Users/${createdBody.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": createdBody.meta.version }),
      body: JSON.stringify({
        SCHEMAS: ["URN:IETF:PARAMS:SCIM:API:MESSAGES:2.0:PATCHOP"],
        operations: [{ OP: "Replace", VALUE: { ACTIVE: false, DISPLAYNAME: "Disabled Azure User" } }],
      }),
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      active: false,
      displayName: "Disabled Azure User",
    });

    const missingSchema = await app.request("/scim/v2/Users", {
      method: "POST",
      headers: headers(key.token),
      body: JSON.stringify({ ...user(), schemas: [] }),
    });
    expect(missingSchema.status).toBe(400);
  });

  it("rejects empty PATCH operations without advancing the resource version", async () => {
    const { app, db, key } = fixture();
    const created = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    });
    const value = await created.json() as { id: string; meta: { version: string } };
    const before = getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")!;

    const rejected = await app.request(`/scim/v2/Users/${value.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": value.meta.version }),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [],
      }),
    });

    expect(rejected.status).toBe(400);
    expect(getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")?.updated_at).toBe(before.updated_at);
    expect(listAudit(db, "tenant-a").filter((row) => row.action === "scim.user.patch")).toHaveLength(0);
  });

  it("rejects case-insensitive duplicate pathless attributes without mutation", async () => {
    const { app, db, key } = fixture();
    const created = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    });
    const value = await created.json() as { id: string; meta: { version: string } };
    const before = getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")!;

    const rejected = await app.request(`/scim/v2/Users/${value.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": value.meta.version }),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "Replace", value: { active: true, ACTIVE: false } }],
      }),
    });

    expect(rejected.status).toBe(400);
    expect(getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")).toMatchObject({
      status: before.status,
      updated_at: before.updated_at,
    });
    expect(listAudit(db, "tenant-a").filter((row) => row.action === "scim.user.patch")).toHaveLength(0);
  });

  it.each([
    [{ value: "engineer", VALUE: "viewer", primary: true }],
    [{ value: "engineer", primary: true, PRIMARY: false }],
  ])("rejects case-insensitive duplicate role subattributes without mutation", async (ambiguousRole) => {
    const { app, db, key } = fixture();
    const created = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    });
    const value = await created.json() as { id: string; meta: { version: string } };
    const before = getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")!;

    const rejected = await app.request(`/scim/v2/Users/${value.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": value.meta.version }),
      body: JSON.stringify({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "Replace", path: "roles", value: [ambiguousRole] }],
      }),
    });

    expect(rejected.status).toBe(400);
    expect(getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")).toMatchObject({
      role: before.role,
      updated_at: before.updated_at,
    });
    expect(listAudit(db, "tenant-a").filter((row) => row.action === "scim.user.patch")).toHaveLength(0);
  });

  it("enforces case-insensitive userName uniqueness inside one tenant provisioning domain", async () => {
    const { app, key } = fixture();
    expect((await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    })).status).toBe(201);
    const duplicate = await app.request("/scim/v2/Users", {
      method: "POST",
      headers: headers(key.token),
      body: JSON.stringify(user({ externalId: "idp-user-2", userName: "REVIEWER@EXAMPLE.COM" })),
    });
    expect(duplicate.status).toBe(409);
  });

  it("rejects conflicting replay and stale updates, then deactivates and reactivates the same identity", async () => {
    const { app, db, key } = fixture();
    const created = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user()),
    });
    const value = await created.json() as { id: string; meta: { version: string } };
    insertPrincipal(db, {
      id: "principal-human-scim-user",
      tenantId: "tenant-a",
      kind: "human",
      subject: `${ISSUER}|idp-user-1`,
      displayName: "Reviewer",
      audience: ISSUER,
      createdAt: NOW,
    });
    const session = claimIdentitySession(db, {
      tenantId: "tenant-a",
      principalId: "principal-human-scim-user",
      issuer: ISSUER,
      subject: "idp-user-1",
      membershipUpdatedAt: NOW,
      authStrength: "amr:mfa",
      token: "scim-user-session-token",
      issuedAt: "2026-08-30T11:55:00.000Z",
      expiresAt: "2026-08-30T13:00:00.000Z",
      observedAt: NOW,
    });
    const conflicting = await app.request("/scim/v2/Users", {
      method: "POST", headers: headers(key.token), body: JSON.stringify(user({ displayName: "Different" })),
    });
    expect(conflicting.status).toBe(409);

    const stale = await app.request(`/scim/v2/Users/${value.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": 'W/"stale"' }),
      body: JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: false }] }),
    });
    expect(stale.status).toBe(412);

    const deactivated = await app.request(`/scim/v2/Users/${value.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": value.meta.version }),
      body: JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: false }] }),
    });
    expect(deactivated.status).toBe(200);
    const deactivatedValue = await deactivated.json() as { active: boolean; meta: { version: string } };
    expect(deactivatedValue.active).toBe(false);
    expect(getIdentitySession(db, "tenant-a", session.id)).toMatchObject({
      revoked_at: "2026-08-30T12:00:00.001Z",
      revoke_reason: "scim_deactivated",
    });

    const reactivated = await app.request(`/scim/v2/Users/${value.id}`, {
      method: "PATCH",
      headers: headers(key.token, { "if-match": deactivatedValue.meta.version }),
      body: JSON.stringify({ schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "Replace", path: "active", value: true }] }),
    });
    expect(reactivated.status).toBe(200);
    expect(getTenantMembership(db, "tenant-a", ISSUER, "idp-user-1")?.status).toBe("active");
  });

  it("keeps owner lifecycle outside SCIM", async () => {
    const { app, db, key } = fixture();
    putTenantMembership(db, {
      tenantId: "tenant-a", issuer: ISSUER, subject: "owner-1", email: "owner@example.com",
      displayName: "Owner", role: "owner", status: "active", updatedAt: NOW,
    });
    const owners = await app.request('/scim/v2/Users?filter=externalId%20eq%20%22owner-1%22', { headers: headers(key.token) });
    const owner = (await owners.json() as { Resources: Array<{ id: string; meta: { version: string } }> }).Resources[0]!;
    const deleteOwner = await app.request(`/scim/v2/Users/${owner.id}`, {
      method: "DELETE", headers: headers(key.token, { "if-match": owner.meta.version }),
    });
    expect(deleteOwner.status).toBe(400);
    expect(getTenantMembership(db, "tenant-a", ISSUER, "owner-1")?.status).toBe("active");
  });
});
