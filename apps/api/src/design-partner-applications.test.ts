import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey, createDb, type AppDb } from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createDesignPartnerApplicationStore } from "./design-partner-applications-store.js";
import { createDesignPartnerApplicationRoutes } from "./design-partner-applications.js";
import { requestIdMiddleware } from "./production.js";

const KEY = Buffer.alloc(32, 41);
const NOW = new Date("2026-08-01T16:00:00.000Z");
const directories: string[] = [];
const databases: AppDb[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  for (const db of databases.splice(0)) db.raw.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Jordan Lee",
    workEmail: "jordan@customer.dev",
    company: "Customer Labs",
    role: "Engineering lead",
    providerChange: "We need to validate a provider API migration before the planned release date.",
    repositoryScope: "One approved integration repository limited to the provider adapter and tests.",
    successMetric: "A verified patch passes the existing checks and changes only approved files.",
    authorized: true,
    consent: true,
    website: "",
    startedAt: NOW.getTime() - 10_000,
    ...overrides,
  };
}

function fixture(options: { now?: () => Date; retentionMs?: number } = {}) {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-design-partner-api-"));
  directories.push(directory);
  const db = createDb(join(directory, "api.sqlite"));
  databases.push(db);
  const tenantA = createApiKey(db, {
    id: "key-a",
    name: "Tenant A",
    tenantId: "tenant-a",
    scopes: ["*"],
    createdAt: NOW.toISOString(),
  });
  const tenantB = createApiKey(db, {
    id: "key-b",
    name: "Tenant B",
    tenantId: "tenant-b",
    scopes: ["*"],
    createdAt: NOW.toISOString(),
  });
  const viewer = createApiKey(db, {
    id: "key-viewer",
    name: "Viewer",
    tenantId: "tenant-a",
    scopes: ["role:viewer"],
    createdAt: NOW.toISOString(),
  });
  let sequence = 0;
  const store = createDesignPartnerApplicationStore({
    db,
    key: KEY,
    now: options.now ?? (() => new Date(NOW)),
    createId: () => `application-api-${++sequence}`,
    retentionMs: options.retentionMs,
  });
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db));
  app.route("/design-partner-applications", createDesignPartnerApplicationRoutes({ db, store }));
  return { app, store, tenantA: tenantA.token, tenantB: tenantB.token, viewer: viewer.token };
}

function headers(token: string, requestId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  };
}

