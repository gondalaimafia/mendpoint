import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const DISASTER_RECOVERY_POLICY_SCHEMA_VERSION = 1 as const;
export const BACKUP_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RECOVERY_DRILL_REPORT_SCHEMA_VERSION = 1 as const;

export type RecoveryResourceKind = "database" | "graph" | "artifacts" | "configuration";

const RESOURCE_KINDS: readonly RecoveryResourceKind[] = Object.freeze([
  "artifacts",
  "configuration",
  "database",
  "graph",
]);

export interface DisasterRecoveryPolicy {
  schemaVersion: typeof DISASTER_RECOVERY_POLICY_SCHEMA_VERSION;
  policyId: string;
  version: string;
  effectiveAt: string;
  rtoSeconds: number;
  rpoSeconds: number;
  drillCadenceDays: number;
  requiredResources: readonly RecoveryResourceKind[];
}

export const CORE_DISASTER_RECOVERY_POLICY: Readonly<DisasterRecoveryPolicy> = Object.freeze({
  schemaVersion: DISASTER_RECOVERY_POLICY_SCHEMA_VERSION,
  policyId: "mendpoint-core",
  version: "2026-08-02",
  effectiveAt: "2026-08-02T00:00:00.000Z",
  rtoSeconds: 900,
  rpoSeconds: 3600,
  drillCadenceDays: 30,
  requiredResources: Object.freeze(["database", "graph", "artifacts", "configuration"] as const),
});

