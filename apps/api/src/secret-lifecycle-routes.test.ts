import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, listAudit, type AppDb } from "@mendpoint/db";
import { LocalEnvelopeKeyProvider, type Role } from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";
import { createSecretLifecycleRoutes } from "./secret-lifecycle-routes.js";

const open: AppDb[] = [];
afterEach(() => {
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
      customerManaged: true,
    }, Buffer.alloc(32, Number(version)));
  }
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", c.req.header("X-Request-Id") ?? "test-request");
    const apiKeyId = c.req.header("X-Api-Key-Id");
    if (apiKeyId) c.set("apiKeyId", apiKeyId);
    c.set("principal", {
      id: "operator-a",
      tenantId: c.req.header("X-Tenant") ?? "tenant-a",
      role: (c.req.header("X-Role") ?? "admin") as Role,
    });
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

describe("secret lifecycle routes", () => {
  it("exposes authorized create, rotate, revoke, and owner break glass operations", async () => {
    const { app, db } = fixture();
    const created = await app.request("/platform/secrets", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(createBody),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ generation: 1, customerManaged: true });

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
      customerManaged: true,
    });
    const rotate = (requestId: string) => app.request(
      "/platform/secrets/credential-a/rotate",
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
      customerManaged: true,
    }, Buffer.alloc(32, 2));
    expect((await rotate("rotate-http-two")).status).toBe(200);
    expect(listAudit(db, "tenant-a").filter(
      (event) => event.action === "secret.lifecycle.rotation_source.granted",
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
        key: { provider: "local-envelope", keyId: "tenant-key", version: "2" },
      }),
    });
    expect(crossTenant.status).toBe(404);
  });
});
