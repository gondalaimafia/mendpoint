import { createHash } from "node:crypto";
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
  getWardenCampaign,
  insertConnectedRepository,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  insertPrincipal,
  insertRepositorySnapshot,
  listAudit,
  listMissionTasks,
  listWardenCampaignTargets,
  fettlerCampaignMissionTaskId,
  putTenantMembership,
  resolveMissionForFettlerCampaign,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import {
  openGraphLearnDb,
  publishSoftwareGraphVersion,
  type SoftwareGraphPublicationV1,
} from "@mendpoint/graph-learn";
import type { InstallationRepository } from "@mendpoint/github";
import type { ApiEnv } from "./auth.js";
import { createWardenCampaignEnrollmentRoutes } from "./warden-campaign-enrollment.js";

const NOW = "2026-08-12T18:00:00.000Z";
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

// The strong-gate session the auth middleware exposes on the request context,
// mirroring apps/api/src/warden-campaign-create.test.ts. Enrolment now holds the
// same bar as creation, so its tests seed the same OIDC trust + membership shape.
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

function eligibleRepo(
  db: AppDb, root: string, tenantId: string, connectionId: string,
  id: string, remoteId: string, name: string, monitors: boolean,
) {
  const snapshotRoot = join(root, `snapshot-${id}`);
  mkdirSync(snapshotRoot);
  const repository = insertConnectedRepository(db, {
    id, tenantId, connectionId, remoteId, owner: "acme", name,
    defaultBranch: "main", status: "ready", createdAt: NOW, updatedAt: NOW,
  });
  insertRepositorySnapshot(db, {
    id: `snapshot-${id}`, tenantId, repositoryId: repository.id, requestedRef: "main",
    resolvedSha: "a".repeat(40), manifestSha256: "b".repeat(64), storagePath: snapshotRoot,
    createdAt: NOW, expiresAt: "2026-09-01T18:00:00.000Z",
  });
  insertConsumer(db, {
    id: `consumer-${id}`, name, githubOwner: "acme", githubRepo: name, tenantId, createdAt: NOW,
  });
  insertConsumerRepo(db, { id: `consumer-repo-${id}`, consumerId: `consumer-${id}`, localPath: snapshotRoot, createdAt: NOW });
  bindConsumerRepoSnapshot(db, {
    tenantId, consumerRepoId: `consumer-repo-${id}`, connectionId,
    connectedRepositoryId: repository.id, snapshotId: `snapshot-${id}`,
  });
  if (monitors) {
    insertMonitoredApi(db, { id: `monitor-${id}`, consumerId: `consumer-${id}`, providerId: "provider-stripe", detectionSource: "detected" });
  }
}

function baseDb() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-enroll-api-"));
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(`INSERT INTO providers (id, slug, name, created_at)
    VALUES ('provider-stripe', 'stripe', 'Stripe', ?)`).run(NOW);
  return { db, root };
}

function mountRoutes(db: AppDb, sessions: Record<string, Session>) {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const session = sessions[c.req.header("X-Test-Session") ?? ""];
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
  // Both aliases mount the SAME router instance, exactly as apps/api/src/server.ts
  // does, so a gate change cannot land on one path and miss the other.
  const routes = createWardenCampaignEnrollmentRoutes({ db, now: () => NOW, crawl: async () => CRAWL_REPOS });
  app.route("/fettler/campaigns", routes);
  app.route("/warden/campaigns", routes);
  return app;
}

function fixture(opts: {
  membershipStatus?: "active" | "offboarded";
  trustExpiresAt?: string | null;
  trustRevokedAt?: string | null;
} = {}) {
  const { db, root } = baseDb();
  seedTenant(db, "tenant-a", "writer-a", opts);
  const connection = upsertScmConnection(db, {
    id: "connection-a", tenantId: "tenant-a", provider: "github", credentialRef: "github-app://installation/100",
    externalAccountId: "100", displayName: "Acme", createdAt: NOW, updatedAt: NOW,
  });
  eligibleRepo(db, root, "tenant-a", connection.id, "repository-a", "200", "shop", true);
  eligibleRepo(db, root, "tenant-a", connection.id, "repository-b", "201", "docs", false);
  // Pre-created draft campaign owned by the same trust principal the strong
  // session presents, so autoEnrollWardenCampaignOrg's assertPrincipal is satisfied.
  createWardenCampaign(db, { id: "campaign-a", tenantId: "tenant-a", name: "Stripe upgrade",
    ownerPrincipalId: "trust-tenant-a-writer-a", concurrencyLimit: 2, completionPolicy: "all",
    eventId: "ev-create", idempotencyKey: "create", correlationId: "corr", createdAt: NOW });

  const sessions: Record<string, Session> = { "tenant-a": defaultSession("tenant-a", "writer-a") };
  const app = mountRoutes(db, sessions);
  return { app, db, sessions, root };
}

