/**
 * Runnable measured disaster-recovery drill.
 *
 * Builds a fixture data dir with the eight recovery resources, runs a real
 * backup -> restore -> integrity verification against a temp dir, and prints the
 * measured RTO/RPO plus PASS/FAIL against the CORE disaster-recovery policy.
 *
 * Usage: npm run dr:drill
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  CORE_DISASTER_RECOVERY_POLICY,
  runMeasuredDrDrill,
  verifyMeasuredDrillResult,
  type DrillCanaryResult,
} from "@mendpoint/ops";
import { notifyPaging } from "@mendpoint/notify";

const BACKUP_KEY = Buffer.alloc(32, 0x5a);
const BACKUP_KEY_ID = "dr-drill-key-v1";
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

function createSqlite(path: string, table: string, value: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE ${table} (value TEXT NOT NULL); INSERT INTO ${table} VALUES ('${value}')`);
  } finally {
    db.close();
  }
}

function canaryRowSurvives(targetRoot: string): DrillCanaryResult {
  const db = new DatabaseSync(join(targetRoot, "database.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM canary").get() as { value?: string } | undefined;
    return row?.value === "dr-drill-canary"
      ? { ok: true, detail: "canary_row_survived" }
      : { ok: false, detail: "canary_row_missing" };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-dr-drill-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
    mkdirSync(join(source, "artifacts", retainedRoot), { recursive: true });
  }
  createSqlite(join(source, "database.sqlite"), "canary", "dr-drill-canary");
  createSqlite(join(source, "graph.sqlite"), "graph_state", "graph-v1");
  createSqlite(join(source, "change-sources.sqlite"), "change_state", "change-v1");
  createSqlite(join(source, "release-ingestion.sqlite"), "release_state", "release-v1");
  createSqlite(join(source, "transformer-control-plane.sqlite"), "control_state", "control-v1");
  createSqlite(join(source, "transformer-pilot.sqlite"), "pilot_state", "pilot-v1");
  writeFileSync(join(source, "artifacts", "warden-evidence", "result.json"), "{\"ok\":true}");
  writeFileSync(join(source, "config.json"), "{\"region\":\"primary\"}");

  try {
    // Age the backup slightly so the printed RPO is a non-trivial measured number.
    const createdAt = new Date(Date.now() - 5_000).toISOString();
    const result = runMeasuredDrDrill({
      drillId: `dr-drill-${Date.now()}`,
      backupId: "dr-drill-backup",
      sourceRoot: source,
      backupRoot: join(root, "backup"),
      targetRoot: join(root, "restore"),
      reportTargetRoot: join(root, "report-restore"),
      resources: RESOURCES,
      key: BACKUP_KEY,
      keyId: BACKUP_KEY_ID,
      createdAt,
      verifyCanary: canaryRowSurvives,
    });

    const policy = CORE_DISASTER_RECOVERY_POLICY;
    const pass = result.outcome === "passed" && verifyMeasuredDrillResult(result);
    console.log("Measured disaster-recovery drill");
    console.log(`  drillId:            ${result.drillId}`);
    console.log(`  backupId:           ${result.backupId}`);
    console.log(`  canary:             ${result.canary.ok ? "ok" : "FAILED"} (${result.canary.detail})`);
    console.log(
      `  measured RTO:       ${result.measured.recoveryTimeSeconds.toFixed(3)}s ` +
        `(target ${policy.rtoSeconds}s, ${result.rtoMet ? "met" : "MISSED"})`,
    );
    console.log(
      `  measured RPO:       ${result.measured.recoveryPointAgeSeconds.toFixed(3)}s ` +
        `(target ${policy.rpoSeconds}s, ${result.rpoMet ? "met" : "MISSED"})`,
    );
    console.log(`  restoredDigest:     ${result.restoredDigest ?? "none"}`);
    console.log(`  evidence report:    ${result.report ? "recorded" : "none"}`);
    console.log(`  outcome:            ${pass ? "PASS" : "FAIL"}`);
    if (!pass) {
      process.exitCode = 1;
      // Best-effort page: a measured drill that misses its targets means the
      // restore path is not proven. Awaited (not fire-and-forget) because this
      // is a short-lived CLI, so the delivery must complete before it exits;
      // no-op unless a paging sink is configured. notifyPaging is fail-open, so
      // a paging outage never changes the drill's own PASS/FAIL exit code.
      await notifyPaging({
        type: "dr_drill_fail",
        severity: "critical",
        summary: `DR drill ${result.drillId} failed its recovery targets`,
        dedupeKey: `dr_drill_fail:${result.drillId}`,
        details: {
          outcome: result.outcome,
          rtoMet: result.rtoMet,
          rpoMet: result.rpoMet,
          canaryOk: result.canary.ok,
          verified: verifyMeasuredDrillResult(result),
        },
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
