import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApiKey,
  createDb,
  getPrincipal,
  putTenantMembership,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createSelfServeSignupRoutes, selfServeSignupEnabled } from "./self-serve-signup.js";
import { createTenantMembershipRoutes } from "./tenant-memberships.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(enabled = true) {
  process.env.API_AUTH = "required";
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-signup-api-"));
  dirs.push(dir);
  const db = createDb(join(dir, "app.sqlite"));
  dbs.push(db);
  const app = new Hono<ApiEnv>();
  app.use("*", createAuthMiddleware(db));
  app.route("/auth/signup", createSelfServeSignupRoutes({ db, enabled }));
  app.route("/tenants/memberships", createTenantMembershipRoutes({ db }));
  return { app, db };
}

const json = { "content-type": "application/json" };

describe("self-serve signup API", () => {
  it("is unavailable by default and only enables on the exact flag", async () => {
    expect(selfServeSignupEnabled({})).toBe(false);
    expect(selfServeSignupEnabled({ MENDPOINT_SELF_SERVE_SIGNUP: "true" })).toBe(false);
    expect(selfServeSignupEnabled({ MENDPOINT_SELF_SERVE_SIGNUP: "1" })).toBe(true);
    const { app } = fixture(false);
    const response = await app.request("/auth/signup", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "founder@acme.test" }),
    });
    expect(response.status).toBe(404);
  });

  it("provisions a new tenant, owner, and API key without any prior credential", async () => {
    const { app, db } = fixture();
    const response = await app.request("/auth/signup", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "Founder@Acme.test", workspaceName: "Acme Corp" }),
    });
    expect(response.status).toBe(201);
    const created = await response.json() as {
      tenant: { id: string; slug: string; name: string; plan: string };
      owner: { subject: string; role: string; email: string };
      apiKey: { token: string; prefix: string };
    };
    expect(created.owner).toMatchObject({ subject: "founder@acme.test", role: "owner", email: "founder@acme.test" });
    expect(created.tenant.name).toBe("Acme Corp");
    expect(created.apiKey.token).toMatch(/^me_/);

    // The freshly minted key authenticates as this tenant's owner.
    const memberships = await app.request("/tenants/memberships", {
      headers: { Authorization: `Bearer ${created.apiKey.token}` },
    });
    expect(memberships.status).toBe(200);
    const body = await memberships.json() as { data: Array<{ tenantId: string; role: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ tenantId: created.tenant.id, role: "owner" });

    // Durable rows exist exactly once.
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM tenants WHERE id = ?").get(created.tenant.id) as { n: number }).n).toBe(1);
  });

  it("returns 409 when the same owner signs up twice", async () => {
    const { app } = fixture();
    const first = await app.request("/auth/signup", { method: "POST", headers: json, body: JSON.stringify({ email: "founder@acme.test" }) });
    expect(first.status).toBe(201);
    const second = await app.request("/auth/signup", { method: "POST", headers: json, body: JSON.stringify({ email: "founder@acme.test" }) });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "self_serve_account_exists" });
  });

  it("migrates a legacy self-serve owner key to the founding human authority", async () => {
    const { app, db } = fixture();
    const createdAt = "2026-08-13T00:00:00.000Z";
    db.raw.prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant_ss_legacy', 'ss-legacy', 'Legacy', 'free', 'active', 3, ?)`,
    ).run(createdAt);
    putTenantMembership(db, {
      tenantId: "tenant_ss_legacy",
      issuer: "https://self-serve.mendpoint.ai",
      subject: "legacy@example.test",
      email: "legacy@example.test",
      displayName: "Legacy",
      role: "owner",
      status: "active",
      updatedAt: createdAt,
    });
    const legacy = createApiKey(db, {
      id: "key_ss_legacy_owner",
      name: "Legacy owner key",
      tenantId: "tenant_ss_legacy",
      scopes: ["*"],
      createdAt,
    });

    const response = await app.request("/tenants/memberships", {
      headers: { Authorization: `Bearer ${legacy.token}` },
    });
    expect(response.status).toBe(200);
    const key = db.raw.prepare(
      "SELECT authority_principal_id, authority_role FROM api_keys WHERE id = ?",
    ).get(legacy.id) as { authority_principal_id: string | null; authority_role: string | null };
    expect(key.authority_role).toBe("owner");
    expect(getPrincipal(db, "tenant_ss_legacy", key.authority_principal_id!)).toMatchObject({
      kind: "human",
      subject: "https://self-serve.mendpoint.ai|legacy@example.test",
      audience: "https://self-serve.mendpoint.ai",
    });
  });

  it("isolates the new tenant: its key cannot read another tenant's data", async () => {
    const { app, db } = fixture();
    // A pre-existing tenant with its own membership row.
    createApiKey(db, { id: "key-other", name: "Other", tenantId: "tenant-other", scopes: ["*"], createdAt: "2026-08-13T00:00:00.000Z" });
    db.raw.prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-other', 'other', 'Other', 'free', 'active', 3, '2026-08-13T00:00:00.000Z')`,
    ).run();
    db.raw.prepare(
      `INSERT INTO tenant_memberships (tenant_id, issuer, subject, email, display_name, role, status, created_at, updated_at, offboarded_at)
       VALUES ('tenant-other', 'https://id.example', 'other-owner', 'other@x.test', 'Other Owner', 'owner', 'active', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z', NULL)`,
    ).run();

    const signup = await app.request("/auth/signup", { method: "POST", headers: json, body: JSON.stringify({ email: "founder@acme.test" }) });
    const created = await signup.json() as { tenant: { id: string }; apiKey: { token: string } };

    const memberships = await app.request("/tenants/memberships", {
      headers: { Authorization: `Bearer ${created.apiKey.token}` },
    });
    const body = await memberships.json() as { data: Array<{ tenantId: string }> };
    // Only its own tenant is visible; the other tenant's owner row is never returned.
    expect(body.data.every((row) => row.tenantId === created.tenant.id)).toBe(true);
    expect(body.data.some((row) => row.tenantId === "tenant-other")).toBe(false);
  });
});
