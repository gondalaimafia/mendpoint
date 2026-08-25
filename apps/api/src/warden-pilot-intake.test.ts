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
  getJob,
  insertConnectedRepository,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  insertTenant,
  listAudit,
  listJobs,
  putTenantMembership,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { createWardenPilotIntakeRoutes } from "./warden-pilot-intake.js";

const NOW = "2026-08-10T18:00:00.000Z";
const ISSUER = "https://identity.example.com";
const opened: Array<{ db: AppDb; root: string }> = [];

function membershipEvidenceId(tenantId: string, subject: string): string {
  return `membership:${createHash("sha256")
    .update(`${tenantId}\n${ISSUER}\n${subject}`, "utf8")
    .digest("hex")}`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-pilot-api-"));
  const snapshotRoot = join(root, "snapshot");
  mkdirSync(snapshotRoot);
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: NOW });
  insertPrincipal(db, { id: "principal:tenant-a", tenantId: "tenant-a", kind: "human",
    subject: `${ISSUER}|owner`, displayName: "Owner", audience: ISSUER, createdAt: NOW });
  putTenantMembership(db, { tenantId: "tenant-a", issuer: ISSUER, subject: "owner",
    email: "owner@example.com", displayName: "Owner", role: "owner", status: "active", updatedAt: NOW });
  db.raw.prepare(`INSERT INTO providers (id, slug, name, created_at)
    VALUES ('provider-stripe', 'stripe', 'Stripe', ?)`)
    .run(NOW);
  insertConsumer(db, {
    id: "consumer-a",
    name: "Customer API",
    githubOwner: "acme",
    githubRepo: "customer-api",
    tenantId: "tenant-a",
    createdAt: NOW,
  });
  insertMonitoredApi(db, {
    id: "monitor-a",
    consumerId: "consumer-a",
    providerId: "provider-stripe",
    detectionSource: "approved_pilot",
  });
  const connection = upsertScmConnection(db, {
    id: "connection-a",
    tenantId: "tenant-a",
    provider: "github",
    credentialRef: "github-app://installation/100",
    externalAccountId: "100",
    displayName: "Acme",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const repository = insertConnectedRepository(db, {
    id: "repository-a",
    tenantId: "tenant-a",
    connectionId: connection.id,
    remoteId: "200",
    owner: "acme",
    name: "customer-api",
    defaultBranch: "main",
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  });
  insertRepositorySnapshot(db, {
    id: "snapshot-a",
    tenantId: "tenant-a",
    repositoryId: repository.id,
    requestedRef: "main",
    resolvedSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    storagePath: snapshotRoot,
    createdAt: NOW,
    expiresAt: "2026-08-11T18:00:00.000Z",
  });
  insertRepositorySnapshotPolicy(db, {
    id: "policy-a",
    tenantId: "tenant-a",
    snapshotId: "snapshot-a",
    codeowners: [],
    ciFiles: ["check.mjs"],
    verificationCommands: ["node check.mjs"],
    protectedBranch: { name: "main", exactCommit: "a".repeat(40) },
    createdAt: NOW,
  });
  insertConsumerRepo(db, {
    id: "consumer-repo-a",
    consumerId: "consumer-a",
    localPath: snapshotRoot,
    createdAt: NOW,
  });
  bindConsumerRepoSnapshot(db, {
    tenantId: "tenant-a",
    consumerRepoId: "consumer-repo-a",
    connectionId: connection.id,
    connectedRepositoryId: repository.id,
    snapshotId: "snapshot-a",
  });

  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const tenantId = c.req.header("X-Test-Tenant");
    if (tenantId) {
      c.set("principal", { id: "human:owner@example.com", tenantId, role: "owner" });
      c.set("tenantId", tenantId);
      c.set("trustPrincipalId", `principal:${tenantId}`);
      c.set("authMethod", c.req.header("X-Test-Auth-Method") === "api_key" ? "api_key" : "oidc");
      c.set("membershipEvidenceId", c.req.header("X-Test-Membership-Evidence") ??
        membershipEvidenceId(tenantId, "owner"));
      if (c.req.header("X-Test-Api-Key")) c.set("apiKeyId", "api-key-a");
      c.set("requestId", "request-a");
    }
    return next();
  });
  // Mirror server.ts: the same intake instance is mounted under the Fettler
  // canonical prefix and the legacy /warden alias.
  const pilotRoutes = createWardenPilotIntakeRoutes({
    db,
    now: () => NOW,
  });
  app.route("/fettler/pilot", pilotRoutes);
  app.route("/warden/pilot", pilotRoutes);
  return { app, db };
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.raw.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

