import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { openChangeSourceStore } from "@mendpoint/change-intel";
import { createDb } from "@mendpoint/db";
import { openGraphLearnDb } from "@mendpoint/graph-learn";
import {
  CORE_DISASTER_RECOVERY_POLICY,
  loadAuthenticatedBackupManifest,
  parseCustomerBackupKey,
  restoreBackupAtomically,
  tryAcquireMutationLease,
  validateCustomerRestorePathSafety,
  verifyObjectBackupRecoveryReceipt,
  type BackupManifest,
  type ObjectBackupPublication,
  type ObjectBackupRecoveryReceipt,
  type RecoveryResourceKind,
} from "@mendpoint/ops";
import {
  TransformerControlPlaneStore,
  TransformerPilotExecutionStore,
} from "@mendpoint/transformer";

import {
  createRcloneCustomerObjectStoreTransport,
  downloadCommittedCustomerBackup,
  loadCustomerBackupRecoveryReceipt,
  loadCustomerObjectStoreConfig,
  resolveCustomerRestoreStagingPath,
  type CustomerObjectStoreTransport,
} from "./customer-object-store.js";

export const PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION = 1 as const;

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RESOURCE_KINDS: readonly RecoveryResourceKind[] = Object.freeze([
  "artifacts",
  "changeSources",
  "configuration",
  "database",
  "graph",
  "transformerControlPlane",
  "transformerPilot",
]);
const SQLITE_KINDS = new Set<RecoveryResourceKind>([
  "changeSources",
  "database",
  "graph",
  "transformerControlPlane",
  "transformerPilot",
]);
const CANARY_TABLES: Readonly<Record<string, string>> = Object.freeze({
  changeSources: "change_source_schema_migrations",
  database: "providers",
  graph: "gl_nodes",
  transformerControlPlane: "transformer_schema_migrations",
  transformerPilot: "tf_pilot_campaigns",
});

type ProofEnvironment = "local" | "synthetic" | "production";

export type RecoverySchemaIdentity = Readonly<{
  kind: RecoveryResourceKind;
  beforeSha256: string;
  afterSha256: string;
  changed: boolean;
}>;

export type RecoverySemanticCanary = Readonly<{
  kind: RecoveryResourceKind;
  status: "passed";
  identitySha256: string;
  detail: Readonly<Record<string, string | number>>;
}>;

export type ProductionRecoveryProof = Readonly<{
  schemaVersion: typeof PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION;
  proofId: string;
  tenantId: string;
  state: "passed";
  environment: ProofEnvironment;
  requestDigest: string;
  backup: Readonly<{
    backupId: string;
    keyId: string;
    receiptDigest: string;
    commitDigest: string;
    manifestAuthentication: string;
    manifestSha256: string;
    createdAt: string;
  }>;
  revisions: Readonly<{ repository: string; deployed: string }>;
  resources: readonly Readonly<{
    kind: RecoveryResourceKind;
    manifestSha256: string;
    restoredSha256: string;
    sizeBytes: number;
    fileCount: number;
  }>[];
  schemaConvergence: readonly RecoverySchemaIdentity[];
  canaries: readonly RecoverySemanticCanary[];
  objectives: Readonly<{
    startedAt: string;
    finishedAt: string;
    recoveryTimeSeconds: number;
    recoveryPointAgeSeconds: number;
    rtoSeconds: number;
    rpoSeconds: number;
    rtoMet: true;
    rpoMet: true;
  }>;
  rollback: Readonly<{
    expectedDigest: string;
    restoredDigest: string;
    verified: true;
  }>;
  regionalFailure: Readonly<{
    sourceRegion: string;
    recoveryRegion: string;
    state: "isolated_target_exercised";
    productionProven: false;
  }>;
  externalProof: Readonly<{
    state: "pending_external_observation";
    productionBackupProvider: "unproven";
    approvedCrossRegionTarget: "unproven";
    realRegionalFailover: "unproven";
    productionProven: false;
  }>;
  integrity: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    digest: string;
  }>;
}>;

