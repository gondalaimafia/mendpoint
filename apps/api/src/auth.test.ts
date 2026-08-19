import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createApiKey,
  createDb,
  getPrincipalBySubject,
  insertPrincipal,
  putTenantMembership,
  setTenantMembershipStatus,
} from "@mendpoint/db";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import {
  createAuthMiddleware,
  createOidcVerifier,
  delegatedActorSignature,
  isExemptPath,
  roleFromApiKeyScopes,
  scopeAllows,
  type ApiEnv,
} from "./auth.js";

const dirs: string[] = [];
const dbs: Array<ReturnType<typeof createDb>> = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  for (const db of dbs.splice(0)) {
    db.raw.close();
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may briefly retain SQLite handles after close.
    }
  }
});

function testDb() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-auth-"));
  dirs.push(dir);
  const db = createDb(join(dir, "test.sqlite"));
  dbs.push(db);
  db.raw.prepare(
    `INSERT OR IGNORE INTO tenants
       (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'enterprise', 'active', 20, ?)`,
  ).run(new Date().toISOString());
  return db;
}

async function oidcFixture() {
  const issuer = "https://identity.example.com";
  const audience = "mendpoint-api";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "identity-test-key";
  jwk.alg = "RS256";
  const verifier = createOidcVerifier({
    issuer,
    audience,
    tenantClaim: "tenant_id",
    requiredAmr: ["mfa"],
    allowedAcr: ["urn:example:loa:2"],
    maxTokenAgeSeconds: 3_600,
    jwks: createLocalJWKSet({ keys: [jwk] }),
  });
  const token = async (claims: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1_000);
    const { aud, exp, iat, iss, sub, ...customClaims } = claims;
    return new SignJWT({
      tenant_id: "tenant-a",
      email: "token-email@example.com",
      name: "Token Supplied Name",
      amr: ["pwd", "mfa"],
      ...customClaims,
    })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ: "JWT" })
      .setIssuer(typeof iss === "string" ? iss : issuer)
      .setAudience(typeof aud === "string" ? aud : audience)
      .setSubject(typeof sub === "string" ? sub : "user-123")
      .setIssuedAt(typeof iat === "number" ? iat : now)
      .setExpirationTime(typeof exp === "number" ? exp : now + 300)
      .sign(privateKey);
  };
  return { issuer, audience, verifier, token };
}

