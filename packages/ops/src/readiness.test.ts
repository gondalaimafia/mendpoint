import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readiness } from "./readiness.js";
import {
  CORE_DISASTER_RECOVERY_POLICY,
  createBackupBundle,
  createObjectBackupRecoveryReceipt,
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
    mkdirSync(outputRoot, { recursive: true });
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
      ["release-ingestion.sqlite", "release_state"],
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
      MENDPOINT_BACKUP_RELEASE_INGESTION_PATH: "release-ingestion.sqlite",
      MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
      MENDPOINT_BACKUP_REGAUGE_PILOT_PATH: "transformer-pilot.sqlite",
      MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
      MENDPOINT_BACKUP_CONFIGURATION_PATH: "recovery-config.json",
    });
    try {
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");
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
          releaseIngestion: "release-ingestion.sqlite",
          transformerControlPlane: "transformer-control-plane.sqlite",
          transformerPilot: "transformer-pilot.sqlite",
          artifacts: ".",
          configuration: "recovery-config.json",
        },
      });
      const evidenceBase = {
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestAuthentication: manifest.integrity.digest,
        manifest,
      };
      expect(() => recordLastVerifiedBackupEvidence({
        ...evidenceBase,
        backupId: "customer-002",
      })).toThrow("backup_evidence_manifest_identity_mismatch");
      expect(() => recordLastVerifiedBackupEvidence({
        ...evidenceBase,
        createdAt: new Date(Date.parse(manifest.createdAt) - 1_000).toISOString(),
      })).toThrow("backup_evidence_manifest_identity_mismatch");
      expect(() => recordLastVerifiedBackupEvidence({
        ...evidenceBase,
        keyId: "customer-backup-key-v2",
      })).toThrow("backup_evidence_manifest_identity_mismatch");
      expect(() => recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestAuthentication: "a".repeat(64),
        manifest,
      })).toThrow("backup_evidence_manifest_identity_mismatch");
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");

      const legacyManifest = {
        ...manifest,
        schemaVersion: 3 as const,
        resources: manifest.resources.filter((resource) => resource.kind !== "releaseIngestion"),
      };
      expect(() => recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestAuthentication: manifest.integrity.digest,
        manifest: legacyManifest,
      })).toThrow("backup_evidence_manifest_identity_mismatch");
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");

      recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: new Date().toISOString(),
        manifestAuthentication: manifest.integrity.digest,
        manifest,
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

      rmSync(join(outputRoot, "customer-001"), { recursive: true, force: true });
      const publication = {
        kind: "s3" as const,
        backupId: manifest.backupId,
        bucket: "customer-backups",
        prefix: `backups/${manifest.backupId}`,
        endpointOrigin: "https://fly.storage.tigris.dev",
        commitDigest: "b".repeat(64),
        manifestSha256: "c".repeat(64),
      };
      const publishedVerifiedAt = new Date().toISOString();
      const recoveryReceipt = createObjectBackupRecoveryReceipt({
        backupId: manifest.backupId,
        keyId: "customer-backup-key-v1",
        verifiedAt: publishedVerifiedAt,
        manifestAuthentication: manifest.integrity.digest,
        publication,
      }, key);
      expect(() => recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: publishedVerifiedAt,
        manifestAuthentication: manifest.integrity.digest,
        manifest: legacyManifest,
        publication,
        recoveryReceipt,
      })).toThrow("backup_evidence_manifest_identity_mismatch");
      expect(readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true }).status)
        .toBe("fail");

      recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: publishedVerifiedAt,
        manifestAuthentication: manifest.integrity.digest,
        manifest,
        publication,
        recoveryReceipt,
      });
      const objectReport = readiness({ dbPath: join(sourceRoot, "mendpoint.sqlite"), dbPing: () => true });
      expect(objectReport.checks).toContainEqual({
        name: "last_verified_backup",
        ok: true,
        detail: "current",
      });

      const tamperedReceipt = {
        ...recoveryReceipt,
        manifestAuthentication: "d".repeat(64),
      };
      expect(() => recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: publishedVerifiedAt,
        manifestAuthentication: manifest.integrity.digest,
        manifest,
        publication,
        recoveryReceipt: tamperedReceipt,
      })).toThrow("backup_evidence_recovery_receipt_invalid");

      expect(() => recordLastVerifiedBackupEvidence({
        evidencePath,
        key,
        keyId: "customer-backup-key-v1",
        backupId: manifest.backupId,
        backupRoot: join(outputRoot, "customer-001"),
        createdAt: manifest.createdAt,
        verifiedAt: publishedVerifiedAt,
        manifestAuthentication: manifest.integrity.digest,
        manifest,
        publication,
      })).toThrow("backup_evidence_recovery_receipt_invalid");
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

  it("exposes the model egress mode and fails on a local_only violation", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-egress-"));
    roots.push(root);
    process.env.MENDPOINT_DATA_DIR = join(root, "db");
    const savedMode = process.env.MENDPOINT_MODEL_EGRESS;
    const savedUrl = process.env.LLM_AGENT_URL;
    try {
      process.env.MENDPOINT_MODEL_EGRESS = "local_only";
      process.env.LLM_AGENT_URL = "http://127.0.0.1:11434/v1";
      const localReport = readiness({ dbPing: () => true });
      expect(localReport.modelEgress).toEqual({
        mode: "local_only",
        localOnly: true,
        endpointConfigured: true,
        localOnlySatisfied: true,
      });
      expect(localReport.checks).toContainEqual({
        name: "model_egress",
        ok: true,
        detail: "local_only",
      });

      process.env.LLM_AGENT_URL = "https://api.meta.ai/v1";
      const publicReport = readiness({ dbPing: () => true });
      expect(publicReport.status).toBe("fail");
      expect(publicReport.modelEgress?.localOnlySatisfied).toBe(false);
      expect(publicReport.checks).toContainEqual({
        name: "model_egress",
        ok: false,
        detail: "model_egress_local_only_violation",
      });
    } finally {
      if (savedMode === undefined) delete process.env.MENDPOINT_MODEL_EGRESS;
      else process.env.MENDPOINT_MODEL_EGRESS = savedMode;
      if (savedUrl === undefined) delete process.env.LLM_AGENT_URL;
      else process.env.LLM_AGENT_URL = savedUrl;
    }
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

  it("reports customer readiness from the declaration and fails closed when indeterminate", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-readiness-customer-"));
    roots.push(root);
    const previous = { ...process.env };
    Object.assign(process.env, {
      NODE_ENV: "test",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
    });
    try {
      const readinessCheck = () =>
        readiness({ dbPath: join(root, "mendpoint.sqlite"), dbPing: () => true }).checks.find(
          (c) => c.name === "customer_readiness",
        );

      process.env.MENDPOINT_CUSTOMER_READY = "1";
      expect(readinessCheck()).toEqual({ name: "customer_readiness", ok: true, detail: "ready" });

      process.env.MENDPOINT_CUSTOMER_READY = "0";
      const notReady = readinessCheck();
      expect(notReady?.ok).toBe(false);
      expect(notReady?.detail).toContain("not_ready");

      delete process.env.MENDPOINT_CUSTOMER_READY;
      const indeterminate = readinessCheck();
      expect(indeterminate?.ok).toBe(false);
      expect(indeterminate?.detail).toContain("indeterminate");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key];
      }
      Object.assign(process.env, previous);
    }
  });
});
