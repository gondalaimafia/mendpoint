import {
  createDb,
  insertPrincipal,
  listApiKeys,
  listAudit,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createServicePrincipalRoutes } from "./service-principals.js";

const NOW = "2026-08-30T12:00:00.000Z";
const EXPIRES = "2026-09-29T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];
const savedAuth = process.env.API_AUTH;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-service-principal-"));
  const db = createDb(join(directory, "identity.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'enterprise', 'active', 20, ?),
            ('tenant-b', 'tenant-b', 'Tenant B', 'enterprise', 'active', 20, ?)`,
  ).run(NOW, NOW);
  insertPrincipal(db, {
    id: "human-owner-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "https://identity.example|owner-a",
    displayName: "Owner A",
    audience: "https://identity.example",
    createdAt: NOW,
  });
  insertPrincipal(db, {
    id: "human-owner-b",
    tenantId: "tenant-b",
    kind: "human",
    subject: "https://identity.example|owner-b",
    displayName: "Owner B",
    audience: "https://identity.example",
    createdAt: NOW,
  });
  const identities = {
    owner: { id: "human:owner-a", tenantId: "tenant-a", role: "owner" as const, trust: "human-owner-a" },
    owner_b: { id: "human:owner-b", tenantId: "tenant-b", role: "owner" as const, trust: "human-owner-b" },
    viewer: { id: "human:viewer-a", tenantId: "tenant-a", role: "viewer" as const, trust: "human-owner-a" },
  };
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const identity = identities[c.req.header("x-test-actor") as keyof typeof identities];
    if (identity) {
      c.set("principal", { id: identity.id, tenantId: identity.tenantId, role: identity.role });
      c.set("trustPrincipalId", identity.trust);
      c.set("requestId", c.req.header("x-request-id") ?? "request");
    }
    await next();
  });
  app.route("/tenants/service-principals", createServicePrincipalRoutes({
    db,
    now: () => new Date(NOW),
  }));
  return { app, db };
}

afterEach(() => {
  process.env.API_AUTH = savedAuth;
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function mutationHeaders(idempotencyKey: string, actor = "owner") {
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-test-actor": actor,
    "x-request-id": `request-${idempotencyKey}`,
  };
}

async function createPrincipal(app: Hono<ApiEnv>, idempotencyKey = "create-1") {
  const response = await app.request("/tenants/service-principals", {
    method: "POST",
    headers: mutationHeaders(idempotencyKey),
    body: JSON.stringify({
      subject: "release-dispatch",
      displayName: "Release dispatch worker",
      scopes: ["graph:read", "plan:execute"],
      expiresAt: EXPIRES,
    }),
  });
  const payload = await response.json() as {
    data: { id: string; credential: { id: string; token: string; prefix: string; scopes: string[] } };
  };
  return { response, payload };
}

describe("service principal administration", () => {
  it("issues one tenant-bound attenuated credential and authenticates it as a service", async () => {
    const { app, db } = fixture();
    const { response, payload } = await createPrincipal(app);
    expect(response.status).toBe(201);
    expect(payload.data).toMatchObject({
      id: expect.stringMatching(/^principal-service_/),
      credential: {
        id: expect.stringMatching(/^key-service_/),
        token: expect.stringMatching(/^me_/),
        scopes: ["graph:read", "plan:execute"],
      },
    });

    const authApp = new Hono<ApiEnv>();
    authApp.use("*", createAuthMiddleware(db, { oidc: null, now: () => new Date(NOW) }));
    authApp.get("/private", (c) => c.json({
      principal: c.get("principal"),
      trustPrincipalId: c.get("trustPrincipalId"),
      scopes: c.get("authScopes"),
    }));
    process.env.API_AUTH = "required";
    const authenticated = await authApp.request("/private", {
      headers: { authorization: `Bearer ${payload.data.credential.token}` },
    });
    expect(authenticated.status).toBe(200);
    await expect(authenticated.json()).resolves.toMatchObject({
      principal: { id: "service:release-dispatch", tenantId: "tenant-a", role: "agent" },
      trustPrincipalId: payload.data.id,
      scopes: ["graph:read", "plan:execute"],
    });
    const expiredAuthApp = new Hono<ApiEnv>();
    expiredAuthApp.use("*", createAuthMiddleware(db, {
      oidc: null,
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    }));
    expiredAuthApp.get("/private", (c) => c.json({ ok: true }));
    expect((await expiredAuthApp.request("/private", {
      headers: { authorization: `Bearer ${payload.data.credential.token}` },
    })).status).toBe(401);

    const listed = await app.request("/tenants/service-principals", {
      headers: { "x-test-actor": "owner" },
    });
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain(payload.data.credential.token);
    expect(listedText).toContain(payload.data.credential.prefix);
    expect(JSON.stringify(listAudit(db, "tenant-a"))).not.toContain(payload.data.credential.token);
    expect(listAudit(db, "tenant-b")).toHaveLength(0);
    expect(() => db.raw.prepare(
      "UPDATE api_keys SET tenant_id = 'tenant-b' WHERE id = ?",
    ).run(payload.data.credential.id)).toThrow("api_key_principal_tenant_mismatch");
  });

  it("rejects wildcard, tenant administration, excessive lifetime, and nonmanager authority", async () => {
    const { app } = fixture();
    for (const scopes of [["*"], ["tenant:admin"]]) {
      const response = await app.request("/tenants/service-principals", {
        method: "POST",
        headers: mutationHeaders(`scope-${scopes[0]}`),
        body: JSON.stringify({ subject: "worker", displayName: "Worker", scopes, expiresAt: EXPIRES }),
      });
      expect(response.status).toBe(422);
    }
    const excessive = await app.request("/tenants/service-principals", {
      method: "POST",
      headers: mutationHeaders("too-long"),
      body: JSON.stringify({
        subject: "worker",
        displayName: "Worker",
        scopes: ["graph:read"],
        expiresAt: "2027-08-30T12:00:00.000Z",
      }),
    });
    expect(excessive.status).toBe(422);
    const viewer = await app.request("/tenants/service-principals", {
      method: "POST",
      headers: mutationHeaders("viewer", "viewer"),
      body: JSON.stringify({ subject: "worker", displayName: "Worker", scopes: ["graph:read"], expiresAt: EXPIRES }),
    });
    expect(viewer.status).toBe(403);
  });

  it("rotates exactly once, invalidates the prior key, and rejects replay without another credential", async () => {
    const { app, db } = fixture();
    const created = await createPrincipal(app);
    const prior = created.payload.data.credential;
    const rotation = await app.request(
      `/tenants/service-principals/${created.payload.data.id}/credentials/rotate`,
      {
        method: "POST",
        headers: mutationHeaders("rotate-1"),
        body: JSON.stringify({ currentCredentialId: prior.id, scopes: ["graph:read"] }),
      },
    );
    expect(rotation.status).toBe(201);
    const rotated = await rotation.json() as { data: { id: string; token: string } };
    expect(rotated.data.token).not.toBe(prior.token);
    expect(listApiKeys(db, "tenant-a").filter((key) => !key.revoked_at)).toHaveLength(1);

    process.env.API_AUTH = "required";
    const authApp = new Hono<ApiEnv>();
    authApp.use("*", createAuthMiddleware(db, { oidc: null, now: () => new Date(NOW) }));
    authApp.get("/private", (c) => c.json({ id: c.get("principal")?.id }));
    expect((await authApp.request("/private", { headers: { authorization: `Bearer ${prior.token}` } })).status).toBe(401);
    expect((await authApp.request("/private", { headers: { authorization: `Bearer ${rotated.data.token}` } })).status).toBe(200);

    const replay = await app.request(
      `/tenants/service-principals/${created.payload.data.id}/credentials/rotate`,
      {
        method: "POST",
        headers: mutationHeaders("rotate-1"),
        body: JSON.stringify({ currentCredentialId: prior.id, scopes: ["graph:read"] }),
      },
    );
    expect(replay.status).toBe(409);
    expect(listApiKeys(db, "tenant-a")).toHaveLength(2);
  });

  it("revokes the service and every credential while remaining tenant scoped and idempotent", async () => {
    const { app, db } = fixture();
    const created = await createPrincipal(app);
    const principalId = created.payload.data.id;
    const crossTenant = await app.request(`/tenants/service-principals/${principalId}/revoke`, {
      method: "POST",
      headers: mutationHeaders("revoke-b", "owner_b"),
    });
    expect(crossTenant.status).toBe(404);
    const tenantBList = await app.request("/tenants/service-principals", {
      headers: { "x-test-actor": "owner_b" },
    });
    expect(await tenantBList.json()).toEqual({ data: [] });

    const revoked = await app.request(`/tenants/service-principals/${principalId}/revoke`, {
      method: "POST",
      headers: mutationHeaders("revoke-a"),
    });
    expect(revoked.status).toBe(200);
    const replay = await app.request(`/tenants/service-principals/${principalId}/revoke`, {
      method: "POST",
      headers: mutationHeaders("revoke-a-again"),
    });
    expect(replay.status).toBe(200);
    expect(listApiKeys(db, "tenant-a").every((key) => Boolean(key.revoked_at))).toBe(true);

    process.env.API_AUTH = "required";
    const authApp = new Hono<ApiEnv>();
    authApp.use("*", createAuthMiddleware(db, { oidc: null, now: () => new Date(NOW) }));
    authApp.get("/private", (c) => c.json({ ok: true }));
    expect((await authApp.request("/private", {
      headers: { authorization: `Bearer ${created.payload.data.credential.token}` },
    })).status).toBe(401);
  });
});
