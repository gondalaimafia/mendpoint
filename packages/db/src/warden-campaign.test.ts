import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  claimReadyWardenTargets,
  createDb,
  createWardenCampaign,
  insertPrincipal,
  listDomainEvents,
  planWardenRollback,
  transitionWardenCampaign,
  transitionWardenTarget,
  type AppDb,
} from "./index.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-"));
  const db = createDb(join(dir, "warden.sqlite")); opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, '2026-01-01T00:00:00.000Z'),
           ('t2', 'two', 'Two', 'team', 'active', 10, '2026-01-01T00:00:00.000Z')`).run();
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: "2026-01-01T00:00:00.000Z" });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com",
    displayName: "Two", createdAt: "2026-01-01T00:00:00.000Z" });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('c1', 't1', 'local_git', 'ref', 'acct', 'Local', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  for (const id of ["r1", "r2", "r3"]) {
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment,
       retention_days, status, created_at, updated_at)
      VALUES (?, 't1', 'c1', ?, 'owner', ?, 'main', 'main', 'test', 30, 'ready',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(id, id, id);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, created_at, expires_at)
      VALUES (?, 't1', ?, 'main', ?, ?, ?, 'reject', 'reject', '[]',
       '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`).run(`s${id.slice(1)}`, id,
        id.repeat(40).slice(0, 40), id.repeat(64).slice(0, 64), `C:/tmp/${id}`);
  }
  return db;
}
afterEach(() => { for (const { db, dir } of opened.splice(0)) { db.raw.close(); rmSync(dir, { recursive: true, force: true }); } });

function create(db: AppDb) {
  return createWardenCampaign(db, { id: "campaign", tenantId: "t1", name: "Payments upgrade",
    ownerPrincipalId: "p1", concurrencyLimit: 1, completionPolicy: "all", eventId: "event-create",
    idempotencyKey: "create", correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" });
}
function add(db: AppDb, id: string, repositoryId: string, dependsOn: string[] = []) {
  return addWardenCampaignTarget(db, { id, tenantId: "t1", campaignId: "campaign", repositoryId,
    snapshotId: `s${repositoryId.slice(1)}`, ownerPrincipalId: "p1", dependsOn,
    eventId: `event-${id}`, idempotencyKey: `add-${id}`, correlationId: "corr",
    createdAt: `2026-01-01T00:00:0${id.slice(1)}.000Z` });
}
function move(db: AppDb, id: string, revision: number, from: Parameters<typeof transitionWardenTarget>[1]["from"],
  to: Parameters<typeof transitionWardenTarget>[1]["to"], extra: Record<string, unknown> = {}) {
  return transitionWardenTarget(db, { tenantId: "t1", campaignId: "campaign", targetId: id,
    expectedRevision: revision, from, to, actorPrincipalId: "p1", eventId: `event-${id}-${revision}`,
    idempotencyKey: `move-${id}-${revision}`, correlationId: "corr", createdAt: `2026-01-02T00:00:0${revision}.000Z`, ...extra });
}

describe("warden campaign control plane", () => {
  it("persists dependency ordered work with concurrency and revision fencing", () => {
    const db = fixture(); const campaign = create(db);
    expect(() => createWardenCampaign(db, { id: "bad", tenantId: "t1", name: "Bad", ownerPrincipalId: "p2",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "bad-event", idempotencyKey: "bad",
      correlationId: "bad", createdAt: campaign.createdAt })).toThrow("warden_principal_tenant_mismatch");
    add(db, "target1", "r1"); add(db, "target2", "r2", ["target1"]); add(db, "target3", "r3", ["target1"]);
    expect(() => add(db, "cycle", "r3", ["cycle"])).toThrow("warden_dependency_cycle");
    const running = transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "running", actorPrincipalId: "p1", eventId: "event-run", idempotencyKey: "run", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(claimReadyWardenTargets(db, "t1", "campaign").map((item) => item.id)).toEqual(["target1"]);
    expect(() => transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "paused", actorPrincipalId: "p1", eventId: "stale", idempotencyKey: "stale", correlationId: "corr",
      createdAt: running.updatedAt })).toThrow("warden_revision_conflict");
    move(db, "target1", 1, "queued", "analyzing");
    expect(claimReadyWardenTargets(db, "t1", "campaign")).toEqual([]);
    move(db, "target1", 2, "analyzing", "editing");
    move(db, "target1", 3, "editing", "verifying");
    expect(() => move(db, "target1", 4, "verifying", "review")).toThrow("warden_pr_package_required");
    db.raw.prepare(`INSERT INTO artifact_manifests
      (id, tenant_id, kind, schema_version, sha256, media_type, size_bytes, storage_ref, created_at)
      VALUES ('package1', 't1', 'warden-pr-package', 1, ?, 'application/json', 1, 'db:package1',
       '2026-01-02T00:00:00.000Z')`).run("a".repeat(64));
    move(db, "target1", 4, "verifying", "review", { packageArtifactId: "package1" });
    move(db, "target1", 5, "review", "delivering"); move(db, "target1", 6, "delivering", "completed");
    expect(claimReadyWardenTargets(db, "t1", "campaign").map((item) => item.id)).toEqual(["target2"]);
    expect(listDomainEvents(db, "t1", "warden_campaign", "campaign").length).toBe(11);
  });

  it("plans rollback in reverse dependency order", () => {
    const db = fixture(); create(db); add(db, "target1", "r1"); add(db, "target2", "r2", ["target1"]);
    transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "running", actorPrincipalId: "p1", eventId: "run", idempotencyKey: "run", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    db.raw.prepare(`UPDATE warden_campaign_targets SET stage = 'completed' WHERE campaign_id = 'campaign'`).run();
    expect(planWardenRollback(db, "t1", "campaign").map((item) => item.id)).toEqual(["target2", "target1"]);
  });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
