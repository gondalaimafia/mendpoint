import { afterEach, describe, expect, it, vi } from "vitest";

// The production defect this file pins was a read failure reported as a parse failure: the
// configuration file was valid JSON that the effective user could not open, and the backup said
// the JSON was bad. Denying read permission portably is not possible on Windows (Node's chmod only
// toggles the read-only bit there), so the failure is injected at the readFileSync seam instead,
// with the exact EACCES shape Node raises. Everything else in node:fs passes through.
const unreadablePaths = vi.hoisted(() => new Set<string>());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, options: unknown) => {
    if (typeof path === "string" && unreadablePaths.has(path)) {
      const error = new Error(`EACCES: permission denied, open '${path}'`) as NodeJS.ErrnoException;
      error.code = "EACCES";
      error.errno = -13;
      error.syscall = "open";
      error.path = path;
      throw error;
    }
    return (actual.readFileSync as (...args: readonly unknown[]) => unknown)(path, options);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CORE_DISASTER_RECOVERY_POLICY, createBackupBundle } from "./disaster-recovery.js";

const BACKUP_KEY = Buffer.alloc(32, 0x5a);
const BACKUP_KEY_ID = "customer-backup-key-v1";
const RETAINED_ARTIFACT_ROOTS = [
  "warden-candidates",
  "warden-evidence",
  "transformer-candidates",
  "transformer-evidence",
] as const;
const RESOURCES = {
  database: "mendpoint.sqlite",
  graph: "graph-learn.sqlite",
  changeSources: "change-sources.sqlite",
  transformerControlPlane: "transformer-control-plane.sqlite",
  transformerPilot: "transformer-pilot.sqlite",
  artifacts: "artifacts",
  configuration: "recovery-config.json",
} as const;

// Production's recovery configuration carries ten keys. A two-key stand-in would let a shape
// assumption pass here and fail on the deployed file, so the fixture matches the real shape with
// obviously fake values.
const PRODUCTION_SHAPED_CONFIGURATION = {
  schemaVersion: 3,
  deploymentProfile: "customer",
  region: "primary",
  bucket: "example-backup-bucket",
  endpointOrigin: "https://object.invalid",
  storageClass: "durable_isolated_mount",
  retentionDays: 35,
  drillCadenceDays: 30,
  keyId: BACKUP_KEY_ID,
  sentinel: "fixture-only-value",
} as const;

const roots: string[] = [];

function createSqlite(path: string, table: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ${table} (value TEXT NOT NULL); INSERT INTO ${table} VALUES ('fixture')`);
  } finally {
    db.close();
  }
}

function fixture(configurationBody: string) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-dr-config-"));
  roots.push(root);
  const source = join(root, "source");
  for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
    mkdirSync(join(source, "artifacts", retainedRoot), { recursive: true });
  }
  createSqlite(join(source, RESOURCES.database), "main_state");
  createSqlite(join(source, RESOURCES.graph), "graph_state");
  createSqlite(join(source, RESOURCES.changeSources), "change_state");
  createSqlite(join(source, RESOURCES.transformerControlPlane), "control_state");
  createSqlite(join(source, RESOURCES.transformerPilot), "pilot_state");
  writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), '{"ok":true}');
  const configurationPath = join(source, RESOURCES.configuration);
  writeFileSync(configurationPath, configurationBody);
  return { source, configurationPath, backup: join(root, "backup") };
}

function bundle(source: string, backup: string): void {
  createBackupBundle({
    policy: CORE_DISASTER_RECOVERY_POLICY,
    backupId: "backup-configuration-check",
    createdAt: "2026-08-02T01:00:00.000Z",
    sourceRoot: source,
    backupRoot: backup,
    resources: RESOURCES,
    key: BACKUP_KEY,
    keyId: BACKUP_KEY_ID,
  });
}

afterEach(() => {
  unreadablePaths.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("backup configuration readability", () => {
  it("reports an unreadable configuration as unreadable, not as malformed JSON", () => {
    const { source, configurationPath, backup } = fixture(
      `${JSON.stringify(PRODUCTION_SHAPED_CONFIGURATION, null, 2)}\n`,
    );
    expect(Object.keys(PRODUCTION_SHAPED_CONFIGURATION)).toHaveLength(10);
    unreadablePaths.add(configurationPath);
    let thrown: unknown;
    try {
      bundle(source, backup);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("backup_configuration_unreadable");
    expect((thrown as Error).message).not.toBe("backup_configuration_json_required");
  });

  it("still reports malformed configuration content as malformed JSON", () => {
    const malformed = fixture('{"schemaVersion":3,');
    expect(() => bundle(malformed.source, malformed.backup))
      .toThrow("backup_configuration_json_required");

    const nonObject = fixture("[1,2,3]\n");
    expect(() => bundle(nonObject.source, nonObject.backup))
      .toThrow("backup_configuration_json_required");
  });
});
