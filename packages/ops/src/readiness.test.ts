import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readiness } from "./readiness.js";
import {
  CORE_DISASTER_RECOVERY_POLICY,
  createBackupBundle,
  recordLastVerifiedBackupEvidence,
} from "./disaster-recovery.js";

const roots: string[] = [];
const originalDataDir = process.env.MENDPOINT_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.MENDPOINT_DATA_DIR;
  else process.env.MENDPOINT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("readiness storage boundary", () => {
  it("fails customer readiness for empty or tampered evidence targets and accepts a fully verified bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-backup-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const outputRoot = join(root, "backups");
    const evidencePath = join(sourceRoot, ".backup-state", "last-verified.json");
    mkdirSync(sourceRoot, { recursive: true });
    for (const name of [
      "warden-candidates",
      "warden-evidence",
      "transformer-candidates",
      "transformer-evidence",
    ]) mkdirSync(join(sourceRoot, name), { recursive: true });
    for (const [name, table] of [
      ["mendpoint.sqlite", "main_state"],
      ["graph-learn.sqlite", "graph_state"],
      ["change-sources.sqlite", "change_state"],
      ["transformer-control-plane.sqlite", "control_state"],
      ["transformer-pilot.sqlite", "pilot_state"],
    ] as const) {
      const db = new DatabaseSync(join(sourceRoot, name));
      db.exec(`CREATE TABLE ${table} (value TEXT NOT NULL); INSERT INTO ${table} VALUES ('current')`);
      db.close();
    }
    writeFileSync(join(sourceRoot, "warden-evidence", "result.json"), "{\"ok\":true}");
    writeFileSync(join(sourceRoot, "recovery-config.json"), "{\"region\":\"primary\"}");
    const key = Buffer.alloc(32, 0x5a);
    const previous = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: "test",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_BACKUP_SOURCE_ROOT: sourceRoot,
      MENDPOINT_BACKUP_OUTPUT_ROOT: outputRoot,
      MENDPOINT_BACKUP_FENCE_ROOT: join(sourceRoot, ".backup-fence"),
      MENDPOINT_BACKUP_EVIDENCE_PATH: evidencePath,
      MENDPOINT_BACKUP_STORAGE_CLASS: "durable_isolated_mount",
      MENDPOINT_BACKUP_KEY: key.toString("hex"),
      MENDPOINT_BACKUP_KEY_ID: "customer-backup-key-v1",
      MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
      MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
      MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
      MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
      MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH: "transformer-pilot.sqlite",
      MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
      MENDPOINT_BACKUP_CONFIGURATION_PATH: "recovery-config.json",
    });
    try {
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");
      mkdirSync(join(outputRoot, "customer-001"), { recursive: true });
      recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: "customer-001",
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        manifestAuthentication: "a".repeat(64),
      });
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");
      rmSync(join(outputRoot, "customer-001"), { recursive: true, force: true });

      const createdAt = new Date().toISOString();
      const manifest = createBackupBundle({
        policy: CORE_DISASTER_RECOVERY_POLICY,
        backupId: "customer-001",
        createdAt,
        sourceRoot,
        backupRoot: join(outputRoot, "customer-001"),
        key,
        keyId: "customer-backup-key-v1",
        resources: {
          database: "mendpoint.sqlite",
          graph: "graph-learn.sqlite",
          changeSources: "change-sources.sqlite",
          transformerControlPlane: "transformer-control-plane.sqlite",
          transformerPilot: "transformer-pilot.sqlite",
          artifacts: ".",
          configuration: "recovery-config.json",
        },
      });
      recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestAuthentication: manifest.integrity.digest,
      });
      const report = readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true });
      expect(report.checks).toContainEqual({ name: "last_verified_backup", ok: true, detail: "current" });

      const ciphertextPath = manifest.resources
        .flatMap((resource) => resource.encryptedFiles)
        .at(0)?.ciphertextPath;
      expect(ciphertextPath).toBeDefined();
      writeFileSync(join(outputRoot, "customer-001", ciphertextPath!), "tampered");
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });

  it("uses the configured data directory and reports a writable storage root", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-"));
    roots.push(root);
    process.env.MENDPOINT_DATA_DIR = join(root, "nested", "db");

    const report = readiness({ dbPing: () => true });

    expect(report.status).not.toBe("fail");
    expect(report.checks).toContainEqual({
      name: "data_dir_writable",
      ok: true,
      detail: "available",
    });
  });

  it("fails when the configured storage root resolves through a file", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-file-"));
    roots.push(root);
    const file = join(root, "not-a-directory");
    writeFileSync(file, "blocked");

    const report = readiness({ dbPath: join(file, "mendpoint.sqlite"), dbPing: () => true });

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual({
      name: "data_dir_writable",
      ok: false,
      detail: "unavailable",
    });
  });

  it("does not expose database exception details", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-error-"));
    roots.push(root);
    const report = readiness({
      dbPath: join(root, "mendpoint.sqlite"),
      dbPing: () => {
        throw new Error("C:\\private\\customer.sqlite SQL secret payload");
      },
    });

    const database = report.checks.find((check) => check.name === "db_ping");
    expect(report.status).toBe("fail");
    expect(database).toEqual({ name: "db_ping", ok: false, detail: "failed" });
    expect(JSON.stringify(report)).not.toContain("customer.sqlite");
    expect(JSON.stringify(report)).not.toContain("secret payload");
  });

  it("reports schema integrity independently without exposing failures", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-schema-"));
    roots.push(root);
    const report = readiness({
      dbPath: join(root, "mendpoint.sqlite"),
      dbPing: () => true,
      schemaCheck: () => {
        throw new Error("private schema statement");
      },
    });

    expect(report.status).toBe("fail");
    expect(report.checks).toContainEqual({
      name: "db_schema",
      ok: false,
      detail: "invalid",
    });
    expect(JSON.stringify(report)).not.toContain("private schema statement");
  });
});
