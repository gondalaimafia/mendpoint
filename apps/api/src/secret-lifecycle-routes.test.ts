import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "@mendpoint/db";
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
  }));
  return { app, db };
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
    const { app } = fixture();
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
