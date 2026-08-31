import {
  changeTenantMembershipRole,
  createDb,
  getIdentitySession,
  listAudit,
  putTenantMembership,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv, type OidcVerifier } from "./auth.js";
import { createIdentitySessionRoutes } from "./identity-sessions.js";

const NOW = "2026-08-30T12:00:00.000Z";
const ISSUED = "2026-08-30T11:55:00.000Z";
const EXPIRES = "2026-08-30T12:55:00.000Z";
const TOKEN = "header.payload.signature";
const opened: Array<{ db: AppDb; directory: string }> = [];
const saved = { apiAuth: process.env.API_AUTH, nodeEnv: process.env.NODE_ENV };

function fixture(session = true) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-identity-session-"));
  const db = createDb(join(directory, "identity.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'enterprise', 'active', 20, ?)`,
  ).run(NOW);
  putTenantMembership(db, {
    tenantId: "tenant-a",
    issuer: "https://identity.example",
    subject: "human-a",
    email: "human-a@example.com",
    displayName: "Human A",
    role: "owner",
    status: "active",
    updatedAt: NOW,
  });
  const oidc: OidcVerifier = {
    verify: async () => ({
      issuer: "https://identity.example",
      subject: "human-a",
      tenantId: "tenant-a",
      ...(session ? { session: { issuedAt: ISSUED, expiresAt: EXPIRES, authStrength: "amr:mfa" } } : {}),
    }),
  };
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("x-request-id") ?? "request-session");
    await next();
  });
  app.use("*", createAuthMiddleware(db, { oidc, now: () => new Date(NOW) }));
  app.route("/auth/sessions", createIdentitySessionRoutes({ db, now: () => new Date(NOW) }));
  app.get("/private", (c) => c.json({
    sessionId: c.get("identitySessionId"),
    principal: c.get("principal"),
  }));
  process.env.API_AUTH = "required";
  return { app, db };
}

afterEach(() => {
  process.env.API_AUTH = saved.apiAuth;
  process.env.NODE_ENV = saved.nodeEnv;
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function authorization() {
  return { authorization: `Bearer ${TOKEN}`, "x-request-id": "request-session" };
}

describe("durable OIDC session authority", () => {
  it("binds the token to exact human, membership version, MFA, and expiry without storing plaintext", async () => {
    const { app, db } = fixture();
    const response = await app.request("/private", { headers: authorization() });
    expect(response.status).toBe(200);
    const payload = await response.json() as { sessionId: string };
    expect(payload.sessionId).toMatch(/^identity-session-/);
    const row = getIdentitySession(db, "tenant-a", payload.sessionId)!;
    expect(row).toMatchObject({
      principal_id: expect.stringMatching(/^principal-human-/),
      issuer: "https://identity.example",
      subject: "human-a",
      membership_updated_at: NOW,
      auth_strength: "amr:mfa",
      issued_at: ISSUED,
      expires_at: EXPIRES,
      revoked_at: null,
    });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    const current = await app.request("/auth/sessions/current", { headers: authorization() });
    expect(current.status).toBe(200);
    expect(await current.text()).not.toContain(row.token_sha256);
  });

  it("revokes the current session and rejects the same still-valid bearer token afterward", async () => {
    const { app, db } = fixture();
    expect((await app.request("/private", { headers: authorization() })).status).toBe(200);
    const revoked = await app.request("/auth/sessions/current/revoke", {
      method: "POST",
      headers: authorization(),
    });
    expect(revoked.status).toBe(200);
    const denied = await app.request("/private", { headers: authorization() });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ message: "identity_session_revoked" });
    expect(listAudit(db, "tenant-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "identity_session.revoke" }),
    ]));
  });

  it("invalidates an existing token after any membership authority version change", async () => {
    const { app, db } = fixture();
    expect((await app.request("/private", { headers: authorization() })).status).toBe(200);
    const changed = changeTenantMembershipRole(db, {
      tenantId: "tenant-a",
      issuer: "https://identity.example",
      subject: "human-a",
      role: "admin",
      expectedUpdatedAt: NOW,
      updatedAt: "2026-08-30T12:01:00.000Z",
    });
    expect(changed?.role).toBe("admin");
    const denied = await app.request("/private", { headers: authorization() });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ message: "identity_session_membership_invalid" });
  });

  it("requires durable session claims from production OIDC verifiers", async () => {
    const { app } = fixture(false);
    process.env.NODE_ENV = "production";
    const response = await app.request("/private", { headers: authorization() });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: "oidc_session_authority_required" });
  });
});
