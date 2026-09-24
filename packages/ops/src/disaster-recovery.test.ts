import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, parse, resolve } from "node:path";
import { hostname, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createDb, createDependencyOutageQueue } from "@mendpoint/db";
import {
  assessRecoveryDrillCadence,
  createApplicationConsistentBackup,
  customerBackupInputFromEnv,
  CORE_DISASTER_RECOVERY_POLICY,
  createBackupBundle,
  initializeWithMutationLease,
  inspectMutationFence,
  isBackupFenceActive,
  mutationMarkerOwnerTermination,
  REGAUGE_CUTOVER_FENCE_NAME,
  reapOrphanedMutationMarkers,
  recoverStaleMutationMarker,
  resolveMutationFenceRoot,
  restoreBackupAtomically,
  runIsolatedRecoveryDrill,
  tryAcquireMutationLease,
  validateCustomerRestorePathSafety,
  verifyBackupBundle,
  verifyRecoveryDrillReport,
  waitForMutationFenceRelease,
  type DisasterRecoveryPolicy,
} from "./disaster-recovery.js";
import { inspectRegaugeCutoverFence } from "./regauge-cutover.js";

const BACKUP_KEY = Buffer.alloc(32, 0x5a);
const WRONG_BACKUP_KEY = Buffer.alloc(32, 0x6b);
const BACKUP_KEY_ID = "customer-backup-key-v1";
// Repo root: this file lives at packages/ops/src, and a `--import tsx` child must run
// from the root so `@mendpoint/ops` resolves via the workspace symlink.
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const CUTOVER_TRANSFER_KEY_HEX = "ab".repeat(32);
const RETAINED_ARTIFACT_ROOTS = [
  "warden-candidates",
  "warden-evidence",
  "transformer-candidates",
  "transformer-evidence",
] as const;
const TEST_RESOURCES = {
  database: "database.sqlite",
  graph: "graph.sqlite",
  changeSources: "change-sources.sqlite",
  transformerControlPlane: "transformer-control-plane.sqlite",
  transformerPilot: "transformer-pilot.sqlite",
  artifacts: "artifacts",
  configuration: "config.json",
} as const;

