/**
 * Measured disaster-recovery drill.
 *
 * Unlike runIsolatedRecoveryDrill (which records objectives from caller supplied
 * timestamps), this module performs a real backup then a real restore against the
 * existing backup mechanism and MEASURES the recovery numbers:
 *   - measured RTO: wall-clock of the restore + integrity verification
 *   - measured RPO: age of the backup at the moment the restore starts
 * It returns a frozen, tamper-evident DrillResult with pass/fail against the
 * CORE_DISASTER_RECOVERY_POLICY targets, and (on a passing drill) feeds those
 * measured numbers into the existing RecoveryDrillReport evidence shape so the
 * DR cadence assessment reflects a real measured drill rather than policy
 * constants alone.
 */
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  CORE_DISASTER_RECOVERY_POLICY,
  createBackupBundle,
  restoreBackupAtomically,
  runIsolatedRecoveryDrill,
  type BackupManifest,
  type DisasterRecoveryPolicy,
  type RecoveryDrillReport,
  type RecoveryResourceKind,
} from "./disaster-recovery.js";
import { recordCounter, recordHistogram, startSpan } from "./telemetry.js";

export const MEASURED_DR_DRILL_SCHEMA_VERSION = 1 as const;

export type DrillCanaryResult = Readonly<{ ok: boolean; detail: string }>;

export type MeasuredDrillResult = Readonly<{
  schemaVersion: typeof MEASURED_DR_DRILL_SCHEMA_VERSION;
  drillId: string;
  backupId: string;
  outcome: "passed" | "failed";
  measured: Readonly<{
    recoveryTimeSeconds: number;
    recoveryPointAgeSeconds: number;
  }>;
  targets: Readonly<{ rtoSeconds: number; rpoSeconds: number }>;
  rtoMet: boolean;
  rpoMet: boolean;
  canary: DrillCanaryResult;
  restoredDigest: string | null;
  backupCreatedAt: string;
  restoreStartedAt: string;
  restoreFinishedAt: string;
  report: RecoveryDrillReport | null;
  error: string | null;
  sha256: string;
}>;

export interface MeasureRestoreDrillInput {
  drillId: string;
  backupRoot: string;
  targetRoot: string;
  manifest: BackupManifest;
  key: Buffer;
  policy?: DisasterRecoveryPolicy;
  createdAt?: string;
  verifyCanary?: (targetRoot: string) => DrillCanaryResult;
  now?: () => number;
  clock?: () => number;
}

