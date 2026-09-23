import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  recordAgentRunMeter,
  insertProvider,
  recordAudit,
  listProviders,
  listAudit,
  createApiKey,
  createApiKeyFromToken,
  insertPrincipal,
  listApiKeys,
  findApiKeyByToken,
  revokeApiKey,
  countActiveApiKeys,
  insertFeedPoll,
  listFeedPolls,
  latestSuccessfulHash,
  feedPollToApi,
  upsertFeedSchedule,
  listFeedSchedules,
  listFeedScheduleWindows,
  claimFeedScheduleWindow,
  completeFeedScheduleWindow,
  getFeedScheduleHealth,
  insertTenant,
  listTenants,
  updateTenantPlan,
  upsertGitHubInstallation,
  listGitHubInstallations,
  enqueueJob,
  claimNextJob,
  renewJobLease,
  completeJob,
  failJob,
  retryJob,
  cancelJob,
  recoverExpiredJobs,
  getJobRecoverySummary,
  jobToApi,
  getJob,
  listJobs,
  insertAgentRun,
  getAgentRunByJobId,
  listAgentRuns,
  insertRepairSession,
  getRepairSession,
  listRepairSessions,
  repairSessionToApi,
  agentRunToApi,
  insertSuppressedPattern,
  listSuppressedPatterns,
  listFindingsForChange,
  insertImpactFinding,
  findingToApi,
  createGitHubInstallState,
  consumeGitHubInstallState,
  completeGitHubInstallState,
  findAuthorizedGitHubInstallationForRepository,
  recordGitHubWebhookDelivery,
  completeGitHubWebhookDelivery,
  failGitHubWebhookDelivery,
  findPrByGitHubIdentityAndNumber,
  updateMigrationPrDelivery,
  insertApiVersionIfAbsent,
  claimFeedTenantDispatch,
  completeFeedTenantDispatch,
  recordRoutingDecision,
  recordRoutingOutcome,
  recordRoutingOutcomeExactlyOnce,
  recordRoutingExecutorOutcome,
  loadRoutingAvailability,
  loadRoutingBreakerSnapshot,
  getRoutingLedgerForJob,
  listRoutingLedgerForRun,
  DEFAULT_ROUTING_BREAKER,
  recordAdaptiveCandidate,
} from "./index.js";
import { newId, nowIso } from "@mendpoint/shared";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  while (dbs.length) {
    const db = dbs.pop();
    try {
      db?.raw.close?.();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore lock races on Windows */
      }
    }
  }
});

