import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessRecoveryDrillCadence,
  CORE_DISASTER_RECOVERY_POLICY,
  createBackupBundle,
  restoreBackupAtomically,
  runIsolatedRecoveryDrill,
  verifyBackupBundle,
  verifyRecoveryDrillReport,
  type DisasterRecoveryPolicy,
} from "./disaster-recovery.js";

const POLICY = Object.freeze({
  schemaVersion: 1,
  policyId: "mendpoint-core",
  version: "2026-08-02",
  effectiveAt: "2026-08-02T00:00:00.000Z",
  rtoSeconds: 900,
  rpoSeconds: 3600,
  drillCadenceDays: 30,
  requiredResources: Object.freeze(["database", "graph", "artifacts", "configuration"] as const),
}) satisfies DisasterRecoveryPolicy;

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-dr-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(join(source, "graph"), { recursive: true });
  mkdirSync(join(source, "artifacts"), { recursive: true });
  writeFileSync(join(source, "database.sqlite"), "database-v1");
  writeFileSync(join(source, "graph", "nodes.json"), "[1,2,3]");
  writeFileSync(join(source, "artifacts", "result.json"), "{\"ok\":true}");
  writeFileSync(join(source, "config.json"), "{\"region\":\"primary\"}");
  return { root, source, backup: join(root, "backup"), restore: join(root, "restore") };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disaster recovery", () => {
  it("publishes a versioned policy with explicit RTO, RPO, scope, and drill cadence", () => {
    expect(CORE_DISASTER_RECOVERY_POLICY).toEqual(POLICY);
  });

  it("creates and verifies an atomic four resource backup bundle", () => {
    const { source, backup } = fixture();
    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-001",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: {
        database: "database.sqlite",
        graph: "graph",
        artifacts: "artifacts",
        configuration: "config.json",
      },
    });

    expect(manifest.resources.map((entry) => entry.kind)).toEqual([
      "artifacts",
      "configuration",
      "database",
      "graph",
    ]);
    expect(manifest.resources.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(verifyBackupBundle(backup, manifest)).toEqual({ ok: true, issues: [] });

    writeFileSync(join(backup, "resources", "database"), "tampered");
    expect(verifyBackupBundle(backup, manifest)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.stringContaining("database_hash_mismatch")]),
    });
  });

  it("restores only to a new isolated target and never publishes a partial restore", () => {
    const { source, backup, restore } = fixture();
    const manifest = createBackupBundle({
      policy: POLICY,
      backupId: "backup-002",
      createdAt: "2026-08-02T01:00:00.000Z",
      sourceRoot: source,
      backupRoot: backup,
      resources: {
        database: "database.sqlite",
        graph: "graph",
        artifacts: "artifacts",
        configuration: "config.json",
      },
    });

    const restored = restoreBackupAtomically({ backupRoot: backup, targetRoot: restore, manifest });
    expect(restored.atomic).toBe(true);
    expect(restored.isolated).toBe(true);
    expect(readFileSync(join(restore, "resources", "database"), "utf8")).toBe("database-v1");
    expect(() => restoreBackupAtomically({ backupRoot: backup, targetRoot: source, manifest })).toThrow(
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
      resources: {
        database: "database.sqlite",
        graph: "graph",
        artifacts: "artifacts",
        configuration: "config.json",
      },
    });

    const report = runIsolatedRecoveryDrill({
      drillId: "drill-001",
      policy: POLICY,
      manifest,
      backupRoot: backup,
      targetRoot: restore,
      startedAt: "2026-08-02T01:10:00.000Z",
      finishedAt: "2026-08-02T01:12:00.000Z",
      sourceRegion: "primary-test",
      recoveryRegion: "secondary-test",
      migrate(targetRoot) {
        writeFileSync(join(targetRoot, "resources", "configuration"), "{\"schema\":2}");
        return "migration:test-schema-v2";
      },
      rollback(targetRoot) {
        writeFileSync(join(targetRoot, "resources", "configuration"), "{\"region\":\"primary\"}");
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
      resources: {
        database: "database.sqlite",
        graph: "graph",
        artifacts: "artifacts",
        configuration: "config.json",
      },
    });

    expect(() => runIsolatedRecoveryDrill({
      drillId: "drill-002",
      policy: POLICY,
      manifest,
      backupRoot: backup,
      targetRoot: restore,
      startedAt: "2026-08-02T01:10:00.000Z",
      finishedAt: "2026-08-02T01:12:00.000Z",
      sourceRegion: "primary-test",
      recoveryRegion: "secondary-test",
      migrate(targetRoot) {
        writeFileSync(join(targetRoot, "resources", "configuration"), "changed");
        return "migration:test";
      },
      rollback() {
        return "rollback:incomplete";
      },
    })).toThrow("recovery_rollback_integrity_failed");
  });
});
