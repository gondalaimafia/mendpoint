import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  bindConsumerRepoSnapshot,
  createDb,
  getWardenCampaign,
  insertConnectedRepository,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  insertPrincipal,
  insertRepositorySnapshot,
  listAudit,
  listWardenCampaignTargets,
  putTenantMembership,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import type { InstallationRepository } from "@mendpoint/github";
import type { ApiEnv } from "./auth.js";
import { createWardenCampaignEnrollmentRoutes } from "./warden-campaign-enrollment.js";

const NOW = "2026-08-20T12:00:00.000Z";
const ISSUER = "https://identity.example.com";
const opened: Array<{ db: AppDb; root: string }> = [];

function evidenceId(tenantId: string, issuer: string, subject: string): string {
  return `membership:${createHash("sha256")
    .update(`${tenantId}\n${issuer}\n${subject}`, "utf8")
    .digest("hex")}`;
}

function campaignIdFor(tenantId: string, key: string): string {
  const identity = createHash("sha256").update(`${tenantId}\0${key}`, "utf8").digest("hex");
  return `fettler-campaign-${identity.slice(0, 32)}`;
}

type Session = {
  present: boolean;
  principalId: string;
  tenantId: string;
  trustPrincipalId: string;
  authMethod: "oidc" | "api_key";
  apiKeyId?: string;
  membershipEvidenceId: string;
};

function defaultSession(tenantId: string, subject: string): Session {
  return {
    present: true,
    principalId: `human:${subject}@example.com`,
    tenantId,
    trustPrincipalId: `trust-${tenantId}-${subject}`,
    authMethod: "oidc",
    membershipEvidenceId: evidenceId(tenantId, ISSUER, subject),
  };
}