afterEach(() => {
  for (const item of opened.splice(0)) { item.db.raw.close(); rmSync(item.root, { recursive: true, force: true }); }
});

function enroll(
  app: Hono<ApiEnv>,
  body: Record<string, unknown> = { providerSlug: "stripe", connectionId: "connection-a" },
  session = "tenant-a",
  mount: "warden" | "fettler" = "warden",
) {
  return app.request(`/${mount}/campaigns/campaign-a/enroll-org`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Session": session },
    body: JSON.stringify(body),
  });
}

function startCampaign(
  app: Hono<ApiEnv>,
  session = "tenant-a",
  mount: "warden" | "fettler" = "fettler",
) {
  return app.request(`/${mount}/campaigns/campaign-a/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Session": session },
    body: JSON.stringify({
      ownerHandle: "@payments",
      source: {
        id: "source-a",
        tenantId: "tenant-a",
        sourceKind: "release",
        sourceUri: "https://provider.example/releases/2026-08",
        providerSlug: "stripe",
        sourceRevision: "2026-08",
        contentSha256: "a".repeat(64),
        contentType: "application/json",
        content: "{}",
        observedAt: NOW,
        capturedAt: NOW,
        capturedBy: "worker:catalog",
        taxonomyVersion: "2026-08-02",
        taxonomySignals: [],
        createdAt: NOW,
      },
      diffEntries: [{ op: "request_field_renamed", fromField: "amount_cents", toField: "amount" }],
    }),
  });
}

type EnrollBody = {
  campaignId: string;
  scanned: number;
  enrolled: Array<{ repositoryId: string; enrollmentSource: string; enrolledInstallationId: string | null }>;
  skipped: Array<{ remoteId: string; reason: string }>;
};

describe("Warden campaign org enrollment", () => {
  it("maps to plan execution authority and requires authentication", async () => {
    expect(permissionForRoute("POST", "/warden/campaigns/campaign-a/enroll-org")).toBe("plan:execute");
    expect(permissionForRoute("POST", "/fettler/campaigns/campaign-a/start")).toBe("plan:execute");
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
      expect.objectContaining({ action: "warden.campaign.org_enrolled", resource_id: "campaign-a", principal_id: "trust-tenant-a-writer-a" }),
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
    const mission = resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a");
    expect(listMissionTasks(db, "tenant-a", mission!.id)).toHaveLength(1);
  });

  it("creates and campaign-links an unscoped Fettler Mission on enrollment", async () => {
    const { app, db } = fixture();
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toBeUndefined();

    expect((await enroll(app)).status).toBe(200);

    const mission = resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a");
    expect(mission).toBeDefined();
    expect(mission).toMatchObject({
      product: "fettler",
      state: "created",
      fettlerCampaignId: "campaign-a",
      ownerPrincipalId: "trust-tenant-a-writer-a",
      graphVersionId: null,
      repositoryId: null,
      snapshotId: null,
    });

    expect(listMissionTasks(db, "tenant-a", mission!.id)).toEqual([
      expect.objectContaining({
        id: fettlerCampaignMissionTaskId(mission!.id, "repository-a"),
        taskType: "code_migration",
        status: "unassigned",
      }),
    ]);

    // Idempotent: a second enrollment resolves the same Mission, not a new one.
    expect((await enroll(app)).status).toBe(200);
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")?.id).toBe(mission!.id);
    expect(listMissionTasks(db, "tenant-a", mission!.id)).toHaveLength(1);
  });

  it("leaves mission repository and snapshot unbound when a later scan adds a repository", async () => {
    const { app, db } = fixture();
    expect((await enroll(app)).status).toBe(200);
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toMatchObject({
      repositoryId: null,
      snapshotId: null,
    });

    insertMonitoredApi(db, {
      id: "monitor-repository-b", consumerId: "consumer-repository-b",
      providerId: "provider-stripe", detectionSource: "detected",
    });
    expect((await enroll(app)).status).toBe(200);
    expect(listWardenCampaignTargets(db, "tenant-a", "campaign-a")).toHaveLength(2);
    const mission = resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a");
    expect(mission).toMatchObject({ repositoryId: null, snapshotId: null });
    expect((await startCampaign(app)).status).toBe(200);
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toMatchObject({
      repositoryId: null,
      snapshotId: null,
    });
  });

  it("pins a published Change Graph version on a single-repo enrollment", async () => {
    const { app, db, root } = fixture();
    const graphPath = join(root, "graph-learn.sqlite");
    const graphDb = openGraphLearnDb(graphPath);
    const extractor = Object.freeze({
      id: "mendpoint.code-index",
      version: "1.0.0",
      digest: `sha256:${"1".repeat(64)}`,
    });
    const publication: SoftwareGraphPublicationV1 = {
      schemaVersion: "mendpoint.software-graph.v1",
      tenantId: "tenant-a",
      repositoryId: "repository-a",
      repositorySnapshotId: "snapshot-repository-a",
      repositoryRevision: "a".repeat(40),
      providerId: "provider-stripe",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
      observedAt: "2026-08-17T12:00:00.000Z",
      entities: [{
        id: "endpoint:charges-create",
        kind: "endpoint",
        canonicalKey: "POST /v1/charges",
        aliases: ["charges.create"],
        label: "POST /v1/charges",
        scope: "provider",
        evidenceRefs: ["artifact:openapi:v1"],
        extractor,
        derivation: "provider_spec",
        confidenceBasis: "deterministic_exact",
        status: "active",
        validFrom: "2026-08-17T12:00:00.000Z",
      }],
      relationships: [],
      coverage: ([
        "repository_discovery",
        "language_parsing",
        "provider_specification",
        "sdk_resolution",
        "call_resolution",
        "test_resolution",
      ] as const).map((stage) => ({
        extractor,
        stage,
        basis: "complete" as const,
        analyzed: 1,
        omitted: 0,
        evidenceRefs: [`evidence:${stage}`],
      })),
    };
    const published = publishSoftwareGraphVersion(graphDb, publication);
    graphDb.raw.close();

    const previous = process.env.GRAPH_LEARN_DB;
    process.env.GRAPH_LEARN_DB = graphPath;
    try {
      expect((await enroll(app)).status).toBe(200);
      const mission = resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a");
      expect(mission?.graphVersionId).toBe(published.versionId);
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  });

  it("POST /fettler/campaigns/:id/start plans a conservative rollout and marks the campaign running", async () => {
    const { app, db } = fixture();
    expect((await enroll(app)).status).toBe(200);
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toMatchObject({
      repositoryId: null,
      snapshotId: null,
    });

    const res = await startCampaign(app);
    expect(res.status).toBe(200);
    const body = await res.json() as { campaignId: string; status: string; jobIds: string[]; rolloutDecisionId: string };
    expect(body).toMatchObject({
      campaignId: "campaign-a",
      status: "running",
      rolloutDecisionId: "rollout-campaign-a",
    });
    expect(body.jobIds).toHaveLength(1);
    expect(getWardenCampaign(db, "tenant-a", "campaign-a")?.status).toBe("running");
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toMatchObject({
      repositoryId: "repository-a",
      snapshotId: "snapshot-repository-a",
    });
    expect(listAudit(db, "tenant-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "warden.campaign.started", resource_id: "campaign-a" }),
    ]));
  });

  it("POST /fettler/campaigns/:id/start is a no-op when the campaign is already running", async () => {
    const { app, db } = fixture();
    expect((await enroll(app)).status).toBe(200);
    expect((await startCampaign(app)).status).toBe(200);
    const first = resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a");
    const second = await startCampaign(app);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      campaignId: "campaign-a",
      status: "running",
      jobIds: [],
      rolloutDecisionId: "rollout-campaign-a",
    });
    expect(resolveMissionForFettlerCampaign(db, "tenant-a", "campaign-a")).toMatchObject({
      id: first?.id,
      repositoryId: "repository-a",
      snapshotId: "snapshot-repository-a",
      revision: first?.revision,
    });
  });

  it("fails closed on unknown provider, missing connection, and unknown fields", async () => {
    const { app } = fixture();
    expect((await enroll(app, { providerSlug: "unknown", connectionId: "connection-a" })).status).toBe(404);
    expect((await enroll(app, { providerSlug: "stripe", connectionId: "missing" })).status).toBe(404);
    expect((await enroll(app, { providerSlug: "stripe", connectionId: "connection-a", extra: 1 })).status).toBe(422);
  });

  // --- Authorization gate: raised to match campaign creation (PR #286). ---
  // Each test below fails (enrolment would 200) if the corresponding control in
  // authorizeCampaignWriter / reverifyCampaignWriter is removed.

  it("refuses a caller without OIDC (403)", async () => {
    // Control: authorizeCampaignWriter's `authMethod !== "oidc"` check.
    const { app, sessions } = fixture();
    sessions["tenant-a"].authMethod = "api_key";
    expect((await enroll(app)).status).toBe(403);
  });

  it("refuses an API-key principal (403)", async () => {
    // Control: isHumanWardenReviewer's apiKeyId rejection inside authorizeCampaignWriter.
    const { app, sessions } = fixture();
    sessions["tenant-a"].apiKeyId = "key-1";
    expect((await enroll(app)).status).toBe(403);
  });

  it("refuses when the request carries the wrong membership evidence (403)", async () => {
    // Control: authorizeCampaignWriter's membershipEvidenceId equality check.
    const { app, sessions } = fixture();
    sessions["tenant-a"].membershipEvidenceId = evidenceId("tenant-a", ISSUER, "someone-else");
    expect((await enroll(app)).status).toBe(403);
  });

  it("refuses when the tenant membership is not active (403)", async () => {
    // Control: authorizeCampaignWriter's active-membership check.
    const { app, db } = fixture();
    putTenantMembership(db, {
      tenantId: "tenant-a", issuer: ISSUER, subject: "writer-a", email: "writer-a@example.com",
      displayName: "Writer", role: "owner", status: "offboarded", updatedAt: "2026-08-12T19:00:00.000Z",
    });
    expect((await enroll(app)).status).toBe(403);
  });

  it("refuses an expired trust principal the weaker gate would have admitted (403)", async () => {
    // Control the OLD gate missed entirely: reverifyCampaignWriter's expiry check.
    // The trust principal is a valid human with active membership and matching
    // evidence, so the entry gate admits it; only the expiry re-check refuses.
    const { app, db } = fixture({ trustExpiresAt: "2020-01-01T00:00:00.000Z" });
    expect((await enroll(app)).status).toBe(403);
    // Fail closed: nothing was enrolled.
    expect(listWardenCampaignTargets(db, "tenant-a", "campaign-a")).toHaveLength(0);
  });

  it("enforces the same gate on the /fettler/ and /warden/ aliases", async () => {
    // Both mounts share one router instance; a strong session succeeds on each,
    // and the same OIDC-less session is refused on each. If only one alias were
    // strengthened this test would show a 200 on the unguarded path.
    const good = fixture();
    expect((await enroll(good.app, undefined, "tenant-a", "fettler")).status).toBe(200);

    const alsoGood = fixture();
    expect((await enroll(alsoGood.app, undefined, "tenant-a", "warden")).status).toBe(200);

    const badF = fixture();
    badF.sessions["tenant-a"].authMethod = "api_key";
    expect((await enroll(badF.app, undefined, "tenant-a", "fettler")).status).toBe(403);

    const badW = fixture();
    badW.sessions["tenant-a"].authMethod = "api_key";
    expect((await enroll(badW.app, undefined, "tenant-a", "warden")).status).toBe(403);
  });

  it("isolates tenants: a valid writer cannot enrol into another tenant's campaign (404)", async () => {
    // Control: autoEnrollWardenCampaignOrg scoping the campaign to the caller's
    // tenant, indistinguishable from a nonexistent campaign.
    const { app, db, sessions, root } = fixture();
    seedTenant(db, "tenant-b", "writer-b");
    const connectionB = upsertScmConnection(db, {
      id: "connection-b", tenantId: "tenant-b", provider: "github", credentialRef: "github-app://installation/200",
      externalAccountId: "200", displayName: "Beta", createdAt: NOW, updatedAt: NOW,
    });
    eligibleRepo(db, root, "tenant-b", connectionB.id, "repository-b-shop", "200", "shop", true);
    sessions["tenant-b"] = defaultSession("tenant-b", "writer-b");

    // tenant-b is a fully authorized writer, but campaign-a is tenant-a's.
    const cross = await enroll(app, { providerSlug: "stripe", connectionId: "connection-b" }, "tenant-b");
    expect(cross.status).toBe(404);
    expect(getWardenCampaign(db, "tenant-b", "campaign-a")).toBeUndefined();
  });

  it("lets a strong-gated caller create then enrol into the same campaign end to end", async () => {
    // The success path the gate must not block: create via POST / then enrol into
    // exactly the id that was created.
    const { app, db } = fixture();
    const key = "enroll-e2e-0001";
    const expectedId = campaignIdFor("tenant-a", key);

    const created = await app.request("/warden/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Session": "tenant-a", "Idempotency-Key": key },
      body: JSON.stringify({ name: "End to end", concurrencyLimit: 1, completionPolicy: "all" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json() as { campaignId: string }).campaignId).toBe(expectedId);

    const enrolled = await app.request(`/fettler/campaigns/${expectedId}/enroll-org`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Session": "tenant-a" },
      body: JSON.stringify({ providerSlug: "stripe", connectionId: "connection-a" }),
    });
    expect(enrolled.status).toBe(200);
    const body = await enrolled.json() as EnrollBody;
    expect(body.campaignId).toBe(expectedId);
    expect(body.enrolled).toHaveLength(1);
    expect(listWardenCampaignTargets(db, "tenant-a", expectedId)).toHaveLength(1);
  });
});