type FailedProductionRecoveryProof = Readonly<{
  schemaVersion: typeof PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION;
  proofId: string;
  tenantId: string;
  state: "failed";
  environment: ProofEnvironment;
  requestDigest: string;
  revisions: Readonly<{ repository: string; deployed: string }>;
  failedAt: string;
  failure: Readonly<{ code: string }>;
  externalProof: Readonly<{
    state: "pending_external_observation";
    productionProven: false;
  }>;
  integrity: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    digest: string;
  }>;
}>;

type PersistedRecoveryProof = ProductionRecoveryProof | FailedProductionRecoveryProof;

export type ProductionRecoveryProofInput = Readonly<{
  proofId: string;
  tenantId: string;
  environment: ProofEnvironment;
  key: Buffer;
  keyId: string;
  receipt: ObjectBackupRecoveryReceipt;
  expectedPublication: Readonly<Pick<ObjectBackupPublication, "bucket" | "prefix" | "endpointOrigin">>;
  evidencePath: string;
  backupRoot: string;
  targetRoot: string;
  rollbackRoot: string;
  dataRoot: string;
  sourceRoot?: string;
  fenceRoot: string;
  repositoryRevision: string;
  deployedRevision: string;
  sourceRegion: string;
  recoveryRegion: string;
  startedAt?: string;
}>;

export type ProductionRecoveryProofDependencies = Readonly<{
  downloadBackup: (input: {
    publication: ObjectBackupPublication;
    key: Buffer;
    destination: string;
  }) => Promise<string>;
  convergeStores?: (paths: Readonly<Record<RecoveryResourceKind, string>>) => void;
  runCanaries?: (
    paths: Readonly<Record<RecoveryResourceKind, string>>,
  ) => readonly RecoverySemanticCanary[];
  rollback?: (targetRoot: string, rollbackRoot: string) => void;
  now?: () => number;
  monotonic?: () => number;
}>;

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function requiredId(value: string, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) throw new Error(`${name}_invalid`);
  return value.trim();
}

function requiredSha(value: string, name: string): string {
  if (!SHA256.test(value)) throw new Error(`${name}_invalid`);
  return value;
}

function requiredRevision(value: string, name: string): string {
  if (!REVISION.test(value)) throw new Error(`${name}_invalid`);
  return value;
}