describe("design partner application API", () => {
  it.each([
    ["provider", "application_provider_token_invalid"],
    ["filesystem", "application_/customers/acme/private_not_found"],
    ["database", "application_SQLITE_CONSTRAINT"],
    ["resource existence", "application_repository_not_found"],
  ])("fails unknown %s exceptions closed at the API boundary", async (_kind, sentinel) => {
    const { app, store, tenantA } = fixture();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store, "list").mockImplementation(() => {
      throw new Error(sentinel);
    });

    const response = await app.request("/design-partner-applications", {
      headers: headers(tenantA, "sentinel-application"),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      requestId: "sentinel-application",
    });
  });

  it("requires authentication, derives identity, isolates tenants, and redacts metadata", async () => {
    const { app, store, tenantA, tenantB, viewer } = fixture();
    const unauthenticated = await app.request("/design-partner-applications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "unauthenticated" },
      body: JSON.stringify(validBody()),
    });
    expect(unauthenticated.status).toBe(401);

    const created = await app.request("/design-partner-applications", {
      method: "POST",
      headers: {
        ...headers(tenantA, "create-a"),
        "X-Tenant-Id": "tenant-victim",
        "X-User-Id": "spoofed-actor",
        "X-Mendpoint-Application-Bridge": "public-design-partner-v1",
        "X-Mendpoint-Application-Origin": "https://mendpoint.dev",
      },
      body: JSON.stringify(validBody()),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { applicationId: string } };
    expect(createdBody).toEqual({ data: { applicationId: "application-api-1" } });
    expect(store.reveal({
      tenantId: "tenant-a",
      actorPrincipalId: "api-key:key-a",
      requestId: "inspect-derived-actor",
      applicationId: createdBody.data.applicationId,
      purposeCode: "application_review",
    }, vi.fn()).payload).toMatchObject({
      evidence: { actorPrincipalId: "api-key:key-a", source: { bridge: "public-design-partner-v1" } },
    });
    expect(() => store.reveal({
      tenantId: "tenant-victim",
      actorPrincipalId: "api-key:key-a",
      requestId: "inspect-wrong-tenant",
      applicationId: createdBody.data.applicationId,
      purposeCode: "application_review",
    }, vi.fn())).toThrow("application_not_found");

    const crossTenant = await app.request(`/design-partner-applications/${createdBody.data.applicationId}`, {
      headers: headers(tenantB, "read-b"),
    });
    expect(crossTenant.status).toBe(404);
    const list = await app.request("/design-partner-applications", {
      headers: headers(tenantA, "list-a"),
    });
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain("application-api-1");
    for (const privateValue of ["Jordan", "jordan@customer.dev", "Customer Labs", "api-key:key-a"]) {
      expect(listText).not.toContain(privateValue);
    }
    const viewerList = await app.request("/design-partner-applications", {
      headers: headers(viewer, "viewer-list"),
    });
    expect(viewerList.status).toBe(403);
  });

  it("uses request IDs for exact replay and rejects changed replays", async () => {
    const { app, tenantA } = fixture();
    const first = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantA, "replay-request"),
      body: JSON.stringify(validBody()),
    });
    const firstBody = await first.json();
    const replay = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantA, "replay-request"),
      body: JSON.stringify(validBody()),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);

    const conflict = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantA, "replay-request"),
      body: JSON.stringify(validBody({ company: "Changed Company" })),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "application_idempotency_conflict" },
    });
  });

  it("rejects oversized payloads before storage", async () => {
    const { app, store, tenantA } = fixture();
    const oversized = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantA, "oversized"),
      body: JSON.stringify(validBody({ providerChange: "x".repeat(17_000) })),
    });
    expect(oversized.status).toBe(413);
    expect(store.list("tenant-a")).toEqual([]);
  });

  it("audits owner reveals, denies cross-tenant access, and idempotently erases the payload", async () => {
    const { app, store, tenantA, tenantB, viewer } = fixture();
    const created = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantA, "lifecycle-create"),
      body: JSON.stringify(validBody()),
    });
    const applicationId = ((await created.json()) as { data: { applicationId: string } }).data.applicationId;

    const viewerReveal = await app.request(`/design-partner-applications/${applicationId}/reveals`, {
      method: "POST",
      headers: headers(viewer, "viewer-reveal"),
      body: JSON.stringify({ purposeCode: "application_review" }),
    });
    expect(viewerReveal.status).toBe(403);
    const crossTenantReveal = await app.request(`/design-partner-applications/${applicationId}/reveals`, {
      method: "POST",
      headers: headers(tenantB, "cross-tenant-reveal"),
      body: JSON.stringify({ purposeCode: "application_review" }),
    });
    expect(crossTenantReveal.status).toBe(404);

    const reveal = await app.request(`/design-partner-applications/${applicationId}/reveals`, {
      method: "POST",
      headers: headers(tenantA, "owner-reveal"),
      body: JSON.stringify({ purposeCode: "applicant_follow_up" }),
    });
    expect(reveal.status).toBe(200);
    await expect(reveal.json()).resolves.toMatchObject({
      data: {
        application: { id: applicationId, payloadState: "available" },
        payload: { contact: { workEmail: "jordan@customer.dev" } },
      },
    });
    const audit = store.db.raw.prepare(`SELECT actor, principal_id, request_id, action, resource_id
      FROM audit_events WHERE action = 'design_partner_application.reveal'`).get();
    expect(audit).toEqual({
      actor: "api-key:key-a",
      principal_id: "api-key:key-a",
      request_id: "owner-reveal",
      action: "design_partner_application.reveal",
      resource_id: applicationId,
    });

    const eraseRequest = {
      method: "POST",
      headers: headers(tenantA, "owner-erase"),
      body: JSON.stringify({ reasonCode: "applicant_request" }),
    };
    const erased = await app.request(`/design-partner-applications/${applicationId}/erasures`, eraseRequest);
    expect(erased.status).toBe(200);
    await expect(erased.json()).resolves.toMatchObject({
      data: { application: { id: applicationId, payloadState: "erased" }, replayed: false },
    });
    const replay = await app.request(`/design-partner-applications/${applicationId}/erasures`, eraseRequest);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ data: { replayed: true } });
    const unavailable = await app.request(`/design-partner-applications/${applicationId}/reveals`, {
      method: "POST",
      headers: headers(tenantA, "reveal-erased"),
      body: JSON.stringify({ purposeCode: "privacy_request" }),
    });
    expect(unavailable.status).toBe(410);
    expect(store.db.raw.prepare(`SELECT COUNT(*) AS count FROM design_partner_application_payload_keys
      WHERE tenant_id = 'tenant-a' AND application_id = ?`).get(applicationId)).toEqual({ count: 0 });
    expect(store.db.raw.prepare(`SELECT COUNT(*) AS count FROM design_partner_application_erasures
      WHERE tenant_id = 'tenant-a' AND application_id = ?`).get(applicationId)).toEqual({ count: 1 });
  });

  it("purges expired payloads through the admin endpoint without crossing tenants", async () => {
    let current = new Date(NOW);
    const { app, store, tenantA, tenantB } = fixture({
      now: () => new Date(current),
      retentionMs: 24 * 60 * 60 * 1_000,
    });
    const createA = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantA, "purge-create-a"),
      body: JSON.stringify(validBody()),
    });
    const idA = ((await createA.json()) as { data: { applicationId: string } }).data.applicationId;
    const createB = await app.request("/design-partner-applications", {
      method: "POST",
      headers: headers(tenantB, "purge-create-b"),
      body: JSON.stringify(validBody()),
    });
    const idB = ((await createB.json()) as { data: { applicationId: string } }).data.applicationId;
    current = new Date("2026-08-03T16:00:00.000Z");

    const purged = await app.request("/design-partner-applications/retention-purges", {
      method: "POST",
      headers: headers(tenantA, "purge-tenant-a"),
      body: JSON.stringify({ limit: 25 }),
    });
    expect(purged.status).toBe(200);
    await expect(purged.json()).resolves.toEqual({
      data: { purgedApplicationIds: [idA], purgedCount: 1 },
    });
    expect(store.get("tenant-a", idA)?.payloadState).toBe("erased");
    expect(store.get("tenant-b", idB)?.payloadState).toBe("available");
  });
});
