import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  autoEnrollWardenCampaignOrg,
  createDb,
  createWardenCampaign,
  insertPrincipal,
  listWardenCampaignTargets,
  transitionWardenCampaign,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

function connection(db: AppDb, id: string, installationId: string) {
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES (?, 't1', 'github', 'me://ref', ?, 'Acme', ?, ?)`).run(id, installationId, T0, T0);
}

function repo(db: AppDb, id: string, connectionId: string, remoteId: string, opts: {
  snapshot?: boolean; monitors?: boolean;
} = {}) {
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment,
     retention_days, status, created_at, updated_at)
    VALUES (?, 't1', ?, ?, 'acme', ?, 'main', 'main', 'production', 30, 'ready', ?, ?)`)
    .run(id, connectionId, remoteId, id, T0, T0);
  if (opts.snapshot !== false) {
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES (?, 't1', ?, 'main', ?, ?, ?, 'reject', 'reject', '[]', 1, ?, '2026-02-01T00:00:00.000Z')`)
      .run(`snap_${id}`, id, "a".repeat(40), "b".repeat(64), `C:/tmp/${id}`, T0);
  }
  if (opts.monitors) {
    db.raw.prepare(`INSERT INTO consumers
      (id, name, github_owner, github_repo, installation_id, github_delivery_mode, tenant_id, created_at)
      VALUES (?, ?, 'acme', ?, '55', 'app', 't1', ?)`).run(`cons_${id}`, id, id, T0);
    db.raw.prepare(`INSERT INTO consumer_repos
      (id, consumer_id, local_path, default_branch, connected_repository_id, snapshot_id, exact_commit, created_at)
      VALUES (?, ?, ?, 'main', ?, ?, ?, ?)`)
      .run(`crepo_${id}`, `cons_${id}`, `C:/tmp/${id}`, id, `snap_${id}`, "a".repeat(40), T0);
    db.raw.prepare(`INSERT INTO monitored_apis (id, consumer_id, provider_id, detection_source)
      VALUES (?, ?, 'prov_payments', 'detected')`).run(`mon_${id}`, `cons_${id}`);
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-org-"));
  const db = createDb(join(dir, "warden.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, ?)`).run(T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: T0 });
  db.raw.prepare(`INSERT INTO providers (id, slug, name, created_at)
    VALUES ('prov_payments', 'payments', 'Payments', ?)`).run(T0);
  connection(db, "gh55", "55");
  connection(db, "gh77", "77");
  repo(db, "shop", "gh55", "101", { snapshot: true, monitors: true });
  repo(db, "billing", "gh55", "102", { snapshot: true, monitors: true });
  repo(db, "web", "gh55", "103", { snapshot: true, monitors: true });
  repo(db, "api", "gh55", "104", { snapshot: true, monitors: true });
  repo(db, "docs", "gh55", "105", { snapshot: true, monitors: false });
  repo(db, "legacy", "gh55", "106", { snapshot: false, monitors: true });
  repo(db, "other", "gh77", "201", { snapshot: true, monitors: true });
  createWardenCampaign(db, { id: "campaign", tenantId: "t1", name: "Payments upgrade",
    ownerPrincipalId: "p1", concurrencyLimit: 2, completionPolicy: "all", eventId: "ev-create",
    idempotencyKey: "create", correlationId: "corr", createdAt: T0 });
  return db;
}

const candidate = (remoteId: string, name: string, extra: Partial<{ archived: boolean; disabled: boolean }> = {}) =>
  ({ remoteId, owner: "acme", name, archived: false, disabled: false, ...extra });

const CANDIDATES = [
  candidate("101", "shop"),
  candidate("102", "billing"),
  candidate("103", "web", { archived: true }),
  candidate("104", "api", { disabled: true }),
  candidate("105", "docs"),
  candidate("106", "legacy"),
  candidate("201", "other"),
  candidate("999", "ghost"),
];

function enroll(db: AppDb, at = T0) {
  return autoEnrollWardenCampaignOrg(db, {
    tenantId: "t1", campaignId: "campaign", providerSlug: "payments", installationId: "55",
    ownerPrincipalId: "p1", accessibleRepositories: CANDIDATES, correlationId: "corr", createdAt: at,
  });
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) { db.raw.close(); rmSync(dir, { recursive: true, force: true }); }
});