function createSqlite(path: string, table: string, value = "sentinel-customer-value"): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ${table} (value TEXT NOT NULL); INSERT INTO ${table} VALUES ('${value}')`);
  } finally {
    db.close();
  }
}

function secureFixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-dr-secure-"));
  roots.push(root);
  const source = join(root, "source");
  for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
    mkdirSync(join(source, "artifacts", retainedRoot), { recursive: true });
  }
  createSqlite(join(source, "mendpoint.sqlite"), "main_state");
  createSqlite(join(source, "graph-learn.sqlite"), "graph_state");
  createSqlite(join(source, "change-sources.sqlite"), "change_state");
  createSqlite(join(source, "transformer-control-plane.sqlite"), "control_state");
  createSqlite(join(source, "transformer-pilot.sqlite"), "pilot_state");
  writeFileSync(
    join(source, "artifacts", "warden-evidence", "result.json"),
    '{"secret":"sentinel-customer-value"}',
  );
  writeFileSync(join(source, "recovery-config.json"), '{"region":"primary","sentinel":"sentinel-customer-value"}');
  return {
    root,
    source,
    backup: join(root, "backup"),
    restore: join(root, "restore"),
    resources: {
      database: "mendpoint.sqlite",
      graph: "graph-learn.sqlite",
      changeSources: "change-sources.sqlite",
      transformerControlPlane: "transformer-control-plane.sqlite",
      transformerPilot: "transformer-pilot.sqlite",
      artifacts: "artifacts",
      configuration: "recovery-config.json",
    } as const,
  };
}

function allFileContents(root: string): Buffer[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? allFileContents(path) : [readFileSync(path)];
  });
}

const POLICY = Object.freeze({
  schemaVersion: 1,
  policyId: "mendpoint-core",
  version: "2026-08-02",
  effectiveAt: "2026-08-02T00:00:00.000Z",
  rtoSeconds: 900,
  rpoSeconds: 3600,
  drillCadenceDays: 30,
  requiredResources: Object.freeze([
    "artifacts",
    "changeSources",
    "configuration",
    "database",
    "graph",
    "transformerControlPlane",
    "transformerPilot",
  ] as const),
}) satisfies DisasterRecoveryPolicy;

const roots: string[] = [];

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test_wait_timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-dr-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
    mkdirSync(join(source, "artifacts", retainedRoot), { recursive: true });
  }
  createSqlite(join(source, "database.sqlite"), "database_state", "database-v1");
  createSqlite(join(source, "graph.sqlite"), "graph_state", "graph-v1");
  createSqlite(join(source, "change-sources.sqlite"), "change_state", "change-v1");
  createSqlite(join(source, "transformer-control-plane.sqlite"), "control_state", "control-v1");
  createSqlite(join(source, "transformer-pilot.sqlite"), "pilot_state", "pilot-v1");
  writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), "{\"ok\":true}");
  writeFileSync(join(source, "config.json"), "{\"region\":\"primary\"}");
  return { root, source, backup: join(root, "backup"), restore: join(root, "restore") };
}

function customerBackupEnv(root: string): Record<string, string> {
  const sourceRoot = join(root, "source");
  return {
    MENDPOINT_DEPLOYMENT_PROFILE: "customer",
    MENDPOINT_BACKUP_SOURCE_ROOT: sourceRoot,
    MENDPOINT_BACKUP_OUTPUT_ROOT: join(root, "outside", "backups"),
    MENDPOINT_BACKUP_FENCE_ROOT: join(sourceRoot, ".backup-fence"),
    MENDPOINT_BACKUP_EVIDENCE_PATH: join(sourceRoot, ".backup-state", "last-verified.json"),
    MENDPOINT_BACKUP_STORAGE_CLASS: "durable_isolated_mount",
    MENDPOINT_BACKUP_KEY: BACKUP_KEY.toString("hex"),
    MENDPOINT_BACKUP_KEY_ID: BACKUP_KEY_ID,
    MENDPOINT_BACKUP_ID: "customer-path-safety",
    MENDPOINT_DATA_DIR: sourceRoot,
    MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
    MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
    MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
    MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
    MENDPOINT_BACKUP_REGAUGE_PILOT_PATH: "transformer-pilot.sqlite",
    MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
    MENDPOINT_BACKUP_CONFIGURATION_PATH: "config.json",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disaster recovery", () => {
  it("publishes a versioned policy with explicit RTO, RPO, scope, and drill cadence", () => {
    expect(CORE_DISASTER_RECOVERY_POLICY).toEqual(POLICY);
  });

  it("resolves one absolute mutation fence shared by backup, API, and worker processes", () => {
    const { root } = fixture();
    expect(resolveMutationFenceRoot({ MENDPOINT_BACKUP_FENCE_ROOT: join(root, "explicit") }))
      .toBe(join(root, "explicit"));
    expect(resolveMutationFenceRoot({ MENDPOINT_DATA_DIR: join(root, "data") }))
      .toBe(join(root, "data", ".backup-fence"));
    expect(() => resolveMutationFenceRoot({ MENDPOINT_BACKUP_FENCE_ROOT: "relative/fence" }))
      .toThrow("backup_fence_root_must_be_absolute");
  });

  it("builds a fail closed customer backup invocation from explicit resource paths", () => {
    const { root } = fixture();
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "outside", "backups");
    const fenceRoot = join(root, "source", ".backup-fence");
    const env = {
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_BACKUP_SOURCE_ROOT: sourceRoot,
      MENDPOINT_BACKUP_OUTPUT_ROOT: outputRoot,
      MENDPOINT_BACKUP_FENCE_ROOT: fenceRoot,
      MENDPOINT_BACKUP_EVIDENCE_PATH: join(sourceRoot, ".backup-state", "last-verified.json"),
      MENDPOINT_BACKUP_STORAGE_CLASS: "durable_isolated_mount",
      MENDPOINT_BACKUP_KEY: BACKUP_KEY.toString("hex"),
      MENDPOINT_BACKUP_KEY_ID: BACKUP_KEY_ID,
      MENDPOINT_BACKUP_ID: "customer-001",
      MENDPOINT_DATA_DIR: sourceRoot,
      MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
      MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
      MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
      MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
      MENDPOINT_BACKUP_REGAUGE_PILOT_PATH: "transformer-pilot.sqlite",
      MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
      MENDPOINT_BACKUP_CONFIGURATION_PATH: "config.json",
    };
    expect(customerBackupInputFromEnv(env, new Date("2026-08-02T01:00:00.000Z"))).toEqual({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "customer-001",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot,
      outputRoot,
      backupRoot: join(outputRoot, "customer-001"),
      fenceRoot,
      evidencePath: join(sourceRoot, ".backup-state", "last-verified.json"),
      storageClass: "durable_isolated_mount",
      requireDistinctDevice: true,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      waitTimeoutMs: 30_000,
      resources: {
        database: "mendpoint.sqlite",
        graph: "graph-learn.sqlite",
        changeSources: "change-sources.sqlite",
        transformerControlPlane: "transformer-control-plane.sqlite",
        transformerPilot: "transformer-pilot.sqlite",
        artifacts: ".",
        configuration: "config.json",
      },
    });
    expect(() => customerBackupInputFromEnv({ ...env, MENDPOINT_DEPLOYMENT_PROFILE: "pilot" }))
      .toThrow("customer_backup_profile_required");
    expect(() => customerBackupInputFromEnv({ ...env, MENDPOINT_BACKUP_ID: "../escape" }))
      .toThrow("customer_backup_id_invalid");
    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_GRAPH_PATH: "mendpoint.sqlite",
    })).toThrow("backup_resources_must_be_distinct");
    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_DATABASE_PATH: "decoy.sqlite",
    })).toThrow("customer_backup_database_runtime_path_mismatch");
    const { MENDPOINT_BACKUP_GRAPH_PATH: _missing, ...missingGraph } = env;
    expect(() => customerBackupInputFromEnv(missingGraph))
      .toThrow("customer_backup_graph_path_required");
  });

  it("rejects filesystem roots and immediate children before privileged backup preparation", () => {
    const { root } = fixture();
    const env = customerBackupEnv(root);
    const filesystemRoot = parse(root).root;

    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_OUTPUT_ROOT: filesystemRoot,
    })).toThrow("customer_backup_output_root_unsafe");

    const shallowSource = join(filesystemRoot, "mendpoint-data");
    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_SOURCE_ROOT: shallowSource,
      MENDPOINT_DATA_DIR: shallowSource,
      MENDPOINT_BACKUP_FENCE_ROOT: join(shallowSource, ".backup-fence"),
      MENDPOINT_BACKUP_EVIDENCE_PATH: join(shallowSource, ".backup-state", "last-verified.json"),
    })).toThrow("customer_backup_source_root_parent_unsafe");
  });

  it("rejects fence and evidence paths that escape through ancestors or filesystem redirects", () => {
    const { root, source } = fixture();
    const env = customerBackupEnv(root);

    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_FENCE_ROOT: dirname(source),
    })).toThrow("customer_backup_fence_outside_data_root");
    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_EVIDENCE_PATH: join(dirname(source), "last-verified.json"),
    })).toThrow("customer_backup_evidence_outside_data_root");

    const redirected = join(root, "redirected-fence");
    mkdirSync(redirected, { recursive: true });
    const redirect = join(source, "fence-redirect");
    symlinkSync(redirected, redirect, process.platform === "win32" ? "junction" : "dir");
    expect(() => customerBackupInputFromEnv({
      ...env,
      MENDPOINT_BACKUP_FENCE_ROOT: redirect,
    })).toThrow("customer_backup_fence_filesystem_redirect_rejected");
  });

  it("validates restore isolation before a privileged parent can be created or reowned", () => {
    const { root } = fixture();
    const dataRoot = join(root, "customer", "data");
    const backupRoot = join(root, "backup", "bundle");
    const targetRoot = join(root, "restore", "mendpoint");
    mkdirSync(backupRoot, { recursive: true });
    mkdirSync(dataRoot, { recursive: true });

    expect(validateCustomerRestorePathSafety({ backupRoot, targetRoot, dataRoot })).toEqual({
      backupRoot,
      targetRoot,
      targetParent: dirname(targetRoot),
      dataRoot,
    });
    expect(() => validateCustomerRestorePathSafety({
      backupRoot,
      targetRoot: parse(root).root,
      dataRoot,
    })).toThrow("customer_restore_target_root_unsafe");
    expect(() => validateCustomerRestorePathSafety({
      backupRoot,
      targetRoot: join(parse(root).root, "restore"),
      dataRoot,
    })).toThrow("customer_restore_target_parent_unsafe");
    expect(() => validateCustomerRestorePathSafety({
      backupRoot,
      targetRoot: join(root, "customer"),
      dataRoot,
    })).toThrow("customer_restore_target_data_overlap");

    const redirectedParent = join(root, "restore-redirect");
    const actualParent = join(root, "actual-restore");
    mkdirSync(actualParent, { recursive: true });
    symlinkSync(actualParent, redirectedParent, process.platform === "win32" ? "junction" : "dir");
    expect(() => validateCustomerRestorePathSafety({
      backupRoot,
      targetRoot: join(redirectedParent, "mendpoint"),
      dataRoot,
    })).toThrow("customer_restore_target_filesystem_redirect_rejected");
  });

  it("creates and verifies an atomic encrypted resource backup bundle", () => {
    const { source, backup } = fixture();
    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-001",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });

    expect(manifest.resources.map((entry) => entry.kind)).toEqual([
      "artifacts",
      "changeSources",
      "configuration",
      "database",
      "graph",
      "transformerControlPlane",
      "transformerPilot",
    ]);
    expect(manifest.resources.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(verifyBackupBundle(backup, manifest, BACKUP_KEY)).toEqual({ ok: true, issues: [] });

    const databaseCiphertext = manifest.resources.find((entry) => entry.kind === "database")!
      .encryptedFiles[0]!.ciphertextPath;
    writeFileSync(join(backup, databaseCiphertext), "tampered");
    expect(verifyBackupBundle(backup, manifest, BACKUP_KEY)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("database_ciphertext_hash_mismatch")]),
    });
  });

  it("captures a consistent live WAL database and verifies relational integrity", () => {
    const { source, backup, restore } = fixture();
    const databasePath = join(source, "database.sqlite");
    rmSync(databasePath);
    const live = new DatabaseSync(databasePath);
    try {
      live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON");
      live.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE child (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES parent(id)
        );
        INSERT INTO parent (id, value) VALUES (1, 'before'), (2, 'wal-only');
        INSERT INTO child (id, parent_id) VALUES (1, 2);
      `);

      const manifest = createBackupBundle({
        policy: POLICY,
        backupId: "backup-live-wal",
        createdAt: "2026-08-02T01:00:00.000Z",
        sourceRoot: source,
        backupRoot: backup,
        resources: TEST_RESOURCES,
        key: BACKUP_KEY,
        keyId: BACKUP_KEY_ID,
      });

      expect(verifyBackupBundle(backup, manifest, BACKUP_KEY)).toEqual({ ok: true, issues: [] });
      restoreBackupAtomically({ backupRoot: backup, targetRoot: restore, manifest, key: BACKUP_KEY });
      const restored = new DatabaseSync(join(restore, "database.sqlite"), { readOnly: true });
      try {
        expect(restored.prepare("SELECT id, value FROM parent ORDER BY id").all()).toEqual([
          { id: 1, value: "before" },
          { id: 2, value: "wal-only" },
        ]);
        expect(restored.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(restored.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        restored.close();
      }
    } finally {
      live.close();
    }
  });

  it("retains the production dependency outage queue through restart, backup, and restore", () => {
    const { source, backup, restore } = fixture();
    const databasePath = join(source, "database.sqlite");
    rmSync(databasePath);
    const app = createDb(databasePath);
    const queue = createDependencyOutageQueue(app.raw);
    const scope = {
      tenantId: "tenant-acme",
      dependencyKind: "scm" as const,
      providerId: "github",
      operationId: "github-draft:authority-proof",
      operationDigest: "b".repeat(64),
    };
    queue.enqueue({
      ...scope,
      retryBudget: 3,
      expiresAt: "2026-09-01T13:00:00.000Z",
      nextAttemptAt: "2026-09-01T12:00:00.000Z",
      standing: "degraded_blocked",
      authorityVersion: "installation-v1",
      status: "blocked",
    }, "2026-09-01T12:00:00.000Z");
    app.raw.close();

    const restarted = createDb(databasePath);
    expect(createDependencyOutageQueue(restarted.raw).get(scope)).toMatchObject({
      status: "blocked",
      authorityVersion: "installation-v1",
    });
    restarted.raw.close();

    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-outage-queue",
      createdAt: "2026-09-01T12:05:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });
    restoreBackupAtomically({ backupRoot: backup, targetRoot: restore, manifest, key: BACKUP_KEY });
    const restored = createDb(join(restore, "database.sqlite"));
    try {
      expect(createDependencyOutageQueue(restored.raw).get(scope)).toMatchObject({
        status: "blocked",
        authorityVersion: "installation-v1",
      });
    } finally {
      restored.raw.close();
    }
  });

  it("fences concurrent writers and restores database, artifact, configuration, and graph from one point", async () => {
    const { root, source, backup, restore } = fixture();
    const databasePath = join(source, "database.sqlite");
    const graphPath = join(source, "graph.sqlite");
    rmSync(databasePath);
    const database = new DatabaseSync(databasePath);
    const graph = new DatabaseSync(graphPath);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE state (generation INTEGER NOT NULL); INSERT INTO state VALUES (1)");
    graph.exec("PRAGMA journal_mode=WAL; CREATE TABLE state (generation INTEGER NOT NULL); INSERT INTO state VALUES (1)");
    writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), '{"generation":1}');
    writeFileSync(join(source, "config.json"), '{"generation":1}');

    const fenceRoot = join(root, "backup-fence");
    const activeWriter = tryAcquireMutationLease(fenceRoot);
    expect(activeWriter).not.toBeNull();
    const backupPromise = createApplicationConsistentBackup({
      policy: POLICY,
      backupId: "backup-consistent",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      fenceRoot,
      waitTimeoutMs: 1_000,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });

    await waitUntil(() => isBackupFenceActive(fenceRoot));
    expect(tryAcquireMutationLease(fenceRoot)).toBeNull();

    database.exec("UPDATE state SET generation = 2");
    writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), '{"generation":2}');
    writeFileSync(join(source, "config.json"), '{"generation":2}');
    graph.exec("UPDATE state SET generation = 2");
    activeWriter!.release();

    const manifest = await backupPromise;
    restoreBackupAtomically({ backupRoot: backup, targetRoot: restore, manifest, key: BACKUP_KEY });
    expect(isBackupFenceActive(fenceRoot)).toBe(false);

    const restoredDatabase = new DatabaseSync(join(restore, "database.sqlite"), { readOnly: true });
    const restoredGraph = new DatabaseSync(join(restore, "graph.sqlite"), { readOnly: true });
    try {
      expect(restoredDatabase.prepare("SELECT generation FROM state").get()).toEqual({ generation: 2 });
      expect(JSON.parse(readFileSync(
        join(restore, "artifacts", "warden-evidence", "result.json"),
        "utf8",
      ))).toEqual({ generation: 2 });
      expect(JSON.parse(readFileSync(join(restore, "config.json"), "utf8"))).toEqual({ generation: 2 });
      expect(restoredGraph.prepare("SELECT generation FROM state").get()).toEqual({ generation: 2 });
    } finally {
      restoredDatabase.close();
      restoredGraph.close();
    }

    const laterWriter = tryAcquireMutationLease(fenceRoot);
    expect(laterWriter).not.toBeNull();
    database.exec("UPDATE state SET generation = 3");
    graph.exec("UPDATE state SET generation = 3");
    writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), '{"generation":3}');
    writeFileSync(join(source, "config.json"), '{"generation":3}');
    laterWriter!.release();
    database.close();
    graph.close();
  });

  it("fails safely on a crash-stale writer lease without reaping it", async () => {
    const { root, source, backup } = fixture();
    const fenceRoot = join(root, "backup-fence");
    const staleWriter = tryAcquireMutationLease(fenceRoot);
    expect(staleWriter).not.toBeNull();

    await expect(createApplicationConsistentBackup({
      policy: POLICY,
      backupId: "backup-stale-writer",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      fenceRoot,
      waitTimeoutMs: 20,
      pollIntervalMs: 5,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    })).rejects.toThrow("backup_fence_writer_drain_timeout");
    expect(isBackupFenceActive(fenceRoot)).toBe(false);
    expect(readFileSync(join(fenceRoot, "writers", `${staleWriter!.id}.json`), "utf8"))
      .toContain(staleWriter!.id);
    expect(() => readFileSync(join(backup, "manifest.json"), "utf8")).toThrow();
    staleWriter!.release();
  });

  it("restores only to a new isolated target and never publishes a partial restore", () => {
    const { source, backup, restore } = fixture();
    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-002",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });

    const restored = restoreBackupAtomically({ backupRoot: backup, targetRoot: restore, manifest, key: BACKUP_KEY });
    expect(restored.atomic).toBe(true);
    expect(restored.isolated).toBe(true);
    const restoredDb = new DatabaseSync(join(restore, "database.sqlite"), { readOnly: true });
    expect(restoredDb.prepare("SELECT value FROM database_state").get()).toEqual({ value: "database-v1" });
    restoredDb.close();
    expect(() => restoreBackupAtomically({ backupRoot: backup, targetRoot: source, manifest, key: BACKUP_KEY })).toThrow(
      "restore_target_exists",
    );
  });

  it("records migration, rollback, regional simulation, objectives, and tamper evident drill state", () => {
    const { source, backup, restore } = fixture();
    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-003",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });

    const report = runIsolatedRecoveryDrill({
      drillId: "drill-001",
      policy: POLICY,
      manifest,
      key: BACKUP_KEY,
      backupRoot: backup,
      targetRoot: restore,
      startedAt: "2026-08-02T01:10:00.000Z",
      finishedAt: "2026-08-02T01:12:00.000Z",
      sourceRegion: "primary-test",
      recoveryRegion: "secondary-test",
      migrate(targetRoot) {
        writeFileSync(join(targetRoot, "config.json"), "{\"schema\":2}");
        return "migration:test-schema-v2";
      },
      rollback(targetRoot) {
        writeFileSync(join(targetRoot, "config.json"), "{\"region\":\"primary\"}");
        return "rollback:test-schema-v1";
      },
    });

    expect(report.outcome).toBe("passed");
    expect(report.objectives).toMatchObject({ rtoMet: true, rpoMet: true });
    expect(report.migration.status).toBe("applied");
    expect(report.rollback.status).toBe("verified");
    expect(report.regionalFailure).toEqual({
      mode: "isolated_simulation",
      sourceRegion: "primary-test",
      recoveryRegion: "secondary-test",
      state: "simulated",
      productionProven: false,
    });
    expect(verifyRecoveryDrillReport(report)).toEqual({ ok: true, issues: [] });

    const tampered = structuredClone(report);
    tampered.outcome = "failed";
    expect(verifyRecoveryDrillReport(tampered).ok).toBe(false);
    expect(assessRecoveryDrillCadence({ policy: POLICY, reports: [tampered], asOf: "2026-08-20T00:00:00.000Z" }).status).toBe("never_run");

    expect(assessRecoveryDrillCadence({ policy: POLICY, reports: [report], asOf: "2026-08-20T00:00:00.000Z" })).toMatchObject({
      status: "current",
      lastVerifiedDrillId: "drill-001",
      nextDueAt: "2026-09-01T01:12:00.000Z",
    });
    expect(assessRecoveryDrillCadence({ policy: POLICY, reports: [report], asOf: "2026-09-02T00:00:00.000Z" }).status).toBe("overdue");
  });

  it("fails closed when rollback does not restore the original digest", () => {
    const { source, backup, restore } = fixture();
    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-004",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: TEST_RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });

    expect(() => runIsolatedRecoveryDrill({
      drillId: "drill-002",
      policy: POLICY,
      manifest,
      key: BACKUP_KEY,
      backupRoot: backup,
      targetRoot: restore,
      startedAt: "2026-08-02T01:10:00.000Z",
      finishedAt: "2026-08-02T01:12:00.000Z",
      sourceRegion: "primary-test",
      recoveryRegion: "secondary-test",
      migrate(targetRoot) {
        writeFileSync(join(targetRoot, "config.json"), "changed");
        return "migration:test";
      },
      rollback() {
        return "rollback:incomplete";
      },
    })).toThrow("recovery_rollback_integrity_failed");
  });

  it("rejects fake SQLite content and aliased durable resources before backup", () => {
    const secure = secureFixture();
    writeFileSync(join(secure.source, "mendpoint.sqlite"), "not-a-sqlite-database");
    expect(() => createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "secure-invalid-sqlite",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: secure.source,
      backupRoot: secure.backup,
      key: BACKUP_KEY,
      keyId: "customer-backup-key-v1",
      resources: secure.resources,
    })).toThrow("backup_database_sqlite_required");

    const aliased = secureFixture();
    expect(() => createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "secure-aliased",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: aliased.source,
      backupRoot: aliased.backup,
      key: BACKUP_KEY,
      keyId: "customer-backup-key-v1",
      resources: { ...aliased.resources, graph: aliased.resources.database },
    })).toThrow("backup_resources_must_be_distinct");

    const hardLinked = secureFixture();
    rmSync(join(hardLinked.source, hardLinked.resources.graph));
    linkSync(
      join(hardLinked.source, hardLinked.resources.database),
      join(hardLinked.source, hardLinked.resources.graph),
    );
    expect(() => createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "secure-hard-link-aliased",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: hardLinked.source,
      backupRoot: hardLinked.backup,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      resources: hardLinked.resources,
    })).toThrow("backup_resources_filesystem_identity_aliased");
  });

  it("requires every retained Warden and Transformer artifact root", () => {
    const secure = secureFixture();
    rmSync(join(secure.source, "artifacts", "transformer-evidence"), { recursive: true });
    expect(() => createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "secure-missing-artifact-root",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: secure.source,
      backupRoot: secure.backup,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      resources: secure.resources,
    })).toThrow("backup_transformer_evidence_artifact_root_missing");
  });

  it("encrypts every resource and authenticates the manifest against forgery and wrong keys", () => {
    const secure = secureFixture();
    const manifest = createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "secure-authenticated",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: secure.source,
      backupRoot: secure.backup,
      key: BACKUP_KEY,
      keyId: "customer-backup-key-v1",
      resources: secure.resources,
    });

    expect(allFileContents(secure.backup).every((content) =>
      !content.includes(Buffer.from("sentinel-customer-value"))
    )).toBe(true);
    expect(verifyBackupBundle(secure.backup, manifest, BACKUP_KEY)).toEqual({ ok: true, issues: [] });
    expect(verifyBackupBundle(secure.backup, manifest, WRONG_BACKUP_KEY).issues)
      .toContain("manifest_authentication_failed");
    expect(verifyBackupBundle(secure.backup, manifest, undefined).issues)
      .toContain("backup_key_required");

    const forged = structuredClone(manifest);
    forged.createdAt = "2026-08-02T02:00:00.000Z";
    writeFileSync(join(secure.backup, "manifest.json"), JSON.stringify(forged));
    expect(verifyBackupBundle(secure.backup, forged, BACKUP_KEY).issues)
      .toContain("manifest_authentication_failed");

    const forgedKeyIdentity = {
      ...structuredClone(manifest),
      integrity: { ...manifest.integrity, keyId: "attacker-selected-key" },
    };
    writeFileSync(join(secure.backup, "manifest.json"), JSON.stringify(forgedKeyIdentity));
    expect(verifyBackupBundle(secure.backup, forgedKeyIdentity, BACKUP_KEY).issues)
      .toContain("manifest_authentication_failed");
  });

  it("restores authenticated ciphertext to the original resource layout", () => {
    const secure = secureFixture();
    const manifest = createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "secure-restore",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: secure.source,
      backupRoot: secure.backup,
      key: BACKUP_KEY,
      keyId: "customer-backup-key-v1",
      resources: secure.resources,
    });

    restoreBackupAtomically({
      backupRoot: secure.backup,
      targetRoot: secure.restore,
      manifest,
      key: BACKUP_KEY,
    });
    expect(JSON.parse(readFileSync(join(secure.restore, "recovery-config.json"), "utf8")))
      .toMatchObject({ sentinel: "sentinel-customer-value" });
    const restored = new DatabaseSync(join(secure.restore, "transformer-pilot.sqlite"), { readOnly: true });
    try {
      expect(restored.prepare("SELECT value FROM pilot_state").get())
        .toEqual({ value: "sentinel-customer-value" });
    } finally {
      restored.close();
    }
  });

  it("recovers stale markers only with exact marker evidence and owner termination evidence", () => {
    const secure = secureFixture();
    const fenceRoot = join(secure.root, "fence");
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const marker = {
      schemaVersion: 1,
      kind: "writer",
      id: "stale-writer",
      ownerToken: "owner-token-stale-writer",
      hostname: "retired-customer-instance",
      pid: 424242,
      processStartedAt: "2026-08-01T00:00:00.000Z",
      acquiredAt: "2026-08-02T00:00:00.000Z",
    };
    writeFileSync(join(fenceRoot, "writers", "stale-writer.json"), `${JSON.stringify(marker)}\n`);
    const inspected = inspectMutationFence(fenceRoot);
    const stale = inspected.writers.find((entry) => entry.id === marker.id)!;

    expect(() => recoverStaleMutationMarker({
      fenceRoot,
      kind: "writer",
      markerId: marker.id,
      expectedMarkerSha256: "0".repeat(64),
      ownerTerminationEvidence: "orchestrator-event-123",
    })).toThrow("backup_fence_recovery_marker_evidence_mismatch");
    expect(() => recoverStaleMutationMarker({
      fenceRoot,
      kind: "writer",
      markerId: marker.id,
      expectedMarkerSha256: stale.markerSha256,
      ownerTerminationEvidence: "",
    })).toThrow("backup_fence_recovery_owner_termination_evidence_required");
    expect(recoverStaleMutationMarker({
      fenceRoot,
      kind: "writer",
      markerId: marker.id,
      expectedMarkerSha256: stale.markerSha256,
      ownerTerminationEvidence: "orchestrator-event-123",
    })).toMatchObject({ recovered: true, kind: "writer", markerId: marker.id });
    expect(inspectMutationFence(fenceRoot).writers).toEqual([]);
  });

  it("restores an exact stale marker when the recovery audit cannot be persisted", () => {
    const secure = secureFixture();
    const fenceRoot = join(secure.root, "fence-audit-failure");
    const writers = join(fenceRoot, "writers");
    mkdirSync(writers, { recursive: true });
    const marker = {
      schemaVersion: 1,
      kind: "writer",
      id: "stale-writer-audit-failure",
      ownerToken: "owner-token-stale-writer-audit-failure",
      hostname: "retired-customer-instance",
      pid: 424243,
      processStartedAt: "2026-08-01T00:00:00.000Z",
      acquiredAt: "2026-08-02T00:00:00.000Z",
    };
    const markerPath = join(writers, `${marker.id}.json`);
    const markerText = `${JSON.stringify(marker)}\n`;
    writeFileSync(markerPath, markerText);
    const inspected = inspectMutationFence(fenceRoot).writers[0]!;
    mkdirSync(join(fenceRoot, "recovery-audit.jsonl"));

    expect(() => recoverStaleMutationMarker({
      fenceRoot,
      kind: "writer",
      markerId: marker.id,
      expectedMarkerSha256: inspected.markerSha256,
      ownerTerminationEvidence: "orchestrator-event-audit-unavailable",
    })).toThrow();
    expect(readFileSync(markerPath, "utf8")).toBe(markerText);
    expect(inspectMutationFence(fenceRoot).writers).toHaveLength(1);
  });

  it("refuses to reap live owners and recovers an exact stale exclusive marker without using age", () => {
    const secure = secureFixture();
    const live = tryAcquireMutationLease(join(secure.root, "live-fence"));
    expect(live).not.toBeNull();
    const liveMarker = inspectMutationFence(join(secure.root, "live-fence")).writers[0]!;
    expect(() => recoverStaleMutationMarker({
      fenceRoot: join(secure.root, "live-fence"),
      kind: "writer",
      markerId: liveMarker.id,
      expectedMarkerSha256: liveMarker.markerSha256,
      ownerTerminationEvidence: "incorrect-live-owner-claim",
    })).toThrow("backup_fence_recovery_owner_still_alive");
    live!.release();

    const fenceRoot = join(secure.root, "exclusive-fence");
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const exclusive = {
      schemaVersion: 1,
      kind: "exclusive",
      id: "stale-backup",
      ownerToken: "owner-token-stale-exclusive",
      hostname: "retired-customer-instance",
      pid: 434343,
      processStartedAt: "2099-01-01T00:00:00.000Z",
      acquiredAt: "2099-01-01T00:00:00.000Z",
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(exclusive)}\n`);
    const inspected = inspectMutationFence(fenceRoot).exclusive!;
    expect(recoverStaleMutationMarker({
      fenceRoot,
      kind: "exclusive",
      markerId: exclusive.id,
      expectedMarkerSha256: inspected.markerSha256,
      ownerTerminationEvidence: "orchestrator-instance-destroyed-456",
    })).toMatchObject({ recovered: true, kind: "exclusive", markerId: exclusive.id });
    expect(isBackupFenceActive(fenceRoot)).toBe(false);
  });

  it("keeps a persistent ReGauge cutover hold closed against generic recovery", () => {
    const secure = secureFixture();
    const fenceRoot = join(secure.root, "regauge-cutover-fence");
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const exclusive = {
      schemaVersion: 1,
      kind: "exclusive",
      id: "regauge-cutover",
      ownerToken: "owner-token-regauge-cutover",
      hostname: "retired-regauge-instance",
      pid: 454545,
      processStartedAt: "2026-08-25T00:00:00.000Z",
      acquiredAt: "2026-08-25T00:00:00.000Z",
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(exclusive)}\n`);
    writeFileSync(join(fenceRoot, REGAUGE_CUTOVER_FENCE_NAME), "authenticated-cutover-hold\n");
    const inspected = inspectMutationFence(fenceRoot).exclusive!;

    expect(() => recoverStaleMutationMarker({
      fenceRoot,
      kind: "exclusive",
      markerId: exclusive.id,
      expectedMarkerSha256: inspected.markerSha256,
      ownerTerminationEvidence: "old-regauge-machine-destroyed",
    })).toThrow("backup_fence_recovery_persistent_hold_active");

    rmSync(join(fenceRoot, "exclusive.json"));
    expect(isBackupFenceActive(fenceRoot)).toBe(true);
    expect(tryAcquireMutationLease(fenceRoot)).toBeNull();
  });
});

