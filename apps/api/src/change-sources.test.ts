import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey, createDb, type AppDb } from "@mendpoint/db";
import { openChangeSourceStore, type ChangeSourceStore } from "@mendpoint/change-intel";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import { createChangeSourceRoutes } from "./change-sources.js";
import { requestIdMiddleware } from "./production.js";

const NOW = "2026-08-01T14:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const directories: string[] = [];
const databases: AppDb[] = [];
const stores: ChangeSourceStore[] = [];
const originalAuth = process.env.API_AUTH;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Restart tests close an earlier handle explicitly.
    }
  }
  for (const db of databases.splice(0)) db.raw.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-change-source-api-"));
  directories.push(directory);
  const db = createDb(join(directory, "auth.sqlite"));
  databases.push(db);
  const tenantA = createApiKey(db, {
    id: "key-a",
    name: "Tenant A",
    tenantId: "tenant-a",
    scopes: ["*"],
    createdAt: NOW,
  });
  const tenantB = createApiKey(db, {
    id: "key-b",
    name: "Tenant B",
    tenantId: "tenant-b",
    scopes: ["*"],
    createdAt: NOW,
  });
  const path = join(directory, "change-sources.sqlite");
  const store = openChangeSourceStore(path);
  stores.push(store);
  return { directory, db, path, store, tenantA: tenantA.token, tenantB: tenantB.token };
}

function appFor(db: AppDb, store: ChangeSourceStore, now = NOW) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db, { now: () => new Date(now) }));
  app.route("/change-sources", createChangeSourceRoutes({ store, now: () => now }));
  return app;
}

function headers(token: string, requestId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  };
}

function manualBody() {
  return {
    kind: "manual_provider_announcement",
    providerSlug: "stripe",
    announcement: "The Charges API removes amount_cents on 2026-10-01.",
    source: { kind: "provider_page", uri: "https://docs.stripe.com/changelog/charges-v2" },
    effectiveDate: "2026-10-01T00:00:00.000Z",
    affectedProducts: ["charges", "payments"],
    evidence: [{ kind: "document", locator: "https://docs.stripe.com/changelog/charges-v2", sha256: HASH_A }],
    provenance: { observedAt: NOW, capturedAt: NOW, capturedBy: "collector:manual" },
    excerpt: { text: "amount_cents is removed", location: "migration section" },
    confidence: 0.9,
  };
}

function incidentBody() {
  return {
    kind: "customer_incident",
    incidentRef: "INC-1042",
    redactedDetails: "Payment requests return 400 for account [REDACTED].",
    redactionEvidence: {
      method: "deterministic field allowlist v1",
      sourceSha256: HASH_B,
      redactedFields: ["account_id", "authorization"],
    },
    source: { kind: "customer_ticket", uri: "urn:mendpoint:incident:INC-1042" },
    effectiveDate: null,
    affectedProducts: ["payments"],
    evidence: [{ kind: "ticket", locator: "urn:mendpoint:evidence:ticket-1042", sha256: HASH_B }],
    provenance: { observedAt: NOW, capturedAt: NOW, capturedBy: "collector:support" },
    excerpt: { text: "requests return 400", location: "customer report line 1" },
    confidence: 0.6,
  };
}

async function createSource(app: Hono<ApiEnv>, token: string, requestId: string, body: unknown) {
  return app.request("/change-sources", {
    method: "POST",
    headers: headers(token, requestId),
    body: JSON.stringify(body),
  });
}

