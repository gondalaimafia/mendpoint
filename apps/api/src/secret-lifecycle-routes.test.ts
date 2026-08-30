import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApiKey,
  createDb,
  getPrincipalBySubject,
  insertPrincipal,
  listAudit,
  type AppDb,
} from "@mendpoint/db";
import { LocalEnvelopeKeyProvider, type Role } from "@mendpoint/platform";
import { createAuthMiddleware, createRbacMiddleware, type ApiEnv } from "./auth.js";
import {
  createSecretBreakGlassDenialAuditMiddleware,
  createSecretLifecycleRoutes,
} from "./secret-lifecycle-routes.js";

const open: AppDb[] = [];
const originalAuth = process.env.API_AUTH;
afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  while (open.length) open.pop()?.raw.close();
});

function fixture() {
  const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-secret-routes-")), "db.sqlite"));
  open.push(db);
  const provider = new LocalEnvelopeKeyProvider();
  for (const version of ["1", "2"]) {
    provider.putKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version,
      customerManaged: false,
    }, Buffer.alloc(32, Number(version)));
  }
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("X-Request-Id") ?? "test-request");
    const apiKeyId = c.req.header("X-Api-Key-Id");
    if (apiKeyId) c.set("apiKeyId", apiKeyId);
    const role = (c.req.header("X-Role") ?? "admin") as Role;
    c.set("principal", {
      id: "operator-a",
      tenantId: c.req.header("X-Tenant") ?? "tenant-a",
      role,
    });
    c.set("authorityRole", role);
    await next();
  });
  app.route("/platform/secrets", createSecretLifecycleRoutes({
    db,
    providers: [provider],
    breakGlassEnabled: true,
    requestCommitment: { keyId: "secret-request-v1", key: Buffer.alloc(32, 9) },
  }));
  return { app, db, provider };
}

function headers(extra: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json",
    "X-Request-Id": "secret-route-test",
    "Idempotency-Key": "secret-route-operation",
    ...extra,
  };
}

const createBody = {
  credentialId: "credential-a",
  sourceRef: "vault://github/installations/12345",
  plaintext: "customer-secret",
  audiences: ["github:installation:12345"],
  key: { provider: "local-envelope", keyId: "tenant-key", version: "1" },
};

function realAuthFixture(options: Readonly<{
  denialAudit?: Parameters<typeof createSecretBreakGlassDenialAuditMiddleware>[0]["audit"];
  installDenialMiddleware?: boolean;
}> = {}) {
  process.env.API_AUTH = "required";
  const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-secret-real-auth-")), "db.sqlite"));
  open.push(db);
  db.raw.prepare(`INSERT OR IGNORE INTO tenants
    (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'enterprise', 'active', 20, ?)`)
    .run("2026-08-30T00:00:00.000Z");
  for (const [id, subject] of [
    ["principal-service-owner", "lifecycle-owner"],
    ["principal-service-other", "unrelated-owner"],
  ] as const) {
    insertPrincipal(db, {
      id,
      tenantId: "tenant-a",
      kind: "service",
      subject,
      displayName: subject,
      audience: "mendpoint-api",
      createdAt: "2026-08-30T00:00:00.000Z",
    });
  }
  const first = createApiKey(db, {
    id: "lifecycle-key-one",
    name: "Lifecycle key one",
    tenantId: "tenant-a",
    scopes: ["*"],
    authorityPrincipalId: "principal-service-owner",
    authorityRole: "owner",
    createdAt: "2026-08-30T00:00:00.000Z",
  });
  const second = createApiKey(db, {
    id: "lifecycle-key-two",
    name: "Lifecycle key two",
    tenantId: "tenant-a",
    scopes: ["*"],
    authorityPrincipalId: "principal-service-owner",
    authorityRole: "owner",
    createdAt: "2026-08-30T00:01:00.000Z",
  });
  const unrelated = createApiKey(db, {
    id: "lifecycle-key-other",
    name: "Unrelated lifecycle key",
    tenantId: "tenant-a",
    scopes: ["*"],
    authorityPrincipalId: "principal-service-other",
    authorityRole: "owner",
    createdAt: "2026-08-30T00:02:00.000Z",
  });
  const viewer = createApiKey(db, {
    id: "lifecycle-key-viewer",
    name: "Lifecycle viewer",
    tenantId: "tenant-a",
    scopes: ["role:viewer", "tenant:admin"],
    authorityPrincipalId: "principal-service-other",
    authorityRole: "viewer",
    createdAt: "2026-08-30T00:03:00.000Z",
  });
  const provider = new LocalEnvelopeKeyProvider();
  for (const version of ["1", "2"]) {
    provider.putKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version,
      customerManaged: false,
    }, Buffer.alloc(32, Number(version)));
  }
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("X-Request-Id") ?? "real-auth-request");
    await next();
  });
  if (options.installDenialMiddleware) {
    app.use("*", createSecretBreakGlassDenialAuditMiddleware({
      db,
      audit: options.denialAudit,
    }));
  }
  app.use("*", createAuthMiddleware(db, { oidc: null }));
  app.use("*", createRbacMiddleware());
  app.route("/platform/secrets", createSecretLifecycleRoutes({
    db,
    providers: [provider],
    breakGlassEnabled: true,
    requestCommitment: { keyId: "secret-request-v1", key: Buffer.alloc(32, 9) },
  }));
  return { app, db, provider, first, second, unrelated, viewer };
}