function request(app: Hono<ApiEnv>, body: Record<string, unknown>, key = "pilot-request-0001",
  headers: Readonly<Record<string, string>> = {}) {
  return app.request("/warden/pilot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-Test-Tenant": "tenant-a",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("Warden pilot intake", () => {
  it("uses plan execution authority and queues one replay-safe server-owned fanout", async () => {
    expect(permissionForRoute("POST", "/warden/pilot")).toBe("plan:execute");
    const { app, db } = fixture();
    expect((await app.request("/warden/pilot", { method: "POST" })).status).toBe(401);

    const first = await request(app, { providerSlug: "stripe", consumerId: "consumer-a" });
    const replay = await request(app, { providerSlug: "stripe", consumerId: "consumer-a" });
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    const firstBody = await first.json() as { jobId: string; replayed: boolean };
    const replayBody = await replay.json() as { jobId: string; replayed: boolean };
    expect(firstBody).toMatchObject({ replayed: false });
    expect(replayBody).toEqual({ ...firstBody, replayed: true });
    expect(listJobs(db, 20, "tenant-a")).toHaveLength(1);
    expect(JSON.parse(getJob(db, firstBody.jobId, "tenant-a")!.payload_json)).toEqual({
      providerSlug: "stripe",
      consumerIds: ["consumer-a"],
      wardenPilot: true,
    });
    expect(listAudit(db, "tenant-a")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "warden.pilot.requested",
        resource_id: firstBody.jobId,
        principal_id: "principal:tenant-a",
        request_id: "request-a",
      }),
    ]));
  });

  it("rejects caller-authored execution authority and idempotency reuse with different input", async () => {
    const { app, db } = fixture();
    for (const field of [
      "allowedChangedPaths",
      "verifyCommand",
      "useLlm",
      "allowNetwork",
      "snapshotId",
      "budgetUsd",
      "deliveryMode",
    ]) {
      const response = await request(app, {
        providerSlug: "stripe",
        consumerId: "consumer-a",
        [field]: field === "allowedChangedPaths" ? ["src/client.ts"] : "caller-value",
      }, `pilot-forbidden-${field}`);
      expect(response.status, field).toBe(422);
    }
    expect(listJobs(db, 20, "tenant-a")).toHaveLength(0);

    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-conflict-01")).status)
      .toBe(202);
    const conflict = await request(app, { providerSlug: "other", consumerId: "consumer-a" }, "pilot-conflict-01");
    expect(conflict.status).toBe(409);
    expect(listJobs(db, 20, "tenant-a")).toHaveLength(1);
  });

  it("fails closed for another tenant, an unmonitored provider, or an incomplete snapshot binding", async () => {
    const { app, db } = fixture();
    const crossTenant = await app.request("/warden/pilot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "pilot-cross-tenant",
        "X-Test-Tenant": "tenant-b",
      },
      body: JSON.stringify({ providerSlug: "stripe", consumerId: "consumer-a" }),
    });
    expect(crossTenant.status).toBe(403);

    db.raw.prepare("DELETE FROM monitored_apis WHERE consumer_id = 'consumer-a'").run();
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-unmonitored")).status)
      .toBe(409);
    db.raw.prepare("UPDATE consumer_repos SET snapshot_id = NULL WHERE consumer_id = 'consumer-a'").run();
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-unbound")).status)
      .toBe(409);
    expect(listJobs(db, 20, "tenant-a")).toHaveLength(0);
  });

  it("requires OIDC, a current human trust principal, and matching active membership", async () => {
    const { app, db } = fixture();
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-api-key",
      { "X-Test-Api-Key": "1" })).status).toBe(403);
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-auth-method",
      { "X-Test-Auth-Method": "api_key" })).status).toBe(403);
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-membership",
      { "X-Test-Membership-Evidence": "membership:wrong" })).status).toBe(403);
    db.raw.prepare("UPDATE principals SET revoked_at = ? WHERE tenant_id = ? AND id = ?")
      .run(NOW, "tenant-a", "principal:tenant-a");
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-revoked"))
      .status).toBe(403);
    db.raw.prepare("UPDATE principals SET revoked_at = NULL WHERE tenant_id = ? AND id = ?")
      .run("tenant-a", "principal:tenant-a");
    putTenantMembership(db, { tenantId: "tenant-a", issuer: ISSUER, subject: "owner",
      email: "owner@example.com", displayName: "Owner", role: "owner", status: "offboarded",
      updatedAt: "2026-08-10T18:00:01.000Z" });
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-offboarded"))
      .status).toBe(403);
    putTenantMembership(db, { tenantId: "tenant-a", issuer: ISSUER, subject: "owner",
      email: "owner@example.com", displayName: "Owner", role: "owner", status: "active",
      updatedAt: "2026-08-10T18:00:02.000Z" });
    db.raw.prepare("UPDATE principals SET expires_at = ? WHERE tenant_id = ? AND id = ?")
      .run(NOW, "tenant-a", "principal:tenant-a");
    expect((await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-expired"))
      .status).toBe(403);
    expect(listJobs(db, 20, "tenant-a")).toHaveLength(0);
  });
});