describe("change source API routes", () => {
  it.each([
    ["provider", "change_source_provider_token_invalid"],
    ["filesystem", "change_source_/customers/acme/private_not_found"],
    ["database", "change_source_SQLITE_CONSTRAINT"],
    ["resource existence", "change_source_repository_not_found"],
  ])("fails unknown %s exceptions closed at the API boundary", async (_kind, sentinel) => {
    const { db, store, tenantA } = fixture();
    const app = appFor(db, store);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(store.raw, "prepare").mockImplementation(() => {
      throw new Error(sentinel);
    });

    const response = await app.request("/change-sources/source-unknown", {
      headers: headers(tenantA, "sentinel-change-source"),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "internal_error",
      requestId: "sentinel-change-source",
    });
  });

  it("requires authentication and derives tenant scope only from the authenticated principal", async () => {
    const { db, store, tenantA, tenantB } = fixture();
    const app = appFor(db, store);
    const unauthenticated = await app.request("/change-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "unauth-create" },
      body: JSON.stringify(manualBody()),
    });
    expect(unauthenticated.status).toBe(401);

    const created = await createSource(app, tenantA, "create-a", manualBody());
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: { id: string; author: { principalId: string } } };
    expect(createdBody.data.author.principalId).toBe("api-key:key-a");

    const crossTenant = await app.request(`/change-sources/${createdBody.data.id}`, {
      headers: { ...headers(tenantB, "read-b"), "X-Tenant-Id": "tenant-a" },
    });
    expect(crossTenant.status).toBe(404);
    await expect(crossTenant.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("keeps fanout closed until approval and replays a request ID without another revision", async () => {
    const { db, store, tenantA } = fixture();
    const app = appFor(db, store);
    const created = await createSource(app, tenantA, "create-manual", manualBody());
    const source = await created.json() as { data: { id: string } };

    const pending = await app.request(`/change-sources/${source.data.id}/fanout-eligibility`, {
      headers: headers(tenantA, "eligibility-before"),
    });
    await expect(pending.json()).resolves.toMatchObject({
      data: { eligible: false, reasonCode: "change_source_not_approved_for_fanout" },
    });

    const reviewBody = { expectedRevision: 1, decision: "approve", reason: "provider evidence verified" };
    const review = await app.request(`/change-sources/${source.data.id}/reviews`, {
      method: "POST",
      headers: headers(tenantA, "approve-manual"),
      body: JSON.stringify(reviewBody),
    });
    expect(review.status).toBe(200);
    const replay = await app.request(`/change-sources/${source.data.id}/reviews`, {
      method: "POST",
      headers: headers(tenantA, "approve-manual"),
      body: JSON.stringify(reviewBody),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await review.clone().json());

    const revisions = await app.request(`/change-sources/${source.data.id}/revisions`, {
      headers: headers(tenantA, "revisions-after"),
    });
    const revisionBody = await revisions.json() as { data: unknown[] };
    expect(revisionBody.data).toHaveLength(2);
    const eligible = await app.request(`/change-sources/${source.data.id}/fanout-eligibility`, {
      headers: headers(tenantA, "eligibility-after"),
    });
    await expect(eligible.json()).resolves.toMatchObject({ data: { eligible: true, reasonCode: null } });
  });

  it("rejects raw incident material and requires customer confirmation after review", async () => {
    const { db, store, tenantA } = fixture();
    const app = appFor(db, store);
    const rejected = await createSource(app, tenantA, "raw-incident", {
      ...incidentBody(),
      rawDetails: "Authorization: Bearer secret-token",
    });
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "change_source_unredacted_incident_material_rejected" },
    });

    const created = await createSource(app, tenantA, "safe-incident", incidentBody());
    const source = await created.json() as { data: { id: string } };
    await app.request(`/change-sources/${source.data.id}/reviews`, {
      method: "POST",
      headers: headers(tenantA, "approve-incident"),
      body: JSON.stringify({ expectedRevision: 1, decision: "approve", reason: "redaction verified" }),
    });
    const provisional = await app.request(`/change-sources/${source.data.id}/fanout-eligibility`, {
      headers: headers(tenantA, "incident-before-confirm"),
    });
    await expect(provisional.json()).resolves.toMatchObject({
      data: { eligible: false, reasonCode: "change_source_incident_not_confirmed_for_fanout" },
    });

    const confirmed = await app.request(`/change-sources/${source.data.id}/confirm`, {
      method: "POST",
      headers: headers(tenantA, "confirm-incident"),
      body: JSON.stringify({ expectedRevision: 2, confirmed: true, reason: "customer reproduced the issue" }),
    });
    expect(confirmed.status).toBe(200);
    const eligible = await app.request(`/change-sources/${source.data.id}/fanout-eligibility`, {
      headers: headers(tenantA, "incident-after-confirm"),
    });
    await expect(eligible.json()).resolves.toMatchObject({ data: { eligible: true } });
    expect(JSON.stringify(await confirmed.json())).not.toContain("secret-token");
  });

  it("reopens durable state and replays a completed create request after restart", async () => {
    const { db, path, store, tenantA } = fixture();
    let app = appFor(db, store);
    const first = await createSource(app, tenantA, "durable-create", manualBody());
    const firstBody = await first.json() as { data: { id: string } };
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openChangeSourceStore(path);
    stores.push(reopened);
    app = appFor(db, reopened);
    const replay = await createSource(app, tenantA, "durable-create", manualBody());
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    const read = await app.request(`/change-sources/${firstBody.data.id}`, {
      headers: headers(tenantA, "read-after-restart"),
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ data: { id: firstBody.data.id } });
  });

  it("reconciles a stale pending review after a crash between domain append and ledger completion", async () => {
    const { db, path, store, tenantA } = fixture();
    let app = appFor(db, store);
    const created = await createSource(app, tenantA, "crash-create", manualBody());
    const source = await created.json() as { data: { id: string } };
    store.raw.exec(`CREATE TRIGGER simulate_request_completion_crash
      BEFORE UPDATE OF state ON change_source_api_requests
      WHEN NEW.state = 'completed'
      BEGIN SELECT RAISE(ABORT, 'simulated_completion_crash'); END;
      CREATE TRIGGER preserve_pending_after_crash
      BEFORE DELETE ON change_source_api_requests
      BEGIN SELECT RAISE(ABORT, 'simulated_process_exit'); END;`);
    const reviewBody = { expectedRevision: 1, decision: "approve", reason: "provider evidence verified" };
    const interrupted = await app.request(`/change-sources/${source.data.id}/reviews`, {
      method: "POST",
      headers: headers(tenantA, "crash-review"),
      body: JSON.stringify(reviewBody),
    });
    expect(interrupted.status).toBe(500);
    expect(store.raw.prepare(`SELECT state FROM change_source_api_requests
      WHERE tenant_id = 'tenant-a' AND request_id = 'crash-review'`).get()).toEqual({ state: "pending" });
    expect(store.raw.prepare(`SELECT COUNT(*) AS count FROM change_source_revisions
      WHERE tenant_id = 'tenant-a' AND artifact_id = ?`).get(source.data.id)).toEqual({ count: 2 });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = openChangeSourceStore(path);
    stores.push(reopened);
    reopened.raw.exec("DROP TRIGGER simulate_request_completion_crash; DROP TRIGGER preserve_pending_after_crash;");
    app = appFor(db, reopened, "2026-08-01T14:01:00.000Z");
    const reconciled = await app.request(`/change-sources/${source.data.id}/reviews`, {
      method: "POST",
      headers: headers(tenantA, "crash-review"),
      body: JSON.stringify(reviewBody),
    });
    expect(reconciled.status).toBe(200);
    await expect(reconciled.json()).resolves.toMatchObject({
      data: { id: source.data.id, latestRevision: { revision: 2, reviewState: "approved" } },
    });
    expect(reopened.raw.prepare(`SELECT state FROM change_source_api_requests
      WHERE tenant_id = 'tenant-a' AND request_id = 'crash-review'`).get()).toEqual({ state: "completed" });
    expect(reopened.raw.prepare(`SELECT COUNT(*) AS count FROM change_source_revisions
      WHERE tenant_id = 'tenant-a' AND artifact_id = ?`).get(source.data.id)).toEqual({ count: 2 });
  });
});