function requiredDate(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name}_invalid`);
  return new Date(value).toISOString();
}

function comparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(first: string, second: string): boolean {
  const a = comparablePath(first);
  const b = comparablePath(second);
  const relA = relative(a, b);
  const relB = relative(b, a);
  const contained = (rel: string) => rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return contained(relA) || contained(relB);
}

function assertNoExistingRedirect(value: string, code: string): void {
  const target = resolve(value);
  let current = parse(target).root;
  const rel = relative(current, target);
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error(code);
    if (comparablePath(realpathSync(current)) !== comparablePath(current)) throw new Error(code);
  }
}

function validateEvidencePath(value: string): string {
  if (!isAbsolute(value)) throw new Error("production_recovery_evidence_path_absolute_required");
  const path = resolve(value);
  if (comparablePath(path) === comparablePath(parse(path).root)) {
    throw new Error("production_recovery_evidence_path_unsafe");
  }
  assertNoExistingRedirect(dirname(path), "production_recovery_evidence_redirect_rejected");
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("production_recovery_evidence_redirect_rejected");
  }
  return path;
}

function keyedDigest(key: Buffer, purpose: string, value: unknown): string {
  return createHmac("sha256", key)
    .update(`mendpoint:${purpose}:v1\0`, "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function safeEqual(actual: string, expected: string): boolean {
  return SHA256.test(actual) && SHA256.test(expected) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function withoutIntegrity<T extends { integrity: unknown }>(value: T): Omit<T, "integrity"> {
  const { integrity: _integrity, ...unsigned } = value;
  return unsigned;
}

function signEvidence<T extends Omit<PersistedRecoveryProof, "integrity">>(
  value: T,
  key: Buffer,
  keyId: string,
): T & { integrity: PersistedRecoveryProof["integrity"] } {
  return Object.freeze({
    ...value,
    integrity: Object.freeze({
      algorithm: "hmac-sha256" as const,
      keyId,
      digest: keyedDigest(key, "production-recovery-proof", value),
    }),
  });
}

function verifyPersistedEvidence(
  value: PersistedRecoveryProof,
  key: Buffer,
  keyId: string,
): PersistedRecoveryProof {
  if (
    value.schemaVersion !== PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION ||
    value.integrity?.algorithm !== "hmac-sha256" ||
    value.integrity.keyId !== keyId ||
    !safeEqual(
      value.integrity.digest,
      keyedDigest(key, "production-recovery-proof", withoutIntegrity(value)),
    )
  ) throw new Error("production_recovery_evidence_authentication_failed");
  return value;
}

function persistCreateOnly(path: string, value: PersistedRecoveryProof): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const handle = openSync(path, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "production_recovery_failed";
  return /^[a-z0-9_:,.-]{1,256}$/.test(message)
    ? message
    : "production_recovery_dependency_failed";
}

function requestMaterial(input: ProductionRecoveryProofInput): Record<string, unknown> {
  return {
    schemaVersion: PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION,
    proofId: input.proofId,
    tenantId: input.tenantId,
    environment: input.environment,
    keyId: input.keyId,
    receiptDigest: input.receipt.integrity.digest,
    backupId: input.receipt.backupId,
    commitDigest: input.receipt.publication.commitDigest,
    manifestAuthentication: input.receipt.manifestAuthentication,
    manifestSha256: input.receipt.publication.manifestSha256,
    publication: input.expectedPublication,
    repositoryRevision: input.repositoryRevision,
    deployedRevision: input.deployedRevision,
    sourceRegion: input.sourceRegion,
    recoveryRegion: input.recoveryRegion,
    pathBindings: {
      backup: keyedDigest(input.key, "production-recovery-path", resolve(input.backupRoot)),
      target: keyedDigest(input.key, "production-recovery-path", resolve(input.targetRoot)),
      rollback: keyedDigest(input.key, "production-recovery-path", resolve(input.rollbackRoot)),
      data: keyedDigest(input.key, "production-recovery-path", resolve(input.dataRoot)),
      source: input.sourceRoot
        ? keyedDigest(input.key, "production-recovery-path", resolve(input.sourceRoot))
        : null,
      fence: keyedDigest(input.key, "production-recovery-path", resolve(input.fenceRoot)),
    },
  };
}

function validateInput(input: ProductionRecoveryProofInput): {
  evidencePath: string;
  requestDigest: string;
} {
  requiredId(input.proofId, "production_recovery_proof_id");
  requiredId(input.tenantId, "production_recovery_tenant_id");
  requiredId(input.keyId, "production_recovery_key_id");
  if (!new Set<ProofEnvironment>(["local", "synthetic", "production"]).has(input.environment)) {
    throw new Error("production_recovery_environment_invalid");
  }
  if (input.key.byteLength !== 32) throw new Error("production_recovery_key_invalid");
  requiredRevision(input.repositoryRevision, "production_recovery_repository_revision");
  requiredRevision(input.deployedRevision, "production_recovery_deployed_revision");
  if (input.environment === "production" && input.repositoryRevision !== input.deployedRevision) {
    throw new Error("production_recovery_revision_mismatch");
  }
  const sourceRegion = requiredId(input.sourceRegion, "production_recovery_source_region");
  const recoveryRegion = requiredId(input.recoveryRegion, "production_recovery_region");
  if (sourceRegion === recoveryRegion) throw new Error("production_recovery_regions_must_differ");
  const receipt = verifyObjectBackupRecoveryReceipt(input.receipt, input.key, input.keyId);
  if (!receipt.ok) {
    throw new Error(`production_recovery_receipt_invalid:${receipt.issues.join(",")}`);
  }
  if (
    input.receipt.publication.bucket !== input.expectedPublication.bucket ||
    input.receipt.publication.prefix !== input.expectedPublication.prefix ||
    input.receipt.publication.endpointOrigin !== input.expectedPublication.endpointOrigin
  ) throw new Error("production_recovery_publication_binding_mismatch");
  requiredSha(input.receipt.integrity.digest, "production_recovery_receipt_digest");
  requiredSha(input.receipt.publication.commitDigest, "production_recovery_commit_digest");
  requiredSha(input.receipt.publication.manifestSha256, "production_recovery_manifest_sha256");
  requiredSha(input.receipt.manifestAuthentication, "production_recovery_manifest_authentication");
  if (![input.backupRoot, input.targetRoot, input.rollbackRoot, input.dataRoot, input.fenceRoot]
    .every((value) => isAbsolute(value))) {
    throw new Error("production_recovery_absolute_paths_required");
  }
  const evidencePath = validateEvidencePath(input.evidencePath);
  return {
    evidencePath,
    requestDigest: keyedDigest(input.key, "production-recovery-request", requestMaterial(input)),
  };
}

function digestPath(path: string): { sha256: string; sizeBytes: number; fileCount: number } {
  assertNoExistingRedirect(path, "production_recovery_resource_redirect_rejected");
  const info = statSync(path);
  if (info.isFile()) {
    const content = readFileSync(path);
    return { sha256: sha256(content), sizeBytes: content.byteLength, fileCount: 1 };
  }
  if (!info.isDirectory()) throw new Error("production_recovery_resource_type_invalid");
  let sizeBytes = 0;
  const entries: Array<readonly [string, number, string]> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("production_recovery_resource_redirect_rejected");
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        const content = readFileSync(child);
        sizeBytes += content.byteLength;
        entries.push([relative(path, child).replaceAll("\\", "/"), content.byteLength, sha256(content)]);
      } else throw new Error("production_recovery_resource_type_invalid");
    }
  };
  visit(path);
  return { sha256: sha256(JSON.stringify(entries)), sizeBytes, fileCount: entries.length };
}

function restoredPaths(
  targetRoot: string,
  manifest: BackupManifest,
): Readonly<Record<RecoveryResourceKind, string>> {
  const paths = Object.fromEntries(manifest.resources.map((resource) => {
    const path = resolve(targetRoot, resource.sourceRelativePath);
    const rel = relative(resolve(targetRoot), path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("production_recovery_manifest_path_escape");
    }
    return [resource.kind, path];
  })) as Record<RecoveryResourceKind, string>;
  if (JSON.stringify(Object.keys(paths).sort()) !== JSON.stringify([...RESOURCE_KINDS].sort())) {
    throw new Error("production_recovery_manifest_resources_incomplete");
  }
  return Object.freeze(paths);
}

function sqliteSchemaDigest(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") {
      throw new Error("production_recovery_sqlite_integrity_failed");
    }
    const schema = db.prepare(
      "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    const userVersion = db.prepare("PRAGMA user_version").get();
    return sha256(JSON.stringify({ schema, userVersion }));
  } finally {
    db.close();
  }
}

function schemaIdentities(
  paths: Readonly<Record<RecoveryResourceKind, string>>,
): Readonly<Record<RecoveryResourceKind, string>> {
  return Object.freeze(Object.fromEntries(RESOURCE_KINDS.map((kind) => [
    kind,
    SQLITE_KINDS.has(kind) ? sqliteSchemaDigest(paths[kind]) : digestPath(paths[kind]).sha256,
  ])) as Record<RecoveryResourceKind, string>);
}

function migrationVersion(path: string, table: string): number | null {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const exists = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { present: number } | undefined;
    if (!exists) return null;
    const row = db.prepare(`SELECT MAX(version) AS version FROM "${table}"`).get() as {
      version: number | null;
    };
    return row.version === null ? 0 : Number(row.version);
  } finally {
    db.close();
  }
}

function defaultConvergeStores(paths: Readonly<Record<RecoveryResourceKind, string>>): void {
  const changeSourceVersion = migrationVersion(paths.changeSources, "change_source_schema_migrations");
  if (changeSourceVersion !== null && changeSourceVersion > 1) {
    throw new Error(`change_source_schema_newer_than_runtime:${changeSourceVersion}`);
  }
  const controlPlaneVersion = migrationVersion(paths.transformerControlPlane, "transformer_schema_migrations");
  if (controlPlaneVersion !== null && controlPlaneVersion > 2) {
    throw new Error(`unsupported_transformer_schema:${controlPlaneVersion}`);
  }
  const database = createDb(paths.database);
  database.raw.close();
  const graph = openGraphLearnDb(paths.graph);
  graph.raw.close();
  const changes = openChangeSourceStore(paths.changeSources);
  changes.close();
  const controlPlane = new TransformerControlPlaneStore(paths.transformerControlPlane);
  controlPlane.close();
  const pilot = new TransformerPilotExecutionStore(paths.transformerPilot);
  pilot.close();
}

function defaultCanaries(
  paths: Readonly<Record<RecoveryResourceKind, string>>,
): readonly RecoverySemanticCanary[] {
  return Object.freeze(RESOURCE_KINDS.map((kind): RecoverySemanticCanary => {
    if (SQLITE_KINDS.has(kind)) {
      const db = new DatabaseSync(paths[kind], { readOnly: true });
      try {
        const table = CANARY_TABLES[kind];
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        ).all() as Array<{ name: string }>;
        if (!table || !tables.some((row) => row.name === table)) {
          throw new Error(`production_recovery_${kind}_canary_failed`);
        }
        const row = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number };
        const detail = Object.freeze({ canonicalTable: table, canonicalRows: Number(row.count), tableCount: tables.length });
        return Object.freeze({ kind, status: "passed", identitySha256: sha256(JSON.stringify(detail)), detail });
      } finally {
        db.close();
      }
    }
    if (kind === "configuration") {
      const parsed = JSON.parse(readFileSync(paths.configuration, "utf8")) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("production_recovery_configuration_canary_failed");
      }
      const detail = Object.freeze({ keyCount: Object.keys(parsed).length, object: 1 });
      return Object.freeze({ kind, status: "passed", identitySha256: sha256(JSON.stringify(parsed)), detail });
    }
    const retainedRoots = ["transformer-candidates", "transformer-evidence", "warden-candidates", "warden-evidence"];
    for (const root of retainedRoots) {
      const path = resolve(paths.artifacts, root);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new Error("production_recovery_artifacts_canary_failed");
      }
    }
    const summary = digestPath(paths.artifacts);
    const detail = Object.freeze({ retainedRootCount: retainedRoots.length, fileCount: summary.fileCount });
    return Object.freeze({ kind, status: "passed", identitySha256: summary.sha256, detail });
  }));
}

function copyTreeCreateOnly(source: string, destination: string): void {
  if (existsSync(destination)) throw new Error("production_recovery_rollback_target_exists");
  assertNoExistingRedirect(source, "production_recovery_rollback_source_redirect_rejected");
  assertNoExistingRedirect(dirname(destination), "production_recovery_rollback_target_redirect_rejected");
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const visit = (from: string, to: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const sourcePath = resolve(from, entry.name);
      const destinationPath = resolve(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error("production_recovery_rollback_symlink_rejected");
      if (entry.isDirectory()) {
        mkdirSync(destinationPath, { mode: 0o700 });
        visit(sourcePath, destinationPath);
      } else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
      else throw new Error("production_recovery_rollback_resource_type_invalid");
    }
  };
  try {
    visit(source, destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function defaultRollback(targetRoot: string, rollbackRoot: string): void {
  rmSync(targetRoot, { recursive: true, force: true });
  renameSync(rollbackRoot, targetRoot);
}

function validateRunPaths(input: ProductionRecoveryProofInput): void {
  validateCustomerRestorePathSafety({
    backupRoot: input.backupRoot,
    targetRoot: input.targetRoot,
    dataRoot: input.dataRoot,
    sourceRoot: input.sourceRoot,
  });
  validateCustomerRestorePathSafety({
    backupRoot: input.backupRoot,
    targetRoot: input.rollbackRoot,
    dataRoot: input.dataRoot,
    sourceRoot: input.sourceRoot,
  });
  if (pathsOverlap(input.targetRoot, input.rollbackRoot)) {
    throw new Error("production_recovery_target_rollback_overlap");
  }
  for (const [path, code] of [
    [input.backupRoot, "production_recovery_staging_not_empty"],
    [input.targetRoot, "production_recovery_target_not_empty"],
    [input.rollbackRoot, "production_recovery_rollback_target_exists"],
  ] as const) {
    if (existsSync(path)) throw new Error(code);
  }
  assertNoExistingRedirect(input.fenceRoot, "production_recovery_fence_redirect_rejected");
}

function readCompletedReplay(
  input: ProductionRecoveryProofInput,
  evidencePath: string,
  requestDigest: string,
): ProductionRecoveryProof | null {
  if (!existsSync(evidencePath)) return null;
  let persisted: PersistedRecoveryProof;
  try {
    persisted = verifyPersistedEvidence(
      JSON.parse(readFileSync(evidencePath, "utf8")) as PersistedRecoveryProof,
      input.key,
      input.keyId,
    );
  } catch {
    throw new Error("production_recovery_existing_evidence_invalid");
  }
  if (
    persisted.proofId !== input.proofId ||
    persisted.tenantId !== input.tenantId ||
    persisted.environment !== input.environment ||
    !safeEqual(persisted.requestDigest, requestDigest)
  ) throw new Error("production_recovery_replay_binding_mismatch");
  if (persisted.state !== "passed") throw new Error("production_recovery_prior_failure_retained");
  return persisted;
}

export async function runProductionRecoveryProof(
  input: ProductionRecoveryProofInput,
  dependencies: ProductionRecoveryProofDependencies,
): Promise<ProductionRecoveryProof> {
  const { evidencePath, requestDigest } = validateInput(input);
  const replay = readCompletedReplay(input, evidencePath, requestDigest);
  if (replay) return replay;

  const now = dependencies.now ?? Date.now;
  const monotonic = dependencies.monotonic ?? (() => globalThis.performance.now());
  const startedAt = requiredDate(input.startedAt ?? new Date(now()).toISOString(), "production_recovery_started_at");
  const startedMs = Date.parse(startedAt);
  const perfStarted = monotonic();
  let manifest: BackupManifest | undefined;
  let lease: ReturnType<typeof tryAcquireMutationLease> | null = null;
  try {
    validateRunPaths(input);
    lease = tryAcquireMutationLease(input.fenceRoot);
    if (!lease) throw new Error("production_recovery_mutation_fence_unavailable");
    mkdirSync(dirname(resolve(input.targetRoot)), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(resolve(input.rollbackRoot)), { recursive: true, mode: 0o700 });

    await dependencies.downloadBackup({
      publication: input.receipt.publication,
      key: input.key,
      destination: input.backupRoot,
    });
    manifest = loadAuthenticatedBackupManifest(input.backupRoot, input.key);
    if (
      manifest.backupId !== input.receipt.backupId ||
      manifest.integrity.keyId !== input.keyId ||
      !safeEqual(manifest.integrity.digest, input.receipt.manifestAuthentication)
    ) throw new Error("production_recovery_manifest_binding_mismatch");

    const restore = restoreBackupAtomically({
      backupRoot: input.backupRoot,
      targetRoot: input.targetRoot,
      manifest,
      key: input.key,
    });
    const paths = restoredPaths(input.targetRoot, manifest);
    const restoredDigest = digestPath(input.targetRoot).sha256;
    if (!safeEqual(restoredDigest, restore.restoredDigest)) {
      throw new Error("production_recovery_restore_digest_mismatch");
    }
    const resourceDigests = Object.freeze(manifest.resources.map((resource) => {
      const restoredResource = digestPath(paths[resource.kind]);
      return Object.freeze({
        kind: resource.kind,
        manifestSha256: resource.sha256,
        restoredSha256: restoredResource.sha256,
        sizeBytes: restoredResource.sizeBytes,
        fileCount: restoredResource.fileCount,
      });
    }).sort((a, b) => a.kind.localeCompare(b.kind)));
    if (resourceDigests.length !== RESOURCE_KINDS.length) {
      throw new Error("production_recovery_resource_digest_incomplete");
    }

    copyTreeCreateOnly(input.targetRoot, input.rollbackRoot);
    const rollbackSnapshotDigest = digestPath(input.rollbackRoot).sha256;
    if (!safeEqual(rollbackSnapshotDigest, restoredDigest)) {
      throw new Error("production_recovery_rollback_snapshot_mismatch");
    }

    const before = schemaIdentities(paths);
    (dependencies.convergeStores ?? defaultConvergeStores)(paths);
    const after = schemaIdentities(paths);
    const schemaConvergence = Object.freeze(RESOURCE_KINDS.map((kind) => Object.freeze({
      kind,
      beforeSha256: before[kind],
      afterSha256: after[kind],
      changed: before[kind] !== after[kind],
    })));
    const canaries = Object.freeze([...(dependencies.runCanaries ?? defaultCanaries)(paths)]);
    if (
      canaries.length !== RESOURCE_KINDS.length ||
      JSON.stringify(canaries.map((canary) => canary.kind).sort()) !== JSON.stringify([...RESOURCE_KINDS].sort()) ||
      canaries.some((canary) => canary.status !== "passed" || !SHA256.test(canary.identitySha256))
    ) throw new Error("production_recovery_canary_matrix_incomplete");

    (dependencies.rollback ?? defaultRollback)(input.targetRoot, input.rollbackRoot);
    const rollbackDigest = digestPath(input.targetRoot).sha256;
    if (!safeEqual(rollbackDigest, restoredDigest)) {
      throw new Error("production_recovery_rollback_integrity_failed");
    }

    const recoveryTimeSeconds = Math.max(0, monotonic() - perfStarted) / 1000;
    const recoveryPointAgeSeconds = Math.max(0, startedMs - Date.parse(manifest.createdAt)) / 1000;
    if (recoveryTimeSeconds > CORE_DISASTER_RECOVERY_POLICY.rtoSeconds) {
      throw new Error("production_recovery_rto_missed");
    }
    if (recoveryPointAgeSeconds > CORE_DISASTER_RECOVERY_POLICY.rpoSeconds) {
      throw new Error("production_recovery_rpo_missed");
    }
    const finishedAt = new Date(startedMs + Math.round(recoveryTimeSeconds * 1000)).toISOString();
    const unsigned: Omit<ProductionRecoveryProof, "integrity"> = {
      schemaVersion: PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION,
      proofId: input.proofId,
      tenantId: input.tenantId,
      state: "passed",
      environment: input.environment,
      requestDigest,
      backup: Object.freeze({
        backupId: manifest.backupId,
        keyId: input.keyId,
        receiptDigest: input.receipt.integrity.digest,
        commitDigest: input.receipt.publication.commitDigest,
        manifestAuthentication: manifest.integrity.digest,
        manifestSha256: input.receipt.publication.manifestSha256,
        createdAt: manifest.createdAt,
      }),
      revisions: Object.freeze({ repository: input.repositoryRevision, deployed: input.deployedRevision }),
      resources: resourceDigests,
      schemaConvergence,
      canaries,
      objectives: Object.freeze({
        startedAt,
        finishedAt,
        recoveryTimeSeconds,
        recoveryPointAgeSeconds,
        rtoSeconds: CORE_DISASTER_RECOVERY_POLICY.rtoSeconds,
        rpoSeconds: CORE_DISASTER_RECOVERY_POLICY.rpoSeconds,
        rtoMet: true,
        rpoMet: true,
      }),
      rollback: Object.freeze({ expectedDigest: restoredDigest, restoredDigest: rollbackDigest, verified: true }),
      regionalFailure: Object.freeze({
        sourceRegion: input.sourceRegion,
        recoveryRegion: input.recoveryRegion,
        state: "isolated_target_exercised",
        productionProven: false,
      }),
      externalProof: Object.freeze({
        state: "pending_external_observation",
        productionBackupProvider: "unproven",
        approvedCrossRegionTarget: "unproven",
        realRegionalFailover: "unproven",
        productionProven: false,
      }),
    };
    const proof = signEvidence(unsigned, input.key, input.keyId) as ProductionRecoveryProof;
    persistCreateOnly(evidencePath, proof);
    return proof;
  } catch (error) {
    if (!existsSync(evidencePath)) {
      const failed = signEvidence({
        schemaVersion: PRODUCTION_RECOVERY_PROOF_SCHEMA_VERSION,
        proofId: input.proofId,
        tenantId: input.tenantId,
        state: "failed" as const,
        environment: input.environment,
        requestDigest,
        revisions: Object.freeze({ repository: input.repositoryRevision, deployed: input.deployedRevision }),
        failedAt: new Date(now()).toISOString(),
        failure: Object.freeze({ code: safeFailureCode(error) }),
        externalProof: Object.freeze({ state: "pending_external_observation" as const, productionProven: false as const }),
      }, input.key, input.keyId) as FailedProductionRecoveryProof;
      persistCreateOnly(evidencePath, failed);
    }
    throw error;
  } finally {
    lease?.release();
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_required`);
  return value;
}