describe("Fettler pilot intake mirrors the legacy /warden alias", () => {
  function fettlerRequest(app: Hono<ApiEnv>, body: Record<string, unknown>, key = "pilot-request-fettler") {
    return app.request("/fettler/pilot", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        "X-Test-Tenant": "tenant-a",
      },
      body: JSON.stringify(body),
    });
  }

  it("resolves to the same permission on the canonical and legacy paths", () => {
    expect(permissionForRoute("POST", "/fettler/pilot")).toBe("plan:execute");
    expect(permissionForRoute("POST", "/fettler/pilot")).toBe(
      permissionForRoute("POST", "/warden/pilot"),
    );
  });

  it("shares one handler: a canonical create replays through the legacy alias", async () => {
    const { app, db } = fixture();
    const canonical = await fettlerRequest(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-shared");
    expect(canonical.status).toBe(202);
    const canonicalBody = await canonical.json() as { jobId: string; replayed: boolean };
    expect(canonicalBody).toMatchObject({ replayed: false });

    // Same idempotency key through the legacy /warden alias returns the identical job.
    const replay = await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-shared");
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ ...canonicalBody, replayed: true });
    expect(listJobs(db, 20, "tenant-a")).toHaveLength(1);
  });

  it("keeps the legacy /warden alias working", async () => {
    const { app } = fixture();
    const legacy = await request(app, { providerSlug: "stripe", consumerId: "consumer-a" }, "pilot-legacy");
    expect(legacy.status).toBe(202);
    expect(await legacy.json()).toMatchObject({ replayed: false });
  });

  it("rejects unauthenticated calls identically on the canonical and legacy paths", async () => {
    const { app } = fixture();
    const canonical = await app.request("/fettler/pilot", { method: "POST" });
    const legacy = await app.request("/warden/pilot", { method: "POST" });
    expect(canonical.status).toBe(401);
    expect(legacy.status).toBe(401);
  });
});
