import {
  claimIdentitySession,
  createApiKey,
  createDb,
  insertPrincipal,
  listApiKeys,
  listAudit,
  putTenantMembership,
  revokePrincipal,
  revokeApiKey,
  setTenantMembershipStatus,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { can, permissionsFor } from "@mendpoint/platform";
import { createAuthMiddleware, scopeAllows, type ApiEnv } from "./auth.js";
import {
  createServicePrincipalRoutes,
  SERVICE_PRINCIPAL_ALLOWED_SCOPES,
} from "./service-principals.js";

const NOW = "2026-08-30T12:00:00.000Z";
const EXPIRES = "2026-09-29T12:00:00.000Z";
const ISSUER = "https://identity.example";
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
  putTenantMembership(db, {
    tenantId: "tenant-a",
    issuer: ISSUER,
    subject: "owner-a",
    email: "owner-a@example.com",
    displayName: "Owner A",
    role: "owner",
    status: "active",
    updatedAt: NOW,
  });
  createApiKey(db, {
    id: "key-manager-a",
    name: "Manager delegation key",
    tenantId: "tenant-a",
    scopes: ["tenant:admin"],
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
  putTenantMembership(db, {
    tenantId: "tenant-b",
    issuer: ISSUER,
    subject: "owner-b",
    email: "owner-b@example.com",
    displayName: "Owner B",
    role: "owner",
    status: "active",
    updatedAt: NOW,
  });
  insertPrincipal(db, {
    id: "human-viewer-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: `${ISSUER}|viewer-a`,
    displayName: "Viewer A",
    audience: ISSUER,
    createdAt: NOW,
  });
  putTenantMembership(db, {
    tenantId: "tenant-a",
    issuer: ISSUER,
    subject: "viewer-a",
    email: "viewer-a@example.com",
    displayName: "Viewer A",
    role: "viewer",
    status: "active",
    updatedAt: NOW,
  });
  const session = (tenantId: string, principalId: string, subject: string) => claimIdentitySession(db, {
    tenantId,
    principalId,
    issuer: ISSUER,
    subject,
    membershipUpdatedAt: NOW,
    authStrength: "amr:mfa",
    token: `token-${tenantId}-${subject}`,
    issuedAt: "2026-08-30T11:59:00.000Z",
    expiresAt: "2026-08-30T13:00:00.000Z",
    observedAt: NOW,
  });
  const identities = {
    owner: {
      id: `human:${ISSUER}|owner-a`, tenantId: "tenant-a", role: "owner" as const,
      trust: "human-owner-a", session: session("tenant-a", "human-owner-a", "owner-a").id, subject: "owner-a",
    },
    owner_b: {
      id: `human:${ISSUER}|owner-b`, tenantId: "tenant-b", role: "owner" as const,
      trust: "human-owner-b", session: session("tenant-b", "human-owner-b", "owner-b").id, subject: "owner-b",
    },
    viewer: {
      id: `human:${ISSUER}|viewer-a`, tenantId: "tenant-a", role: "viewer" as const,
      trust: "human-viewer-a", session: session("tenant-a", "human-viewer-a", "viewer-a").id, subject: "viewer-a",
    },
  };
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const identity = identities[c.req.header("x-test-actor") as keyof typeof identities];
    if (identity) {
      c.set("principal", { id: identity.id, tenantId: identity.tenantId, role: identity.role });
      c.set("trustPrincipalId", identity.trust);
      if (c.req.header("x-test-auth-method") === "api_key") {
        c.set("authMethod", "api_key");
        c.set("apiKeyId", "key-manager-a");
        c.set("authScopes", ["tenant:admin"]);
      } else {
        c.set("authMethod", "oidc");
        c.set("identitySessionId", identity.session);
        c.set("membershipEvidenceId", `membership:${createHash("sha256")
          .update(`${identity.tenantId}\n${ISSUER}\n${identity.subject}`, "utf8")
          .digest("hex")}`);
      }
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

async function delayedJsonRequest(
  app: Hono<ApiEnv>,
  path: string,
  init: Omit<RequestInit, "body">,
  payload: unknown,
  revoke: () => void,
): Promise<Response> {
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
  });
  const pending = app.request(path, { ...init, body, duplex: "half" } as RequestInit & { duplex: "half" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  revoke();
  bodyController.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
  bodyController.close();
  return pending;
}

describe("service principal administration", () => {
  it("advertises only scopes the production agent role can exercise", () => {
    expect(SERVICE_PRINCIPAL_ALLOWED_SCOPES).toEqual(permissionsFor("agent").slice().sort());
    for (const scope of SERVICE_PRINCIPAL_ALLOWED_SCOPES) {
      expect(can({ id: "service:test", tenantId: "tenant-a", role: "agent" }, scope)).toBe(true);
      expect(scopeAllows([scope], scope)).toBe(true);
    }
    expect(SERVICE_PRINCIPAL_ALLOWED_SCOPES).not.toEqual(expect.arrayContaining([
      "plan:edit",
      "pr:write",
      "dogfood:read",
    ]));
  });

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
    for (const scopes of [["*"], ["tenant:admin"], ["plan:edit"], ["pr:write"], ["dogfood:read"]]) {
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
    expect(listApiKeys(db, "tenant-a").filter(
      (key) => key.principal_id === created.payload.data.id && !key.revoked_at,
    )).toHaveLength(1);

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
    expect(listApiKeys(db, "tenant-a").filter(
      (key) => key.principal_id === created.payload.data.id,
    )).toHaveLength(2);
  });

  it("blocks delayed creation after manager membership revocation without state mutation", async () => {
    const { app, db } = fixture();
    const principalsBefore = db.raw.prepare("SELECT * FROM principals ORDER BY id").all();
    const keysBefore = listApiKeys(db, "tenant-a");
    const auditBefore = listAudit(db, "tenant-a");

    const rejected = await delayedJsonRequest(app, "/tenants/service-principals", {
      method: "POST",
      headers: mutationHeaders("delayed-create"),
    }, {
      subject: "delayed-worker",
      displayName: "Delayed worker",
      scopes: ["graph:read"],
      expiresAt: EXPIRES,
    }, () => {
      setTenantMembershipStatus(db, {
        tenantId: "tenant-a",
        issuer: ISSUER,
        subject: "owner-a",
        status: "offboarded",
        updatedAt: "2026-08-30T12:00:01.000Z",
      });
    });

    expect(rejected.status).toBe(403);
    expect(db.raw.prepare("SELECT * FROM principals ORDER BY id").all()).toEqual(principalsBefore);
    expect(listApiKeys(db, "tenant-a")).toEqual(keysBefore);
    expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
  });

  it("blocks delayed creation after delegated API-key revocation without state mutation", async () => {
    const { app, db } = fixture();
    const principalsBefore = db.raw.prepare("SELECT * FROM principals ORDER BY id").all();
    const keysBefore = listApiKeys(db, "tenant-a");
    const auditBefore = listAudit(db, "tenant-a");

    const rejected = await delayedJsonRequest(app, "/tenants/service-principals", {
      method: "POST",
      headers: { ...mutationHeaders("delayed-key-create"), "x-test-auth-method": "api_key" },
    }, {
      subject: "delayed-key-worker",
      displayName: "Delayed key worker",
      scopes: ["graph:read"],
      expiresAt: EXPIRES,
    }, () => {
      revokeApiKey(db, "key-manager-a", "2026-08-30T12:00:01.000Z", "tenant-a");
    });

    expect(rejected.status).toBe(401);
    expect(db.raw.prepare("SELECT * FROM principals ORDER BY id").all()).toEqual(principalsBefore);
    expect(listApiKeys(db, "tenant-a").filter((key) => key.id !== "key-manager-a"))
      .toEqual(keysBefore.filter((key) => key.id !== "key-manager-a"));
    expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
  });

  it("blocks delayed rotation after trust-principal revocation without credential mutation", async () => {
    const { app, db } = fixture();
    const created = await createPrincipal(app, "delayed-rotate-create");
    const prior = created.payload.data.credential;
    const keysBefore = listApiKeys(db, "tenant-a");
    const auditBefore = listAudit(db, "tenant-a");

    const rejected = await delayedJsonRequest(
      app,
      `/tenants/service-principals/${created.payload.data.id}/credentials/rotate`,
      { method: "POST", headers: mutationHeaders("delayed-rotate") },
      { currentCredentialId: prior.id, scopes: ["graph:read"] },
      () => {
        revokePrincipal(db, {
          tenantId: "tenant-a",
          principalId: "human-owner-a",
          revokedAt: "2026-08-30T12:00:01.000Z",
        });
      },
    );

    expect(rejected.status).toBe(401);
    expect(listApiKeys(db, "tenant-a")).toEqual(keysBefore);
    expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
  });

  it("revalidates manager authority inside service revocation without target mutation", async () => {
    const { app, db } = fixture();
    const created = await createPrincipal(app, "pre-revoke-create");
    const principalId = created.payload.data.id;
    const targetBefore = db.raw.prepare("SELECT * FROM principals WHERE tenant_id = ? AND id = ?")
      .get("tenant-a", principalId);
    const keysBefore = listApiKeys(db, "tenant-a");
    const auditBefore = listAudit(db, "tenant-a");
    revokePrincipal(db, {
      tenantId: "tenant-a",
      principalId: "human-owner-a",
      revokedAt: "2026-08-30T12:00:01.000Z",
    });

    const rejected = await app.request(`/tenants/service-principals/${principalId}/revoke`, {
      method: "POST",
      headers: mutationHeaders("pre-revoked-manager"),
    });

    expect(rejected.status).toBe(401);
    expect(db.raw.prepare("SELECT * FROM principals WHERE tenant_id = ? AND id = ?")
      .get("tenant-a", principalId)).toEqual(targetBefore);
    expect(listApiKeys(db, "tenant-a")).toEqual(keysBefore);
    expect(listAudit(db, "tenant-a")).toEqual(auditBefore);
  });

  it("cancels an oversized streamed body at the byte ceiling and rejects invalid lengths", async () => {
    const { app, db } = fixture();
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1_024 + 1)); },
      cancel() { cancelled = true; },
    });
    const rejected = await app.request("/tenants/service-principals", {
      method: "POST",
      headers: mutationHeaders("oversized-stream"),
      body: oversized,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(rejected.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(db.raw.prepare("SELECT * FROM principals WHERE kind = 'service'").all()).toEqual([]);

    for (const declared of ["-1", "not-a-number"]) {
      const invalid = await app.request("/tenants/service-principals", {
        method: "POST",
        headers: { ...mutationHeaders(`invalid-length-${declared}`), "content-length": declared },
        body: JSON.stringify({
          subject: "invalid-length",
          displayName: "Invalid length",
          scopes: ["graph:read"],
          expiresAt: EXPIRES,
        }),
      });
      expect(invalid.status).toBe(422);
    }
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
    expect(listApiKeys(db, "tenant-a")
      .filter((key) => key.principal_id === principalId)
      .every((key) => Boolean(key.revoked_at))).toBe(true);

    process.env.API_AUTH = "required";
    const authApp = new Hono<ApiEnv>();
    authApp.use("*", createAuthMiddleware(db, { oidc: null, now: () => new Date(NOW) }));
    authApp.get("/private", (c) => c.json({ ok: true }));
    expect((await authApp.request("/private", {
      headers: { authorization: `Bearer ${created.payload.data.credential.token}` },
    })).status).toBe(401);
  });
});