describe("orphaned mutation fence recovery at boot", () => {
  const linuxOnly = process.platform === "linux" ? it : it.skip;

  function fenceFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-dr-reap-"));
    roots.push(root);
    return join(root, "fence");
  }

  function auditLines(fenceRoot: string): Record<string, unknown>[] {
    return readFileSync(join(fenceRoot, "recovery-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // A pid that is provably no longer running: spawnSync waits for the child to exit.
  function deadPid(): number {
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    if (!dead.pid || dead.pid <= 0) throw new Error("failed_to_spawn_dead_pid");
    return dead.pid;
  }

  // Build a real persistent ReGauge cutover hold (the authenticated fence file plus
  // its paired exclusive.json, bound by exclusiveMarkerSha256) by calling the real
  // acquireRegaugeCutoverFence in a child that exits, so the exclusive marker records
  // a dead pid on this host exactly as the one-shot `flyctl console` cutover does.
  function acquireCutoverFenceInChild(fenceRoot: string): { fenceId: string; transferKey: Buffer } {
    const fenceId = "regauge-cutover-guard";
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `const { acquireRegaugeCutoverFence } = await import("@mendpoint/ops");\n` +
      `acquireRegaugeCutoverFence({\n` +
      `  fenceRoot: process.env.FENCE_ROOT,\n` +
      `  fenceId: process.env.FENCE_ID,\n` +
      `  transferId: "transfer-cutover-guard",\n` +
      `  createdAt: process.env.CREATED_AT,\n` +
      `  sourceApp: "mendpoint-transformer-pilot",\n` +
      `  sourceVolume: "vol_source_guard",\n` +
      `  transferKeyId: "cutover-key-guard",\n` +
      `  transferKey: Buffer.from(process.env.TRANSFER_KEY_HEX, "hex"),\n` +
      `});`,
    ], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        FENCE_ROOT: fenceRoot,
        FENCE_ID: fenceId,
        CREATED_AT: "2026-09-10T00:00:00.000Z",
        TRANSFER_KEY_HEX: CUTOVER_TRANSFER_KEY_HEX,
      },
    });
    expect(child.status, `cutover child failed: ${child.stderr}`).toBe(0);
    return { fenceId, transferKey: Buffer.from(CUTOVER_TRANSFER_KEY_HEX, "hex") };
  }

  it("judges owner termination by boot id and same-host liveness, never host alone", () => {
    const started = new Date(Date.now() - process.uptime() * 1_000).toISOString();
    expect(mutationMarkerOwnerTermination(
      { bootId: "boot-a", hostname: hostname(), pid: process.pid, processStartedAt: started },
      { currentBootId: "boot-b", currentHostname: hostname() },
    )).toBe("boot_id_mismatch");
    // A marker from another hostname with no boot-id mismatch is NOT proof of
    // termination: it could be a second container sharing the fence volume.
    expect(mutationMarkerOwnerTermination(
      { bootId: undefined, hostname: "a-different-machine", pid: process.pid, processStartedAt: started },
      { currentBootId: undefined, currentHostname: hostname() },
    )).toBeNull();
    expect(mutationMarkerOwnerTermination(
      { bootId: undefined, hostname: hostname(), pid: process.pid, processStartedAt: started },
      { currentBootId: undefined, currentHostname: hostname() },
    )).toBeNull();
  });

  it("reaps an exclusive marker written in a different kernel boot", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const marker = {
      schemaVersion: 1, kind: "exclusive", id: "orphan-backup",
      ownerToken: "owner-token-exclusive", hostname: hostname(), pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(), bootId: "boot-from-before-the-reboot",
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(marker)}\n`);
    const reaped = reapOrphanedMutationMarkers(fenceRoot, { currentBootId: "boot-after-the-reboot" });
    expect(reaped).toEqual([
      { kind: "exclusive", id: "orphan-backup", reason: "boot_id_mismatch", quarantined: false },
    ]);
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(false);
    expect(isBackupFenceActive(fenceRoot)).toBe(false);
  });

  it("reaps a writer lease whose recorded pid is no longer running", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.pid).toBeGreaterThan(0);
    const marker = {
      schemaVersion: 1, kind: "writer", id: "dead-writer",
      ownerToken: "owner-token-dead-writer", hostname: hostname(), pid: dead.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(join(fenceRoot, "writers", "dead-writer.json"), `${JSON.stringify(marker)}\n`);
    const reaped = reapOrphanedMutationMarkers(fenceRoot);
    expect(reaped).toEqual([
      { kind: "writer", id: "dead-writer", reason: "process_not_alive", quarantined: false },
    ]);
    expect(inspectMutationFence(fenceRoot).writers).toEqual([]);
  });

  linuxOnly("reaps a live pid whose /proc start time proves the number was reused", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const marker = {
      schemaVersion: 1, kind: "writer", id: "reused-pid-writer",
      ownerToken: "owner-token-reused", hostname: hostname(), pid: process.pid,
      // Years before this process started; /proc says the number is a different process.
      processStartedAt: "2020-01-01T00:00:00.000Z",
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(join(fenceRoot, "writers", "reused-pid-writer.json"), `${JSON.stringify(marker)}\n`);
    const reaped = reapOrphanedMutationMarkers(fenceRoot);
    expect(reaped).toEqual([
      { kind: "writer", id: "reused-pid-writer", reason: "pid_reused_start_time_mismatch", quarantined: false },
    ]);
    expect(inspectMutationFence(fenceRoot).writers).toEqual([]);
  });

  it("keeps a live writer lease and never touches the persistent ReGauge cutover hold", () => {
    const fenceRoot = fenceFixture();
    const live = tryAcquireMutationLease(fenceRoot);
    expect(live).not.toBeNull();
    writeFileSync(join(fenceRoot, REGAUGE_CUTOVER_FENCE_NAME), "authenticated-cutover-hold\n");
    const reaped = reapOrphanedMutationMarkers(fenceRoot);
    expect(reaped).toEqual([]);
    expect(inspectMutationFence(fenceRoot).writers.map((entry) => entry.id)).toEqual([live!.id]);
    expect(existsSync(join(fenceRoot, REGAUGE_CUTOVER_FENCE_NAME))).toBe(true);
    live!.release();
  });

  it("quarantines an unparseable marker older than 30s instead of leaving it to wedge boot", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    writeFileSync(join(fenceRoot, "exclusive.json"), "this is not a fence marker\n");
    // Older than the 30s young-marker guard, so it is a genuine corrupt marker rather
    // than a writer observed mid-write.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(fenceRoot, "exclusive.json"), past, past);
    const reaped = reapOrphanedMutationMarkers(fenceRoot);
    expect(reaped).toEqual([
      { kind: "exclusive", id: null, reason: "marker_unparseable", quarantined: true },
    ]);
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(false);
    expect(isBackupFenceActive(fenceRoot)).toBe(false);
    expect(readdirSync(fenceRoot).filter((name) => name.startsWith(".corrupt-exclusive.json-")))
      .toHaveLength(1);
    expect(auditLines(fenceRoot).at(-1)).toMatchObject({
      reason: "marker_unparseable", kind: "exclusive", markerFile: "exclusive.json",
    });
  });

  it("leaves a freshly written unparseable marker alone (a writer may be mid-write)", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    // A reader can observe a create-then-write marker as an empty or partial file; a
    // marker younger than 30s must not be quarantined out from under a live writer.
    writeFileSync(join(fenceRoot, "exclusive.json"), "");
    const reaped = reapOrphanedMutationMarkers(fenceRoot);
    expect(reaped).toEqual([]);
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(true);
    expect(readdirSync(fenceRoot).filter((name) => name.startsWith(".corrupt-"))).toHaveLength(0);
  });

  it("records each reaped marker in the recovery audit with its termination reason", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const marker = {
      schemaVersion: 1, kind: "exclusive", id: "orphan-from-prior-boot",
      ownerToken: "owner-token-prior-boot", hostname: hostname(), pid: process.pid,
      processStartedAt: "2026-08-01T00:00:00.000Z", acquiredAt: "2026-08-01T00:00:00.000Z",
      bootId: "boot-before-the-reboot",
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(marker)}\n`);
    const reaped = reapOrphanedMutationMarkers(fenceRoot, { currentBootId: "boot-after-the-reboot" });
    expect(reaped).toEqual([
      { kind: "exclusive", id: "orphan-from-prior-boot", reason: "boot_id_mismatch", quarantined: false },
    ]);
    const audit = auditLines(fenceRoot).at(-1)!;
    expect(audit).toMatchObject({
      kind: "exclusive",
      markerId: "orphan-from-prior-boot",
      ownerTerminationEvidence: "boot_id_mismatch",
      ownerBootId: "boot-before-the-reboot",
      currentBootId: "boot-after-the-reboot",
    });
    expect(String(audit.recoveryOwnerToken)).toMatch(/^boot-reaper:/);
  });

  linuxOnly("recovers a marker from a prior boot even though its pid is now a live process", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const marker = {
      schemaVersion: 1, kind: "writer", id: "prior-boot-writer",
      ownerToken: "owner-token-prior-boot", hostname: hostname(), pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(), bootId: "a-previous-boot-id",
    };
    writeFileSync(join(fenceRoot, "writers", "prior-boot-writer.json"), `${JSON.stringify(marker)}\n`);
    const inspected = inspectMutationFence(fenceRoot).writers[0]!;
    expect(recoverStaleMutationMarker({
      fenceRoot, kind: "writer", markerId: "prior-boot-writer",
      expectedMarkerSha256: inspected.markerSha256,
      ownerTerminationEvidence: "machine-rebooted",
    })).toMatchObject({ recovered: true, kind: "writer", markerId: "prior-boot-writer" });
    expect(inspectMutationFence(fenceRoot).writers).toEqual([]);
  });

  it("still refuses to recover a live owner running in the current boot", () => {
    const fenceRoot = fenceFixture();
    const live = tryAcquireMutationLease(fenceRoot);
    expect(live).not.toBeNull();
    const inspected = inspectMutationFence(fenceRoot).writers[0]!;
    expect(() => recoverStaleMutationMarker({
      fenceRoot, kind: "writer", markerId: live!.id,
      expectedMarkerSha256: inspected.markerSha256,
      ownerTerminationEvidence: "incorrect-live-owner-claim",
    })).toThrow("backup_fence_recovery_owner_still_alive");
    live!.release();
  });

  it("waits out an orphaned hold and rejects when a live hold never clears", async () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const orphan = {
      schemaVersion: 1, kind: "exclusive", id: "orphan-exclusive",
      ownerToken: "owner-token-orphan", hostname: hostname(), pid: deadPid(),
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(orphan)}\n`);
    await expect(waitForMutationFenceRelease(fenceRoot, { timeoutMs: 2_000, pollMs: 10 }))
      .resolves.toBeUndefined();
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(false);

    const live = {
      schemaVersion: 1, kind: "exclusive", id: "live-exclusive",
      ownerToken: "owner-token-live", hostname: hostname(), pid: process.pid,
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(live)}\n`);
    await expect(waitForMutationFenceRelease(fenceRoot, { timeoutMs: 40, pollMs: 10 }))
      .rejects.toThrow("backup_fence_wait_timeout");
    rmSync(join(fenceRoot, "exclusive.json"), { force: true });
  });

  it("drains past an orphaned writer lease and completes the backup", async () => {
    const { root, source, backup } = fixture();
    const fenceRoot = join(root, "backup-fence");
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const orphanWriter = {
      schemaVersion: 1, kind: "writer", id: "orphan-writer",
      ownerToken: "owner-token-orphan-writer", hostname: hostname(), pid: deadPid(),
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(join(fenceRoot, "writers", "orphan-writer.json"), `${JSON.stringify(orphanWriter)}\n`);
    const manifest = await createApplicationConsistentBackup({
      policy: POLICY, backupId: "backup-orphan-writer", createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source, backupRoot: backup, fenceRoot, waitTimeoutMs: 1_000, pollIntervalMs: 5,
      resources: TEST_RESOURCES, key: BACKUP_KEY, keyId: BACKUP_KEY_ID,
    });
    expect(manifest.backupId).toBe("backup-orphan-writer");
    expect(inspectMutationFence(fenceRoot).writers).toEqual([]);
    expect(isBackupFenceActive(fenceRoot)).toBe(false);
  });

  // Mutation control: initializeWithMutationLease reaps before admission. Removing
  // the reapOrphanedMutationMarkers call from initializeWithMutationLease makes this
  // test fail (tryAcquireMutationLease then sees the orphaned exclusive marker and
  // throws customer_startup_blocked_by_backup).
  it("boots past an orphaned exclusive backup marker left by a crashed process", () => {
    const fenceRoot = fenceFixture();
    mkdirSync(join(fenceRoot, "writers"), { recursive: true });
    const orphan = {
      schemaVersion: 1, kind: "exclusive", id: "orphan-backup",
      ownerToken: "owner-token-orphan", hostname: hostname(), pid: deadPid(),
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(join(fenceRoot, "exclusive.json"), `${JSON.stringify(orphan)}\n`);
    const result = initializeWithMutationLease(() => "initialized", {
      MENDPOINT_BACKUP_FENCE_ROOT: fenceRoot,
    });
    expect(result).toBe("initialized");
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(false);
  });

  // Mutation control: the pairing guard in reapOrphanedMutationMarkers protects the
  // cutover's exclusive marker. Removing that guard makes this test fail: the reaper
  // then judges the paired marker's dead pid as process_not_alive, reaps it, and
  // inspectRegaugeCutoverFence throws because exclusive.json is gone. (B2)
  it("never reaps or quarantines the exclusive marker paired with a persistent ReGauge cutover hold", () => {
    const fenceRoot = fenceFixture();
    const { fenceId, transferKey } = acquireCutoverFenceInChild(fenceRoot);
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(true);
    expect(existsSync(join(fenceRoot, REGAUGE_CUTOVER_FENCE_NAME))).toBe(true);

    const reaped = reapOrphanedMutationMarkers(fenceRoot);
    expect(reaped).toEqual([]);
    expect(existsSync(join(fenceRoot, "exclusive.json"))).toBe(true);
    expect(existsSync(join(fenceRoot, REGAUGE_CUTOVER_FENCE_NAME))).toBe(true);
    // The cutover fence still validates against its paired, untouched marker.
    expect(inspectRegaugeCutoverFence({ fenceRoot, fenceId, transferKey }).fence.fenceId)
      .toBe(fenceId);
  });

  it("fails fast with a distinct error when the only hold is the persistent cutover fence", async () => {
    const fenceRoot = fenceFixture();
    acquireCutoverFenceInChild(fenceRoot);
    // The cutover hold never clears on its own; consuming the full startup timeout
    // (600s in production) would be wrong. It must fail fast and name the hold.
    await expect(waitForMutationFenceRelease(fenceRoot, { timeoutMs: 2_000, pollMs: 25 }))
      .rejects.toThrow("backup_fence_blocked_by_regauge_cutover");
  });
});