describe("warden org auto-enrollment", () => {
  it("enrolls eligible installation repos and records provenance, skipping the rest", () => {
    const db = fixture();
    const result = enroll(db);
    expect(result.scanned).toBe(8);
    expect(result.enrolled.map((t) => t.repositoryId).sort()).toEqual(["billing", "shop"]);
    for (const target of result.enrolled) {
      expect(target.enrollmentSource).toBe("auto");
      expect(target.enrolledInstallationId).toBe("55");
      expect(target.stage).toBe("queued");
    }
    const skips = Object.fromEntries(result.skipped.map((s) => [s.remoteId, s.reason]));
    expect(skips).toEqual({
      "103": "archived",
      "104": "disabled",
      "105": "not_provider_consumer",
      "106": "snapshot_missing",
      "201": "not_connected",
      "999": "not_connected",
    });
    const targets = listWardenCampaignTargets(db, "t1", "campaign");
    expect(targets.map((t) => t.repositoryId).sort()).toEqual(["billing", "shop"]);
    expect(targets.every((t) => t.enrollmentSource === "auto")).toBe(true);
  });

  it("is idempotent: a re-scan enrolls no duplicates", () => {
    const db = fixture();
    const first = enroll(db);
    expect(first.enrolled).toHaveLength(2);
    const second = enroll(db, "2026-01-01T01:00:00.000Z");
    expect(second.enrolled).toHaveLength(0);
    expect(second.skipped.filter((s) => s.reason === "already_enrolled").map((s) => s.remoteId).sort())
      .toEqual(["101", "102"]);
    expect(listWardenCampaignTargets(db, "t1", "campaign")).toHaveLength(2);
  });

  it("never enrolls repos outside the installation's granted access", () => {
    const db = fixture();
    const result = enroll(db);
    // "other" (remote 201) is connected under installation 77, not 55.
    expect(result.enrolled.some((t) => t.repositoryId === "other")).toBe(false);
    expect(result.skipped.find((s) => s.remoteId === "201")?.reason).toBe("not_connected");
  });

  it("keeps manual enrollment provenance distinct from auto", () => {
    const db = fixture();
    const manual = addWardenCampaignTarget(db, { id: "manual-target", tenantId: "t1", campaignId: "campaign",
      repositoryId: "docs", snapshotId: "snap_docs", ownerPrincipalId: "p1", eventId: "ev-manual",
      idempotencyKey: "manual", correlationId: "corr", createdAt: T0 });
    expect(manual.enrollmentSource).toBe("manual");
    expect(manual.enrolledInstallationId).toBeNull();
    const result = enroll(db);
    // docs is now enrolled (manually) so auto skips it as already_enrolled.
    expect(result.skipped.find((s) => s.remoteId === "105")?.reason).toBe("already_enrolled");
    expect(result.enrolled.map((t) => t.repositoryId).sort()).toEqual(["billing", "shop"]);
  });

  it("rejects unknown providers, non-draft campaigns, and disconnected installations", () => {
    const db = fixture();
    expect(() => autoEnrollWardenCampaignOrg(db, { tenantId: "t1", campaignId: "campaign",
      providerSlug: "unknown", installationId: "55", ownerPrincipalId: "p1",
      accessibleRepositories: [], correlationId: "corr", createdAt: T0 }))
      .toThrow("warden_org_provider_unknown");
    expect(() => autoEnrollWardenCampaignOrg(db, { tenantId: "t1", campaignId: "campaign",
      providerSlug: "payments", installationId: "999", ownerPrincipalId: "p1",
      accessibleRepositories: [], correlationId: "corr", createdAt: T0 }))
      .toThrow("warden_org_installation_not_connected");
    transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "running", actorPrincipalId: "p1", eventId: "ev-run", idempotencyKey: "run",
      correlationId: "corr", createdAt: T0 });
    expect(() => enroll(db)).toThrow("warden_campaign_not_draft");
  });
});