describe("API authentication identity", () => {
  it("binds principal role and tenant to the API key instead of request headers", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const created = createApiKey(db, {
      id: "key-owner",
      name: "owner",
      tenantId: "tenant-a",
      scopes: ["*"],
      createdAt: new Date().toISOString(),
    });
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db));
    app.get("/private", (c) =>
      c.json({
        principal: c.get("principal"),
        scopes: c.get("authScopes"),
      }),
    );

    const response = await app.request("/private", {
      headers: {
        Authorization: `Bearer ${created.token}`,
        "X-Role": "viewer",
        "X-Tenant-Id": "tenant-victim",
        "X-User-Id": "spoofed",
      },
    });
    const body = (await response.json()) as {
      principal: { id: string; tenantId: string; role: string };
      scopes: string[];
    };

    expect(response.status).toBe(200);
    expect(body.principal).toEqual({
      id: "api-key:key-owner",
      tenantId: "tenant-a",
      role: "owner",
    });
    expect(body.scopes).toEqual(["*"]);
    expect(getPrincipalBySubject(db, "tenant-a", "api_key", created.id)).toMatchObject({
      audience: "mendpoint-api",
    });
  });

  it("verifies OIDC tokens, requires MFA, and binds role to an active tenant membership", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const oidc = await oidcFixture();
    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer: oidc.issuer,
      subject: "user-123",
      email: "membership@example.com",
      displayName: "Membership Owner",
      role: "admin",
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db, { oidc: oidc.verifier }));
    app.get("/private", (c) => c.json({
      principal: c.get("principal"),
      scopes: c.get("authScopes"),
      trustPrincipalId: c.get("trustPrincipalId"),
      authMethod: c.get("authMethod"),
      membershipEvidenceId: c.get("membershipEvidenceId"),
    }));

    const response = await app.request("/private", {
      headers: {
        Authorization: `Bearer ${await oidc.token({ role: "owner" })}`,
        "X-Tenant-Id": "tenant-b",
        "X-Role": "owner",
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      principal: {
        id: `human:${oidc.issuer}|user-123`,
        tenantId: "tenant-a",
        role: "admin",
        email: "membership@example.com",
      },
      scopes: ["*"],
      trustPrincipalId: expect.stringMatching(/^principal-human-/),
      authMethod: "oidc",
      membershipEvidenceId: `membership:${createHash("sha256")
        .update(`tenant-a\n${oidc.issuer}\nuser-123`, "utf8")
        .digest("hex")}`,
    });
    expect(
      getPrincipalBySubject(db, "tenant-a", "human", `${oidc.issuer}|user-123`),
    ).toMatchObject({
      display_name: "Membership Owner",
      audience: oidc.issuer,
    });
  });

  it("rejects an OIDC identity whose durable trust principal is revoked", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const oidc = await oidcFixture();
    const observedAt = new Date().toISOString();
    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer: oidc.issuer,
      subject: "user-123",
      email: null,
      displayName: "Revoked Reviewer",
      role: "admin",
      status: "active",
      updatedAt: observedAt,
    });
    insertPrincipal(db, {
      id: "principal-human-revoked",
      tenantId: "tenant-a",
      kind: "human",
      subject: `${oidc.issuer}|user-123`,
      displayName: "Revoked Reviewer",
      audience: oidc.issuer,
      revokedAt: observedAt,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db, { oidc: oidc.verifier }));
    app.get("/private", (c) => c.json({ principal: c.get("principal") }));

    const response = await app.request("/private", {
      headers: { Authorization: `Bearer ${await oidc.token()}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "unauthorized",
      message: "trust_principal_inactive",
    });
  });

  it("fails closed for absent membership, offboarding, missing MFA, and invalid token claims", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const oidc = await oidcFixture();
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db, { oidc: oidc.verifier }));
    app.get("/private", (c) => c.json({ principal: c.get("principal") }));
    const request = (token: string) => app.request("/private", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect((await request(await oidc.token())).status).toBe(401);

    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer: oidc.issuer,
      subject: "user-123",
      email: null,
      displayName: "Reviewer",
      role: "engineer",
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    expect((await request(await oidc.token({ amr: ["pwd"] }))).status).toBe(401);
    expect((await request(await oidc.token({ tenant_id: undefined }))).status).toBe(401);
    expect((await request(await oidc.token({ aud: "wrong-audience" }))).status).toBe(401);
    expect((await request(await oidc.token({ exp: Math.floor(Date.now() / 1_000) - 60 }))).status).toBe(401);

    setTenantMembershipStatus(db, {
      tenantId: "tenant-a",
      issuer: oidc.issuer,
      subject: "user-123",
      status: "offboarded",
      updatedAt: new Date().toISOString(),
    });
    expect((await request(await oidc.token())).status).toBe(401);
  });

  it("accepts configured ACR evidence and rejects JWTs when OIDC is not configured", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const oidc = await oidcFixture();
    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer: oidc.issuer,
      subject: "user-123",
      email: null,
      displayName: "Reviewer",
      role: "viewer",
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    const configured = new Hono<ApiEnv>();
    configured.use("*", createAuthMiddleware(db, { oidc: oidc.verifier }));
    configured.get("/private", (c) => c.json({ principal: c.get("principal") }));
    const acrToken = await oidc.token({ amr: [], acr: "urn:example:loa:2" });
    expect((await configured.request("/private", {
      headers: { Authorization: `Bearer ${acrToken}` },
    })).status).toBe(200);

    const unconfigured = new Hono<ApiEnv>();
    unconfigured.use("*", createAuthMiddleware(db, { oidc: null }));
    unconfigured.get("/private", (c) => c.json({ principal: c.get("principal") }));
    const denied = await unconfigured.request("/private", {
      headers: { Authorization: `Bearer ${acrToken}` },
    });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ message: "oidc_not_configured" });
  });

  it("requires authentication in auto mode when OIDC is configured without API keys", async () => {
    process.env.API_AUTH = "auto";
    const db = testDb();
    const oidc = await oidcFixture();
    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer: oidc.issuer,
      subject: "user-123",
      email: null,
      displayName: "Reviewer",
      role: "viewer",
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db, { oidc: oidc.verifier }));
    app.get("/private", (c) => c.json({ principal: c.get("principal") }));

    expect((await app.request("/private")).status).toBe(401);
    expect((await app.request("/private", {
      headers: { Authorization: `Bearer ${await oidc.token()}` },
    })).status).toBe(200);
  });

  it("rejects insecure OIDC issuer and JWKS endpoints", async () => {
    const oidc = await oidcFixture();
    expect(() => createOidcVerifier({
      issuer: "http://identity.example.com",
      audience: oidc.audience,
      tenantClaim: "tenant_id",
      requiredAmr: ["mfa"],
      allowedAcr: [],
      maxTokenAgeSeconds: 3_600,
      jwks: { } as never,
    })).toThrow("oidc_issuer_https_required");
    expect(() => createOidcVerifier({
      issuer: oidc.issuer,
      audience: oidc.audience,
      tenantClaim: "tenant_id",
      requiredAmr: ["mfa"],
      allowedAcr: [],
      maxTokenAgeSeconds: 3_600,
      jwksUri: "http://identity.example.com/jwks.json",
    })).toThrow("oidc_jwks_https_required");
  });

  it("fails closed for malformed scopes and enforces explicit permissions", () => {
    expect(roleFromApiKeyScopes(["role:bogus"])).toBe("viewer");
    expect(scopeAllows(["role:engineer", "graph:read"], "graph:read")).toBe(true);
    expect(scopeAllows(["role:engineer", "graph:read"], "graph:write")).toBe(false);
  });

  it("accepts delegated human identity only for an active verified membership", async () => {
    process.env.API_AUTH = "required";
    const db = testDb();
    const created = createApiKey(db, {
      id: "key-proxy",
      name: "web proxy",
      tenantId: "tenant-a",
      scopes: ["*"],
      createdAt: new Date().toISOString(),
    });
    const app = new Hono<ApiEnv>();
    app.use("*", createAuthMiddleware(db));
    app.post("/reviews", (c) => c.json({ principal: c.get("principal") }));
    const timestamp = new Date().toISOString();
    const requestId = "request-actor-1";
    const issuer = "https://identity.example.com";
    const subject = "reviewer-123";
    const actor = "principal-human-web-reviewer";
    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer,
      subject,
      email: "reviewer@example.com",
      displayName: "Verified Reviewer",
      role: "admin",
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    insertPrincipal(db, {
      id: actor,
      tenantId: "tenant-a",
      kind: "human",
      subject: `${issuer}|${subject}`,
      displayName: "Verified Reviewer",
      audience: issuer,
      createdAt: new Date().toISOString(),
    });
    const signature = delegatedActorSignature(created.token, {
      actor,
      timestamp,
      requestId,
      method: "POST",
      path: "/reviews",
    });
    const headers = {
      Authorization: `Bearer ${created.token}`,
      "X-Request-Id": requestId,
      "X-Mendpoint-Actor": actor,
      "X-Mendpoint-Actor-Timestamp": timestamp,
      "X-Mendpoint-Actor-Signature": signature,
    };
    const accepted = await app.request("/reviews", { method: "POST", headers });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      principal: {
        id: `human:${issuer}|${subject}`,
        tenantId: "tenant-a",
        role: "admin",
        email: "reviewer@example.com",
      },
    });

    const tampered = await app.request("/reviews", {
      method: "POST",
      headers: { ...headers, "X-Mendpoint-Actor": "attacker@example.com" },
    });
    expect(tampered.status).toBe(401);
    await expect(tampered.json()).resolves.toMatchObject({
      message: "delegated_actor_signature_invalid",
    });

    const arbitraryActor = "principal-human-not-provisioned";
    const arbitraryRequestId = "request-actor-arbitrary";
    const arbitraryTimestamp = new Date().toISOString();
    const arbitrary = await app.request("/reviews", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.token}`,
        "X-Request-Id": arbitraryRequestId,
        "X-Mendpoint-Actor": arbitraryActor,
        "X-Mendpoint-Actor-Timestamp": arbitraryTimestamp,
        "X-Mendpoint-Actor-Signature": delegatedActorSignature(created.token, {
          actor: arbitraryActor,
          timestamp: arbitraryTimestamp,
          requestId: arbitraryRequestId,
          method: "POST",
          path: "/reviews",
        }),
      },
    });
    expect(arbitrary.status).toBe(401);
    await expect(arbitrary.json()).resolves.toMatchObject({
      message: "delegated_actor_membership_required",
    });

    const replay = await app.request("/reviews", { method: "POST", headers });
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({
      message: "delegated_actor_replay_detected",
    });

    const invalidRequestId = "invalid request id";
    const invalidRequestHeaders = {
      ...headers,
      "X-Request-Id": invalidRequestId,
      "X-Mendpoint-Actor-Signature": delegatedActorSignature(created.token, {
        actor,
        timestamp,
        requestId: invalidRequestId,
        method: "POST",
        path: "/reviews",
      }),
    };
    const invalidRequest = await app.request("/reviews", {
      method: "POST",
      headers: invalidRequestHeaders,
    });
    expect(invalidRequest.status).toBe(401);
    await expect(invalidRequest.json()).resolves.toMatchObject({
      message: "delegated_actor_request_invalid",
    });
  });

  it("does not exempt GitHub App inventory or callbacks", () => {
    expect(isExemptPath("/github/app/installations")).toBe(false);
    expect(isExemptPath("/github/app/callback")).toBe(false);
  });

  it("uses the shared public route policy for probes", () => {
    expect(isExemptPath("/ready")).toBe(true);
    expect(isExemptPath("/status", "HEAD")).toBe(true);
    expect(isExemptPath("/ready", "POST")).toBe(false);
  });
});