export interface BackupResourceManifest {
  kind: RecoveryResourceKind;
  sourceRelativePath: string;
  backupPath: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

export interface BackupManifest {
  schemaVersion: typeof BACKUP_MANIFEST_SCHEMA_VERSION;
  backupId: string;
  createdAt: string;
  policy: Readonly<Pick<DisasterRecoveryPolicy, "policyId" | "version" | "rtoSeconds" | "rpoSeconds">>;
  resources: readonly BackupResourceManifest[];
  integrity: Readonly<{ algorithm: "sha256"; digest: string }>;
}

export interface RecoveryDrillReport {
  schemaVersion: typeof RECOVERY_DRILL_REPORT_SCHEMA_VERSION;
  drillId: string;
  policy: Readonly<{ policyId: string; version: string; drillCadenceDays: number }>;
  backup: Readonly<{ backupId: string; manifestSha256: string; createdAt: string }>;
  startedAt: string;
  finishedAt: string;
  outcome: "passed" | "failed";
  restore: Readonly<{ atomic: true; isolated: true; restoredDigest: string }>;
  migration: Readonly<{ status: "applied"; evidence: string; beforeDigest: string; afterDigest: string }>;
  rollback: Readonly<{ status: "verified"; evidence: string; restoredDigest: string }>;
  regionalFailure: Readonly<{
    mode: "isolated_simulation";
    sourceRegion: string;
    recoveryRegion: string;
    state: "simulated";
    productionProven: false;
  }>;
  objectives: Readonly<{
    recoveryTimeSeconds: number;
    recoveryPointAgeSeconds: number;
    rtoSeconds: number;
    rpoSeconds: number;
    rtoMet: boolean;
    rpoMet: boolean;
  }>;
  nextDueAt: string;
  integrity: Readonly<{ algorithm: "sha256"; digest: string }>;
}

interface PathDigest {
  sha256: string;
  sizeBytes: number;
  fileCount: number;
}

interface CreateBackupBundleInput {
  policy: DisasterRecoveryPolicy;
  backupId: string;
  createdAt: string;
  sourceRoot: string;
  backupRoot: string;
  resources: Record<RecoveryResourceKind, string>;
}

interface RestoreBackupInput {
  backupRoot: string;
  targetRoot: string;
  manifest: BackupManifest;
}

interface RunRecoveryDrillInput extends RestoreBackupInput {
  drillId: string;
  policy: DisasterRecoveryPolicy;
  startedAt: string;
  finishedAt: string;
  sourceRegion: string;
  recoveryRegion: string;
  migrate: (targetRoot: string) => string;
  rollback: (targetRoot: string) => string;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name}_required`);
  return value.trim();
}

function validDate(value: string, name: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name}_invalid`);
  return date;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name}_invalid`);
  return value;
}

function validatePolicy(policy: DisasterRecoveryPolicy): void {
  if (policy.schemaVersion !== DISASTER_RECOVERY_POLICY_SCHEMA_VERSION) {
    throw new Error("recovery_policy_schema_version_unsupported");
  }
  requiredText(policy.policyId, "recovery_policy_id");
  requiredText(policy.version, "recovery_policy_version");
  validDate(policy.effectiveAt, "recovery_policy_effective_at");
  positiveInteger(policy.rtoSeconds, "recovery_policy_rto_seconds");
  positiveInteger(policy.rpoSeconds, "recovery_policy_rpo_seconds");
  positiveInteger(policy.drillCadenceDays, "recovery_policy_drill_cadence_days");
  const actual = [...new Set(policy.requiredResources)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(RESOURCE_KINDS)) {
    throw new Error("recovery_policy_resources_incomplete");
  }
}

function resolveContained(root: string, path: string, name: string): string {
  if (isAbsolute(path)) throw new Error(`${name}_must_be_relative`);
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, path);
  if (candidate === rootPath || !candidate.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`${name}_outside_root`);
  }
  return candidate;
}

function assertNoSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error("recovery_resource_symlink_rejected");
}

function listFiles(root: string, current = root): string[] {
  assertNoSymlink(current);
  if (statSync(current).isFile()) return [current];
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("recovery_resource_symlink_rejected");
      return entry.isDirectory() ? listFiles(root, path) : [path];
    });
}

function digestPath(path: string): PathDigest {
  if (!existsSync(path)) throw new Error("recovery_resource_missing");
  assertNoSymlink(path);
  if (statSync(path).isFile()) {
    const content = readFileSync(path);
    return { sha256: sha256(content), sizeBytes: content.byteLength, fileCount: 1 };
  }
  const files = listFiles(path);
  let sizeBytes = 0;
  const entries = files.map((file) => {
    const content = readFileSync(file);
    sizeBytes += content.byteLength;
    return [relative(path, file).replaceAll("\\", "/"), content.byteLength, sha256(content)];
  });
  return { sha256: sha256(JSON.stringify(entries)), sizeBytes, fileCount: files.length };
}

function withoutIntegrity<T extends { integrity: unknown }>(value: T): Omit<T, "integrity"> {
  const { integrity: _integrity, ...unsigned } = value;
  return unsigned;
}

function manifestDigest(manifest: BackupManifest): string {
  return sha256(JSON.stringify(withoutIntegrity(manifest)));
}

function reportDigest(report: RecoveryDrillReport): string {
  return sha256(JSON.stringify(withoutIntegrity(report)));
}

function digestRestoredResources(targetRoot: string): string {
  return digestPath(resolve(targetRoot, "resources")).sha256;
}

function ensureDistinctRoots(first: string, second: string, error: string): void {
  const a = resolve(first);
  const b = resolve(second);
  if (a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)) throw new Error(error);
}

export function createBackupBundle(input: CreateBackupBundleInput): BackupManifest {
  validatePolicy(input.policy);
  requiredText(input.backupId, "backup_id");
  validDate(input.createdAt, "backup_created_at");
  if (!existsSync(input.sourceRoot)) throw new Error("backup_source_missing");
  if (existsSync(input.backupRoot)) throw new Error("backup_target_exists");
  ensureDistinctRoots(input.sourceRoot, input.backupRoot, "backup_target_not_isolated");

  const stagingRoot = `${resolve(input.backupRoot)}.staging-${randomUUID()}`;
  try {
    mkdirSync(resolve(stagingRoot, "resources"), { recursive: true });
    const resources = RESOURCE_KINDS.map((kind): BackupResourceManifest => {
      const sourceRelativePath = requiredText(input.resources[kind], `backup_${kind}_path`).replaceAll("\\", "/");
      const sourcePath = resolveContained(input.sourceRoot, sourceRelativePath, `backup_${kind}_path`);
      if (!existsSync(sourcePath)) throw new Error(`backup_${kind}_missing`);
      const backupPath = `resources/${kind}`;
      const destination = resolveContained(stagingRoot, backupPath, `backup_${kind}_destination`);
      cpSync(sourcePath, destination, { recursive: true, errorOnExist: true });
      const digest = digestPath(destination);
      return { kind, sourceRelativePath, backupPath, ...digest };
    });
    const unsigned = {
      schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      backupId: input.backupId,
      createdAt: input.createdAt,
      policy: {
        policyId: input.policy.policyId,
        version: input.policy.version,
        rtoSeconds: input.policy.rtoSeconds,
        rpoSeconds: input.policy.rpoSeconds,
      },
      resources,
    } as const;
    const manifest: BackupManifest = {
      ...unsigned,
      integrity: { algorithm: "sha256", digest: sha256(JSON.stringify(unsigned)) },
    };
    writeFileSync(resolve(stagingRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    renameSync(stagingRoot, resolve(input.backupRoot));
    return manifest;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function verifyBackupBundle(
  backupRoot: string,
  manifest: BackupManifest,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (manifest.schemaVersion !== BACKUP_MANIFEST_SCHEMA_VERSION) issues.push("manifest_schema_version_unsupported");
  if (manifest.integrity?.algorithm !== "sha256" || manifest.integrity.digest !== manifestDigest(manifest)) {
    issues.push("manifest_integrity_mismatch");
  }
  try {
    const stored = JSON.parse(readFileSync(resolve(backupRoot, "manifest.json"), "utf8")) as BackupManifest;
    if (JSON.stringify(stored) !== JSON.stringify(manifest)) issues.push("stored_manifest_mismatch");
  } catch (error) {
    issues.push(`stored_manifest_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  const kinds = manifest.resources.map((resource) => resource.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(RESOURCE_KINDS)) issues.push("manifest_resources_incomplete_or_unsorted");
  for (const resource of manifest.resources) {
    try {
      const path = resolveContained(backupRoot, resource.backupPath, `manifest_${resource.kind}_path`);
      const actual = digestPath(path);
      if (actual.sha256 !== resource.sha256) issues.push(`${resource.kind}_hash_mismatch`);
      if (actual.sizeBytes !== resource.sizeBytes) issues.push(`${resource.kind}_size_mismatch`);
      if (actual.fileCount !== resource.fileCount) issues.push(`${resource.kind}_file_count_mismatch`);
    } catch (error) {
      issues.push(`${resource.kind}_verification_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function restoreBackupAtomically(input: RestoreBackupInput): {
  atomic: true;
  isolated: true;
  restoredDigest: string;
} {
  if (existsSync(input.targetRoot)) throw new Error("restore_target_exists");
  ensureDistinctRoots(input.backupRoot, input.targetRoot, "restore_target_not_isolated");
  const verified = verifyBackupBundle(input.backupRoot, input.manifest);
  if (!verified.ok) throw new Error(`backup_integrity_failed:${verified.issues.join(",")}`);

  const target = resolve(input.targetRoot);
  const stagingRoot = `${target}.staging-${randomUUID()}`;
  try {
    mkdirSync(resolve(stagingRoot, "resources"), { recursive: true });
    for (const resource of input.manifest.resources) {
      const source = resolveContained(input.backupRoot, resource.backupPath, `restore_${resource.kind}_source`);
      const destination = resolveContained(stagingRoot, resource.backupPath, `restore_${resource.kind}_destination`);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true, errorOnExist: true });
      if (digestPath(destination).sha256 !== resource.sha256) {
        throw new Error(`restore_${resource.kind}_integrity_failed`);
      }
    }
    writeFileSync(resolve(stagingRoot, "manifest.json"), `${JSON.stringify(input.manifest, null, 2)}\n`, { flag: "wx" });
    const restoredDigest = digestRestoredResources(stagingRoot);
    renameSync(stagingRoot, target);
    return { atomic: true, isolated: true, restoredDigest };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function runIsolatedRecoveryDrill(input: RunRecoveryDrillInput): RecoveryDrillReport {
  validatePolicy(input.policy);
  requiredText(input.drillId, "recovery_drill_id");
  const startedAt = validDate(input.startedAt, "recovery_drill_started_at");
  const finishedAt = validDate(input.finishedAt, "recovery_drill_finished_at");
  const backupCreatedAt = validDate(input.manifest.createdAt, "backup_created_at");
  if (finishedAt < startedAt) throw new Error("recovery_drill_time_order_invalid");
  if (startedAt < backupCreatedAt) throw new Error("recovery_point_time_order_invalid");
  if (input.manifest.policy.policyId !== input.policy.policyId || input.manifest.policy.version !== input.policy.version) {
    throw new Error("recovery_policy_manifest_mismatch");
  }
  const sourceRegion = requiredText(input.sourceRegion, "recovery_source_region");
  const recoveryRegion = requiredText(input.recoveryRegion, "recovery_target_region");
  if (sourceRegion === recoveryRegion) throw new Error("recovery_regions_must_differ");

  const restore = restoreBackupAtomically(input);
  const beforeDigest = digestRestoredResources(input.targetRoot);
  const migrationEvidence = requiredText(input.migrate(input.targetRoot), "recovery_migration_evidence");
  const afterDigest = digestRestoredResources(input.targetRoot);
  const rollbackEvidence = requiredText(input.rollback(input.targetRoot), "recovery_rollback_evidence");
  const rollbackDigest = digestRestoredResources(input.targetRoot);
  const verifiedRestore = verifyBackupBundle(input.targetRoot, input.manifest);
  if (rollbackDigest !== beforeDigest || !verifiedRestore.ok) {
    throw new Error("recovery_rollback_integrity_failed");
  }

  const recoveryTimeSeconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
  const recoveryPointAgeSeconds = (startedAt.getTime() - backupCreatedAt.getTime()) / 1000;
  const nextDue = new Date(finishedAt);
  nextDue.setUTCDate(nextDue.getUTCDate() + input.policy.drillCadenceDays);
  const unsigned = {
    schemaVersion: RECOVERY_DRILL_REPORT_SCHEMA_VERSION,
    drillId: input.drillId,
    policy: {
      policyId: input.policy.policyId,
      version: input.policy.version,
      drillCadenceDays: input.policy.drillCadenceDays,
    },
    backup: {
      backupId: input.manifest.backupId,
      manifestSha256: input.manifest.integrity.digest,
      createdAt: input.manifest.createdAt,
    },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    outcome: "passed" as const,
    restore,
    migration: { status: "applied" as const, evidence: migrationEvidence, beforeDigest, afterDigest },
    rollback: { status: "verified" as const, evidence: rollbackEvidence, restoredDigest: rollbackDigest },
    regionalFailure: {
      mode: "isolated_simulation" as const,
      sourceRegion,
      recoveryRegion,
      state: "simulated" as const,
      productionProven: false as const,
    },
    objectives: {
      recoveryTimeSeconds,
      recoveryPointAgeSeconds,
      rtoSeconds: input.policy.rtoSeconds,
      rpoSeconds: input.policy.rpoSeconds,
      rtoMet: recoveryTimeSeconds <= input.policy.rtoSeconds,
      rpoMet: recoveryPointAgeSeconds <= input.policy.rpoSeconds,
    },
    nextDueAt: nextDue.toISOString(),
  };
  const report: RecoveryDrillReport = {
    ...unsigned,
    integrity: { algorithm: "sha256", digest: sha256(JSON.stringify(unsigned)) },
  };
  return report;
}

export function verifyRecoveryDrillReport(report: RecoveryDrillReport): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (report.schemaVersion !== RECOVERY_DRILL_REPORT_SCHEMA_VERSION) issues.push("report_schema_version_unsupported");
  if (report.integrity?.algorithm !== "sha256" || report.integrity.digest !== reportDigest(report)) {
    issues.push("report_integrity_mismatch");
  }
  if (report.regionalFailure.mode !== "isolated_simulation" || report.regionalFailure.productionProven !== false) {
    issues.push("report_production_claim_forbidden");
  }
  if (report.outcome === "passed" && report.rollback.status !== "verified") issues.push("report_rollback_unverified");
  return { ok: issues.length === 0, issues };
}

export function assessRecoveryDrillCadence(input: {
  policy: DisasterRecoveryPolicy;
  reports: readonly RecoveryDrillReport[];
  asOf: string;
}): {
  status: "never_run" | "current" | "overdue";
  lastVerifiedDrillId: string | null;
  nextDueAt: string | null;
} {
  validatePolicy(input.policy);
  const asOf = validDate(input.asOf, "recovery_cadence_as_of");
  const verified = input.reports
    .filter((report) => report.policy.policyId === input.policy.policyId && report.policy.version === input.policy.version)
    .filter((report) => report.outcome === "passed" && verifyRecoveryDrillReport(report).ok)
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  const latest = verified[0];
  if (!latest) return { status: "never_run", lastVerifiedDrillId: null, nextDueAt: null };
  const nextDue = validDate(latest.nextDueAt, "recovery_next_due_at");
  return {
    status: asOf <= nextDue ? "current" : "overdue",
    lastVerifiedDrillId: latest.drillId,
    nextDueAt: latest.nextDueAt,
  };
}