function seedTenant(db: AppDb, tenantId: string, subject: string, opts: {
  membershipStatus?: "active" | "offboarded";
  trustExpiresAt?: string | null;
  trustRevokedAt?: string | null;
} = {}) {
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES (?, ?, ?, 'team', 'active', 10, ?)`).run(tenantId, tenantId, tenantId, NOW);
  insertPrincipal(db, {
    id: `trust-${tenantId}-${subject}`,
    tenantId,
    kind: "human",
    subject: `${ISSUER}|${subject}`,
    displayName: "Writer",
    audience: ISSUER,
    ...(opts.trustExpiresAt !== undefined ? { expiresAt: opts.trustExpiresAt } : {}),
    ...(opts.trustRevokedAt !== undefined ? { revokedAt: opts.trustRevokedAt } : {}),
    createdAt: NOW,
  });
  putTenantMembership(db, {
    tenantId,
    issuer: ISSUER,
    subject,
    email: `${subject}@example.com`,
    displayName: "Writer",
    role: "owner",
    status: opts.membershipStatus ?? "active",
    updatedAt: NOW,
  });
}

function eligibleRepo(db: AppDb, root: string, tenantId: string, connectionId: string, providerId: string) {
  const snapshotRoot = join(root, `snapshot-${tenantId}`);
  mkdirSync(snapshotRoot);
  const repository = insertConnectedRepository(db, {
    id: `repository-${tenantId}`, tenantId, connectionId, remoteId: "200", owner: "acme", name: "shop",
    defaultBranch: "main", status: "ready", createdAt: NOW, updatedAt: NOW,
  });
  insertRepositorySnapshot(db, {
    id: `snapshot-${tenantId}`, tenantId, repositoryId: repository.id, requestedRef: "main",
    resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64), storagePath: snapshotRoot,
    createdAt: NOW, expiresAt: "2026-09-01T18:00:00.000Z",
  });
  insertConsumer(db, {
    id: `consumer-${tenantId}`, name: "shop", githubOwner: "acme", githubRepo: "shop", tenantId, createdAt: NOW,
  });
  insertConsumerRepo(db, { id: `consumer-repo-${tenantId}`, consumerId: `consumer-${tenantId}`, localPath: snapshotRoot, createdAt: NOW });
  bindConsumerRepoSnapshot(db, {
    tenantId, consumerRepoId: `consumer-repo-${tenantId}`, connectionId,
    connectedRepositoryId: repository.id, snapshotId: `snapshot-${tenantId}`,
  });
  insertMonitoredApi(db, { id: `monitor-${tenantId}`, consumerId: `consumer-${tenantId}`, providerId, detectionSource: "detected" });
}

const CRAWL_REPOS: InstallationRepository[] = [Object.freeze({
  id: 200, owner: "acme", name: "shop", fullName: "acme/shop", defaultBranch: "main",
  private: true, archived: false, disabled: false,
})];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-create-api-"));
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  // Providers are a global catalog (slug is globally unique), shared across tenants.
  db.raw.prepare(`INSERT INTO providers (id, slug, name, created_at)
    VALUES ('provider-stripe', 'stripe', 'Stripe', ?)`).run(NOW);
  seedTenant(db, "tenant-a", "writer-a");
  const connection = upsertScmConnection(db, {
    id: "connection-a", tenantId: "tenant-a", provider: "github", credentialRef: "github-app://installation/100",
    externalAccountId: "100", displayName: "Acme", createdAt: NOW, updatedAt: NOW,
  });
  eligibleRepo(db, root, "tenant-a", connection.id, "provider-stripe");

  // Session store the middleware reads; tests mutate it before issuing requests.
  const sessions: Record<string, Session> = {
    "tenant-a": defaultSession("tenant-a", "writer-a"),
  };
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const key = c.req.header("X-Test-Session");
    const session = key ? sessions[key] : undefined;
    if (session?.present) {
      c.set("principal", { id: session.principalId, tenantId: session.tenantId, role: "owner" });
      c.set("tenantId", session.tenantId);
      c.set("trustPrincipalId", session.trustPrincipalId);
      c.set("authMethod", session.authMethod);
      c.set("membershipEvidenceId", session.membershipEvidenceId);
      if (session.apiKeyId) c.set("apiKeyId", session.apiKeyId);
      c.set("requestId", "request-a");
    }
    return next();
  });
  const campaignRoutes = createWardenCampaignEnrollmentRoutes({
    db, now: () => NOW, crawl: async () => CRAWL_REPOS,
  });
  app.route("/fettler/campaigns", campaignRoutes);
  return { app, db, sessions, root };
}

afterEach(() => {
  for (const item of opened.splice(0)) { item.db.raw.close(); rmSync(item.root, { recursive: true, force: true }); }
});

function create(app: Hono<ApiEnv>, opts: {
  body?: Record<string, unknown> | string;
  key?: string | null;
  session?: string;
} = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.session !== undefined) headers["X-Test-Session"] = opts.session;
  else headers["X-Test-Session"] = "tenant-a";
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  const body = opts.body ?? { name: "Stripe upgrade", concurrencyLimit: 2, completionPolicy: "all" };
  return app.request("/fettler/campaigns", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function enroll(app: Hono<ApiEnv>, campaignId: string, session = "tenant-a") {
  return app.request(`/fettler/campaigns/${campaignId}/enroll-org`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Session": session },
    body: JSON.stringify({ providerSlug: "stripe", connectionId: "connection-a" }),
  });
}

describe("Warden campaign creation", () => {
  it("creates a campaign the enrollment route can find (no longer 404)", async () => {
    const { app, db } = fixture();
    const key = "camp-key-0001";
    const expectedId = campaignIdFor("tenant-a", key);

    const response = await create(app, { key });
    expect(response.status).toBe(201);
    const body = await response.json() as { campaignId: string; status: string; replayed: boolean };
    expect(body.campaignId).toBe(expectedId);
    expect(body.status).toBe("draft");
    expect(body.replayed).toBe(false);
    expect(getWardenCampaign(db, "tenant-a", expectedId)?.name).toBe("Stripe upgrade");

    // The visible symptom the change fixes: enrolment resolves the campaign and
    // returns success instead of a permanent 404.
    const enrolled = await enroll(app, expectedId);
    expect(enrolled.status).toBe(200);
    const enrollBody = await enrolled.json() as { enrolled: unknown[] };
    expect(enrollBody.enrolled).toHaveLength(1);
    expect(listWardenCampaignTargets(db, "tenant-a", expectedId)).toHaveLength(1);

    expect(listAudit(db, "tenant-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "warden.campaign.created", resource_id: expectedId }),
    ]));
  });

  it("replays idempotently without duplicating the campaign or audit", async () => {
    const { app, db } = fixture();
    const key = "camp-key-0002";
    const expectedId = campaignIdFor("tenant-a", key);

    expect((await create(app, { key })).status).toBe(201);
    const second = await create(app, { key });
    expect(second.status).toBe(200);
    const body = await second.json() as { campaignId: string; replayed: boolean };
    expect(body.campaignId).toBe(expectedId);
    expect(body.replayed).toBe(true);

    expect(getWardenCampaign(db, "tenant-a", expectedId)).toBeDefined();
    const created = listAudit(db, "tenant-a").filter((a) => a.action === "warden.campaign.created");
    expect(created).toHaveLength(1);
  });

  it("rejects a replay that reuses the key with a different body (409)", async () => {
    const { app } = fixture();
    const key = "camp-key-0003";
    expect((await create(app, { key, body: { name: "First", concurrencyLimit: 1, completionPolicy: "all" } })).status).toBe(201);
    const conflict = await create(app, { key, body: { name: "Second", concurrencyLimit: 1, completionPolicy: "all" } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: string }).error).toBe("idempotency_conflict");
  });

  it("requires an authenticated principal (401)", async () => {
    const { app } = fixture();
    const res = await app.request("/fettler/campaigns", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("refuses an API-key principal (403)", async () => {
    const { app, sessions } = fixture();
    sessions["tenant-a"].apiKeyId = "key-1";
    const res = await create(app, { key: "camp-key-0004" });
    expect(res.status).toBe(403);
  });

  it("refuses a non-OIDC auth method (403)", async () => {
    const { app, sessions } = fixture();
    sessions["tenant-a"].authMethod = "api_key";
    const res = await create(app, { key: "camp-key-0005" });
    expect(res.status).toBe(403);
  });

  it("refuses when the tenant membership is not active (403)", async () => {
    const { app, db } = fixture();
    putTenantMembership(db, {
      tenantId: "tenant-a", issuer: ISSUER, subject: "writer-a", email: "writer-a@example.com",
      displayName: "Writer", role: "owner", status: "offboarded", updatedAt: "2026-08-20T13:00:00.000Z",
    });
    const res = await create(app, { key: "camp-key-0006" });
    expect(res.status).toBe(403);
  });

  it("refuses when the request carries the wrong membership evidence (403)", async () => {
    const { app, sessions } = fixture();
    sessions["tenant-a"].membershipEvidenceId = evidenceId("tenant-a", ISSUER, "someone-else");
    const res = await create(app, { key: "camp-key-0007" });
    expect(res.status).toBe(403);
  });

  it("refuses an expired trust principal that the entry gate alone would admit (403)", async () => {
    // The trust principal is a valid human with active membership and matching
    // evidence, so the entry gate and createWardenCampaign.assertPrincipal both
    // admit it; only reverifyCampaignWriter's expiry check rejects it.
    const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-create-exp-"));
    const db = createDb(join(root, "api.sqlite"));
    opened.push({ db, root });
    seedTenant(db, "tenant-a", "writer-a", { trustExpiresAt: "2020-01-01T00:00:00.000Z" });
    const sessions: Record<string, Session> = { "tenant-a": defaultSession("tenant-a", "writer-a") };
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      const session = sessions[c.req.header("X-Test-Session") ?? ""];
      if (session?.present) {
        c.set("principal", { id: session.principalId, tenantId: session.tenantId, role: "owner" });
        c.set("tenantId", session.tenantId);
        c.set("trustPrincipalId", session.trustPrincipalId);
        c.set("authMethod", session.authMethod);
        c.set("membershipEvidenceId", session.membershipEvidenceId);
        c.set("requestId", "request-a");
      }
      return next();
    });
    app.route("/fettler/campaigns", createWardenCampaignEnrollmentRoutes({ db, now: () => NOW }));
    const res = await app.request("/fettler/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Session": "tenant-a", "Idempotency-Key": "camp-key-0008" },
      body: JSON.stringify({ name: "Expired", concurrencyLimit: 1, completionPolicy: "all" }),
    });
    expect(res.status).toBe(403);
    expect(getWardenCampaign(db, "tenant-a", campaignIdFor("tenant-a", "camp-key-0008"))).toBeUndefined();
  });

  it("requires a valid Idempotency-Key (422)", async () => {
    const { app } = fixture();
    expect((await create(app, { key: null })).status).toBe(422);
    expect((await create(app, { key: "short" })).status).toBe(422);
  });

  it("rejects unknown body fields and invalid values (422)", async () => {
    const { app } = fixture();
    expect((await create(app, { key: "camp-key-0009", body: { name: "x", rogue: 1 } })).status).toBe(422);
    expect((await create(app, { key: "camp-key-0010", body: { name: "", concurrencyLimit: 1, completionPolicy: "all" } })).status).toBe(422);
    expect((await create(app, { key: "camp-key-0011", body: { name: "x", concurrencyLimit: 0, completionPolicy: "all" } })).status).toBe(422);
    expect((await create(app, { key: "camp-key-0012", body: { name: "x", concurrencyLimit: 1, completionPolicy: "nope" } })).status).toBe(422);
  });

  it("binds tenant into the id so no tenant can see, enrol, or infer another's campaign", async () => {
    const { app, db, sessions, root } = fixture();
    // Second tenant in the same database, with its own connection + eligible repo.
    seedTenant(db, "tenant-b", "writer-b");
    const connectionB = upsertScmConnection(db, {
      id: "connection-b", tenantId: "tenant-b", provider: "github", credentialRef: "github-app://installation/200",
      externalAccountId: "200", displayName: "Beta", createdAt: NOW, updatedAt: NOW,
    });
    eligibleRepo(db, root, "tenant-b", connectionB.id, "provider-stripe");
    sessions["tenant-b"] = defaultSession("tenant-b", "writer-b");

    const key = "shared-key-0001";
    const idA = campaignIdFor("tenant-a", key);
    const idB = campaignIdFor("tenant-b", key);
    expect(idA).not.toBe(idB); // structural: same key, different tenant, different id

    expect((await create(app, { key, session: "tenant-a" })).status).toBe(201);

    // tenant-b cannot see tenant-a's campaign...
    expect(getWardenCampaign(db, "tenant-b", idA)).toBeUndefined();
    // ...cannot enrol into it (indistinguishable 404, no existence leak)...
    const crossEnroll = await enroll(app, idA, "tenant-b");
    expect(crossEnroll.status).toBe(404);
    // ...and a truly nonexistent campaign returns the same 404 to tenant-b.
    const missingEnroll = await enroll(app, campaignIdFor("tenant-b", "never-created-000"), "tenant-b");
    expect(missingEnroll.status).toBe(404);

    // tenant-b creating with the same idempotency key gets its own campaign, not tenant-a's.
    const bCreate = await create(app, { key, session: "tenant-b" });
    expect(bCreate.status).toBe(201);
    expect((await bCreate.json() as { campaignId: string }).campaignId).toBe(idB);
    expect(getWardenCampaign(db, "tenant-a", idB)).toBeUndefined();
  });
});