describe("db", () => {
  it("upgrades legacy snapshot identity without treating legacy rows as reusable mode manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-snapshot-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "legacy-snapshots.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE scm_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE connected_repositories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES scm_connections(id),
        remote_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        selected_branch TEXT NOT NULL,
        environment TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE repository_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES connected_repositories(id),
        requested_ref TEXT NOT NULL,
        resolved_sha TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        submodules_policy TEXT NOT NULL,
        lfs_policy TEXT NOT NULL,
        sparse_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (tenant_id, repository_id, resolved_sha, manifest_sha256)
      );
      CREATE UNIQUE INDEX repository_snapshots_id_tenant_uidx
        ON repository_snapshots(id, tenant_id);
      CREATE TABLE repository_snapshot_files (
        snapshot_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        path TEXT NOT NULL,
        mode TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, path),
        FOREIGN KEY (snapshot_id, tenant_id) REFERENCES repository_snapshots(id, tenant_id)
      );
      INSERT INTO scm_connections VALUES (
        'connection-a', 'tenant-a', 'local_git', 'env://LOCAL_GIT_TEST', 'local-a',
        'Local A', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL
      );
      INSERT INTO connected_repositories VALUES (
        'repository-a', 'tenant-a', 'connection-a', 'owner/repo', 'owner', 'repo',
        'main', 'main', 'production', 14, 'ready',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO repository_snapshots VALUES (
        'snapshot-main', 'tenant-a', 'repository-a', 'main', '${"a".repeat(40)}',
        '${"b".repeat(64)}', '${join(dir, "snapshot-main").replaceAll("'", "''")}',
        'reject', 'reject', '[]', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      INSERT INTO repository_snapshot_files VALUES (
        'snapshot-main', 'tenant-a', 'package.json', '100644', 'file', 2,
        '${"c".repeat(64)}'
      );
      CREATE TRIGGER repository_snapshots_append_only_update
        BEFORE UPDATE ON repository_snapshots
        BEGIN SELECT RAISE(ABORT, 'repository_snapshots_append_only'); END;
      CREATE TRIGGER repository_snapshots_append_only_delete
        BEFORE DELETE ON repository_snapshots
        BEGIN SELECT RAISE(ABORT, 'repository_snapshots_append_only'); END;
    `);
    legacy.close();

    const db = createDb(path);
    dbs.push(db);
    expect(
      db.raw.prepare(
        "SELECT file_manifest_version FROM repository_snapshots WHERE id = 'snapshot-main'",
      ).get(),
    ).toEqual({ file_manifest_version: 0 });
    expect(db.raw.prepare(
      "SELECT path, mode FROM repository_snapshot_files WHERE snapshot_id = 'snapshot-main'",
    ).get()).toEqual({ path: "package.json", mode: "100644" });
    expect(() => db.raw.prepare(`
      INSERT INTO repository_snapshots
        (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
         storage_path, submodules_policy, lfs_policy, sparse_paths_json,
         file_manifest_version, created_at, expires_at)
      VALUES
        ('snapshot-release', 'tenant-a', 'repository-a', 'release', '${"a".repeat(40)}',
         '${"b".repeat(64)}', '${join(dir, "snapshot-release").replaceAll("'", "''")}',
         'reject', 'reject', '[]', 1, '2026-08-01T01:00:00.000Z', '2026-09-01T01:00:00.000Z')
    `).run()).not.toThrow();
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.raw.prepare(
      "UPDATE repository_snapshots SET requested_ref = 'other' WHERE id = 'snapshot-main'",
    ).run()).toThrow("repository_snapshots_append_only");
  });

  it("boots the snapshot migration despite a dangling foreign key in an unrelated table", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-snapshot-fk-"));
    dirs.push(dir);
    const path = join(dir, "legacy-snapshots-fk.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE scm_connections (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE connected_repositories (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES scm_connections(id),
        remote_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        selected_branch TEXT NOT NULL,
        environment TEXT NOT NULL,
        retention_days INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE repository_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES connected_repositories(id),
        requested_ref TEXT NOT NULL,
        resolved_sha TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        submodules_policy TEXT NOT NULL,
        lfs_policy TEXT NOT NULL,
        sparse_paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE (tenant_id, repository_id, resolved_sha, manifest_sha256)
      );
      CREATE UNIQUE INDEX repository_snapshots_id_tenant_uidx
        ON repository_snapshots(id, tenant_id);
      INSERT INTO scm_connections VALUES (
        'connection-a', 'tenant-a', 'local_git', 'env://LOCAL_GIT_TEST', 'local-a',
        'Local A', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL
      );
      INSERT INTO connected_repositories VALUES (
        'repository-a', 'tenant-a', 'connection-a', 'owner/repo', 'owner', 'repo',
        'main', 'main', 'production', 14, 'ready',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
      INSERT INTO repository_snapshots VALUES (
        'snapshot-main', 'tenant-a', 'repository-a', 'main', '${"a".repeat(40)}',
        '${"b".repeat(64)}', '${join(dir, "snapshot-main").replaceAll("'", "''")}',
        'reject', 'reject', '[]', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
      );
      -- An unrelated table with a dangling foreign key. A bare PRAGMA foreign_key_check would report
      -- this and (before the fix) permanently block the snapshot migration from booting the app.
      CREATE TABLE probe_orphans (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES connected_repositories(id)
      );
      INSERT INTO probe_orphans VALUES ('orphan-1', 'missing-repository');
    `);
    legacy.close();

    // The snapshot chain itself is valid, so boot must succeed even though an unrelated table has a
    // dangling foreign key. The migration only checks the table it rewrites.
    const db = createDb(path);
    dbs.push(db);
    expect(
      db.raw.prepare(
        "SELECT file_manifest_version FROM repository_snapshots WHERE id = 'snapshot-main'",
      ).get(),
    ).toEqual({ file_manifest_version: 0 });
    // The unrelated violation is still present — proving the bare check would have blocked boot.
    expect((db.raw.prepare("PRAGMA foreign_key_check").all()).length).toBeGreaterThan(0);
    expect(db.raw.prepare("PRAGMA foreign_key_check(repository_snapshots)").all()).toEqual([]);
  });

  it("upgrades a prior jobs schema before creating tenant indexes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO jobs (id, type, payload_json, created_at)
      VALUES ('legacy-job', 'agent.run', '{}', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const db = createDb(path);
    dbs.push(db);
    const columns = db.raw
      .prepare("PRAGMA table_info(jobs)")
      .all() as Array<{ name: string }>;
    const indexes = db.raw
      .prepare("PRAGMA index_list(jobs)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "lease_owner",
        "lease_expires_at",
        "available_at",
        "lease_generation",
        "error_code",
        "last_error_at",
        "dead_at",
        "cancelled_at",
      ]),
    );
    expect(
      db.raw
        .prepare(
          `SELECT tenant_id, available_at, lease_generation
           FROM jobs WHERE id = ?`,
        )
        .get("legacy-job"),
    ).toEqual({
      tenant_id: null,
      available_at: "2026-01-01T00:00:00.000Z",
      lease_generation: 0,
    });
    expect(
      db.raw
        .prepare("SELECT id FROM jobs WHERE tenant_id = 'tenant_default'")
        .all(),
    ).toEqual([]);
    expect(indexes.map((index) => index.name)).toContain(
      "jobs_tenant_status_idx",
    );
    expect(indexes.map((index) => index.name)).toContain("jobs_due_idx");
  });

  it("revokes legacy App bindings until stable account identity is independently proven", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-app-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE consumers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_repo TEXT NOT NULL,
        installation_id TEXT,
        tenant_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE github_installations (
        id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL UNIQUE,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'Organization',
        tenant_id TEXT,
        permissions_json TEXT,
        repositories_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO github_installations
        (id, installation_id, account_login, tenant_id, permissions_json,
         repositories_json, created_at, updated_at)
      VALUES
        ('verified-install', '12345', 'acme', 'tenant_default',
         '{"metadata":"read","contents":"write","pull_requests":"write","checks":"read"}',
         '[{"id":77,"owner":"acme","name":"shop"}]',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('stale-install', '67890', 'acme', 'tenant_default', NULL,
         '[{"owner":"acme","name":"stale"}]',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO consumers
        (id, name, github_owner, github_repo, installation_id, tenant_id, created_at)
      VALUES
        ('app-consumer', 'App', 'acme', 'shop', '12345', 'tenant_default', '2026-01-01T00:00:00.000Z'),
        ('stale-consumer', 'Stale', 'acme', 'stale', '67890', 'tenant_default', '2026-01-01T00:00:00.000Z'),
        ('pat-consumer', 'PAT', 'acme', 'legacy', NULL, 'tenant_default', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const previousBindings = process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS;
    process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS =
      '{"7123456":"tenant_default"}';
    const db = (() => {
      try {
        return createDb(path);
      } finally {
        if (previousBindings === undefined) {
          delete process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS;
        } else {
          process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS = previousBindings;
        }
      }
    })();
    dbs.push(db);
    expect(
      db.raw
        .prepare("SELECT id, github_delivery_mode FROM consumers ORDER BY id")
        .all(),
    ).toEqual([
      { id: "app-consumer", github_delivery_mode: "revoked" },
      { id: "pat-consumer", github_delivery_mode: "legacy_pat" },
      { id: "stale-consumer", github_delivery_mode: "revoked" },
    ]);
    expect(
      db.raw
        .prepare("SELECT id, installation_id FROM consumers WHERE id IN ('app-consumer', 'stale-consumer') ORDER BY id")
        .all(),
    ).toEqual([
      { id: "app-consumer", installation_id: null },
      { id: "stale-consumer", installation_id: null },
    ]);
    expect(
      db.raw
        .prepare("SELECT installation_id, account_id FROM github_installations ORDER BY installation_id")
        .all(),
    ).toEqual([
      { installation_id: "12345", account_id: null },
      { installation_id: "67890", account_id: null },
    ]);
  });

  it("adds one-way delivery identity binding to legacy migration pull requests", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-pr-identity-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE migration_prs (
        id TEXT PRIMARY KEY,
        change_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        patch_unified TEXT NOT NULL,
        github_pr_number INTEGER,
        github_pr_url TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      INSERT INTO migration_prs
        (id, change_id, consumer_id, title, body, branch_name, status, risk,
         patch_unified, github_pr_number, created_at)
      VALUES
        ('legacy-pr', 'change-1', 'consumer-1', 'Legacy', '', 'branch', 'draft',
         'breaking', '', 7, '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const db = createDb(path);
    dbs.push(db);
    expect(() =>
      updateMigrationPrDelivery(db, "legacy-pr", {
        status: "draft",
        githubPrNumber: 7,
        githubRepositoryId: "77",
        githubInstallationId: "70001",
        githubAccountId: "7123456",
      }),
    ).not.toThrow();
    expect(() =>
      db.raw.prepare(
        "UPDATE migration_prs SET github_pr_number = 8 WHERE id = 'legacy-pr'",
      ).run(),
    ).toThrow("migration_pr_delivery_identity_immutable");
    expect(() =>
      db.raw.prepare(
        "UPDATE migration_prs SET github_repository_id = '88' WHERE id = 'legacy-pr'",
      ).run(),
    ).toThrow("migration_pr_delivery_identity_immutable");
  });

  it("boots on a pre-slice agent_runs schema and adds job_id before its unique index", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-agent-runs-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    // Pre-slice production shape: agent_runs WITHOUT job_id and WITHOUT the
    // partial unique index (copied from origin/main~1).
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        status TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0,
        files_changed_json TEXT,
        report_md TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_runs_created_idx ON agent_runs(created_at);
      INSERT INTO agent_runs (id, tenant_id, goal, repo_path, status, created_at)
      VALUES ('legacy-run', 'tenant_default', 'fix', '/repo', 'succeeded', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    // Booting on the existing database must not throw "no such column: job_id".
    const db = createDb(path);
    dbs.push(db);

    const columns = (
      db.raw.prepare("PRAGMA table_info(agent_runs)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(columns).toContain("job_id");

    const indexes = db.raw
      .prepare("PRAGMA index_list(agent_runs)")
      .all() as Array<{ name: string; unique: number; partial: number }>;
    const uidx = indexes.find(
      (i) => i.name === "agent_runs_tenant_job_uidx",
    );
    expect(uidx).toBeTruthy();
    expect(uidx?.unique).toBe(1);
    expect(uidx?.partial).toBe(1);

    const idxSql = db.raw
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'agent_runs_tenant_job_uidx'`,
      )
      .get() as { sql: string } | undefined;
    expect(idxSql?.sql).toContain("job_id IS NOT NULL");
  });

  it("converges fresh and migrated agent_runs schema", () => {
    const migratedDir = mkdtempSync(join(tmpdir(), "mendpoint-db-conv-migrated-"));
    dirs.push(migratedDir);
    const migratedPath = join(migratedDir, "legacy.sqlite");
    const legacy = new DatabaseSync(migratedPath);
    legacy.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        status TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0,
        files_changed_json TEXT,
        report_md TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_runs_created_idx ON agent_runs(created_at);
    `);
    legacy.close();
    const migrated = createDb(migratedPath);
    dbs.push(migrated);

    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-db-conv-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }) =>
      (
        db.raw.prepare("PRAGMA table_info(agent_runs)").all() as Array<{
          name: string;
        }>
      )
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }) =>
      (
        db.raw.prepare("PRAGMA index_list(agent_runs)").all() as Array<{
          name: string;
        }>
      )
        .map((i) => i.name)
        .sort();

    expect(columnsOf(migrated)).toEqual(columnsOf(fresh));
    expect(indexesOf(migrated)).toEqual(indexesOf(fresh));
    expect(indexesOf(fresh)).toContain("agent_runs_tenant_job_uidx");
  });

  it("boots a pre-Wave-3b schema (no agent_run_meters) and converges with a fresh DB", () => {
    // Pre-change production shape: agent_runs exists but the Wave 3b
    // agent_run_meters metering table does not. Booting createDb must create it
    // (static DDL) and converge byte-for-byte with a fresh database, and the
    // per-run metering path must work against the migrated database.
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-db-meter-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        job_id TEXT,
        goal TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        status TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        steps INTEGER NOT NULL DEFAULT 0,
        files_changed_json TEXT,
        report_md TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_runs_created_idx ON agent_runs(created_at);
      INSERT INTO agent_runs (id, tenant_id, job_id, goal, repo_path, status, created_at, finished_at)
      VALUES ('legacy-run', 'tenant_default', NULL, 'fix', '/repo', 'candidate_ready',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z');
    `);
    legacy.close();

    const migrated = createDb(legacyPath);
    dbs.push(migrated);

    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-db-meter-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }) =>
      (db.raw.prepare("PRAGMA table_info(agent_run_meters)").all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }) =>
      (db.raw.prepare("PRAGMA index_list(agent_run_meters)").all() as Array<{ name: string }>)
        .map((i) => i.name)
        .sort();

    expect(columnsOf(migrated)).toEqual(columnsOf(fresh));
    expect(columnsOf(fresh).length).toBeGreaterThan(0);
    expect(indexesOf(migrated)).toEqual(indexesOf(fresh));

    // The metering path works against the migrated database.
    const meter = recordAgentRunMeter(migrated, {
      tenantId: "tenant_default",
      runId: "legacy-run",
      meteredAt: "2026-01-01T00:00:05.500Z",
    });
    expect(meter.outcome).toBe("candidate_ready");
    expect(meter.durationMs).toBe(5000);
  });

  it("boots a pre-mission schema (no mission table) and converges with a fresh DB", () => {
    // Pre-change production shape: fettler_campaigns exists and the shared
    // mission table does not exist at all. Booting createDb must create the
    // mission table (static DDL) and converge byte-for-byte with a fresh
    // database, while leaving the already-populated fettler_campaigns table
    // untouched (the mission primitive restructures neither stack). Validates
    // startup from the predecessor schema, not merely a fresh install.
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-db-mission-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    // Standalone pre-change fettler_campaigns shape (copied from origin/main).
    // No REFERENCES clauses so the legacy fixture needs no tenants/principals
    // rows; createDb creates the mission table and every other table via DDL.
    legacy.exec(`
      CREATE TABLE fettler_campaigns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'rolling_back', 'rolled_back')),
        owner_principal_id TEXT NOT NULL,
        concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit > 0),
        completion_policy TEXT NOT NULL CHECK (completion_policy IN ('all', 'continue_on_failure')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, id)
      );
      CREATE INDEX IF NOT EXISTS fettler_campaigns_tenant_status_idx
        ON fettler_campaigns(tenant_id, status, updated_at);
      INSERT INTO fettler_campaigns
        (id, tenant_id, name, status, owner_principal_id, concurrency_limit, completion_policy, revision, created_at, updated_at)
        VALUES ('legacy-campaign', 't1', 'Legacy', 'draft', 'p1', 1, 'all', 1,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    // The mission table does not exist in the pre-change volume.
    const before = new DatabaseSync(legacyPath);
    const missionBefore = before.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission'",
    ).get();
    before.close();
    expect(missionBefore).toBeUndefined();

    const migrated = createDb(legacyPath);
    dbs.push(migrated);

    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-db-mission-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
        .map((i) => i.name)
        .sort();

    // The shared mission table is created on the pre-change database and
    // converges byte-for-byte with a fresh DB, including its linkage columns and
    // partial unique indexes.
    expect(columnsOf(migrated, "mission")).toEqual(columnsOf(fresh, "mission"));
    expect(columnsOf(fresh, "mission")).toContain("fettler_campaign_id");
    expect(columnsOf(fresh, "mission")).toContain("regauge_campaign_id");
    expect(indexesOf(migrated, "mission")).toEqual(indexesOf(fresh, "mission"));
    expect(indexesOf(fresh, "mission")).toContain("mission_fettler_campaign_uidx");
    expect(indexesOf(fresh, "mission")).toContain("mission_regauge_campaign_uidx");

    // The existing stack table is untouched and still converges with fresh.
    expect(columnsOf(migrated, "fettler_campaigns")).toEqual(columnsOf(fresh, "fettler_campaigns"));
    expect(indexesOf(migrated, "fettler_campaigns")).toEqual(indexesOf(fresh, "fettler_campaigns"));

    // The pre-existing campaign row survived the boot intact.
    const legacyRow = migrated.raw
      .prepare("SELECT id FROM fettler_campaigns WHERE id = 'legacy-campaign'")
      .get() as { id: string } | undefined;
    expect(legacyRow?.id).toBe("legacy-campaign");
  });

  it("creates tables and records audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    insertProvider(db, {
      id: newId(),
      slug: "x",
      name: "X",
      website: null,
      createdAt: nowIso(),
    });
    recordAudit(db, {
      tenantId: "tenant_default",
      actor: "test",
      action: "ping",
      resourceType: "system",
    });
    expect(listProviders(db)).toHaveLength(1);
    expect(listAudit(db).some((a) => a.action === "ping")).toBe(true);
  });

  it("retrieves stable collection pages beyond the first response", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-pages-"));
    dirs.push(dir);
    const db = createDb(join(dir, "pages.sqlite"));
    dbs.push(db);
    for (let index = 0; index < 5; index++) {
      insertProvider(db, {
        id: `provider-${index}`,
        slug: `provider-${index}`,
        name: `Provider ${index}`,
        website: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      });
    }
    expect(listProviders(db, 2, 0).map((row) => row.id)).toEqual([
      "provider-0",
      "provider-1",
    ]);
    expect(listProviders(db, 2, 2).map((row) => row.id)).toEqual([
      "provider-2",
      "provider-3",
    ]);
    expect(listProviders(db, 2, 4).map((row) => row.id)).toEqual(["provider-4"]);
  });

  it("fences stale feed dispatch completion after recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-fence-"));
    dirs.push(dir);
    const db = createDb(join(dir, "fence.sqlite"));
    dbs.push(db);
    const first = claimFeedTenantDispatch(db, {
      tenantId: "tenant_default",
      providerSlug: "acme",
      contentHash: "hash-one",
      attemptedAt: "2026-08-02T00:00:00.000Z",
      staleAfterMs: 1_000,
    });
    const recovered = claimFeedTenantDispatch(db, {
      tenantId: "tenant_default",
      providerSlug: "acme",
      contentHash: "hash-one",
      attemptedAt: "2026-08-02T00:00:02.000Z",
      staleAfterMs: 1_000,
    });
    expect(first).toBe(1);
    expect(recovered).toBe(2);
    expect(completeFeedTenantDispatch(db, {
      tenantId: "tenant_default",
      providerSlug: "acme",
      contentHash: "hash-one",
      leaseGeneration: first!,
      succeeded: true,
      completedAt: "2026-08-02T00:00:03.000Z",
    })).toBe(false);
    expect(completeFeedTenantDispatch(db, {
      tenantId: "tenant_default",
      providerSlug: "acme",
      contentHash: "hash-one",
      leaseGeneration: recovered!,
      succeeded: true,
      completedAt: "2026-08-02T00:00:03.000Z",
    })).toBe(true);
  });

  it("keeps a noisy tenant from occupying every global worker lane", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-job-fairness-"));
    dirs.push(dir);
    const db = createDb(join(dir, "fairness.sqlite"));
    dbs.push(db);
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      insertTenant(db, {
        id: tenantId,
        slug: tenantId,
        name: tenantId,
        plan: "pilot",
        seatLimit: 5,
        createdAt: "2026-08-02T00:00:00.000Z",
      });
    }
    for (const [id, tenantId, createdAt] of [
      ["a-one", "tenant-a", "2026-08-02T00:00:00.000Z"],
      ["a-two", "tenant-a", "2026-08-02T00:00:01.000Z"],
      ["b-one", "tenant-b", "2026-08-02T00:00:02.000Z"],
    ] as const) {
      enqueueJob(db, {
        id,
        tenantId,
        type: "agent.run",
        payload: {},
        createdAt,
      });
    }
    const first = claimNextJob(db, ["agent.run"], {
      workerId: "lane-one",
      maxRunningPerTenant: 1,
    });
    const second = claimNextJob(db, ["agent.run"], {
      workerId: "lane-two",
      maxRunningPerTenant: 1,
    });
    expect(first).toMatchObject({ id: "a-one", tenant_id: "tenant-a" });
    expect(second).toMatchObject({ id: "b-one", tenant_id: "tenant-b" });
  });

  it("api keys hash and revoke", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-keys-"));
    dirs.push(dir);
    const db = createDb(join(dir, "k.sqlite"));
    dbs.push(db);
    const created = createApiKey(db, {
      id: newId(),
      name: "ci",
      tenantId: "t1",
      createdAt: nowIso(),
    });
    expect(created.token.startsWith("me_")).toBe(true);
    expect(findApiKeyByToken(db, created.token)?.tenant_id).toBe("t1");
    expect(findApiKeyByToken(db, "me_nope")).toBeUndefined();
    expect(countActiveApiKeys(db)).toBe(1);
    expect(revokeApiKey(db, created.id, nowIso(), "other-tenant")).toBe(false);
    expect(findApiKeyByToken(db, created.token)).toBeDefined();
    expect(listApiKeys(db, "other-tenant")).toEqual([]);
    expect(listApiKeys(db, "t1")).toHaveLength(1);
    expect(revokeApiKey(db, created.id, nowIso(), "t1")).toBe(true);
    expect(findApiKeyByToken(db, created.token)).toBeUndefined();
    expect(countActiveApiKeys(db)).toBe(0);
  });

  it("stores a deployment-provided API key by hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-configured-key-"));
    dirs.push(dir);
    const db = createDb(join(dir, "configured.sqlite"));
    dbs.push(db);
    const token = `me_${"a".repeat(40)}`;
    const created = createApiKeyFromToken(db, {
      id: newId(),
      name: "deployment",
      tenantId: "tenant_default",
      token,
      createdAt: nowIso(),
    });

    expect(created.prefix).toBe(token.slice(0, 10));
    expect(findApiKeyByToken(db, token)?.tenant_id).toBe("tenant_default");
    expect(JSON.stringify(listApiKeys(db))).not.toContain(token);
  });

  it("returns durable API-key authority bindings without exposing key hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-key-authority-list-"));
    dirs.push(dir);
    const db = createDb(join(dir, "authority.sqlite"));
    dbs.push(db);
    const authority = insertPrincipal(db, {
      id: "principal-owner",
      tenantId: "tenant_default",
      kind: "human",
      subject: "https://issuer.example|owner",
      displayName: "Owner",
      audience: "https://issuer.example",
      createdAt: nowIso(),
    });
    createApiKey(db, {
      id: "key-owner-bound",
      name: "owner-bound",
      tenantId: "tenant_default",
      scopes: ["tenant:admin"],
      authorityPrincipalId: authority.id,
      authorityRole: "owner",
      createdAt: nowIso(),
    });

    expect(listApiKeys(db, "tenant_default")).toContainEqual(expect.objectContaining({
      id: "key-owner-bound",
      authority_principal_id: authority.id,
      authority_role: "owner",
    }));
    expect(listApiKeys(db, "tenant_default")[0]).not.toHaveProperty("key_hash");
  });

  it("feed poll ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-"));
    dirs.push(dir);
    const db = createDb(join(dir, "f.sqlite"));
    dbs.push(db);
    const pollId = newId();
    insertFeedPoll(db, {
      id: pollId,
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      openapiUrl: "file:x.json",
      contentHash: "abc123",
      versionLabel: "2.0.0",
      status: "new_version",
      polledAt: nowIso(),
      validationEvidence: {
        id: "validation-1",
        source: "catalog",
        format: "json",
        formatStatus: "accepted",
        schemaVersion: "3.1.0",
        schemaStatus: "accepted",
        sizeBytes: 128,
        contentSha256: "a".repeat(64),
        status: "accepted",
        observedAt: "2026-08-02T12:00:00.000Z",
      },
    });
    const polls = listFeedPolls(db);
    expect(polls).toHaveLength(1);
    expect(feedPollToApi(polls[0]!)).toMatchObject({
      id: pollId,
      validation: {
        id: "validation-1",
        source: "catalog",
        schemaVersion: "3.1.0",
        sizeBytes: 128,
        contentSha256: "a".repeat(64),
        status: "accepted",
      },
    });
    expect(latestSuccessfulHash(db, "acme-payments")).toBe("abc123");
    expect(() =>
      db.raw.prepare(`UPDATE feed_validation_evidence SET status = 'rejected' WHERE id = ?`).run(
        "validation-1",
      ),
    ).toThrow("feed_validation_evidence_immutable");
  });

  it("opens a legacy feed poll ledger with null validation evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-legacy-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE feed_polls (
        id TEXT PRIMARY KEY,
        provider_slug TEXT NOT NULL,
        openapi_url TEXT NOT NULL,
        content_hash TEXT,
        version_label TEXT,
        status TEXT NOT NULL,
        error TEXT,
        version_id TEXT,
        pipeline_change_id TEXT,
        polled_at TEXT NOT NULL
      );
      INSERT INTO feed_polls
        (id, provider_slug, openapi_url, status, polled_at)
      VALUES
        ('legacy-poll', 'legacy', 'file:legacy.json', 'error', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();
    const db = createDb(path);
    dbs.push(db);
    expect(feedPollToApi(listFeedPolls(db)[0]!)).toMatchObject({
      id: "legacy-poll",
      validation: null,
    });
  });

  it("claims schedule windows once and recovers stale and failed health", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-schedule-"));
    dirs.push(dir);
    const db = createDb(join(dir, "schedule.sqlite"));
    dbs.push(db);
    const schedule = upsertFeedSchedule(db, {
      id: "schedule-1",
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      intervalMs: 60_000,
      staleAfterMs: 120_000,
      createdAt: "2026-08-02T12:00:00.000Z",
    });
    expect(getFeedScheduleHealth(db, "2026-08-02T12:03:00.001Z")).toMatchObject({
      status: "degraded",
      counts: { stale: 1, failed: 0 },
    });
    const firstWindow = {
      id: "window-1",
      scheduleId: schedule.id,
      windowStartedAt: "2026-08-02T12:03:00.000Z",
      windowEndsAt: "2026-08-02T12:04:00.000Z",
      attemptedAt: "2026-08-02T12:03:01.000Z",
    };
    expect(claimFeedScheduleWindow(db, firstWindow)).toBe(true);
    expect(claimFeedScheduleWindow(db, { ...firstWindow, id: "window-replay" })).toBe(false);
    expect(completeFeedScheduleWindow(db, {
      scheduleId: schedule.id,
      windowStartedAt: firstWindow.windowStartedAt,
      succeeded: false,
      error: "HTTP 503",
      completedAt: "2026-08-02T12:03:02.000Z",
    })).toBe(true);
    expect(listFeedSchedules(db)[0]).toMatchObject({
      alert_state: "failed",
      consecutive_failures: 1,
      last_error: "HTTP 503",
    });

    const recoveryWindow = {
      id: "window-2",
      scheduleId: schedule.id,
      windowStartedAt: "2026-08-02T12:04:00.000Z",
      windowEndsAt: "2026-08-02T12:05:00.000Z",
      attemptedAt: "2026-08-02T12:04:01.000Z",
    };
    expect(claimFeedScheduleWindow(db, recoveryWindow)).toBe(true);
    expect(completeFeedScheduleWindow(db, {
      scheduleId: schedule.id,
      windowStartedAt: recoveryWindow.windowStartedAt,
      succeeded: true,
      completedAt: "2026-08-02T12:04:02.000Z",
    })).toBe(true);
    expect(getFeedScheduleHealth(db, "2026-08-02T12:04:02.000Z")).toMatchObject({
      status: "healthy",
      schedules: [{
        alertState: "healthy",
        lastSuccessAt: "2026-08-02T12:04:02.000Z",
        consecutiveFailures: 0,
        lastError: null,
      }],
    });
    expect(listFeedScheduleWindows(db, schedule.id).map((window) => window.status)).toEqual([
      "failed",
      "succeeded",
    ]);
  });

  it("reclaims an expired schedule window and fences stale completion generations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-feed-schedule-lease-"));
    dirs.push(dir);
    const db = createDb(join(dir, "schedule.sqlite"));
    dbs.push(db);
    const schedule = upsertFeedSchedule(db, {
      id: "schedule-lease",
      tenantId: "tenant_default",
      providerSlug: "release-provider",
      intervalMs: 60_000,
      staleAfterMs: 120_000,
      createdAt: "2026-08-02T12:00:00.000Z",
    });
    const first = {
      id: "window-lease",
      scheduleId: schedule.id,
      windowStartedAt: "2026-08-02T12:00:00.000Z",
      windowEndsAt: "2026-08-02T12:01:00.000Z",
      attemptedAt: "2026-08-02T12:00:01.000Z",
      leaseDurationMs: 1_000,
    };

    expect(claimFeedScheduleWindow(db, first)).toBe(true);
    expect(claimFeedScheduleWindow(db, {
      ...first,
      id: "window-unexpired-replay",
      attemptedAt: "2026-08-02T12:00:01.999Z",
    })).toBe(false);
    expect(claimFeedScheduleWindow(db, {
      ...first,
      id: "window-expiry-takeover",
      attemptedAt: "2026-08-02T12:00:02.001Z",
    })).toBe(true);
    expect(listFeedScheduleWindows(db, schedule.id)).toMatchObject([{
      status: "running",
      lease_generation: 2,
      lease_expires_at: "2026-08-02T12:00:03.001Z",
    }]);
    expect(completeFeedScheduleWindow(db, {
      scheduleId: schedule.id,
      windowStartedAt: first.windowStartedAt,
      leaseGeneration: 1,
      succeeded: true,
      completedAt: "2026-08-02T12:00:02.100Z",
    })).toBe(false);
    expect(completeFeedScheduleWindow(db, {
      scheduleId: schedule.id,
      windowStartedAt: first.windowStartedAt,
      leaseGeneration: 2,
      succeeded: true,
      completedAt: "2026-08-02T12:00:02.100Z",
    })).toBe(true);
  });

  it("tenants and github installations", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-tenant-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    // default tenant seeded by migrate
    expect(listTenants(db).some((t) => t.slug === "default")).toBe(true);
    const id = newId();
    insertTenant(db, {
      id,
      slug: "acme-co",
      name: "Acme Co",
      plan: "free",
      createdAt: nowIso(),
    });
    updateTenantPlan(db, id, "pro");
    expect(listTenants(db).find((t) => t.id === id)?.plan).toBe("pro");
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "42",
      accountId: "7123456",
      accountLogin: "acme-co",
      tenantId: id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(listGitHubInstallations(db)).toHaveLength(1);
    expect(listGitHubInstallations(db)[0]?.account_id).toBe("7123456");
    expect(listGitHubInstallations(db, id)).toHaveLength(1);
    expect(listGitHubInstallations(db, "tenant_default")).toEqual([]);
    expect(() =>
      upsertGitHubInstallation(db, {
        id: newId(),
        installationId: "42",
        accountId: "7123456",
        accountLogin: "attacker",
        tenantId: "tenant_default",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    ).toThrow("github_installation_tenant_mismatch");
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "42",
      accountId: "7123456",
      accountLogin: "acme-renamed",
      tenantId: id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(listGitHubInstallations(db, id)[0]?.account_login).toBe("acme-renamed");
    expect(() => upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "42",
      accountId: "8123456",
      accountLogin: "acme-renamed",
      tenantId: id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })).toThrow("github_installation_account_mismatch");
  });

  it("an installation acquires the account identity its authorization needs", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-install-backfill-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    // Mirror the live pre-migration row: installation 151614362 exists under
    // tenant_default with account_id still null, because the row predates the
    // additive migration that added the column. Every pull-request webhook for
    // it is refused with installation_not_authorized until the id is filled in.
    const rowId = newId();
    upsertGitHubInstallation(db, {
      id: rowId,
      installationId: "151614362",
      accountId: null,
      accountLogin: "octo-org",
      tenantId: "tenant_default",
      repositories: [{ id: 1, owner: "octo-org", name: "widgets" }],
      repositorySelection: "selected",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(listGitHubInstallations(db, "tenant_default")[0]?.account_id).toBeNull();

    // The next signature-verified installation event supplies the account id.
    // COALESCE(account_id, ?) backfills the null on the existing row.
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "151614362",
      accountId: "273115720",
      accountLogin: "octo-org",
      tenantId: "tenant_default",
      repositories: [{ id: 1, owner: "octo-org", name: "widgets" }],
      repositorySelection: "selected",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const acquired = listGitHubInstallations(db, "tenant_default");
    // The null acquired its identity, on the same row: no duplicate, the primary
    // id and tenant binding are preserved.
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.account_id).toBe("273115720");
    expect(acquired[0]?.id).toBe(rowId);
    expect(acquired[0]?.tenant_id).toBe("tenant_default");

    // Replay of the same event is idempotent: the account id is unchanged and
    // there is still exactly one row on the same primary id.
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "151614362",
      accountId: "273115720",
      accountLogin: "octo-org",
      tenantId: "tenant_default",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    const replayed = listGitHubInstallations(db, "tenant_default");
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.account_id).toBe("273115720");
    expect(replayed[0]?.id).toBe(rowId);

    // A later event that omits the account id (for example a repository-only
    // update) must not wipe the bound identity: COALESCE(account_id, ?) keeps
    // it, whereas a plain assignment would null it back out.
    upsertGitHubInstallation(db, {
      id: newId(),
      installationId: "151614362",
      accountId: null,
      accountLogin: "octo-org",
      tenantId: "tenant_default",
      repositories: [{ id: 2, owner: "octo-org", name: "gadgets" }],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    expect(listGitHubInstallations(db, "tenant_default")[0]?.account_id).toBe("273115720");

    // Once bound, a conflicting account id is refused, never silently
    // reassigned. This guards backfill and conflict-refusal from trading places.
    expect(() =>
      upsertGitHubInstallation(db, {
        id: newId(),
        installationId: "151614362",
        accountId: "999999999",
        accountLogin: "octo-org",
        tenantId: "tenant_default",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }),
    ).toThrow("github_installation_account_mismatch");
    expect(listGitHubInstallations(db, "tenant_default")[0]?.account_id).toBe("273115720");
  });

  it("isolates tenant-owned durable records and findings", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-isolation-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const at = nowIso();
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      const suffix = tenantId.at(-1)!;
      db.raw
        .prepare(
          `INSERT INTO consumers
           (id, name, github_owner, github_repo, tenant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`consumer-${suffix}`, tenantId, `owner-${suffix}`, `repo-${suffix}`, tenantId, at);
      db.raw
        .prepare(
          `INSERT INTO impact_findings
           (id, change_id, consumer_id, file_path, line_start, line_end, symbol, confidence, evidence_json)
           VALUES (?, 'change-1', ?, ?, 1, 1, 'x', 'high', '{}')`,
        )
        .run(`finding-${suffix}`, `consumer-${suffix}`, `secret-${suffix}.ts`);
      enqueueJob(db, {
        id: `job-${suffix}`,
        tenantId,
        type: "agent.run",
        payload: {},
        createdAt: at,
      });
      insertAgentRun(db, {
        id: `agent-${suffix}`,
        tenantId,
        jobId: `job-${suffix}`,
        goal: "test",
        repoPath: `C:\\secret-${suffix}`,
        status: "queued",
        ok: false,
        steps: 0,
        createdAt: at,
      });
      insertRepairSession(db, {
        id: `repair-${suffix}`,
        tenantId,
        consumerId: `consumer-${suffix}`,
        repoPath: `C:\\secret-${suffix}`,
        status: "queued",
        attempts: 0,
        editsCount: 0,
        ok: false,
        createdAt: at,
      });
      insertSuppressedPattern(db, {
        id: `suppressed-${suffix}`,
        tenantId,
        consumerId: `consumer-${suffix}`,
        pattern: `secret-${suffix}`,
        createdAt: at,
      });
      recordAudit(db, {
        tenantId,
        actor: "test",
        action: `secret-${suffix}`,
        resourceType: "test",
      });
    }

    expect(listJobs(db, 50, "tenant-a").map((row) => row.id)).toEqual(["job-a"]);
    expect(getJob(db, "job-a", "tenant-a")?.id).toBe("job-a");
    expect(getJob(db, "job-b", "tenant-a")).toBeUndefined();
    expect(listAgentRuns(db, 50, "tenant-a").map((row) => row.id)).toEqual(["agent-a"]);
    expect(getAgentRunByJobId(db, "job-a", "tenant-a")?.id).toBe("agent-a");
    expect(getAgentRunByJobId(db, "job-b", "tenant-a")).toBeUndefined();
    expect(() => insertAgentRun(db, {
      id: "agent-a",
      tenantId: "tenant-b",
      jobId: "job-foreign",
      goal: "foreign overwrite",
      repoPath: "C:\\foreign",
      status: "failed",
      ok: false,
      steps: 0,
      createdAt: at,
    })).toThrow("agent_run_tenant_conflict");
    expect(() => insertAgentRun(db, {
      id: "agent-a",
      tenantId: "tenant-a",
      jobId: "job-other",
      goal: "same tenant takeover",
      repoPath: "C:\\foreign",
      status: "failed",
      ok: false,
      steps: 0,
      createdAt: at,
    })).toThrow("agent_run_tenant_conflict");
    expect(listRepairSessions(db, 50, "tenant-a").map((row) => row.id)).toEqual([
      "repair-a",
    ]);
    expect(
      listSuppressedPatterns(db, { tenantId: "tenant-a" }).map((row) => row.id),
    ).toEqual(["suppressed-a"]);
    expect(
      listFindingsForChange(db, "change-1", "tenant-a").map((row) => row.file_path),
    ).toEqual(["secret-a.ts"]);
    expect(listAudit(db, "tenant-a").map((row) => row.action)).toEqual(["secret-a"]);
  });

  it("claims jobs atomically and recovers expired leases", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");
    const db = createDb(path);
    const peer = createDb(path);
    dbs.push(db, peer);
    enqueueJob(db, {
      id: "job-a",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      maxAttempts: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const first = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(first?.lease_owner).toBe("worker-a");
    expect(
      claimNextJob(peer, ["agent.run"], {
        tenantId: "tenant-a",
        workerId: "worker-b",
        now: "2026-01-01T00:00:00.500Z",
      }),
    ).toBeUndefined();

    expect(
      recoverExpiredJobs(db, "2026-01-01T00:00:02.000Z", "tenant-a"),
    ).toBe(1);
    const retried = claimNextJob(peer, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-b",
      now: "2026-01-01T00:00:03.000Z",
    });
    expect(retried?.attempts).toBe(2);
    expect(retried?.lease_owner).toBe("worker-b");
    expect(retried?.lease_generation).toBe(2);
  });

  it("claims only due jobs and reports tenant recovery state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-due-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-future",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: { secret: "not-for-api" },
      createdAt: "2026-01-01T00:00:00.000Z",
      availableAt: "2026-01-01T00:10:00.000Z",
    });
    enqueueJob(db, {
      id: "job-due",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      createdAt: "2026-01-01T00:01:00.000Z",
      availableAt: "2026-01-01T00:01:00.000Z",
    });

    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:02:00.000Z",
    });
    expect(claimed?.id).toBe("job-due");
    expect(
      getJobRecoverySummary(db, "tenant-a", "2026-01-01T00:02:00.000Z"),
    ).toMatchObject({
      pending: 1,
      due: 0,
      scheduled: 1,
      running: 1,
      deadLetter: 0,
    });
  });

  it("counts verified edits as recoveries but excludes already green work", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-recovered-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    for (const id of ["already-green", "repaired"]) {
      enqueueJob(db, {
        id,
        tenantId: "tenant-a",
        type: "agent.run",
        payload: {},
        createdAt: id === "already-green"
          ? "2026-01-01T00:00:00.000Z"
          : "2026-01-01T00:00:01.000Z",
      });
      const job = claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        workerId: "worker-a",
        now: "2026-01-01T00:00:02.000Z",
      });
      expect(job?.id).toBe(id);
      expect(
        completeJob(
          db,
          id,
          {
            ok: true,
            filesChanged: id === "repaired" ? ["client.ts"] : [],
            stoppedReason: id === "repaired" ? "verify_passed" : "already_passing",
          },
          "2026-01-01T00:00:03.000Z",
          {
            workerId: "worker-a",
            leaseGeneration: job!.lease_generation,
          },
        ),
      ).toBe(true);
    }

    expect(getJobRecoverySummary(db, "tenant-a")).toMatchObject({
      done: 2,
      recovered: 1,
    });
  });

  it("fences stale workers and renews the current lease holder", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-fence-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-fenced",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const first = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    })!;
    recoverExpiredJobs(db, "2026-01-01T00:00:02.000Z", "tenant-a");
    const second = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-b",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:03.000Z",
    })!;

    expect(
      renewJobLease(db, first.id, {
        workerId: "worker-a",
        leaseGeneration: first.lease_generation,
        now: "2026-01-01T00:00:03.250Z",
        leaseMs: 2_000,
      }),
    ).toBe(false);
    expect(
      completeJob(db, first.id, { stale: true }, "2026-01-01T00:00:03.250Z", {
        workerId: "worker-a",
        leaseGeneration: first.lease_generation,
      }),
    ).toBe(false);
    expect(
      failJob(db, first.id, "stale failure", "2026-01-01T00:00:03.250Z", {
        workerId: "worker-a",
        leaseGeneration: first.lease_generation,
      }).applied,
    ).toBe(false);
    expect(
      renewJobLease(db, second.id, {
        workerId: "worker-b",
        leaseGeneration: second.lease_generation,
        now: "2026-01-01T00:00:03.500Z",
        leaseMs: 2_000,
      }),
    ).toBe(true);
    expect(
      completeJob(db, second.id, { ok: true }, "2026-01-01T00:00:04.000Z", {
        workerId: "worker-b",
        leaseGeneration: second.lease_generation,
      }),
    ).toBe(true);
    expect(listJobs(db, 10, "tenant-a")[0].status).toBe("done");
  });

  it("rejects completion and failure after lease expiry before recovery", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-expired-fence-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-expired-fence",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      leaseMs: 1_000,
      now: "2026-01-01T00:00:00.000Z",
    })!;
    const fence = {
      workerId: "worker-a",
      leaseGeneration: claimed.lease_generation,
    };

    expect(completeJob(db, claimed.id, {}, "2026-01-01T00:00:01.000Z", fence)).toBe(false);
    expect(failJob(db, claimed.id, "late", "2026-01-01T00:00:01.000Z", fence).applied)
      .toBe(false);
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({ status: "running" });
  });

  it("dead-letters exhausted jobs and supports explicit retry and cancellation", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-recovery-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-poison",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: { token: "must-not-leak" },
      maxAttempts: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:00:00.000Z",
    })!;
    const failed = failJob(
      db,
      claimed.id,
      "remote response included a credential",
      "2026-01-01T00:00:01.000Z",
      {
        workerId: "worker-a",
        leaseGeneration: claimed.lease_generation,
        errorCode: "github 5xx",
      },
    );
    expect(failed).toEqual({
      applied: true,
      status: "dead_letter",
      availableAt: null,
      deadAt: "2026-01-01T00:00:01.000Z",
    });
    const dead = listJobs(db, 10, "tenant-a")[0];
    expect(dead).toMatchObject({
      status: "dead_letter",
      error_code: "github_5xx",
      dead_at: "2026-01-01T00:00:01.000Z",
    });
    const apiJob = jobToApi(dead);
    expect(apiJob).toMatchObject({
      id: "job-poison",
      status: "dead_letter",
      errorCode: "github_5xx",
    });
    expect(apiJob).not.toHaveProperty("payload_json");
    expect(apiJob).not.toHaveProperty("error");
    expect(apiJob).not.toHaveProperty("lease_owner");
    expect(getJobRecoverySummary(db, "tenant-a").deadLetter).toBe(1);

    expect(
      retryJob(db, "job-poison", {
        tenantId: "tenant-a",
        now: "2026-01-01T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      dead_at: null,
    });
    expect(
      cancelJob(db, "job-poison", "2026-01-01T00:01:01.000Z", {
        tenantId: "tenant-a",
        reason: "operator cancelled",
      }),
    ).toBe(true);
    const cancelled = listJobs(db, 10, "tenant-a")[0];
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error_code: "job_cancelled",
      cancelled_at: "2026-01-01T00:01:01.000Z",
    });
    expect(
      claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        now: "2026-01-01T00:02:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("preserves the resumable checkpoint on retry and discards it only when asked (defect 3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-retry-checkpoint-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    // The Warden checkpoint journal stores its head in jobs.result_json while the
    // job runs; the head survives a dead-letter (failJob does not clear it).
    const checkpoint = JSON.stringify({ kind: "warden_checkpoint_head", generation: 3 });
    const seedDeadLetter = (id: string) => {
      enqueueJob(db, {
        id,
        tenantId: "tenant-a",
        type: "agent.run",
        payload: {},
        maxAttempts: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const claimed = claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        workerId: "worker-a",
        now: "2026-01-01T00:00:00.000Z",
      })!;
      db.raw.prepare("UPDATE jobs SET result_json = ? WHERE id = ?").run(checkpoint, id);
      failJob(db, id, "preempted", "2026-01-01T00:00:01.000Z", {
        workerId: "worker-a",
        leaseGeneration: claimed.lease_generation,
        errorCode: "warden_needs_human",
        retryable: false,
      });
      expect(getJob(db, id)).toMatchObject({ status: "dead_letter", result_json: checkpoint });
    };

    // Default retry keeps the checkpoint so the re-run resumes rather than restarting.
    seedDeadLetter("job-resume");
    expect(
      retryJob(db, "job-resume", { tenantId: "tenant-a", now: "2026-01-01T00:01:00.000Z" }),
    ).toBe(true);
    expect(getJob(db, "job-resume")).toMatchObject({
      status: "pending",
      attempts: 0,
      result_json: checkpoint,
    });

    // The destructive path is explicit and opt-in.
    seedDeadLetter("job-reset");
    expect(
      retryJob(db, "job-reset", {
        tenantId: "tenant-a",
        now: "2026-01-01T00:01:00.000Z",
        discardCheckpoint: true,
      }),
    ).toBe(true);
    expect(getJob(db, "job-reset")).toMatchObject({ status: "pending", result_json: null });
  });

  it("acknowledges a permanent dead letter without losing its failure evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-acknowledge-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-permanent",
      tenantId: "tenant-a",
      type: "pipeline.fanout",
      payload: { providerSlug: "stripe" },
      maxAttempts: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const claimed = claimNextJob(db, ["pipeline.fanout"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:00:00.000Z",
    })!;
    failJob(
      db,
      claimed.id,
      "Provider stripe needs at least 2 API versions",
      "2026-01-01T00:00:01.000Z",
      {
        workerId: "worker-a",
        leaseGeneration: claimed.lease_generation,
        errorCode: "job_failed",
        retryable: false,
      },
    );

    expect(
      cancelJob(db, "job-permanent", "2026-01-01T00:01:00.000Z", {
        tenantId: "tenant-a",
        reason: "operator acknowledged permanent failure",
      }),
    ).toBe(true);
    expect(listJobs(db, 10, "tenant-a")[0]).toMatchObject({
      status: "cancelled",
      error: "Provider stripe needs at least 2 API versions",
      error_code: "job_failed",
      last_error_at: "2026-01-01T00:00:01.000Z",
      dead_at: "2026-01-01T00:00:01.000Z",
      cancelled_at: "2026-01-01T00:01:00.000Z",
    });
    expect(getJobRecoverySummary(db, "tenant-a")).toMatchObject({
      deadLetter: 0,
      cancelled: 1,
    });
  });

  it("schedules retry backoff durably", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-jobs-backoff-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    enqueueJob(db, {
      id: "job-backoff",
      tenantId: "tenant-a",
      type: "agent.run",
      payload: {},
      maxAttempts: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const claimed = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-a",
      now: "2026-01-01T00:00:00.000Z",
    })!;
    const failure = failJob(
      db,
      claimed.id,
      "transient",
      "2026-01-01T00:00:01.000Z",
      {
        workerId: "worker-a",
        leaseGeneration: claimed.lease_generation,
        baseDelayMs: 2_000,
        maxDelayMs: 10_000,
      },
    );
    expect(failure).toMatchObject({
      applied: true,
      status: "pending",
      availableAt: "2026-01-01T00:00:03.000Z",
    });
    expect(
      claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        now: "2026-01-01T00:00:02.999Z",
      }),
    ).toBeUndefined();
    expect(
      claimNextJob(db, ["agent.run"], {
        tenantId: "tenant-a",
        now: "2026-01-01T00:00:03.000Z",
      })?.id,
    ).toBe("job-backoff");
  });

  it("upserts a queued repair session with its completed result", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-repair-upsert-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    insertRepairSession(db, {
      id: "repair-one",
      tenantId: "tenant_default",
      repoPath: "C:\\repo",
      status: "queued",
      attempts: 0,
      editsCount: 0,
      ok: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    insertRepairSession(db, {
      id: "repair-one",
      tenantId: "tenant_default",
      repoPath: "C:\\repo",
      status: "ok",
      attempts: 2,
      editsCount: 1,
      ok: true,
      reportMd: "verified",
      resultJson: "{\"ok\":true}",
      createdAt: "2026-01-01T00:00:05.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(getRepairSession(db, "repair-one", "tenant_default")).toMatchObject({
      status: "ok",
      attempts: 2,
      edits_count: 1,
      ok: 1,
      report_md: "verified",
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });
  });

  it("sanitizes repair and agent results for tenant API responses", () => {
    const repair = repairSessionToApi({
      id: "repair-safe",
      tenant_id: "tenant-a",
      consumer_id: "consumer-a",
      repo_path: "C:\\customer\\private",
      status: "ok",
      attempts: 2,
      edits_count: 1,
      ok: 1,
      report_md: "verified",
      result_json: JSON.stringify({
        jobId: "job-repair",
        stopReason: "verify_passed",
        plans: [{ source: "private source", verifierOutput: "private log" }],
        failureFingerprints: ["failure"],
        actionFingerprints: ["action"],
      }),
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });
    const agent = agentRunToApi({
      id: "agent-safe",
      tenant_id: "tenant-a",
      job_id: "job-agent",
      goal: "repair the API call",
      repo_path: "C:\\customer\\private",
      status: "ok",
      ok: 1,
      steps: 3,
      files_changed_json: "[\"src/client.ts\"]",
      report_md: "verified",
      result_json: JSON.stringify({
        jobId: "job-agent",
        stoppedReason: "verify_passed",
        supersedesRunId: "agent-earlier",
        supersededByRunId: "agent-later",
        review: {
          decision: "regenerate",
          rationale: "The repair needs a narrower change.",
          reviewedAt: "2026-01-01T00:00:30.000Z",
          reviewerPrincipalId: "human:reviewer@example.com",
          supersedingRunId: "agent-later",
          privateEvidence: "private review evidence",
        },
        steps: [{ source: "private source" }],
        verifier: {
          command: "node check.mjs",
          source: "discovered",
          status: "passed",
          output: "private log",
        },
        rollback: {
          performed: true,
          restoredFiles: ["private file"],
          failedFiles: [],
        },
      }),
      created_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:01:00.000Z",
    });

    expect(JSON.stringify(repair)).not.toContain("private source");
    expect(JSON.stringify(repair)).not.toContain("private log");
    expect(repair.result).toMatchObject({ planCount: 1, actionCount: 1 });
    expect(JSON.stringify(agent)).not.toContain("private source");
    expect(JSON.stringify(agent)).not.toContain("private log");
    expect(agent.result?.rollback).toEqual({
      performed: true,
      restoredCount: 1,
      failedCount: 0,
    });
    expect(agent.result?.review).toEqual({
      decision: "regenerate",
      rationale: "The repair needs a narrower change.",
      reviewedAt: "2026-01-01T00:00:30.000Z",
      reviewerPrincipalId: "human:reviewer@example.com",
      supersedingRunId: "agent-later",
    });
    expect(agent.result?.lineage).toEqual({
      supersedesRunId: "agent-earlier",
      supersededByRunId: "agent-later",
    });
    expect(JSON.stringify(agent)).not.toContain("private review evidence");
  });

  it("consumes install state and webhook deliveries once", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-github-state-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    createGitHubInstallState(db, {
      state: "opaque-state",
      tenantId: "tenant-a",
      principalId: "principal-a",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    expect(
      consumeGitHubInstallState(
        db,
        "opaque-state",
        "tenant-b",
        "principal-a",
        "2026-01-01T00:01:00.000Z",
      ),
    ).toBe(false);
    expect(
      consumeGitHubInstallState(
        db,
        "opaque-state",
        "tenant-a",
        "principal-a",
        "2026-01-01T00:01:00.000Z",
      ),
    ).toBe(true);
    expect(
      consumeGitHubInstallState(
        db,
        "opaque-state",
        "tenant-a",
        "principal-a",
        "2026-01-01T00:02:00.000Z",
      ),
    ).toBe(false);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:01:00.000Z",
      ),
    ).toBe(false);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-stale",
        "push",
        "2026-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-stale",
        "push",
        "2026-01-01T00:06:00.000Z",
      ),
    ).toBe(true);
    expect(
      failGitHubWebhookDelivery(
        db,
        "delivery-1",
        "2026-01-01T00:01:01.000Z",
        "transient",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:01:02.000Z",
      ),
    ).toBe(true);
    expect(
      completeGitHubWebhookDelivery(
        db,
        "delivery-1",
        "2026-01-01T00:01:03.000Z",
      ),
    ).toBe(true);
    expect(
      recordGitHubWebhookDelivery(
        db,
        "delivery-1",
        "ping",
        "2026-01-01T00:10:00.000Z",
      ),
    ).toBe(false);
  });

  it("finalizes a webhook bound GitHub install once without burning pending state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-github-complete-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.prepare(
      `INSERT INTO principals
       (id, tenant_id, kind, subject, display_name, created_at)
       VALUES ('principal-a', 'tenant_default', 'human', 'user-a', 'User A', ?)`,
    ).run("2026-01-01T00:00:00.000Z");
    db.raw.prepare(
      `INSERT INTO consumers
       (id, name, github_owner, github_repo, installation_id, tenant_id, created_at)
       VALUES ('consumer-a', 'Customer', 'gondalaimafia', 'private-repo', NULL,
               'tenant_default', ?)`,
    ).run("2026-01-01T00:00:00.000Z");
    createGitHubInstallState(db, {
      state: "s".repeat(43),
      tenantId: "tenant_default",
      principalId: "principal-a",
      expectedAccountId: "7123456",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    const input = {
      state: "s".repeat(43),
      tenantId: "tenant_default",
      principalId: "principal-a",
      installationId: "12345",
      setupAction: "install" as const,
      now: "2026-01-01T00:01:00.000Z",
    };
    expect(completeGitHubInstallState(db, input)).toEqual({ status: "pending" });
    const stateBeforeWebhook = db.raw.prepare(
      `SELECT consumed_at FROM github_install_states`,
    ).get() as { consumed_at: string | null };
    expect(stateBeforeWebhook.consumed_at).toBeNull();

    upsertGitHubInstallation(db, {
      id: "installation-a",
      installationId: "12345",
      accountId: "7123456",
      accountLogin: "gondalaimafia",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 99, owner: "gondalaimafia", name: "private-repo" }],
      createdAt: input.now,
      updatedAt: input.now,
    });
    expect(completeGitHubInstallState(db, input)).toEqual({ status: "pending" });

    upsertGitHubInstallation(db, {
      id: "installation-a",
      installationId: "12345",
      accountId: "7123456",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 100, owner: "gondalaimafia", name: "another-repo" }],
      createdAt: input.now,
      updatedAt: input.now,
    });
    expect(completeGitHubInstallState(db, input)).toEqual({
      status: "repository_scope_incomplete",
    });
    upsertGitHubInstallation(db, {
      id: "installation-a",
      installationId: "12345",
      accountId: "7123456",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 99, owner: "gondalaimafia", name: "private-repo" }],
      createdAt: input.now,
      updatedAt: input.now,
    });
    expect(completeGitHubInstallState(db, input).status).toBe("completed");
    expect(
      completeGitHubInstallState(db, {
        ...input,
        now: "2027-01-01T00:00:00.000Z",
      }).status,
    ).toBe("replayed");
    const consumer = db.raw.prepare(
      `SELECT installation_id FROM consumers WHERE id = 'consumer-a'`,
    ).get() as { installation_id: string | null };
    expect(consumer.installation_id).toBe("12345");
    expect(
      listAudit(db, "tenant_default").filter(
        (event) => event.action === "installation.completed",
      ),
    ).toHaveLength(1);
    expect(
      completeGitHubInstallState(db, {
        ...input,
        principalId: "principal-b",
      }),
    ).toEqual({ status: "invalid" });
  });

  it("rejects a stable account mismatch without consuming install state", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-github-account-mismatch-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    createGitHubInstallState(db, {
      state: "a".repeat(43),
      tenantId: "tenant_default",
      principalId: "principal-a",
      expectedAccountId: "7123456",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    upsertGitHubInstallation(db, {
      id: "installation-mismatch",
      installationId: "92345",
      accountId: "8123456",
      accountLogin: "recycled-login",
      tenantId: "tenant_default",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 99, owner: "recycled-login", name: "private-repo" }],
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    const input = {
      state: "a".repeat(43),
      tenantId: "tenant_default",
      principalId: "principal-a",
      installationId: "92345",
      setupAction: "install" as const,
      now: "2026-01-01T00:02:00.000Z",
    };
    expect(completeGitHubInstallState(db, input)).toEqual({
      status: "account_identity_mismatch",
    });
    expect(completeGitHubInstallState(db, input)).toEqual({
      status: "account_identity_mismatch",
    });
    expect(db.raw.prepare(
      "SELECT consumed_at FROM github_install_states",
    ).get()).toEqual({ consumed_at: null });
  });

  it("completes a verified first installation before a consumer is created", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-github-first-install-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.prepare(
      `INSERT INTO principals
       (id, tenant_id, kind, subject, display_name, created_at)
       VALUES ('principal-first', 'tenant_default', 'human', 'user-first', 'First User', ?)`,
    ).run("2026-01-01T00:00:00.000Z");
    createGitHubInstallState(db, {
      state: "f".repeat(43),
      tenantId: "tenant_default",
      principalId: "principal-first",
      expectedAccountId: "7123456",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:10:00.000Z",
    });
    upsertGitHubInstallation(db, {
      id: "installation-first",
      installationId: "54321",
      accountId: "7123456",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      repositorySelection: "all",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
        checks: "read",
      },
      repositories: [{ id: 99, owner: "gondalaimafia", name: "private-repo" }],
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
    expect(
      completeGitHubInstallState(db, {
        state: "f".repeat(43),
        tenantId: "tenant_default",
        principalId: "principal-first",
        installationId: "54321",
        setupAction: "install",
        now: "2026-01-01T00:02:00.000Z",
      }).status,
    ).toBe("completed");
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "gondalaimafia",
        "private-repo",
      )?.installation_id,
    ).toBe("54321");
    upsertGitHubInstallation(db, {
      id: "installation-first",
      installationId: "54321",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      suspendedAt: "2026-01-01T00:03:00.000Z",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:03:00.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "gondalaimafia",
        "private-repo",
      ),
    ).toBeUndefined();
    upsertGitHubInstallation(db, {
      id: "installation-first",
      installationId: "54321",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:04:00.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "gondalaimafia",
        "private-repo",
      ),
    ).toBeUndefined();
    upsertGitHubInstallation(db, {
      id: "installation-first",
      installationId: "54321",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      suspendedAt: null,
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "gondalaimafia",
        "private-repo",
      )?.installation_id,
    ).toBe("54321");
    upsertGitHubInstallation(db, {
      id: "installation-first",
      installationId: "54321",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      deletedAt: "2026-01-01T00:06:00.000Z",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:06:00.000Z",
    });
    upsertGitHubInstallation(db, {
      id: "installation-first",
      installationId: "54321",
      accountLogin: "gondalaimafia",
      tenantId: "tenant_default",
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:07:00.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "gondalaimafia",
        "private-repo",
      ),
    ).toBeUndefined();
  });

  it("keeps terminal installation events monotonic when they arrive first", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-github-terminal-first-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    const permissions = {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      checks: "read",
    };
    const repositories = [{ id: 77, owner: "acme", name: "shop" }];

    upsertGitHubInstallation(db, {
      id: "suspended-first",
      installationId: "70001",
      accountId: "7123456",
      accountLogin: "acme",
      tenantId: "tenant_default",
      suspendedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    upsertGitHubInstallation(db, {
      id: "stale-created",
      installationId: "70001",
      accountId: "7123456",
      accountLogin: "acme",
      tenantId: "tenant_default",
      permissions,
      repositories,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "acme",
        "shop",
      ),
    ).toBeUndefined();
    upsertGitHubInstallation(db, {
      id: "unsuspended",
      installationId: "70001",
      accountId: "7123456",
      accountLogin: "acme",
      tenantId: "tenant_default",
      suspendedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "acme",
        "shop",
      )?.installation_id,
    ).toBe("70001");

    upsertGitHubInstallation(db, {
      id: "deleted-first",
      installationId: "70002",
      accountId: "7123456",
      accountLogin: "acme",
      tenantId: "tenant_default",
      deletedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    upsertGitHubInstallation(db, {
      id: "stale-created-after-delete",
      installationId: "70002",
      accountId: "7123456",
      accountLogin: "acme",
      tenantId: "tenant_default",
      permissions,
      repositories: [{ id: 78, owner: "acme", name: "deleted-shop" }],
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(
      findAuthorizedGitHubInstallationForRepository(
        db,
        "tenant_default",
        "acme",
        "deleted-shop",
      ),
    ).toBeUndefined();
  });

  it("matches webhook pull requests only by stable GitHub identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-pr-identity-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const at = nowIso();
    for (const suffix of ["a", "b"]) {
      db.raw
        .prepare(
          `INSERT INTO consumers
           (id, name, github_owner, github_repo, tenant_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(`consumer-${suffix}`, suffix, "acme", `repo-${suffix}`, `tenant-${suffix}`, at);
      db.raw
        .prepare(
          `INSERT INTO migration_prs
           (id, change_id, consumer_id, title, body, branch_name, status, risk, patch_unified,
            github_pr_number, github_repository_id, github_installation_id, github_account_id,
            created_at)
           VALUES (?, 'change-1', ?, ?, '', ?, 'open', 'breaking', '', 7, ?, ?, ?, ?)`,
        )
        .run(
          `pr-${suffix}`,
          `consumer-${suffix}`,
          `title-${suffix}`,
          `branch-${suffix}`,
          suffix === "a" ? "77" : "88",
          suffix === "a" ? "70001" : "70002",
          suffix === "a" ? "7123456" : "8123456",
          at,
        );
    }
    expect(
      findPrByGitHubIdentityAndNumber(db, {
        repositoryId: "88",
        installationId: "70002",
        accountId: "8123456",
        number: 7,
      })?.id,
    ).toBe("pr-b");
    expect(
      findPrByGitHubIdentityAndNumber(db, {
        repositoryId: "77",
        installationId: "70002",
        accountId: "8123456",
        number: 7,
      }),
    ).toBeUndefined();
    expect(() =>
      updateMigrationPrDelivery(db, "pr-b", {
        status: "draft",
        githubPrNumber: 7,
        githubRepositoryId: "88",
        githubInstallationId: "70002",
        githubAccountId: "8123456",
      }),
    ).not.toThrow();
    expect(() =>
      updateMigrationPrDelivery(db, "pr-b", {
        status: "draft",
        githubPrNumber: 7,
        githubRepositoryId: "99",
        githubInstallationId: "70002",
        githubAccountId: "8123456",
      }),
    ).toThrow("migration_pr_delivery_identity_mismatch");
    expect(() =>
      updateMigrationPrDelivery(db, "pr-b", {
        status: "draft",
        githubPrNumber: 8,
        githubRepositoryId: "88",
        githubInstallationId: "70002",
        githubAccountId: "8123456",
      }),
    ).toThrow("migration_pr_delivery_identity_mismatch");
    expect(() =>
      db.raw.prepare(
        "UPDATE migration_prs SET github_account_id = '9999999' WHERE id = 'pr-b'",
      ).run(),
    ).toThrow("migration_pr_delivery_identity_immutable");

    db.raw.prepare(
      `INSERT INTO migration_prs
       (id, change_id, consumer_id, title, body, branch_name, status, risk,
        patch_unified, github_pr_number, github_repository_id,
        github_installation_id, github_account_id, created_at)
       VALUES
       ('pr-duplicate', 'change-1', 'consumer-a', 'duplicate', '', 'duplicate',
        'open', 'breaking', '', 7, '88', '70002', '8123456', ?)`,
    ).run(at);
    expect(
      findPrByGitHubIdentityAndNumber(db, {
        repositoryId: "88",
        installationId: "70002",
        accountId: "8123456",
        number: 7,
      }),
    ).toBeUndefined();
  });

  it("deduplicates provider versions atomically by content", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-version-content-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");
    const db = createDb(path);
    const peer = createDb(path);
    dbs.push(db, peer);
    const at = nowIso();
    insertProvider(db, {
      id: "provider-1",
      slug: "provider-1",
      name: "Provider",
      createdAt: at,
    });
    const first = insertApiVersionIfAbsent(db, {
      id: "version-a",
      providerId: "provider-1",
      versionLabel: "a",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: at,
    });
    const duplicate = insertApiVersionIfAbsent(peer, {
      id: "version-b",
      providerId: "provider-1",
      versionLabel: "b",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: at,
    });
    expect(first.inserted).toBe(true);
    expect(duplicate).toEqual({
      inserted: false,
      id: "version-a",
      contentHash: first.contentHash,
    });
    const count = db.raw
      .prepare(`SELECT COUNT(*) AS count FROM api_versions WHERE provider_id = ?`)
      .get("provider-1") as { count: number };
    expect(count.count).toBe(1);
  });

  it("boots on a pre-routing-ledger schema and converges to the fresh shape", () => {
    // Pre-change production shape: a database created before the routing ledger
    // tables existed. createDb runs the static DDL (CREATE TABLE IF NOT EXISTS)
    // before migrations, so booting must add the new tables + indexes and never
    // throw "no such column" from a dependent index.
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    // A minimal legacy database with none of the routing tables present.
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);
    legacy.close();

    const migrated = createDb(legacyPath);
    dbs.push(migrated);

    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
        .map((i) => i.name)
        .sort();

    for (const table of [
      "routing_ledger",
      "routing_executor_health",
      "routing_outcome_applications",
      "repository_snapshot_files",
      "fettler_ci_cycles",
      "fettler_ci_observations",
      "fettler_ci_updates",
    ]) {
      expect(columnsOf(migrated, table)).toEqual(columnsOf(fresh, table));
      expect(indexesOf(migrated, table)).toEqual(indexesOf(fresh, table));
    }
    expect(columnsOf(migrated, "routing_ledger")).toContain("selected_executor_id");
    // The migrated database must be writable through the new ledger path.
    expect(() =>
      recordRoutingDecision(migrated, {
        tenantId: "tenant_default",
        jobId: "job-boot",
        taskKind: "warden.attempt",
        envelopeId: "route-boot",
        policySnapshotId: "policy-1",
        taskSnapshotId: "task-1",
        action: "execute",
        selectedExecutorId: "warden-attempt",
        providerId: "mendpoint-internal",
        eliminated: [],
        fallback: [],
        breaker: [],
        handoffRequired: false,
        decision: {},
      }),
    ).not.toThrow();
  });

  it("boots on a pre-adaptive-candidate schema and converges to the fresh shape", () => {
    // Pre-change production shape: a database created before the transformer
    // adaptive candidate review table existed. createDb runs the static DDL
    // (CREATE TABLE IF NOT EXISTS) before migrations, so booting must add the
    // new table + index and never throw "no such column" from a dependent index.
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-db-adaptive-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        error TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);
    legacy.close();

    const migrated = createDb(legacyPath);
    dbs.push(migrated);

    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-db-adaptive-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
        .map((i) => i.name)
        .sort();

    const table = "regauge_adaptive_candidates";
    expect(columnsOf(migrated, table)).toEqual(columnsOf(fresh, table));
    expect(indexesOf(migrated, table)).toEqual(indexesOf(fresh, table));
    expect(columnsOf(migrated, table)).toContain("candidate_digest");
    // The migrated database must be writable through the new review-state path.
    expect(() =>
      recordAdaptiveCandidate(migrated, {
        tenantId: "tenant_default",
        campaignId: "campaign-boot",
        unitId: "unit-boot",
        attemptId: "tfattempt_boot",
        repositoryId: "repo-boot",
        snapshotId: "snapshot-boot",
        baseBranch: "main",
        expectedBaseRevision: "e".repeat(40),
        divergedFromDigest: `sha256:${"1".repeat(64)}`,
        candidateDigest: `sha256:${"2".repeat(64)}`,
        failingCommandId: "verify:boot",
        sealedPath: "/data/x.json",
        sealedSha256: `sha256:${"3".repeat(64)}`,
        changedPaths: ["package.json"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("boots a pre-graph_path impact_findings schema and converges to the fresh shape (FET-016)", () => {
    // Pre-change production shape: impact_findings created before the FET-016
    // graph_path column existed. createDb runs the static DDL (CREATE TABLE IF
    // NOT EXISTS) — the table already exists, so the column can only arrive via
    // the additive migration. Booting must add it and converge byte-for-byte
    // with a fresh install; this proves upgrade convergence, not merely fresh.
    const legacyDir = mkdtempSync(join(tmpdir(), "mendpoint-db-graphpath-legacy-"));
    dirs.push(legacyDir);
    const legacyPath = join(legacyDir, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE impact_findings (
        id TEXT PRIMARY KEY,
        change_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );
      INSERT INTO impact_findings
        (id, change_id, consumer_id, file_path, line_start, line_end, symbol, confidence, evidence_json)
        VALUES ('legacy-finding', 'change-1', 'consumer-1', 'legacy.ts', 1, 1, 'source', 'high', '{}');
    `);
    legacy.close();

    const migrated = createDb(legacyPath);
    dbs.push(migrated);

    const freshDir = mkdtempSync(join(tmpdir(), "mendpoint-db-graphpath-fresh-"));
    dirs.push(freshDir);
    const fresh = createDb(join(freshDir, "fresh.sqlite"));
    dbs.push(fresh);

    const columnsOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();
    const indexesOf = (db: { raw: DatabaseSync }, table: string) =>
      (db.raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
        .map((i) => i.name)
        .sort();

    expect(columnsOf(migrated, "impact_findings")).toEqual(columnsOf(fresh, "impact_findings"));
    expect(indexesOf(migrated, "impact_findings")).toEqual(indexesOf(fresh, "impact_findings"));
    expect(columnsOf(migrated, "impact_findings")).toContain("graph_path_json");

    // The legacy row survives and reads as "not computed" (null), never a
    // fabricated empty path.
    const legacyRow = migrated.raw
      .prepare(`SELECT graph_path_json FROM impact_findings WHERE id = 'legacy-finding'`)
      .get() as { graph_path_json: string | null };
    expect(legacyRow.graph_path_json).toBeNull();
  });

  it("round-trips a finding graph_path through insert and the API projection (FET-016)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-graphpath-roundtrip-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const at = nowIso();
    db.raw
      .prepare(
        `INSERT INTO consumers (id, name, github_owner, github_repo, tenant_id, created_at)
         VALUES ('consumer-rt', 'rt', 'owner', 'repo', 'tenant-rt', ?)`,
      )
      .run(at);

    const graphPath = {
      nodes: ["client.ts", "wrapper.ts", "app.ts"],
      hops: 2,
      terminal: "anchor" as const,
      truncated: false,
      coverage: "complete" as const,
    };
    insertImpactFinding(db, {
      id: newId(),
      changeId: "change-rt",
      consumerId: "consumer-rt",
      filePath: "app.ts",
      lineStart: 10,
      lineEnd: 10,
      symbol: "source",
      confidence: "high",
      evidenceJson: "{}",
      graphPathJson: JSON.stringify(graphPath),
    });
    // A second finding with no computed path stays null and projects as null.
    insertImpactFinding(db, {
      id: newId(),
      changeId: "change-rt",
      consumerId: "consumer-rt",
      filePath: "loose.ts",
      lineStart: 3,
      lineEnd: 3,
      symbol: "source",
      confidence: "low",
      evidenceJson: "{}",
    });

    const projected = listFindingsForChange(db, "change-rt").map(findingToApi);
    const app = projected.find((f) => f.filePath === "app.ts")!;
    const loose = projected.find((f) => f.filePath === "loose.ts")!;
    expect(app.graphPath).toEqual(graphPath);
    expect(loose.graphPath).toBeNull();
  });

  it("upgrades existing adaptive rows and backfills the immutable base branch", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-adaptive-branch-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const seeded = createDb(path);
    seeded.raw.exec(`
      INSERT INTO scm_connections
        (id, tenant_id, provider, credential_ref, external_account_id, display_name,
         created_at, updated_at, revoked_at)
      VALUES ('connection-upgrade', 'tenant-upgrade', 'github', 'env://GITHUB_TOKEN',
              '123', 'Upgrade', '2026-08-06T00:00:00.000Z',
              '2026-08-06T00:00:00.000Z', NULL);
      INSERT INTO connected_repositories
        (id, tenant_id, connection_id, remote_id, owner, name, default_branch,
         selected_branch, environment, retention_days, status, created_at, updated_at)
      VALUES ('repository-upgrade', 'tenant-upgrade', 'connection-upgrade', '456',
              'acme', 'upgrade', 'main', 'release', 'production', 30, 'ready',
              '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z');
      INSERT INTO repository_snapshots
        (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
         storage_path, submodules_policy, lfs_policy, sparse_paths_json, created_at, expires_at)
      VALUES ('snapshot-upgrade', 'tenant-upgrade', 'repository-upgrade', 'release',
              '${"a".repeat(40)}', '${"b".repeat(64)}', 'C:/snapshot-upgrade',
              'reject', 'reject', '[]', '2026-08-06T00:00:00.000Z',
              '2026-09-06T00:00:00.000Z');
      INSERT INTO regauge_adaptive_candidates
        (id, tenant_id, campaign_id, unit_id, attempt_id, repository_id, snapshot_id,
         base_branch, expected_base_revision, kind, status, diverged_from_digest,
         candidate_digest, failing_command_id, sealed_path, sealed_sha256,
         changed_paths_json, reviewer_principal_id, review_decision, reviewed_at,
         promoted_at, expires_at, created_at, updated_at)
      VALUES ('candidate-upgrade', 'tenant-upgrade', 'campaign-upgrade', 'unit-upgrade',
              'attempt-upgrade', 'repository-upgrade', 'snapshot-upgrade', 'release',
              '${"a".repeat(40)}', 'adaptive', 'approved', 'sha256:${"c".repeat(64)}',
              'sha256:${"d".repeat(64)}', 'verify', 'C:/seal.json',
              'sha256:${"e".repeat(64)}', '["package.json"]', 'reviewer-upgrade',
              'approve', '2026-08-06T00:01:00.000Z', NULL,
              '2026-09-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z',
              '2026-08-06T00:01:00.000Z');
      INSERT INTO regauge_adaptive_deliveries
        (id, tenant_id, candidate_id, job_id, status, repository_id, snapshot_id,
         base_branch, expected_base_revision, requester_principal_id, requested_at, updated_at)
      VALUES ('delivery-upgrade', 'tenant-upgrade', 'candidate-upgrade', 'job-upgrade',
              'delivery_pending', 'repository-upgrade', 'snapshot-upgrade', 'release',
              '${"a".repeat(40)}', 'reviewer-upgrade', '2026-08-06T00:01:00.000Z',
              '2026-08-06T00:01:00.000Z');
    `);
    seeded.raw.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      ALTER TABLE regauge_adaptive_deliveries DROP COLUMN base_branch;
      ALTER TABLE regauge_adaptive_candidates DROP COLUMN base_branch;
    `);
    legacy.close();

    const migrated = createDb(path);
    dbs.push(migrated);
    expect(migrated.raw.prepare(
      "SELECT base_branch FROM regauge_adaptive_candidates WHERE id = 'candidate-upgrade'",
    ).get()).toEqual({ base_branch: "release" });
    expect(migrated.raw.prepare(
      "SELECT base_branch FROM regauge_adaptive_deliveries WHERE id = 'delivery-upgrade'",
    ).get()).toEqual({ base_branch: "release" });
  });

  it("persists a routing decision and outcome queryable per job and run", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-ledger-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);

    recordRoutingDecision(db, {
      tenantId: "tenant_default",
      jobId: "job-1",
      runId: "run-1",
      taskKind: "warden.attempt",
      envelopeId: "route_dec_1",
      policySnapshotId: "policy-1",
      taskSnapshotId: "task-1",
      action: "execute",
      selectedExecutorId: "warden-attempt",
      providerId: "mendpoint-internal",
      eliminated: [{ executorId: "slow", reasons: ["latency_exceeded"] }],
      fallback: [{ executorId: "backup" }],
      breaker: [],
      handoffRequired: false,
      decision: { decisionId: "route_dec_1" },
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    const updated = recordRoutingOutcome(db, {
      tenantId: "tenant_default",
      jobId: "job-1",
      envelopeId: "route_dec_1",
      action: "completed",
      outcome: "succeeded",
      costUsd: 0.42,
      totalTokens: 1200,
      startedAt: "2026-08-01T12:00:00.000Z",
      completedAt: "2026-08-01T12:00:02.000Z",
      observedAt: "2026-08-01T12:00:02.000Z",
    });
    expect(updated).toBe(true);

    const byJob = getRoutingLedgerForJob(db, "job-1", "tenant_default");
    expect(byJob).toHaveLength(1);
    expect(byJob[0]!.selected_executor_id).toBe("warden-attempt");
    expect(byJob[0]!.outcome).toBe("succeeded");
    expect(byJob[0]!.cost_usd).toBe(0.42);
    expect(byJob[0]!.total_tokens).toBe(1200);
    expect(JSON.parse(byJob[0]!.eliminated_json)).toEqual([
      { executorId: "slow", reasons: ["latency_exceeded"] },
    ]);
    expect(JSON.parse(byJob[0]!.fallback_json)).toEqual([{ executorId: "backup" }]);

    const byRun = listRoutingLedgerForRun(db, "run-1", "tenant_default");
    expect(byRun.map((r) => r.envelope_id)).toEqual(["route_dec_1"]);
  });

  it("records the executed executor id on the outcome, readable per run", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-executed-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);

    recordRoutingDecision(db, {
      tenantId: "tenant_default",
      jobId: "job-exec",
      runId: "run-exec",
      taskKind: "warden.attempt",
      envelopeId: "route_exec_1",
      policySnapshotId: "policy-1",
      taskSnapshotId: "task-1",
      action: "execute",
      selectedExecutorId: "warden-attempt",
      providerId: "mendpoint-internal",
      eliminated: [],
      fallback: [],
      breaker: [],
      handoffRequired: false,
      decision: { decisionId: "route_exec_1" },
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    // The executor that actually ran is observed at outcome time. The exactly-once
    // seam is the only production writer, so drive it here to prove the id it
    // already receives now lands in the durable ledger row.
    const applied = recordRoutingOutcomeExactlyOnce(db, {
      tenantId: "tenant_default",
      jobId: "job-exec",
      envelopeId: "route_exec_1",
      idempotencyKey: "idem-exec-1",
      idempotencyPayload: { outcome: "succeeded" },
      executorId: "warden-attempt",
      providerId: "mendpoint-internal",
      breakerFeedback: "success",
      action: "completed",
      outcome: "succeeded",
      observedAt: "2026-08-01T12:00:02.000Z",
    });
    expect(applied).toBe(true);

    const byRun = listRoutingLedgerForRun(db, "run-exec", "tenant_default");
    expect(byRun).toHaveLength(1);
    expect(byRun[0]!.selected_executor_id).toBe("warden-attempt");
    expect(byRun[0]!.executed_executor_id).toBe("warden-attempt");
  });

  it("leaves executed_executor_id NULL when the caller observed no executor", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-noexec-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);

    recordRoutingDecision(db, {
      tenantId: "tenant_default",
      jobId: "job-noexec",
      runId: "run-noexec",
      taskKind: "warden.attempt",
      envelopeId: "route_noexec_1",
      policySnapshotId: "policy-1",
      taskSnapshotId: "task-1",
      action: "execute",
      selectedExecutorId: "warden-attempt",
      providerId: "mendpoint-internal",
      eliminated: [],
      fallback: [],
      breaker: [],
      handoffRequired: false,
      decision: { decisionId: "route_noexec_1" },
      createdAt: "2026-08-01T12:00:00.000Z",
    });

    // No executorId supplied: the executed executor was not observed. It must
    // stay NULL ("not observed"), never a copy of selected_executor_id.
    const updated = recordRoutingOutcome(db, {
      tenantId: "tenant_default",
      jobId: "job-noexec",
      envelopeId: "route_noexec_1",
      action: "completed",
      outcome: "succeeded",
      observedAt: "2026-08-01T12:00:02.000Z",
    });
    expect(updated).toBe(true);

    const byJob = getRoutingLedgerForJob(db, "job-noexec", "tenant_default");
    expect(byJob).toHaveLength(1);
    expect(byJob[0]!.selected_executor_id).toBe("warden-attempt");
    expect(byJob[0]!.executed_executor_id).toBeNull();
  });

  it("adds executed_executor_id to a routing_ledger that predates the column", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-converge-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");

    // Build a database on the current schema, then drop the new column to
    // reproduce a volume created before it existed (ensureTables never alters,
    // so a column missing from the additive list would be permanently absent).
    const seeded = createDb(path);
    seeded.raw.exec(`ALTER TABLE routing_ledger DROP COLUMN executed_executor_id;`);
    seeded.raw.close();

    const legacy = new DatabaseSync(path);
    expect(
      legacy
        .prepare("PRAGMA table_info(routing_ledger)")
        .all()
        .some((c) => (c as { name: string }).name === "executed_executor_id"),
    ).toBe(false);
    legacy.close();

    // Reopening runs ensureTables, whose additive migration must re-add it.
    const migrated = createDb(path);
    dbs.push(migrated);
    expect(
      migrated.raw
        .prepare("PRAGMA table_info(routing_ledger)")
        .all()
        .some((c) => (c as { name: string }).name === "executed_executor_id"),
    ).toBe(true);
  });

  it("records a handoff decision and isolates the ledger across tenants", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-tenant-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);

    for (const tenant of ["tenant_a", "tenant_b"]) {
      recordRoutingDecision(db, {
        tenantId: tenant,
        jobId: "job-shared",
        runId: "run-shared",
        taskKind: "warden.attempt",
        envelopeId: `route_${tenant}`,
        policySnapshotId: "policy-1",
        taskSnapshotId: "task-1",
        action: "human_handoff",
        handoffRequired: true,
        handoffReason: "high_risk",
        eliminated: [],
        fallback: [],
        breaker: [],
        decision: {},
      });
    }

    const a = getRoutingLedgerForJob(db, "job-shared", "tenant_a");
    expect(a).toHaveLength(1);
    expect(a[0]!.envelope_id).toBe("route_tenant_a");
    expect(a[0]!.handoff_required).toBe(1);
    expect(a[0]!.handoff_reason).toBe("high_risk");
    // A cross-tenant read never sees another tenant's decision.
    expect(getRoutingLedgerForJob(db, "job-shared", "tenant_b").map((r) => r.envelope_id))
      .toEqual(["route_tenant_b"]);
    expect(listRoutingLedgerForRun(db, "run-shared", "tenant_a")).toHaveLength(1);
  });

  it("flips breaker state from outcome feedback and stays bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-breaker-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    const at = new Date("2026-08-01T12:00:00.000Z");
    const config = DEFAULT_ROUTING_BREAKER;
    const feed = (success: boolean) =>
      recordRoutingExecutorOutcome(db, {
        tenantId: "tenant_default",
        executorId: "warden-attempt",
        providerId: "mendpoint-internal",
        success,
        observedAt: at.toISOString(),
        config,
      });

    let availability = loadRoutingAvailability(db, "tenant_default", at, config);
    expect(availability.allows("warden-attempt", "mendpoint-internal")).toBe(true);

    // Three consecutive failures open the executor breaker.
    feed(false);
    feed(false);
    feed(false);
    availability = loadRoutingAvailability(db, "tenant_default", at, config);
    expect(availability.allows("warden-attempt", "mendpoint-internal")).toBe(false);

    // After the open window elapses, the breaker allows a probe (half-open).
    const later = new Date(at.getTime() + config.openDurationMs + 1);
    expect(
      loadRoutingAvailability(db, "tenant_default", later, config).allows(
        "warden-attempt",
        "mendpoint-internal",
      ),
    ).toBe(true);

    // A success clears the rows entirely (bounded growth).
    feed(true);
    expect(loadRoutingBreakerSnapshot(db, "tenant_default", at, config)).toHaveLength(0);
    expect(
      loadRoutingAvailability(db, "tenant_default", at, config).allows(
        "warden-attempt",
        "mendpoint-internal",
      ),
    ).toBe(true);
  });

  it("re-opens the breaker after a failed half-open probe past the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-db-route-breaker-reopen-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    dbs.push(db);
    const t0 = new Date("2026-08-01T12:00:00.000Z");
    const config = DEFAULT_ROUTING_BREAKER;
    const feed = (success: boolean, at: Date) =>
      recordRoutingExecutorOutcome(db, {
        tenantId: "tenant_default",
        executorId: "warden-attempt",
        providerId: "mendpoint-internal",
        success,
        observedAt: at.toISOString(),
        config,
      });

    // Three failures at t0 open the breaker.
    feed(false, t0);
    feed(false, t0);
    feed(false, t0);
    expect(
      loadRoutingAvailability(db, "tenant_default", t0, config).allows(
        "warden-attempt",
        "mendpoint-internal",
      ),
    ).toBe(false);

    // After the window elapses the breaker half-opens and allows a probe.
    const halfOpen = new Date(t0.getTime() + config.openDurationMs + 1);
    expect(
      loadRoutingAvailability(db, "tenant_default", halfOpen, config).allows(
        "warden-attempt",
        "mendpoint-internal",
      ),
    ).toBe(true);

    // The half-open probe fails past the original window. The breaker must
    // re-open by advancing its window, not stay available for the outage.
    const probeFailure = new Date(t0.getTime() + config.openDurationMs + 5);
    feed(false, probeFailure);
    expect(
      loadRoutingAvailability(db, "tenant_default", probeFailure, config).allows(
        "warden-attempt",
        "mendpoint-internal",
      ),
    ).toBe(false);
    // Each outcome records an executor-scope and a provider-scope row; both must
    // re-open with the advanced window.
    const snapshot = loadRoutingBreakerSnapshot(db, "tenant_default", probeFailure, config);
    expect(snapshot).toHaveLength(2);
    expect(snapshot.every((row) => row.open)).toBe(true);
    expect(snapshot.every((row) => row.openedAt === probeFailure.toISOString())).toBe(true);

    // A success after the window clears the row entirely.
    const recovery = new Date(probeFailure.getTime() + 1);
    feed(true, recovery);
    expect(loadRoutingBreakerSnapshot(db, "tenant_default", recovery, config)).toHaveLength(0);
  });
});