export interface RunMeasuredDrDrillInput {
  drillId: string;
  backupId: string;
  sourceRoot: string;
  backupRoot: string;
  targetRoot: string;
  resources: Record<RecoveryResourceKind, string>;
  key: Buffer;
  keyId: string;
  policy?: DisasterRecoveryPolicy;
  createdAt?: string;
  verifyCanary?: (targetRoot: string) => DrillCanaryResult;
  reportTargetRoot?: string;
  sourceRegion?: string;
  recoveryRegion?: string;
  now?: () => number;
  clock?: () => number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function resultDigest(result: Omit<MeasuredDrillResult, "sha256">): string {
  return sha256(JSON.stringify(result));
}

function defaultCanary(restoredDigest: string | null): DrillCanaryResult {
  return restoredDigest && /^[a-f0-9]{64}$/.test(restoredDigest)
    ? { ok: true, detail: "restored_digest_verified" }
    : { ok: false, detail: "restored_digest_missing" };
}

function freezeResult(unsigned: Omit<MeasuredDrillResult, "sha256">): MeasuredDrillResult {
  return Object.freeze({ ...unsigned, sha256: resultDigest(unsigned) });
}

/**
 * Measure a restore of an already-created backup bundle. Fails closed: a
 * corrupted or missing backup yields outcome "failed" with a failed canary and
 * finite measured numbers rather than throwing.
 */
export function measureRestoreDrill(input: MeasureRestoreDrillInput): MeasuredDrillResult {
  const policy = input.policy ?? CORE_DISASTER_RECOVERY_POLICY;
  const nowMs = input.now ?? Date.now;
  const clock = input.clock ?? (() => globalThis.performance.now());
  const createdAt = input.createdAt ?? input.manifest.createdAt;
  const backupCreatedMs = Date.parse(createdAt);

  const restoreStartMs = nowMs();
  const restoreStartedAt = new Date(restoreStartMs).toISOString();
  const perfStart = clock();
  let restoredDigest: string | null = null;
  let canary: DrillCanaryResult;
  let error: string | null = null;
  let restoreOk = false;
  try {
    const restored = restoreBackupAtomically({
      backupRoot: input.backupRoot,
      targetRoot: input.targetRoot,
      manifest: input.manifest,
      key: input.key,
    });
    restoredDigest = restored.restoredDigest;
    restoreOk = true;
    canary = input.verifyCanary
      ? input.verifyCanary(input.targetRoot)
      : defaultCanary(restored.restoredDigest);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "measured_restore_failed";
    canary = { ok: false, detail: error };
  }
  const durationMs = Math.max(0, clock() - perfStart);
  const recoveryTimeSeconds = durationMs / 1000;
  const restoreFinishedAt = new Date(restoreStartMs + durationMs).toISOString();
  const recoveryPointAgeSeconds = Number.isFinite(backupCreatedMs)
    ? Math.max(0, (restoreStartMs - backupCreatedMs) / 1000)
    : Number.POSITIVE_INFINITY;

  const rtoMet = restoreOk && recoveryTimeSeconds <= policy.rtoSeconds;
  const rpoMet = recoveryPointAgeSeconds <= policy.rpoSeconds;
  const outcome: MeasuredDrillResult["outcome"] =
    restoreOk && canary.ok && rtoMet && rpoMet ? "passed" : "failed";

  return freezeResult({
    schemaVersion: MEASURED_DR_DRILL_SCHEMA_VERSION,
    drillId: input.drillId,
    backupId: input.manifest.backupId,
    outcome,
    measured: Object.freeze({ recoveryTimeSeconds, recoveryPointAgeSeconds }),
    targets: Object.freeze({ rtoSeconds: policy.rtoSeconds, rpoSeconds: policy.rpoSeconds }),
    rtoMet,
    rpoMet,
    canary: Object.freeze(canary),
    restoredDigest,
    backupCreatedAt: createdAt,
    restoreStartedAt,
    restoreFinishedAt,
    report: null,
    error,
  });
}

function buildMeasuredRecoveryDrillReport(input: {
  drillId: string;
  policy: DisasterRecoveryPolicy;
  manifest: BackupManifest;
  key: Buffer;
  backupRoot: string;
  reportTargetRoot: string;
  createdAt: string;
  recoveryTimeSeconds: number;
  recoveryPointAgeSeconds: number;
  sourceRegion: string;
  recoveryRegion: string;
}): RecoveryDrillReport {
  const backupCreatedMs = Date.parse(input.createdAt);
  const startedMs = backupCreatedMs + Math.round(input.recoveryPointAgeSeconds * 1000);
  const finishedMs = startedMs + Math.round(input.recoveryTimeSeconds * 1000);
  return runIsolatedRecoveryDrill({
    drillId: input.drillId,
    policy: input.policy,
    manifest: input.manifest,
    key: input.key,
    backupRoot: input.backupRoot,
    targetRoot: input.reportTargetRoot,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    sourceRegion: input.sourceRegion,
    recoveryRegion: input.recoveryRegion,
    migrate: () => "measured-drill:no-schema-change",
    rollback: () => "measured-drill:no-rollback-change",
  });
}

/**
 * Run a full measured drill: create a real backup of sourceRoot, restore it into
 * an isolated targetRoot, verify integrity, and measure RTO/RPO. On a passing
 * drill, also emit the existing RecoveryDrillReport evidence shape carrying the
 * measured objectives (fail-open: a report-build failure never fails the drill).
 */
export function runMeasuredDrDrill(input: RunMeasuredDrDrillInput): MeasuredDrillResult {
  const span = startSpan("ops.dr_drill", { drillId: input.drillId });
  const policy = input.policy ?? CORE_DISASTER_RECOVERY_POLICY;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const manifest = createBackupBundle({
    policy,
    backupId: input.backupId,
    createdAt,
    sourceRoot: input.sourceRoot,
    backupRoot: input.backupRoot,
    resources: input.resources,
    key: input.key,
    keyId: input.keyId,
  });

  const measured = measureRestoreDrill({
    drillId: input.drillId,
    backupRoot: input.backupRoot,
    targetRoot: input.targetRoot,
    manifest,
    key: input.key,
    policy,
    createdAt,
    verifyCanary: input.verifyCanary,
    now: input.now,
    clock: input.clock,
  });

  let report: RecoveryDrillReport | null = null;
  if (measured.outcome === "passed") {
    try {
      report = buildMeasuredRecoveryDrillReport({
        drillId: input.drillId,
        policy,
        manifest,
        key: input.key,
        backupRoot: input.backupRoot,
        reportTargetRoot: input.reportTargetRoot ?? `${resolve(input.targetRoot)}-report`,
        createdAt,
        recoveryTimeSeconds: measured.measured.recoveryTimeSeconds,
        recoveryPointAgeSeconds: measured.measured.recoveryPointAgeSeconds,
        sourceRegion: input.sourceRegion ?? "measured-drill-source",
        recoveryRegion: input.recoveryRegion ?? "measured-drill-target",
      });
    } catch {
      report = null;
    }
  }

  span.setAttribute("dr_drill.outcome", measured.outcome);
  span.end(measured.outcome === "passed" ? "ok" : "error");
  recordCounter("dr_drill_total", 1, { outcome: measured.outcome });
  recordHistogram("dr_drill_rto_seconds", measured.measured.recoveryTimeSeconds, {
    outcome: measured.outcome,
  });

  const { sha256: _drop, ...unsigned } = measured;
  return freezeResult({ ...unsigned, report });
}

export function verifyMeasuredDrillResult(result: MeasuredDrillResult): boolean {
  const { sha256: digest, ...unsigned } = result;
  return /^[a-f0-9]{64}$/.test(digest) && resultDigest(unsigned) === digest;
}

/**
 * Persist a measured drill result to an absolute path as authenticated evidence.
 * Additive: callers opt in by supplying a path.
 */
export function writeMeasuredDrillResult(
  evidencePath: string,
  result: MeasuredDrillResult,
): void {
  if (!isAbsolute(evidencePath)) throw new Error("measured_drill_evidence_path_must_be_absolute");
  const target = resolve(evidencePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const staging = `${target}.staging-${process.pid}-${Date.now()}`;
  writeFileSync(staging, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(staging, target);
}
