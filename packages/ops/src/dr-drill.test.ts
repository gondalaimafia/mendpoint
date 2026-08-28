import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackupBundle, CORE_DISASTER_RECOVERY_POLICY } from "./disaster-recovery.js";
import {
  measureRestoreDrill,
  runMeasuredDrDrill,
  verifyMeasuredDrillResult,
  writeMeasuredDrillResult,
  type DrillCanaryResult,
} from "./dr-drill.js";

const BACKUP_KEY = Buffer.alloc(32, 0x5a);
const BACKUP_KEY_ID = "customer-backup-key-v1";
const RETAINED_ARTIFACT_ROOTS = [
  "warden-candidates",
  "warden-evidence",
  "transformer-candidates",
  "transformer-evidence",
] as const;
const RESOURCES = {
  database: "database.sqlite",
  graph: "graph.sqlite",
  changeSources: "change-sources.sqlite",
  releaseIngestion: "release-ingestion.sqlite",
  transformerControlPlane: "transformer-control-plane.sqlite",
  transformerPilot: "transformer-pilot.sqlite",
  artifacts: "artifacts",
  configuration: "config.json",
} as const;

const roots: string[] = [];

function createSqlite(path: string, table: string, value: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ${table} (value TEXT NOT NULL); INSERT INTO ${table} VALUES ('${value}')`);
  } finally {
    db.close();
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-measured-drill-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
    mkdirSync(join(source, "artifacts", retainedRoot), { recursive: true });
  }
  createSqlite(join(source, "database.sqlite"), "canary", "canary-row-v1");
  createSqlite(join(source, "graph.sqlite"), "graph_state", "graph-v1");
  createSqlite(join(source, "change-sources.sqlite"), "change_state", "change-v1");
  createSqlite(join(source, "release-ingestion.sqlite"), "release_state", "release-v1");
  createSqlite(join(source, "transformer-control-plane.sqlite"), "control_state", "control-v1");
  createSqlite(join(source, "transformer-pilot.sqlite"), "pilot_state", "pilot-v1");
  writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), "{\"ok\":true}");
  writeFileSync(join(source, "config.json"), "{\"region\":\"primary\"}");
  return { root, source, backup: join(root, "backup"), restore: join(root, "restore") };
}

function canaryRowSurvives(targetRoot: string): DrillCanaryResult {
  const db = new DatabaseSync(join(targetRoot, "database.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM canary").get() as { value?: string } | undefined;
    const count = (db.prepare("SELECT COUNT(*) AS n FROM canary").get() as { n: number }).n;
    return row?.value === "canary-row-v1" && count === 1
      ? { ok: true, detail: "canary_row_survived" }
      : { ok: false, detail: "canary_row_missing" };
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("measured DR drill", () => {
  it("restores a known dataset, passes integrity, and measures finite RTO/RPO against targets", () => {
    const { root, source, backup, restore } = fixture();
    const result = runMeasuredDrDrill({
      drillId: "measured-drill-001",
      backupId: "measured-backup-001",
      sourceRoot: source,
      backupRoot: backup,
      targetRoot: restore,
      reportTargetRoot: join(root, "report-restore"),
      resources: RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      verifyCanary: canaryRowSurvives,
    });

    expect(result.outcome).toBe("passed");
    expect(result.canary).toEqual({ ok: true, detail: "canary_row_survived" });
    expect(Number.isFinite(result.measured.recoveryTimeSeconds)).toBe(true);
    expect(Number.isFinite(result.measured.recoveryPointAgeSeconds)).toBe(true);
    expect(result.measured.recoveryTimeSeconds).toBeGreaterThanOrEqual(0);
    expect(result.targets).toEqual({
      rtoSeconds: CORE_DISASTER_RECOVERY_POLICY.rtoSeconds,
      rpoSeconds: CORE_DISASTER_RECOVERY_POLICY.rpoSeconds,
    });
    expect(result.rtoMet).toBe(true);
    expect(result.rpoMet).toBe(true);
    expect(verifyMeasuredDrillResult(result)).toBe(true);

    // measured numbers are fed into the existing RecoveryDrillReport evidence
    // shape (objectives are millisecond-rounded because they ride ISO timestamps)
    expect(result.report).not.toBeNull();
    expect(result.report!.objectives.recoveryTimeSeconds).toBeCloseTo(
      result.measured.recoveryTimeSeconds,
      2,
    );
    expect(result.report!.objectives).toMatchObject({ rtoMet: true, rpoMet: true });
  });

  it("feeds a measured RPO older than now into the report objectives", () => {
    const { root, source, backup, restore } = fixture();
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    const result = runMeasuredDrDrill({
      drillId: "measured-drill-rpo",
      backupId: "measured-backup-rpo",
      sourceRoot: source,
      backupRoot: backup,
      targetRoot: restore,
      reportTargetRoot: join(root, "report-restore"),
      resources: RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      createdAt,
      verifyCanary: canaryRowSurvives,
    });
    expect(result.outcome).toBe("passed");
    expect(result.measured.recoveryPointAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(result.report!.objectives.recoveryPointAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(result.report!.objectives.rpoMet).toBe(true);
  });

  it("fails closed on a corrupted backup without throwing", () => {
    const { source, backup, restore } = fixture();
    const manifest = createBackupBundle({
      policy: CORE_DISASTER_RECOVERY_POLICY,
      backupId: "measured-backup-corrupt",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
    });
    const databaseCiphertext = manifest.resources.find((entry) => entry.kind === "database")!
      .encryptedFiles[0]!.ciphertextPath;
    writeFileSync(join(backup, databaseCiphertext), "tampered");

    const result = measureRestoreDrill({
      drillId: "measured-drill-corrupt",
      backupRoot: backup,
      targetRoot: restore,
      manifest,
      key: BACKUP_KEY,
    });
    expect(result.outcome).toBe("failed");
    expect(result.canary.ok).toBe(false);
    expect(result.restoredDigest).toBeNull();
    expect(result.error).toContain("backup_integrity_failed");
    expect(result.report).toBeNull();
    expect(Number.isFinite(result.measured.recoveryTimeSeconds)).toBe(true);
    expect(result.rtoMet).toBe(false);
    expect(verifyMeasuredDrillResult(result)).toBe(true);
  });

  it("persists a tamper-evident measured drill result", () => {
    const { root, source, backup, restore } = fixture();
    const result = runMeasuredDrDrill({
      drillId: "measured-drill-persist",
      backupId: "measured-backup-persist",
      sourceRoot: source,
      backupRoot: backup,
      targetRoot: restore,
      reportTargetRoot: join(root, "report-restore"),
      resources: RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      verifyCanary: canaryRowSurvives,
    });
    const evidencePath = join(root, "evidence", "measured-drill.json");
    writeMeasuredDrillResult(evidencePath, result);
    const reloaded = JSON.parse(readFileSync(evidencePath, "utf8")) as typeof result;
    expect(verifyMeasuredDrillResult(reloaded)).toBe(true);
    expect(reloaded.outcome).toBe("passed");
  });
});
