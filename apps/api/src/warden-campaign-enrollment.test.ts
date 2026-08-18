import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { permissionForRoute } from "@mendpoint/platform";
import {
  bindConsumerRepoSnapshot,
  createDb,
  createWardenCampaign,
  insertConnectedRepository,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  insertPrincipal,
  insertRepositorySnapshot,
  listAudit,
  listWardenCampaignTargets,
  resolveMissionForFettlerCampaign,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import type { InstallationRepository } from "@mendpoint/github";
import type { ApiEnv } from "./auth.js";
import { createWardenCampaignEnrollmentRoutes } from "./warden-campaign-enrollment.js";

const NOW = "2026-08-12T18:00:00.000Z";
const opened: Array<{ db: AppDb; root: string }> = [];

function mockRepo(id: number, name: string, extra: Partial<InstallationRepository> = {}): InstallationRepository {
  return Object.freeze({
    id,
    owner: "acme",
    name,
    fullName: `acme/${name}`,
    defaultBranch: "main",
    private: true,
    archived: false,
    disabled: false,
    ...extra,
  });
}

const CRAWL_REPOS: InstallationRepository[] = [
  mockRepo(200, "shop"),
  mockRepo(201, "docs"),
  mockRepo(202, "ghost"),
  mockRepo(203, "legacy", { archived: true }),
];

function eligibleRepo(db: AppDb, root: string, connectionId: string, id: string, remoteId: string, name: string, monitors: boolean) {
  const snapshotRoot = join(root, `snapshot-${id}`);
  mkdirSync(snapshotRoot);
  const repository = insertConnectedRepository(db, {
    id, tenantId: "tenant-a", connectionId, remoteId, owner: "acme", name,
    defaultBranch: "main", status: "ready", createdAt: NOW, updatedAt: NOW,
  });
  insertRepositorySnapshot(db, {
    id: `snapshot-${id}`, tenantId: "tenant-a", repositoryId: repository.id, requestedRef: "main",
    resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64), storagePath: snapshotRoot,
    createdAt: NOW, expiresAt: "2026-09-01T18:00:00.000Z",
  });
  insertConsumer(db, {
    id: `consumer-${id}`, name, githubOwner: "acme", githubRepo: name, tenantId: "tenant-a", createdAt: NOW,
  });
  insertConsumerRepo(db, { id: `consumer-repo-${id}`, consumerId: `consumer-${id}`, localPath: snapshotRoot, createdAt: NOW });
  bindConsumerRepoSnapshot(db, {
    tenantId: "tenant-a", consumerRepoId: `consumer-repo-${id}`, connectionId,
    connectedRepositoryId: repository.id, snapshotId: `snapshot-${id}`,
  });
  if (monitors) {
    insertMonitoredApi(db, { id: `monitor-${id}`, consumerId: `consumer-${id}`, providerId: "provider-stripe", detectionSource: "detected" });
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-enroll-api-"));
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'a', 'Tenant A', 'team', 'active', 10, ?)`).run(NOW);
  db.raw.prepare(`INSERT INTO providers (id, slug, name, created_at)
    VALUES ('provider-stripe', 'stripe', 'Stripe', ?)`).run(NOW);
  insertPrincipal(db, { id: "principal:tenant-a", tenantId: "tenant-a", kind: "human",
    subject: "owner@example.com", displayName: "Owner", createdAt: NOW });
  const connection = upsertScmConnection(db, {
    id: "connection-a", tenantId: "tenant-a", provider: "github", credentialRef: "github-app://installation/100",
    externalAccountId: "100", displayName: "Acme", createdAt: NOW, updatedAt: NOW,
  });
  eligibleRepo(db, root, connection.id, "repository-a", "200", "shop", true);
  eligibleRepo(db, root, connection.id, "repository-b", "201", "docs", false);
  createWardenCampaign(db, { id: "campaign-a", tenantId: "tenant-a", name: "Stripe upgrade",
    ownerPrincipalId: "principal:tenant-a", concurrencyLimit: 2, completionPolicy: "all",
    eventId: "ev-create", idempotencyKey: "create", correlationId: "corr", createdAt: NOW });

  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const tenantId = c.req.header("X-Test-Tenant");
    if (tenantId) {
      c.set("principal", { id: `human:${tenantId}`, tenantId, role: "owner" });
      c.set("tenantId", tenantId);
      c.set("trustPrincipalId", `principal:${tenantId}`);
      c.set("requestId", "request-a");
    }
    return next();
  });
  app.route("/warden/campaigns", createWardenCampaignEnrollmentRoutes({
    db, now: () => NOW, crawl: async () => CRAWL_REPOS,
  }));
  return { app, db };
}

afterEach(() => {
  for (const item of opened.splice(0)) { item.db.raw.close(); rmSync(item.root, { recursive: true, force: true }); }
});

function enroll(app: Hono<ApiEnv>, body: Record<string, unknown> = { providerSlug: "stripe", connectionId: "connection-a" }, tenant = "tenant-a") {
  return app.request("/warden/campaigns/campaign-a/enroll-org", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Tenant": tenant },
    body: JSON.stringify(body),
  });
}

type EnrollBody = {
  scanned: number;
  enrolled: Array<{ repositoryId: string; enrollmentSource: string; enrolledInstallationId: string | null }>;
  skipped: Array<{ remoteId: string; reason: string }>;
};

describe("Warden campaign org enrollment", () => {
  it("maps to plan execution authority and requires authentication", async () => {
    expect(permissionForRoute("POST", "/warden/campaigns/campaign-a/enroll-org")).toBe("plan:execute");
    const { app } = fixture();
    const unauth = await app.request("/warden/campaigns/campaign-a/enroll-org", { method: "POST" });
    expect(unauth.status).toBe(401);
  });

  it("enrolls eligible installation repos with provenance and skips the rest", async () => {
    const { app, db } = fixture();
    const response = await enroll(app);
    expect(response.status).toBe(200);
    const body = await response.json() as EnrollBody;
    expect(body.scanned).toBe(4);
    expect(body.enrolled).toHaveLength(1);
    expect(body.enrolled[0]).toMatchObject({
      repositoryId: "repository-a", enrollmentSource: "auto", enrolledInstallationId: "100",
    });
    const skips = Object.fromEntries(body.skipped.map((s) => [s.remoteId, s.reason]));
    expect(skips).toEqual({ "201": "not_provider_consumer", "202": "not_connected", "203": "archived" });

    const targets = listWardenCampaignTargets(db, "tenant-a", "campaign-a");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ repositoryId: "repository-a", enrollmentSource: "auto", enrolledInstallationId: "100" });
    expect(listAudit(db, "tenant-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "warden.campaign.org_enrolled", resource_id: "campaign-a", principal_id: "principal:tenant-a" }),
    ]));
  });

  it("is idempotent across re-scans", async () => {
    const { app, db } = fixture();
    expect((await enroll(app)).status).toBe(200);
    const second = await enroll(app);
    const body = await second.json() as EnrollBody;
    expect(body.enrolled).toHaveLength(0);
    expect(body.skipped.find((s) => s.remoteId === "200")?.reason).toBe("already_enrolled");
    expect(listWardenCampaignTargets(db, "tenant-a", "campaign-a")).toHaveLength(1);
  });

  it("creates and campaign-links a Fettler Mission on enrollment", async () => {
    const { app, db } = fixture();
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toBeUndefined();

    expect((await enroll(app)).status).toBe(200);

    const mission = resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a");
    expect(mission).toBeDefined();
    expect(mission).toMatchObject({
      product: "fettler",
      state: "created",
      fettlerCampaignId: "campaign-a",
      ownerPrincipalId: "principal:tenant-a",
    });

    // Idempotent: a second enrollment resolves the same Mission, not a new one.
    expect((await enroll(app)).status).toBe(200);
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")?.id).toBe(mission!.id);
  });

  it("fails closed on unknown provider, missing connection, and wrong tenant", async () => {
    const { app } = fixture();
    expect((await enroll(app, { providerSlug: "unknown", connectionId: "connection-a" })).status).toBe(404);
    expect((await enroll(app, { providerSlug: "stripe", connectionId: "missing" })).status).toBe(404);
    expect((await enroll(app, { providerSlug: "stripe", connectionId: "connection-a" }, "tenant-b")).status).toBe(404);
    expect((await enroll(app, { providerSlug: "stripe", connectionId: "connection-a", extra: 1 })).status).toBe(422);
  });
});