function authenticatedHeaders(token: string, requestId: string, idempotencyKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Request-Id": requestId,
    "Idempotency-Key": idempotencyKey,
  };
}

describe("secret lifecycle routes", () => {
  it("rejects identical envelope and commitment key material when routes are constructed", () => {
    const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-secret-key-separation-")), "db.sqlite"));
    open.push(db);
    const provider = new LocalEnvelopeKeyProvider();
    provider.putKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "1",
      customerManaged: false,
    }, Buffer.alloc(32, 9));
    expect(() => createSecretLifecycleRoutes({
      db,
      providers: [provider],
      breakGlassEnabled: true,
      requestCommitment: { keyId: "secret-request-v1", key: Buffer.alloc(32, 9) },
    })).toThrow("secret_lifecycle_key_material_reuse");
  });

  it("replays lifecycle operations across rotated API keys bound to one stable authority", async () => {
    const { app, db, first, second, unrelated } = realAuthFixture();
    const create = (token: string, requestId: string) => app.request("/platform/secrets", {
      method: "POST",
      headers: authenticatedHeaders(token, requestId, "stable-create"),
      body: JSON.stringify(createBody),
    });
    expect((await create(first.token, "create-one")).status).toBe(201);
    expect((await create(second.token, "create-two")).status).toBe(201);
    expect((await create(unrelated.token, "create-other")).status).toBe(409);

    const rotate = (token: string, requestId: string) => app.request(
      "/platform/secrets/credential-a/rewrap",
      {
        method: "POST",
        headers: authenticatedHeaders(token, requestId, "stable-rotate"),
        body: JSON.stringify({
          expectedGeneration: 1,
          key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
        }),
      },
    );
    expect((await rotate(first.token, "rotate-one")).status).toBe(200);
    expect((await rotate(second.token, "rotate-two")).status).toBe(200);

    const reveal = (token: string, requestId: string) => app.request(
      "/platform/secrets/credential-a/break-glass",
      {
        method: "POST",
        headers: authenticatedHeaders(token, requestId, "stable-break-glass"),
        body: JSON.stringify({ reason: "incident" }),
      },
    );
    expect((await reveal(first.token, "break-glass-one")).status).toBe(200);
    expect((await reveal(second.token, "break-glass-two")).status).toBe(200);
    expect((await reveal(unrelated.token, "break-glass-other")).status).toBe(409);

    const credentialPrincipal = getPrincipalBySubject(
      db,
      "tenant-a",
      "api_key",
      second.id,
    )!;
    for (const action of [
      "secret.lifecycle.create_replayed",
      "secret.lifecycle.rewrap_replayed",
      "secret.break_glass.replayed",
    ]) {
      const replay = listAudit(db, "tenant-a").find((event) => event.action === action);
      expect(replay, action).toMatchObject({
        principal_id: "principal-service-owner",
        api_key_id: second.id,
      });
      expect(JSON.parse(replay!.metadata_json!), action).toMatchObject({
        authorityPrincipalId: "principal-service-owner",
        credentialPrincipalId: credentialPrincipal.id,
      });
    }
  });

  it("resumes an audited rotation failure across rotated API keys without source-audit conflict", async () => {
    const { app, db, provider, first, second } = realAuthFixture();
    expect((await app.request("/platform/secrets", {
      method: "POST",
      headers: authenticatedHeaders(first.token, "rotation-create", "rotation-create"),
      body: JSON.stringify(createBody),
    })).status).toBe(201);
    provider.removeKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: false,
    });
    const rotate = (token: string, requestId: string) => app.request(
      "/platform/secrets/credential-a/rewrap",
      {
        method: "POST",
        headers: authenticatedHeaders(token, requestId, "rotation-resume"),
        body: JSON.stringify({
          expectedGeneration: 1,
          key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
        }),
      },
    );
    expect((await rotate(first.token, "rotation-failed-one")).status).toBe(500);
    provider.putKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: false,
    }, Buffer.alloc(32, 2));
    expect((await rotate(second.token, "rotation-retry-two")).status).toBe(200);
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.lifecycle.rewrap_source.granted",
    )).toHaveLength(1);
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.lifecycle.rewrap_source.attempted",
    ).map((event) => event.api_key_id).sort()).toEqual([first.id, second.id].sort());
  });

  it("audits real authentication and RBAC break-glass denials before route dispatch", async () => {
    const { app, db, first, viewer } = realAuthFixture({ installDenialMiddleware: true });
    const anonymous = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: { "X-Request-Id": "anonymous-real-denial" },
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(anonymous.status).toBe(401);
    expect(listAudit(db, "tenant_unattributed")).toEqual([
      expect.objectContaining({
        action: "secret.break_glass.denied",
        principal_id: null,
        request_id: "anonymous-real-denial",
      }),
    ]);

    const forbidden = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: authenticatedHeaders(viewer.token, "viewer-real-denial", "viewer-denial"),
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(forbidden.status).toBe(403);
    expect(listAudit(db, "tenant-a").find(
      (event) => event.request_id === "viewer-real-denial",
    )).toMatchObject({
      action: "secret.break_glass.denied",
      principal_id: "principal-service-other",
      api_key_id: viewer.id,
    });

    await app.request("/platform/secrets", {
      method: "POST",
      headers: authenticatedHeaders(first.token, "allowed-create", "allowed-create"),
      body: JSON.stringify(createBody),
    });
    const allowed = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: authenticatedHeaders(first.token, "allowed-break-glass", "allowed-break-glass"),
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(allowed.status).toBe(200);
  });

  it("fails closed when pre-route break-glass denial audit persistence fails", async () => {
    const { app } = realAuthFixture({
      installDenialMiddleware: true,
      denialAudit: () => {
        throw new Error("audit unavailable");
      },
    });
    const response = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: { "X-Request-Id": "anonymous-audit-failure" },
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "service_unavailable" });
  });

  it("does not attribute pre-route denial audit to unauthenticated compatibility headers", async () => {
    process.env.API_AUTH = "off";
    const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-secret-header-spoof-")), "db.sqlite"));
    open.push(db);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "header-spoof-denial");
      await next();
    });
    app.use("*", createSecretBreakGlassDenialAuditMiddleware({ db }));
    app.use("*", createAuthMiddleware(db, { oidc: null }));
    app.use("*", createRbacMiddleware());
    app.post("/platform/secrets/:id/break-glass", (c) => c.json({ unexpected: true }));

    const response = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: {
        "X-Tenant-Id": "tenant-spoofed",
        "X-User-Id": "operator-spoofed",
        "X-Role": "viewer",
      },
    });

    expect(response.status).toBe(403);
    expect(listAudit(db, "tenant-spoofed")).toEqual([]);
    expect(listAudit(db, "tenant_unattributed")).toEqual([
      expect.objectContaining({
        action: "secret.break_glass.denied",
        principal_id: null,
        api_key_id: null,
        request_id: "header-spoof-denial",
      }),
    ]);
  });

  it("exposes authorized create, rotate, revoke, and owner break glass operations", async () => {
    const { app, db } = fixture();
    const created = await app.request("/platform/secrets", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      generation: 1,
      customerManaged: false,
      custody: "mendpoint-custodied",
    });

    const breakGlassDenied = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: headers({ "Idempotency-Key": "break-glass-admin-denied" }),
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(breakGlassDenied.status).toBe(403);
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.denied",
    )).toHaveLength(1);

    const breakGlass = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: headers({ "X-Role": "owner", "Idempotency-Key": "break-glass-owner-one" }),
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(breakGlass.status).toBe(200);
    expect(breakGlass.headers.get("Cache-Control")).toBe("no-store");
    expect(await breakGlass.json()).toEqual({ secret: "customer-secret" });

    const rotated = await app.request("/platform/secrets/credential-a/rotate", {
      method: "POST",
      headers: headers({ "Idempotency-Key": "rotate-route-operation" }),
      body: JSON.stringify({
        expectedGeneration: 1,
        plaintext: "customer-secret-next",
        key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
      }),
    });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({ generation: 2, state: "active" });

    const revoked = await app.request("/platform/secrets/credential-a/revoke", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ generation: 2, reason: "incident response" }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ generation: 2, state: "revoked" });
  });

  it("replays real HTTP break glass across request IDs and rejects payload drift", async () => {
    const { app, db } = fixture();
    await app.request("/platform/secrets", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(createBody),
    });
    const request = (requestId: string, reason = "incident") => app.request(
      "/platform/secrets/credential-a/break-glass",
      {
        method: "POST",
        headers: headers({
          "X-Role": "owner",
          "X-Request-Id": requestId,
          "X-Api-Key-Id": requestId === "rotate-http-one" ? "api-key-one" : "api-key-two",
          "Idempotency-Key": "break-glass-http-replay",
        }),
        body: JSON.stringify({ reason }),
      },
    );
    expect((await request("http-retry-one")).status).toBe(200);
    expect((await request("http-retry-two")).status).toBe(200);
    expect((await request("http-retry-three", "different incident")).status).toBe(409);
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.granted",
    )).toHaveLength(1);
  });

  it("resumes an interrupted HTTP rotation across request IDs without duplicate source audit", async () => {
    const { app, db, provider } = fixture();
    await app.request("/platform/secrets", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(createBody),
    });
    provider.removeKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: false,
    });
    const rotate = (requestId: string) => app.request(
      "/platform/secrets/credential-a/rewrap",
      {
        method: "POST",
        headers: headers({
          "X-Request-Id": requestId,
          "X-Api-Key-Id": requestId === "rotate-http-one" ? "api-key-one" : "api-key-two",
          "Idempotency-Key": "rotate-http-resume",
        }),
        body: JSON.stringify({
          expectedGeneration: 1,
          key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
        }),
      },
    );
    expect((await rotate("rotate-http-one")).status).toBe(500);
    provider.putKey("tenant-a", {
      provider: "local-envelope",
      keyId: "tenant-key",
      version: "2",
      customerManaged: false,
    }, Buffer.alloc(32, 2));
    expect((await rotate("rotate-http-two")).status).toBe(200);
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.lifecycle.rewrap_source.granted",
    )).toHaveLength(1);
  });

  it("audits HTTP authorization denial with the actual request context", async () => {
    const { app, db } = fixture();
    const response = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: headers({
        "X-Role": "engineer",
        "X-Request-Id": "http-denied-context",
        "X-Api-Key-Id": "api-key-denied",
        "Idempotency-Key": "break-glass-http-denied",
      }),
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(response.status).toBe(403);
    const denied = listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.denied",
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      principal_id: "operator-a",
      api_key_id: "api-key-denied",
      request_id: "http-denied-context",
    });
  });

  it("audits unauthenticated and malformed break-glass requests before returning", async () => {
    const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-secret-routes-anon-")), "db.sqlite"));
    open.push(db);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", c.req.header("X-Request-Id") ?? "anonymous-request");
      await next();
    });
    app.route("/platform/secrets", createSecretLifecycleRoutes({
      db,
      providers: [],
      breakGlassEnabled: true,
      requestCommitment: { keyId: "secret-request-v1", key: Buffer.alloc(32, 9) },
    }));
    const response = await app.request("/platform/secrets/credential-a/break-glass", {
      method: "POST",
      headers: headers({ "X-Request-Id": "anonymous-denied" }),
      body: JSON.stringify({ reason: "incident" }),
    });
    expect(response.status).toBe(401);
    expect(listAudit(db, "tenant_unattributed")).toEqual([
      expect.objectContaining({
        action: "secret.break_glass.denied",
        principal_id: null,
        request_id: "anonymous-denied",
      }),
    ]);

    const authenticated = fixture();
    const malformed = await authenticated.app.request(
      "/platform/secrets/credential-a/break-glass",
      {
        method: "POST",
        headers: headers({ "X-Role": "owner", "X-Request-Id": "malformed-denied" }),
        body: "{",
      },
    );
    expect(malformed.status).toBe(500);
    expect(listAudit(authenticated.db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.denied",
    )).toEqual([
      expect.objectContaining({ principal_id: "operator-a", request_id: "malformed-denied" }),
    ]);

    const invalidReasonFixture = fixture();
    const invalidReason = await invalidReasonFixture.app.request(
      "/platform/secrets/credential-a/break-glass",
      {
        method: "POST",
        headers: headers({ "X-Role": "owner", "X-Request-Id": "typed-reason-denied" }),
        body: JSON.stringify({ reason: 42 }),
      },
    );
    expect(invalidReason.status).toBe(400);
    expect(listAudit(invalidReasonFixture.db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.denied",
    )).toEqual([
      expect.objectContaining({ principal_id: "operator-a", request_id: "typed-reason-denied" }),
    ]);

    const nullBodyFixture = fixture();
    const nullBody = await nullBodyFixture.app.request(
      "/platform/secrets/credential-a/break-glass",
      {
        method: "POST",
        headers: headers({ "X-Role": "owner", "X-Request-Id": "null-body-denied" }),
        body: "null",
      },
    );
    expect(nullBody.status).toBe(400);
    expect(listAudit(nullBodyFixture.db, "tenant-a").filter(
      (event) => event.action === "secret.break_glass.denied",
    )).toEqual([
      expect.objectContaining({ principal_id: "operator-a", request_id: "null-body-denied" }),
    ]);
  });

  it("denies non-admin mutation and cross-tenant resource discovery", async () => {
    const { app } = fixture();
    const unauthorized = await app.request("/platform/secrets", {
      method: "POST",
      headers: headers({ "X-Role": "engineer" }),
      body: JSON.stringify(createBody),
    });
    expect(unauthorized.status).toBe(403);

    await app.request("/platform/secrets", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(createBody),
    });
    const crossTenant = await app.request("/platform/secrets/credential-a/rotate", {
      method: "POST",
      headers: headers({
        "X-Tenant": "tenant-b",
        "Idempotency-Key": "cross-tenant-route-operation",
      }),
      body: JSON.stringify({
        expectedGeneration: 1,
        plaintext: "tenant-b-secret-next",
        key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
      }),
    });
    expect(crossTenant.status).toBe(404);
  });
});