async function main(): Promise<void> {
  if (process.env.MENDPOINT_DEPLOYMENT_PROFILE !== "customer") {
    throw new Error("production_recovery_customer_profile_required");
  }
  const key = parseCustomerBackupKey(process.env.MENDPOINT_BACKUP_KEY);
  const keyId = requiredEnv("MENDPOINT_BACKUP_KEY_ID");
  const backupId = requiredEnv("MENDPOINT_RECOVERY_BACKUP_ID");
  const objectStore = loadCustomerObjectStoreConfig(process.env);
  const transport: CustomerObjectStoreTransport = createRcloneCustomerObjectStoreTransport(objectStore, process.env);
  const receipt = await loadCustomerBackupRecoveryReceipt({
    backupId,
    keyId,
    key,
    config: objectStore,
  }, transport);
  const stagingRoot = requiredEnv("MENDPOINT_RECOVERY_STAGING_ROOT");
  const backupRoot = resolveCustomerRestoreStagingPath(stagingRoot, `proof-${backupId}`);
  const proof = await runProductionRecoveryProof({
    proofId: requiredEnv("MENDPOINT_RECOVERY_PROOF_ID"),
    tenantId: requiredEnv("MENDPOINT_RECOVERY_TENANT_ID"),
    environment: requiredEnv("MENDPOINT_RECOVERY_ENVIRONMENT") as ProofEnvironment,
    key,
    keyId,
    receipt,
    expectedPublication: {
      bucket: objectStore.bucket,
      prefix: `${objectStore.basePrefix}/${backupId}`,
      endpointOrigin: objectStore.endpointOrigin,
    },
    evidencePath: requiredEnv("MENDPOINT_RECOVERY_EVIDENCE_PATH"),
    backupRoot,
    targetRoot: requiredEnv("MENDPOINT_RECOVERY_TARGET_ROOT"),
    rollbackRoot: requiredEnv("MENDPOINT_RECOVERY_ROLLBACK_ROOT"),
    dataRoot: requiredEnv("MENDPOINT_DATA_DIR"),
    sourceRoot: process.env.MENDPOINT_BACKUP_SOURCE_ROOT?.trim(),
    fenceRoot: requiredEnv("MENDPOINT_BACKUP_FENCE_ROOT"),
    repositoryRevision: requiredEnv("MENDPOINT_RECOVERY_REPOSITORY_REVISION"),
    deployedRevision: requiredEnv("MENDPOINT_RECOVERY_DEPLOYED_REVISION"),
    sourceRegion: requiredEnv("MENDPOINT_RECOVERY_SOURCE_REGION"),
    recoveryRegion: requiredEnv("MENDPOINT_RECOVERY_REGION"),
  }, {
    downloadBackup: async (download) => await downloadCommittedCustomerBackup(download, transport),
  });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(safeFailureCode(error));
    process.exitCode = 1;
  });
}
