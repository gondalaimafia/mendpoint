import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  getMissionPolicyEnvelope,
  insertPrincipal,
  resolveMissionForRegaugeCampaign,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { createTransformerMissionRoutes } from "./transformer-mission-routes.js";

const dirs: string[] = [];
const appDatabases: AppDb[] = [];

afterEach(() => {
  while (appDatabases.length) appDatabases.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(role: "engineer" | "viewer" = "engineer", trust = true) {
  const plan = vi.fn(() => ({ decision: "planned", blueprint: { id: "blueprint-a" } }));
  const launch = vi.fn(() => ({ campaignId: "mission-a", state: "running" }));
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "human:issuer|planner", tenantId: "tenant-a", role });
    if (trust) c.set("trustPrincipalId", "principal-planner");
    c.set("requestId", "request-a");
    await next();
  });
  app.route("/transformer/missions", createTransformerMissionRoutes({
    service: { plan, launch } as never,
    now: () => "2026-08-13T16:00:00.000Z",
  }));
  return { app, plan, launch };
}

describe("Transformer mission routes", () => {
  it("derives tenant, actor, campaign, time, and evidence outside the request body", async () => {
    const value = fixture();
    const response = await value.app.request("/transformer/missions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "plan-a" },
      body: JSON.stringify({
        tenantId: "tenant-b",
        campaignId: "attacker-campaign",
        organization: { id: "attacker" },
        repositoryIds: ["repo-a"],
        objective: {
          id: "upgrade-node",
          statement: "Upgrade Node 18 to Node 20.",
          sourceSystem: "node@18",
          targetSystem: "node@20",
          evidenceRefs: ["evidence:objective:a"],
          assumptions: [],
          risks: [],
        },
      }),
    });
    expect(response.status).toBe(201);
    expect(value.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        actorId: "human:issuer|planner",
        requestId: "request-a",
        idempotencyKey: "plan-a",
        evidenceRefs: ["trust-principal:principal-planner", "request:request-a"],
      }),
      expect.objectContaining({
        campaignId: expect.stringMatching(/^mission-[a-f0-9]{32}$/),
        evaluatedAt: "2026-08-13T16:00:00.000Z",
        repositoryIds: ["repo-a"],
      }),
    );
    expect(JSON.stringify(value.plan.mock.calls[0])).not.toContain("tenant-b");
    expect(JSON.stringify(value.plan.mock.calls[0])).not.toContain("attacker-campaign");
  });

  it("requires execute permission, durable identity, and idempotency before mutation", async () => {
    const viewer = fixture("viewer");
    expect((await viewer.app.request("/transformer/missions", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "x" }, body: "{}",
    })).status).toBe(403);
    expect(viewer.plan).not.toHaveBeenCalled();

    const missingTrust = fixture("engineer", false);
    expect((await missingTrust.app.request("/transformer/missions", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "x" }, body: "{}",
    })).status).toBe(401);
    expect(missingTrust.plan).not.toHaveBeenCalled();

    const missingKey = fixture();
    expect((await missingKey.app.request("/transformer/missions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(400);
    expect(missingKey.plan).not.toHaveBeenCalled();
  });

  it("launches only the tenant scoped reviewed campaign", async () => {
    const value = fixture();
    const response = await value.app.request("/transformer/missions/mission-a/launch", {
      method: "POST",
      headers: { "idempotency-key": "launch-a" },
    });
    expect(response.status).toBe(201);
    expect(value.launch).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", actorId: "human:issuer|planner" }),
      "mission-a",
    );
  });

  it("binds the App-DB Mission and default Policy Envelope on HTTP launch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-mission-launch-bind-"));
    dirs.push(dir);
    const appDb = createDb(join(dir, "app.sqlite"));
    appDatabases.push(appDb);
    const at = "2026-08-25T00:00:00.000Z";
    appDb.raw.prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-a','a','Tenant A','team','active',10,?)`,
    ).run(at);
    insertPrincipal(appDb, {
      id: "principal-planner",
      tenantId: "tenant-a",
      kind: "human",
      subject: "planner@example.com",
      displayName: "Planner",
      createdAt: at,
    });
    appDb.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('conn-a','tenant-a','github','me://ref','acct','GitHub',?,?)`).run(at, at);
    appDb.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-a','tenant-a','conn-a','1','acme','svc','main','main','production',30,'ready',?,?)`)
      .run(at, at);
    appDb.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-a','tenant-a','repo-a','main',?,?,'/tmp/snap-a','reject','reject','[]',1,?, '2026-09-01T00:00:00.000Z')`)
      .run("b".repeat(40), "c".repeat(64), at);

    const plan = vi.fn();
    const launch = vi.fn(() => ({
      campaignId: "mission-a",
      state: "running",
      units: [{
        id: "unit-a",
        snapshot: { repositoryId: "repo-a", snapshotId: "snapshot-a" },
      }],
    }));
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("principal", { id: "human:issuer|planner", tenantId: "tenant-a", role: "engineer" });
      c.set("trustPrincipalId", "principal-planner");
      c.set("requestId", "request-a");
      await next();
    });
    app.route("/regauge/missions", createTransformerMissionRoutes({
      service: { plan, launch } as never,
      now: () => at,
      appDb,
    }));

    const response = await app.request("/regauge/missions/mission-a/launch", {
      method: "POST",
      headers: { "idempotency-key": "launch-bind" },
    });
    expect(response.status).toBe(201);
    expect(launch).toHaveBeenCalled();

    const mission = resolveMissionForRegaugeCampaign(appDb, "tenant-a", "mission-a");
    expect(mission).toMatchObject({
      product: "regauge",
      state: "executing",
      ownerPrincipalId: "principal-planner",
      repositoryId: "repo-a",
      snapshotId: "snapshot-a",
      policyEnvelopeVersion: "1",
    });
    expect(getMissionPolicyEnvelope(appDb, "tenant-a", mission!.id)).not.toBeNull();
  });
});
