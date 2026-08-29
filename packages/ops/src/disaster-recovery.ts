import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  chownSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRenamedEnv } from "@mendpoint/shared";

export const DISASTER_RECOVERY_POLICY_SCHEMA_VERSION = 1 as const;
export const BACKUP_MANIFEST_SCHEMA_VERSION = 3 as const;
export const RECOVERY_DRILL_REPORT_SCHEMA_VERSION = 1 as const;
export const LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const OBJECT_BACKUP_COMMIT_SCHEMA_VERSION = 1 as const;
export const OBJECT_BACKUP_RECOVERY_RECEIPT_SCHEMA_VERSION = 1 as const;
export const REGAUGE_CUTOVER_FENCE_NAME = "regauge-cutover-fence.v1.json" as const;

export type SqliteRecoveryResourceKind =
  | "database"
  | "graph"
  | "changeSources"
  | "transformerControlPlane"
  | "transformerPilot";
export type RecoveryResourceKind =
  | SqliteRecoveryResourceKind
  | "artifacts"
  | "configuration";

const RESOURCE_KINDS: readonly RecoveryResourceKind[] = Object.freeze([
  "artifacts",
  "changeSources",
  "configuration",
  "database",
  "graph",
  "transformerControlPlane",
  "transformerPilot",
]);

const SQLITE_RESOURCE_KINDS = new Set<RecoveryResourceKind>([
  "database",
  "graph",
  "changeSources",
  "transformerControlPlane",
  "transformerPilot",
]);

const RETAINED_ARTIFACT_ROOTS = Object.freeze([
  "warden-candidates",
  "warden-evidence",
  "transformer-candidates",
  "transformer-evidence",
] as const);

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
  requiredResources: RESOURCE_KINDS,
});

export interface BackupEncryptedFileManifest {
  relativePath: string;
  ciphertextPath: string;
  iv: string;
  authTag: string;
  ciphertextSha256: string;
  sizeBytes: number;
}

export interface BackupResourceManifest {
  kind: RecoveryResourceKind;
  sourceRelativePath: string;
  backupPath: string;
  sha256: string;
  sizeBytes: number;
  fileCount: number;
  encryptedFiles: readonly BackupEncryptedFileManifest[];
  retainedArtifactRoots?: readonly string[];
}

export interface BackupManifest {
  schemaVersion: typeof BACKUP_MANIFEST_SCHEMA_VERSION;
  backupId: string;
  createdAt: string;
  policy: Readonly<Pick<DisasterRecoveryPolicy, "policyId" | "version" | "rtoSeconds" | "rpoSeconds">>;
  resources: readonly BackupResourceManifest[];
  encryption: Readonly<{ algorithm: "aes-256-gcm" }>;
  integrity: Readonly<{ algorithm: "hmac-sha256"; keyId: string; digest: string }>;
}

export interface ObjectBackupPublication {
  kind: "s3";
  backupId: string;
  bucket: string;
  prefix: string;
  endpointOrigin: string;
  commitDigest: string;
  manifestSha256: string;
}

export interface ObjectBackupCommit {
  schemaVersion: typeof OBJECT_BACKUP_COMMIT_SCHEMA_VERSION;
  backupId: string;
  bucket: string;
  prefix: string;
  endpointOrigin: string;
  manifestSha256: string;
  manifestAuthentication: string;
  objectCount: number;
  sizeBytes: number;
  publishedAt: string;
  integrity: Readonly<{ algorithm: "hmac-sha256"; digest: string }>;
}

export interface ObjectBackupRecoveryReceipt {
  schemaVersion: typeof OBJECT_BACKUP_RECOVERY_RECEIPT_SCHEMA_VERSION;
  backupId: string;
  keyId: string;
  verifiedAt: string;
  manifestAuthentication: string;
  publication: Readonly<ObjectBackupPublication>;
  integrity: Readonly<{ algorithm: "hmac-sha256"; digest: string }>;
}

export interface LastVerifiedBackupEvidence {
  schemaVersion: 1 | typeof LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION;
  backupId: string;
  backupRoot: string;
  createdAt: string;
  verifiedAt: string;
  keyId: string;
  manifestAuthentication: string;
  publication?: Readonly<ObjectBackupPublication>;
  integrity: Readonly<{ algorithm: "hmac-sha256"; keyId: string; digest: string }>;
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
  key: Buffer;
  keyId: string;
}

export interface MutationLease {
  readonly id: string;
  readonly fenceRoot: string;
  release(): void;
}

export interface ApplicationConsistentBackupInput extends CreateBackupBundleInput {
  fenceRoot: string;
  outputRoot?: string;
  evidencePath?: string;
  storageClass?: "durable_isolated_mount" | "isolated_publish_staging";
  requireDistinctDevice?: boolean;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface RestoreBackupInput {
  backupRoot: string;
  targetRoot: string;
  manifest: BackupManifest;
  key: Buffer;
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

function hmacSha256(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

function derivedKey(key: Buffer, backupId: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    key,
    Buffer.from(backupId, "utf8"),
    Buffer.from(`mendpoint:${purpose}:v1`, "utf8"),
    32,
  ));
}

const OBJECT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function validateObjectPublicationIdentity(input: {
  backupId: string;
  bucket: string;
  prefix: string;
  endpointOrigin: string;
  manifestSha256: string;
}): void {
  if (!CUSTOMER_BACKUP_ID.test(input.backupId)) throw new Error("object_backup_id_invalid");
  if (!BUCKET_NAME.test(input.bucket)) throw new Error("object_backup_bucket_invalid");
  if (
    !OBJECT_PREFIX.test(input.prefix) ||
    input.prefix.startsWith("/") ||
    input.prefix.endsWith("/") ||
    input.prefix.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new Error("object_backup_prefix_invalid");
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpointOrigin);
  } catch {
    throw new Error("object_backup_endpoint_invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.origin !== input.endpointOrigin
  ) throw new Error("object_backup_endpoint_invalid");
  if (!/^[a-f0-9]{64}$/.test(input.manifestSha256)) {
    throw new Error("object_backup_manifest_sha256_invalid");
  }
}

export function createObjectBackupCommit(
  input: Omit<ObjectBackupCommit, "schemaVersion" | "integrity">,
  key: Buffer,
): ObjectBackupCommit {
  if (key.byteLength !== 32) throw new Error("object_backup_key_invalid");
  validateObjectPublicationIdentity(input);
  if (!/^[a-f0-9]{64}$/.test(input.manifestAuthentication)) {
    throw new Error("object_backup_manifest_authentication_invalid");
  }
  if (!Number.isSafeInteger(input.objectCount) || input.objectCount <= 0) {
    throw new Error("object_backup_object_count_invalid");
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new Error("object_backup_size_invalid");
  }
  validDate(input.publishedAt, "object_backup_published_at");
  const unsigned = {
    schemaVersion: OBJECT_BACKUP_COMMIT_SCHEMA_VERSION,
    ...input,
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      digest: hmacSha256(
        derivedKey(key, input.backupId, "object-backup-commit"),
        JSON.stringify(unsigned),
      ),
    },
  };
}

export function verifyObjectBackupCommit(
  commit: ObjectBackupCommit,
  key: Buffer,
): { ok: boolean; issues: string[] } {
  try {
    if (commit.schemaVersion !== OBJECT_BACKUP_COMMIT_SCHEMA_VERSION) {
      return { ok: false, issues: ["object_backup_commit_schema_unsupported"] };
    }
    if (commit.integrity?.algorithm !== "hmac-sha256") {
      return { ok: false, issues: ["object_backup_commit_integrity_algorithm_invalid"] };
    }
    const expected = createObjectBackupCommit(withoutIntegrity(commit), key);
    return safeEqualHex(expected.integrity.digest, commit.integrity?.digest ?? "")
      ? { ok: true, issues: [] }
      : { ok: false, issues: ["object_backup_commit_authentication_failed"] };
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : "object_backup_commit_invalid"],
    };
  }
}

export function createObjectBackupRecoveryReceipt(
  input: Omit<ObjectBackupRecoveryReceipt, "schemaVersion" | "integrity">,
  key: Buffer,
): ObjectBackupRecoveryReceipt {
  if (key.byteLength !== 32) throw new Error("object_backup_key_invalid");
  if (input.publication.backupId !== input.backupId) {
    throw new Error("object_backup_recovery_receipt_id_mismatch");
  }
  const { backupId: _publicationBackupId, ...publicationIdentity } = input.publication;
  validateObjectPublicationIdentity({ backupId: input.backupId, ...publicationIdentity });
  if (!/^[a-f0-9]{64}$/.test(input.publication.commitDigest)) {
    throw new Error("object_backup_commit_digest_invalid");
  }
  if (!input.publication.prefix.endsWith(`/${input.backupId}`)) {
    throw new Error("object_backup_prefix_id_mismatch");
  }
  if (!/^[a-f0-9]{64}$/.test(input.manifestAuthentication)) {
    throw new Error("object_backup_manifest_authentication_invalid");
  }
  const keyId = requiredText(input.keyId, "object_backup_recovery_receipt_key_id");
  validDate(input.verifiedAt, "object_backup_recovery_receipt_verified_at");
  const unsigned = {
    schemaVersion: OBJECT_BACKUP_RECOVERY_RECEIPT_SCHEMA_VERSION,
    backupId: input.backupId,
    keyId,
    verifiedAt: input.verifiedAt,
    manifestAuthentication: input.manifestAuthentication,
    publication: input.publication,
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      digest: hmacSha256(
        derivedKey(key, input.backupId, "object-backup-recovery-receipt"),
        JSON.stringify(unsigned),
      ),
    },
  };
}

export function verifyObjectBackupRecoveryReceipt(
  receipt: ObjectBackupRecoveryReceipt,
  key: Buffer,
  expectedKeyId: string,
): { ok: boolean; issues: string[] } {
  try {
    if (receipt.schemaVersion !== OBJECT_BACKUP_RECOVERY_RECEIPT_SCHEMA_VERSION) {
      return { ok: false, issues: ["object_backup_recovery_receipt_schema_unsupported"] };
    }
    if (receipt.integrity?.algorithm !== "hmac-sha256") {
      return { ok: false, issues: ["object_backup_recovery_receipt_integrity_algorithm_invalid"] };
    }
    if (receipt.keyId !== expectedKeyId) {
      return { ok: false, issues: ["object_backup_recovery_receipt_key_id_mismatch"] };
    }
    const expected = createObjectBackupRecoveryReceipt(withoutIntegrity(receipt), key);
    return safeEqualHex(expected.integrity.digest, receipt.integrity?.digest ?? "")
      ? { ok: true, issues: [] }
      : { ok: false, issues: ["object_backup_recovery_receipt_authentication_failed"] };
  } catch (error) {
    return {
      ok: false,
      issues: [error instanceof Error ? error.message : "object_backup_recovery_receipt_invalid"],
    };
  }
}

export function parseCustomerBackupKey(value: string | undefined): Buffer {
  const raw = requiredText(value ?? "", "customer_backup_key");
  let key: Buffer;
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      key = Buffer.from(raw, "base64url");
    } catch {
      throw new Error("customer_backup_key_invalid");
    }
  }
  if (key.byteLength !== 32) throw new Error("customer_backup_key_invalid");
  return key;
}

function safeEqualHex(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
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

function resolveResourcePath(
  root: string,
  path: string,
  name: string,
  allowRoot = false,
): string {
  if (allowRoot && path === ".") return resolve(root);
  return resolveContained(root, path, name);
}

function assertNoSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error("recovery_resource_symlink_rejected");
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function assertNoFilesystemRedirect(root: string, path: string): void {
  const rootPath = resolve(root);
  const target = resolve(path);
  const rel = relative(rootPath, target);
  const segments = rel === "" ? [] : rel.split(/[\\/]+/);
  let current = rootPath;
  assertNoSymlink(current);
  for (const segment of segments) {
    current = resolve(current, segment);
    assertNoSymlink(current);
  }
  if (comparablePath(realpathSync(target)) !== comparablePath(target)) {
    throw new Error("backup_resource_filesystem_redirect_rejected");
  }
}

function filesystemIdentity(path: string): string {
  const info = statSync(path, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

function assertDistinctFilesystemIdentities(paths: readonly string[]): void {
  const identities = new Set<string>();
  for (const path of paths) {
    const identity = filesystemIdentity(path);
    if (identities.has(identity)) throw new Error("backup_resources_filesystem_identity_aliased");
    identities.add(identity);
  }
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

function isSqliteDatabase(path: string): boolean {
  if (!statSync(path).isFile() || statSync(path).size < 16) return false;
  return readFileSync(path).subarray(0, 16).toString("binary") === "SQLite format 3\0";
}

function assertSqliteIntegrity(db: DatabaseSync): void {
  const quickCheck = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  const quickValues = quickCheck.flatMap((row) => Object.values(row));
  if (quickValues.length !== 1 || quickValues[0] !== "ok") {
    throw new Error("sqlite_integrity_check_failed");
  }
  const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0) {
    throw new Error("sqlite_foreign_key_check_failed");
  }
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function snapshotSqliteDatabase(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const sourceDb = new DatabaseSync(source);
  try {
    assertSqliteIntegrity(sourceDb);
    sourceDb.exec(`VACUUM INTO ${sqliteLiteral(destination)}`);
  } finally {
    sourceDb.close();
  }
  const backupDb = new DatabaseSync(destination, { readOnly: true });
  try {
    assertSqliteIntegrity(backupDb);
  } finally {
    backupDb.close();
  }
}

function assertJsonConfiguration(path: string): void {
  if (!statSync(path).isFile()) throw new Error("backup_configuration_file_required");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
  } catch {
    throw new Error("backup_configuration_json_required");
  }
}

function assertResourcePathsDistinct(
  sourceRoot: string,
  resources: Record<RecoveryResourceKind, string>,
): Record<RecoveryResourceKind, string> {
  const keys = Object.keys(resources).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...RESOURCE_KINDS].sort())) {
    throw new Error("backup_resources_incomplete");
  }
  const resolved = Object.fromEntries(RESOURCE_KINDS.map((kind) => {
    const relativePath = requiredText(resources[kind], `backup_${kind}_path`).replaceAll("\\", "/");
    const path = resolveResourcePath(
      sourceRoot,
      relativePath,
      `backup_${kind}_path`,
      kind === "artifacts",
    );
    return [kind, path];
  })) as Record<RecoveryResourceKind, string>;
  const effectivePaths = RESOURCE_KINDS.flatMap((kind) => kind === "artifacts"
    ? RETAINED_ARTIFACT_ROOTS.map((retainedRoot) => resolve(resolved.artifacts, retainedRoot))
    : [resolved[kind]]);
  for (let index = 0; index < effectivePaths.length; index++) {
    for (let other = index + 1; other < effectivePaths.length; other++) {
      const first = effectivePaths[index]!;
      const second = effectivePaths[other]!;
      if (
        first === second ||
        first.startsWith(`${second}${sep}`) ||
        second.startsWith(`${first}${sep}`)
      ) {
        throw new Error("backup_resources_must_be_distinct");
      }
    }
  }
  return resolved;
}

function assertResourceModel(
  sourceRoot: string,
  resources: Record<RecoveryResourceKind, string>,
): Record<RecoveryResourceKind, string> {
  const resolved = assertResourcePathsDistinct(sourceRoot, resources);
  const identityPaths: string[] = [];
  for (const kind of RESOURCE_KINDS) {
    const path = resolved[kind];
    if (!existsSync(path)) throw new Error(`backup_${kind}_missing`);
    assertNoFilesystemRedirect(sourceRoot, path);
    if (SQLITE_RESOURCE_KINDS.has(kind)) {
      if (!isSqliteDatabase(path)) throw new Error(`backup_${kind}_sqlite_required`);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assertSqliteIntegrity(db);
      } finally {
        db.close();
      }
      identityPaths.push(path);
    } else if (kind === "artifacts") {
      if (!statSync(path).isDirectory()) throw new Error("backup_artifacts_directory_required");
      for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
        const retainedPath = resolve(path, retainedRoot);
        const errorName = retainedRoot.replaceAll("-", "_");
        if (!existsSync(retainedPath)) throw new Error(`backup_${errorName}_artifact_root_missing`);
        assertNoFilesystemRedirect(path, retainedPath);
        if (!statSync(retainedPath).isDirectory()) {
          throw new Error(`backup_${errorName}_artifact_root_directory_required`);
        }
        const retainedFiles = listFiles(retainedPath);
        identityPaths.push(retainedPath, ...retainedFiles);
      }
    } else {
      assertJsonConfiguration(path);
      identityPaths.push(path);
    }
  }
  assertDistinctFilesystemIdentities(identityPaths);
  return resolved;
}

function encryptionAad(input: {
  backupId: string;
  kind: RecoveryResourceKind;
  sourceRelativePath: string;
  relativePath: string;
  ciphertextPath: string;
}): Buffer {
  return Buffer.from(JSON.stringify(input), "utf8");
}

function encryptFile(input: {
  source: string;
  destination: string;
  key: Buffer;
  aad: Buffer;
}): Omit<BackupEncryptedFileManifest, "relativePath" | "ciphertextPath"> {
  const plaintext = readFileSync(input.source);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(input.aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  mkdirSync(dirname(input.destination), { recursive: true, mode: 0o700 });
  writeFileSync(input.destination, ciphertext, { flag: "wx", mode: 0o600 });
  return {
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertextSha256: sha256(ciphertext),
    sizeBytes: plaintext.byteLength,
  };
}

function decryptFile(input: {
  source: string;
  destination: string;
  key: Buffer;
  aad: Buffer;
  iv: string;
  authTag: string;
}): void {
  const decipher = createDecipheriv("aes-256-gcm", input.key, Buffer.from(input.iv, "base64url"));
  decipher.setAAD(input.aad);
  decipher.setAuthTag(Buffer.from(input.authTag, "base64url"));
  const plaintext = Buffer.concat([decipher.update(readFileSync(input.source)), decipher.final()]);
  mkdirSync(dirname(input.destination), { recursive: true, mode: 0o700 });
  writeFileSync(input.destination, plaintext, { flag: "wx", mode: 0o600 });
}

function withoutIntegrity<T extends { integrity: unknown }>(value: T): Omit<T, "integrity"> {
  const { integrity: _integrity, ...unsigned } = value;
  return unsigned;
}

function manifestDigest(manifest: BackupManifest, key: Buffer): string {
  return hmacSha256(
    derivedKey(key, manifest.backupId, "manifest-authentication"),
    JSON.stringify({
      ...withoutIntegrity(manifest),
      authentication: {
        algorithm: manifest.integrity.algorithm,
        keyId: manifest.integrity.keyId,
      },
    }),
  );
}

function reportDigest(report: RecoveryDrillReport): string {
  return sha256(JSON.stringify(withoutIntegrity(report)));
}

function digestRestoredResources(targetRoot: string): string {
  return digestPath(resolve(targetRoot)).sha256;
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const rel = relative(comparablePath(parent), comparablePath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathsOverlap(first: string, second: string): boolean {
  return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

function ensureDistinctRoots(first: string, second: string, error: string): void {
  if (pathsOverlap(first, second)) throw new Error(error);
}

function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path);
  return comparablePath(resolved) === comparablePath(parse(resolved).root);
}

function assertSafePrivilegedRoot(
  path: string,
  name: string,
  errors: { root?: string; parent?: string } = {},
): string {
  const resolved = resolve(requiredText(path, name));
  if (!isAbsolute(path)) throw new Error(`${name}_must_be_absolute`);
  if (isFilesystemRoot(resolved)) throw new Error(errors.root ?? `${name}_unsafe`);
  if (isFilesystemRoot(dirname(resolved))) {
    throw new Error(errors.parent ?? `${name}_parent_unsafe`);
  }
  return resolved;
}

function assertNoExistingFilesystemRedirect(path: string, error: string): void {
  const target = resolve(path);
  const root = parse(target).root;
  const rel = relative(root, target);
  let current = root;
  for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error(error);
    if (comparablePath(realpathSync(current)) !== comparablePath(current)) throw new Error(error);
  }
}

export function validateCustomerBackupPathSafety(input: {
  sourceRoot: string | undefined;
  outputRoot: string | undefined;
  fenceRoot: string | undefined;
  evidencePath: string | undefined;
  dataRoot: string | undefined;
}): {
  sourceRoot: string;
  outputRoot: string;
  fenceRoot: string;
  evidencePath: string;
  evidenceDirectory: string;
  dataRoot: string;
} {
  const sourceRoot = assertSafePrivilegedRoot(
    requiredText(input.sourceRoot ?? "", "customer_backup_source_root"),
    "customer_backup_source_root",
  );
  const outputRoot = assertSafePrivilegedRoot(
    requiredText(input.outputRoot ?? "", "customer_backup_output_root"),
    "customer_backup_output_root",
  );
  const fenceRoot = assertSafePrivilegedRoot(
    requiredText(input.fenceRoot ?? "", "customer_backup_fence_root"),
    "customer_backup_fence_root",
  );
  const evidencePath = resolve(requiredText(
    input.evidencePath ?? "",
    "customer_backup_evidence_path",
  ));
  if (!isAbsolute(input.evidencePath ?? "")) {
    throw new Error("customer_backup_evidence_path_must_be_absolute");
  }
  const evidenceDirectory = assertSafePrivilegedRoot(
    dirname(evidencePath),
    "customer_backup_evidence_directory",
  );
  const dataRoot = assertSafePrivilegedRoot(
    requiredText(input.dataRoot ?? "", "customer_backup_data_root"),
    "customer_backup_data_root",
  );

  if (!isSameOrDescendant(sourceRoot, dataRoot)) {
    throw new Error("customer_backup_data_root_outside_source");
  }
  if (pathsOverlap(sourceRoot, outputRoot) || pathsOverlap(dataRoot, outputRoot)) {
    throw new Error("customer_backup_output_not_isolated");
  }
  if (
    !isSameOrDescendant(sourceRoot, fenceRoot) ||
    !isSameOrDescendant(dataRoot, fenceRoot) ||
    comparablePath(fenceRoot) === comparablePath(sourceRoot) ||
    comparablePath(fenceRoot) === comparablePath(dataRoot)
  ) {
    throw new Error("customer_backup_fence_outside_data_root");
  }
  if (
    !isSameOrDescendant(sourceRoot, evidenceDirectory) ||
    !isSameOrDescendant(dataRoot, evidenceDirectory) ||
    comparablePath(evidenceDirectory) === comparablePath(sourceRoot) ||
    comparablePath(evidenceDirectory) === comparablePath(dataRoot)
  ) {
    throw new Error("customer_backup_evidence_outside_data_root");
  }

  for (const [path, error] of [
    [sourceRoot, "customer_backup_source_filesystem_redirect_rejected"],
    [outputRoot, "customer_backup_output_filesystem_redirect_rejected"],
    [fenceRoot, "customer_backup_fence_filesystem_redirect_rejected"],
    [evidenceDirectory, "customer_backup_evidence_filesystem_redirect_rejected"],
    [dataRoot, "customer_backup_data_filesystem_redirect_rejected"],
  ] as const) {
    assertNoExistingFilesystemRedirect(path, error);
  }

  return { sourceRoot, outputRoot, fenceRoot, evidencePath, evidenceDirectory, dataRoot };
}

export function validateCustomerRestorePathSafety(input: {
  backupRoot: string | undefined;
  targetRoot: string | undefined;
  dataRoot: string | undefined;
  sourceRoot?: string | undefined;
}): {
  backupRoot: string;
  targetRoot: string;
  targetParent: string;
  dataRoot: string;
} {
  const backupRoot = assertSafePrivilegedRoot(
    requiredText(input.backupRoot ?? "", "customer_restore_backup_root"),
    "customer_restore_backup_root",
  );
  const targetRoot = assertSafePrivilegedRoot(
    requiredText(input.targetRoot ?? "", "customer_restore_target_root"),
    "customer_restore_target_root",
    {
      root: "customer_restore_target_root_unsafe",
      parent: "customer_restore_target_parent_unsafe",
    },
  );
  const targetParent = dirname(targetRoot);
  const dataRoot = assertSafePrivilegedRoot(
    requiredText(input.dataRoot ?? "", "customer_restore_data_root"),
    "customer_restore_data_root",
  );
  const sourceRoot = input.sourceRoot?.trim()
    ? assertSafePrivilegedRoot(input.sourceRoot, "customer_restore_source_root")
    : undefined;

  ensureDistinctRoots(backupRoot, targetRoot, "customer_restore_target_backup_overlap");
  if (pathsOverlap(targetRoot, dataRoot) || pathsOverlap(targetParent, dataRoot)) {
    throw new Error("customer_restore_target_data_overlap");
  }
  if (pathsOverlap(targetParent, backupRoot)) {
    throw new Error("customer_restore_target_backup_overlap");
  }
  if (sourceRoot && (pathsOverlap(targetRoot, sourceRoot) || pathsOverlap(targetParent, sourceRoot))) {
    throw new Error("customer_restore_target_source_overlap");
  }

  assertNoExistingFilesystemRedirect(
    backupRoot,
    "customer_restore_backup_filesystem_redirect_rejected",
  );
  assertNoExistingFilesystemRedirect(
    targetParent,
    "customer_restore_target_filesystem_redirect_rejected",
  );
  assertNoExistingFilesystemRedirect(
    dataRoot,
    "customer_restore_data_filesystem_redirect_rejected",
  );
  if (sourceRoot) {
    assertNoExistingFilesystemRedirect(
      sourceRoot,
      "customer_restore_source_filesystem_redirect_rejected",
    );
  }

  return { backupRoot, targetRoot, targetParent, dataRoot };
}

function fencePaths(fenceRoot: string): {
  root: string;
  exclusive: string;
  recovery: string;
  audit: string;
  writers: string;
} {
  const root = resolve(requiredText(fenceRoot, "backup_fence_root"));
  return {
    root,
    exclusive: resolve(root, "exclusive.json"),
    recovery: resolve(root, "recovery.json"),
    audit: resolve(root, "recovery-audit.jsonl"),
    writers: resolve(root, "writers"),
  };
}

interface FenceMarker {
  schemaVersion: 1;
  kind: "writer" | "exclusive" | "recovery";
  id: string;
  ownerToken: string;
  hostname: string;
  pid: number;
  processStartedAt: string;
  acquiredAt: string;
}

export interface InspectedFenceMarker extends FenceMarker {
  markerSha256: string;
}

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();

function newFenceMarker(kind: FenceMarker["kind"], id: string = randomUUID()): FenceMarker {
  return {
    schemaVersion: 1,
    kind,
    id,
    ownerToken: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    acquiredAt: new Date().toISOString(),
  };
}

function parseFenceMarker(raw: string, expectedKind?: FenceMarker["kind"]): FenceMarker {
  const parsed = JSON.parse(raw) as Partial<FenceMarker>;
  if (
    parsed.schemaVersion !== 1 ||
    !parsed.kind ||
    !["writer", "exclusive", "recovery"].includes(parsed.kind) ||
    (expectedKind && parsed.kind !== expectedKind) ||
    typeof parsed.id !== "string" || !parsed.id ||
    typeof parsed.ownerToken !== "string" || !parsed.ownerToken ||
    typeof parsed.hostname !== "string" || !parsed.hostname ||
    !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 ||
    typeof parsed.processStartedAt !== "string" || !Number.isFinite(Date.parse(parsed.processStartedAt)) ||
    typeof parsed.acquiredAt !== "string" || !Number.isFinite(Date.parse(parsed.acquiredAt))
  ) {
    throw new Error("backup_fence_marker_invalid");
  }
  return parsed as FenceMarker;
}

export function resolveMutationFenceRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env.MENDPOINT_BACKUP_FENCE_ROOT?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("backup_fence_root_must_be_absolute");
    return resolve(explicit);
  }
  const dataRoot = resolve(env.MENDPOINT_DATA_DIR?.trim() || join(process.cwd(), "data"));
  return resolve(dataRoot, ".backup-fence");
}

const CUSTOMER_BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function customerBackupInputFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): ApplicationConsistentBackupInput {
  if (env.MENDPOINT_DEPLOYMENT_PROFILE !== "customer") {
    throw new Error("customer_backup_profile_required");
  }
  const sourceRoot = requiredText(
    env.MENDPOINT_BACKUP_SOURCE_ROOT ?? "",
    "customer_backup_source_root",
  );
  const outputRoot = requiredText(
    env.MENDPOINT_BACKUP_OUTPUT_ROOT ?? "",
    "customer_backup_output_root",
  );
  if (!isAbsolute(sourceRoot)) throw new Error("customer_backup_source_root_must_be_absolute");
  if (!isAbsolute(outputRoot)) throw new Error("customer_backup_output_root_must_be_absolute");
  const storageClass = env.MENDPOINT_BACKUP_STORAGE_CLASS === "object_store_publish"
    ? "isolated_publish_staging" as const
    : env.MENDPOINT_BACKUP_STORAGE_CLASS === "durable_isolated_mount"
      ? "durable_isolated_mount" as const
      : null;
  if (!storageClass) {
    throw new Error("customer_backup_storage_class_required");
  }
  const key = parseCustomerBackupKey(env.MENDPOINT_BACKUP_KEY);
  const keyId = requiredText(env.MENDPOINT_BACKUP_KEY_ID ?? "", "customer_backup_key_id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    throw new Error("customer_backup_key_id_invalid");
  }
  if (env.MENDPOINT_APPLICATION_DATA_KEY?.trim()) {
    try {
      const applicationKey = parseCustomerBackupKey(env.MENDPOINT_APPLICATION_DATA_KEY);
      if (timingSafeEqual(key, applicationKey)) throw new Error("customer_backup_key_must_be_distinct");
    } catch (error) {
      if (error instanceof Error && error.message === "customer_backup_key_must_be_distinct") throw error;
    }
  }
  const evidencePath = requiredText(
    env.MENDPOINT_BACKUP_EVIDENCE_PATH ?? "",
    "customer_backup_evidence_path",
  );
  if (!isAbsolute(evidencePath)) throw new Error("customer_backup_evidence_path_must_be_absolute");
  const runtimeDataRoot = resolve(env.MENDPOINT_DATA_DIR?.trim() || sourceRoot);
  const safePaths = validateCustomerBackupPathSafety({
    sourceRoot,
    outputRoot,
    fenceRoot: resolveMutationFenceRoot(env),
    evidencePath,
    dataRoot: runtimeDataRoot,
  });
  const createdAt = validDate(now.toISOString(), "customer_backup_created_at").toISOString();
  const defaultId = `customer-${createdAt.replaceAll(/[:.]/g, "-")}`;
  const backupId = (env.MENDPOINT_BACKUP_ID?.trim() || defaultId);
  if (!CUSTOMER_BACKUP_ID.test(backupId)) throw new Error("customer_backup_id_invalid");
  const waitTimeout = env.MENDPOINT_BACKUP_WAIT_TIMEOUT_MS?.trim();
  const resources = {
    database: requiredText(
      env.MENDPOINT_BACKUP_DATABASE_PATH ?? "",
      "customer_backup_database_path",
    ),
    graph: requiredText(
      env.MENDPOINT_BACKUP_GRAPH_PATH ?? "",
      "customer_backup_graph_path",
    ),
    changeSources: requiredText(
      env.MENDPOINT_BACKUP_CHANGE_SOURCES_PATH ?? "",
      "customer_backup_change_sources_path",
    ),
    transformerControlPlane: requiredText(
      resolveRenamedEnv(env, "MENDPOINT_BACKUP_REGAUGE_CONTROL_PLANE_PATH") ?? "",
      "customer_backup_transformer_control_plane_path",
    ),
    transformerPilot: requiredText(
      resolveRenamedEnv(env, "MENDPOINT_BACKUP_REGAUGE_PILOT_PATH") ?? "",
      "customer_backup_transformer_pilot_path",
    ),
    artifacts: requiredText(
      env.MENDPOINT_BACKUP_ARTIFACTS_PATH ?? "",
      "customer_backup_artifacts_path",
    ),
    configuration: requiredText(
      env.MENDPOINT_BACKUP_CONFIGURATION_PATH ?? "",
      "customer_backup_configuration_path",
    ),
  };
  for (const [kind, path] of Object.entries(resources)) {
    resolveResourcePath(
      sourceRoot,
      path,
      `customer_backup_${kind}_path`,
      kind === "artifacts",
    );
  }
  const resolvedResourcePaths = assertResourcePathsDistinct(safePaths.sourceRoot, resources);
  const databaseUrlPath = env.DATABASE_URL?.trim().replace(/^file:/, "");
  const runtimeSqlitePaths: Record<SqliteRecoveryResourceKind, string> = {
    database: resolve(databaseUrlPath || join(runtimeDataRoot, "mendpoint.sqlite")),
    graph: resolve(env.GRAPH_LEARN_DB?.trim() || join(runtimeDataRoot, "graph-learn.sqlite")),
    changeSources: resolve(runtimeDataRoot, "change-sources.sqlite"),
    transformerControlPlane: resolve(runtimeDataRoot, "transformer-control-plane.sqlite"),
    transformerPilot: resolve(runtimeDataRoot, "transformer-pilot.sqlite"),
  };
  for (const kind of SQLITE_RESOURCE_KINDS) {
    if (resolvedResourcePaths[kind as SqliteRecoveryResourceKind] !== runtimeSqlitePaths[kind as SqliteRecoveryResourceKind]) {
      throw new Error(`customer_backup_${kind}_runtime_path_mismatch`);
    }
  }
  if (resolvedResourcePaths.artifacts !== runtimeDataRoot) {
    throw new Error("customer_backup_artifacts_runtime_path_mismatch");
  }
  for (const [name, configured] of [
    ["transformer_evidence", resolveRenamedEnv(env, "MENDPOINT_REGAUGE_EVIDENCE_ROOT")],
    ["transformer_candidates", resolveRenamedEnv(env, "MENDPOINT_REGAUGE_CANDIDATE_ROOT")],
  ] as const) {
    if (configured?.trim()) {
      const expected = resolve(runtimeDataRoot, name.replaceAll("_", "-"));
      if (resolve(configured) !== expected) {
        throw new Error(`customer_backup_${name}_runtime_path_mismatch`);
      }
    }
  }
  return {
    policy: CORE_DISASTER_RECOVERY_POLICY,
    backupId,
    createdAt,
    sourceRoot: safePaths.sourceRoot,
    outputRoot: safePaths.outputRoot,
    backupRoot: resolve(safePaths.outputRoot, backupId),
    fenceRoot: safePaths.fenceRoot,
    evidencePath: safePaths.evidencePath,
    storageClass,
    requireDistinctDevice: true,
    key,
    keyId,
    waitTimeoutMs: positiveInteger(
      waitTimeout ? Number(waitTimeout) : 30_000,
      "customer_backup_wait_timeout_ms",
    ),
    resources,
  };
}

function ensureFenceDirectories(fenceRoot: string): ReturnType<typeof fencePaths> {
  const paths = fencePaths(fenceRoot);
  mkdirSync(paths.writers, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.root);
  assertNoSymlink(paths.writers);
  accessSync(paths.writers, constants.R_OK | constants.W_OK);
  return paths;
}

export function isBackupFenceActive(fenceRoot: string): boolean {
  const paths = fencePaths(fenceRoot);
  return existsSync(paths.exclusive) || existsSync(resolve(paths.root, REGAUGE_CUTOVER_FENCE_NAME));
}

/**
 * Cooperative interprocess writer admission. The writer publishes its lease
 * before checking the exclusive marker, closing the race with backup admission.
 */
export function tryAcquireMutationLease(fenceRoot: string): MutationLease | null {
  const paths = ensureFenceDirectories(fenceRoot);
  const id = randomUUID();
  const leasePath = resolve(paths.writers, `${id}.json`);
  const marker = newFenceMarker("writer", id);
  writeFileSync(
    leasePath,
    `${JSON.stringify(marker)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  if (existsSync(paths.exclusive) || existsSync(paths.recovery) ||
      existsSync(resolve(paths.root, REGAUGE_CUTOVER_FENCE_NAME))) {
    rmSync(leasePath, { force: true });
    return null;
  }
  let released = false;
  return Object.freeze({
    id,
    fenceRoot: paths.root,
    release() {
      if (released) return;
      released = true;
      rmSync(leasePath, { force: true });
    },
  });
}

/**
 * Protect synchronous durable-state construction from racing an exclusive
 * backup or recovery marker. Demo startup is unchanged unless a fence root is
 * explicitly configured.
 */
export function initializeWithMutationLease<T>(
  initialize: () => T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const enabled = env.MENDPOINT_DEPLOYMENT_PROFILE === "customer" ||
    Boolean(env.MENDPOINT_BACKUP_FENCE_ROOT?.trim());
  if (!enabled) return initialize();
  const lease = tryAcquireMutationLease(resolveMutationFenceRoot(env));
  if (!lease) throw new Error("customer_startup_blocked_by_backup");
  try {
    return initialize();
  } finally {
    lease.release();
  }
}

function activeMutationLeaseCount(writersRoot: string): number {
  return readdirSync(writersRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .length;
}

function inspectMarker(path: string, kind: FenceMarker["kind"]): InspectedFenceMarker | null {
  if (!existsSync(path)) return null;
  assertNoSymlink(path);
  const raw = readFileSync(path, "utf8");
  return { ...parseFenceMarker(raw, kind), markerSha256: sha256(raw) };
}

export function inspectMutationFence(fenceRoot: string): {
  exclusive: InspectedFenceMarker | null;
  recovery: InspectedFenceMarker | null;
  writers: InspectedFenceMarker[];
} {
  const paths = ensureFenceDirectories(fenceRoot);
  const writers = readdirSync(paths.writers, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => inspectMarker(resolve(paths.writers, entry.name), "writer"))
    .filter((marker): marker is InspectedFenceMarker => Boolean(marker));
  return {
    exclusive: inspectMarker(paths.exclusive, "exclusive"),
    recovery: inspectMarker(paths.recovery, "recovery"),
    writers,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function recoverStaleMutationMarker(input: {
  fenceRoot: string;
  kind: "writer" | "exclusive";
  markerId: string;
  expectedMarkerSha256: string;
  ownerTerminationEvidence: string;
}): { recovered: true; kind: "writer" | "exclusive"; markerId: string; auditSha256: string } {
  const markerId = requiredText(input.markerId, "backup_fence_recovery_marker_id");
  if (!CUSTOMER_BACKUP_ID.test(markerId)) throw new Error("backup_fence_recovery_marker_id_invalid");
  const evidence = requiredText(
    input.ownerTerminationEvidence,
    "backup_fence_recovery_owner_termination_evidence",
  );
  if (!/^[a-f0-9]{64}$/.test(input.expectedMarkerSha256)) {
    throw new Error("backup_fence_recovery_marker_evidence_invalid");
  }
  const paths = ensureFenceDirectories(input.fenceRoot);
  const recoveryMarker = newFenceMarker("recovery");
  try {
    writeFileSync(paths.recovery, `${JSON.stringify(recoveryMarker)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("backup_fence_recovery_already_active");
    }
    throw error;
  }
  try {
    if (input.kind === "exclusive" && existsSync(resolve(paths.root, REGAUGE_CUTOVER_FENCE_NAME))) {
      throw new Error("backup_fence_recovery_persistent_hold_active");
    }
    const target = input.kind === "exclusive"
      ? paths.exclusive
      : resolve(paths.writers, `${markerId}.json`);
    const inspected = inspectMarker(target, input.kind);
    if (!inspected || inspected.id !== markerId) throw new Error("backup_fence_recovery_marker_not_found");
    if (!safeEqualHex(inspected.markerSha256, input.expectedMarkerSha256)) {
      throw new Error("backup_fence_recovery_marker_evidence_mismatch");
    }
    if (inspected.hostname === hostname() && processIsAlive(inspected.pid)) {
      throw new Error("backup_fence_recovery_owner_still_alive");
    }
    const audit = {
      schemaVersion: 1,
      recoveredAt: new Date().toISOString(),
      kind: input.kind,
      markerId,
      markerSha256: inspected.markerSha256,
      ownerHostname: inspected.hostname,
      ownerPid: inspected.pid,
      ownerProcessStartedAt: inspected.processStartedAt,
      ownerTerminationEvidence: evidence,
      recoveryOwnerToken: recoveryMarker.ownerToken,
    };
    const auditLine = `${JSON.stringify(audit)}\n`;
    const heldMarker = resolve(
      paths.root,
      `.recovered-${input.kind}-${markerId}-${recoveryMarker.ownerToken}.json`,
    );
    renameSync(target, heldMarker);
    try {
      appendFileSync(paths.audit, auditLine, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      renameSync(heldMarker, target);
      throw error;
    }
    rmSync(heldMarker, { force: true });
    return { recovered: true, kind: input.kind, markerId, auditSha256: sha256(auditLine) };
  } finally {
    rmSync(paths.recovery, { force: true });
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

export function prepareMutationFenceDirectories(
  fenceRoot: string,
  owner: { uid: number; gid: number } = { uid: 1000, gid: 1000 },
): void {
  const safeFenceRoot = assertSafePrivilegedRoot(fenceRoot, "backup_fence_root");
  assertNoExistingFilesystemRedirect(
    safeFenceRoot,
    "backup_fence_filesystem_redirect_rejected",
  );
  const paths = fencePaths(safeFenceRoot);
  for (const directory of [paths.root, paths.writers]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlink(directory);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(directory, owner.uid, owner.gid);
      chmodSync(directory, 0o700);
    }
    accessSync(directory, constants.R_OK | constants.W_OK);
  }
  if (existsSync(paths.audit)) {
    assertNoSymlink(paths.audit);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(paths.audit, owner.uid, owner.gid);
      chmodSync(paths.audit, 0o600);
    }
    accessSync(paths.audit, constants.R_OK | constants.W_OK);
  }
}

export function prepareCustomerBackupDirectories(
  input: Pick<
    ApplicationConsistentBackupInput,
    "backupRoot" | "evidencePath" | "fenceRoot" | "outputRoot" | "sourceRoot"
  >,
  owner: { uid: number; gid: number } = { uid: 1000, gid: 1000 },
): void {
  const safePaths = validateCustomerBackupPathSafety({
    sourceRoot: input.sourceRoot,
    outputRoot: input.outputRoot ?? dirname(input.backupRoot),
    fenceRoot: input.fenceRoot,
    evidencePath: input.evidencePath,
    dataRoot: input.sourceRoot,
  });
  prepareMutationFenceDirectories(safePaths.fenceRoot, owner);
  const directories = [safePaths.outputRoot, safePaths.evidenceDirectory];
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlink(directory);
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      chownSync(directory, owner.uid, owner.gid);
      chmodSync(directory, 0o700);
    }
    accessSync(directory, constants.R_OK | constants.W_OK);
  }
}

function validateDurableBackupMount(input: ApplicationConsistentBackupInput): void {
  if (!input.requireDistinctDevice) return;
  if (
    (input.storageClass !== "durable_isolated_mount" &&
      input.storageClass !== "isolated_publish_staging") ||
    !input.outputRoot
  ) {
    throw new Error("customer_backup_durable_mount_required");
  }
  const source = statSync(resolve(input.sourceRoot));
  const output = statSync(resolve(input.outputRoot));
  if (source.dev === output.dev) throw new Error("customer_backup_mount_not_isolated");
}

/**
 * Acquires the global backup fence, drains admitted writers, and snapshots all
 * resources while new mutations are rejected by cooperative admission points.
 */
export async function createApplicationConsistentBackup(
  input: ApplicationConsistentBackupInput,
): Promise<BackupManifest> {
  validateDurableBackupMount(input);
  const paths = ensureFenceDirectories(input.fenceRoot);
  const waitTimeoutMs = positiveInteger(input.waitTimeoutMs ?? 30_000, "backup_fence_wait_timeout_ms");
  const pollIntervalMs = positiveInteger(input.pollIntervalMs ?? 25, "backup_fence_poll_interval_ms");
  const exclusiveMarker = newFenceMarker("exclusive", input.backupId);
  try {
    writeFileSync(
      paths.exclusive,
      `${JSON.stringify(exclusiveMarker)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("backup_fence_already_active");
    }
    throw error;
  }

  if (existsSync(paths.recovery)) {
    rmSync(paths.exclusive, { force: true });
    throw new Error("backup_fence_recovery_active");
  }

  try {
    const deadline = Date.now() + waitTimeoutMs;
    while (activeMutationLeaseCount(paths.writers) > 0) {
      if (Date.now() >= deadline) throw new Error("backup_fence_writer_drain_timeout");
      await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    return createBackupBundle(input);
  } finally {
    rmSync(paths.exclusive, { force: true });
  }
}

export function createBackupBundle(input: CreateBackupBundleInput): BackupManifest {
  validatePolicy(input.policy);
  const backupId = requiredText(input.backupId, "backup_id");
  validDate(input.createdAt, "backup_created_at");
  if (input.key.byteLength !== 32) throw new Error("backup_key_invalid");
  const keyId = requiredText(input.keyId, "backup_key_id");
  if (!existsSync(input.sourceRoot)) throw new Error("backup_source_missing");
  if (existsSync(input.backupRoot)) throw new Error("backup_target_exists");
  ensureDistinctRoots(input.sourceRoot, input.backupRoot, "backup_target_not_isolated");
  assertNoFilesystemRedirect(dirname(resolve(input.backupRoot)), dirname(resolve(input.backupRoot)));
  const resolvedResources = assertResourceModel(input.sourceRoot, input.resources);
  const encryptionKey = derivedKey(input.key, backupId, "resource-encryption");

  const stagingRoot = `${resolve(input.backupRoot)}.staging-${randomUUID()}`;
  const plaintextRoot = resolve(stagingRoot, ".plaintext");
  try {
    mkdirSync(resolve(stagingRoot, "resources"), { recursive: true, mode: 0o700 });
    mkdirSync(plaintextRoot, { recursive: true, mode: 0o700 });
    const resources = RESOURCE_KINDS.map((kind): BackupResourceManifest => {
      const sourceRelativePath = input.resources[kind].replaceAll("\\", "/");
      const sourcePath = resolvedResources[kind];
      const backupPath = `resources/${kind}`;
      const plaintextFiles: Array<{ path: string; relativePath: string }> = [];
      if (SQLITE_RESOURCE_KINDS.has(kind)) {
        const snapshot = resolve(plaintextRoot, `${kind}.sqlite`);
        snapshotSqliteDatabase(sourcePath, snapshot);
        plaintextFiles.push({ path: snapshot, relativePath: "" });
      } else if (kind === "configuration") {
        plaintextFiles.push({ path: sourcePath, relativePath: "" });
      } else {
        for (const retainedRoot of RETAINED_ARTIFACT_ROOTS) {
          for (const path of listFiles(resolve(sourcePath, retainedRoot))) {
            plaintextFiles.push({
              path,
              relativePath: relative(sourcePath, path).replaceAll("\\", "/"),
            });
          }
        }
      }
      const encryptedFiles = plaintextFiles.map((file, index): BackupEncryptedFileManifest => {
        const ciphertextPath = `${backupPath}/${String(index).padStart(8, "0")}.bin`;
        const aadInput = { backupId, kind, sourceRelativePath, relativePath: file.relativePath, ciphertextPath };
        return {
          relativePath: file.relativePath,
          ciphertextPath,
          ...encryptFile({
            source: file.path,
            destination: resolveContained(stagingRoot, ciphertextPath, `backup_${kind}_ciphertext`),
            key: encryptionKey,
            aad: encryptionAad(aadInput),
          }),
        };
      });
      return {
        kind,
        sourceRelativePath,
        backupPath,
        sha256: sha256(JSON.stringify(encryptedFiles)),
        sizeBytes: encryptedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
        fileCount: encryptedFiles.length,
        encryptedFiles,
        ...(kind === "artifacts" ? { retainedArtifactRoots: RETAINED_ARTIFACT_ROOTS } : {}),
      };
    });
    rmSync(plaintextRoot, { recursive: true, force: true });
    const unsigned = {
      schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
      backupId,
      createdAt: input.createdAt,
      policy: {
        policyId: input.policy.policyId,
        version: input.policy.version,
        rtoSeconds: input.policy.rtoSeconds,
        rpoSeconds: input.policy.rpoSeconds,
      },
      resources,
      encryption: { algorithm: "aes-256-gcm" as const },
    };
    const manifest = {
      ...unsigned,
      integrity: {
        algorithm: "hmac-sha256" as const,
        keyId,
        digest: hmacSha256(
          derivedKey(input.key, backupId, "manifest-authentication"),
          JSON.stringify({
            ...unsigned,
            authentication: { algorithm: "hmac-sha256", keyId },
          }),
        ),
      },
    } satisfies BackupManifest;
    writeFileSync(
      resolve(stagingRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    renameSync(stagingRoot, resolve(input.backupRoot));
    chmodSync(resolve(input.backupRoot), 0o700);
    return manifest;
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function resolveRelativeOrSelf(root: string, path: string, name: string): string {
  if (path === "") return resolve(root);
  return resolveContained(root, path, name);
}

function decryptBundleToRoot(
  backupRoot: string,
  targetRoot: string,
  manifest: BackupManifest,
  key: Buffer,
): void {
  const encryptionKey = derivedKey(key, manifest.backupId, "resource-encryption");
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const resource of manifest.resources) {
    const resourceRoot = resolveResourcePath(
      targetRoot,
      resource.sourceRelativePath,
      `restore_${resource.kind}_destination`,
      resource.kind === "artifacts",
    );
    if (resource.kind === "artifacts") {
      for (const retainedRoot of resource.retainedArtifactRoots ?? []) {
        mkdirSync(
          resolveContained(resourceRoot, retainedRoot, "restore_retained_artifact_root"),
          { recursive: true, mode: 0o700 },
        );
      }
    }
    for (const encryptedFile of resource.encryptedFiles) {
      const source = resolveContained(
        backupRoot,
        encryptedFile.ciphertextPath,
        `restore_${resource.kind}_ciphertext`,
      );
      const destination = resolveRelativeOrSelf(
        resourceRoot,
        encryptedFile.relativePath,
        `restore_${resource.kind}_relative_path`,
      );
      decryptFile({
        source,
        destination,
        key: encryptionKey,
        aad: encryptionAad({
          backupId: manifest.backupId,
          kind: resource.kind,
          sourceRelativePath: resource.sourceRelativePath,
          relativePath: encryptedFile.relativePath,
          ciphertextPath: encryptedFile.ciphertextPath,
        }),
        iv: encryptedFile.iv,
        authTag: encryptedFile.authTag,
      });
    }
  }
}

export function verifyBackupBundle(
  backupRoot: string,
  manifest: BackupManifest,
  key: Buffer | undefined,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (manifest.schemaVersion !== BACKUP_MANIFEST_SCHEMA_VERSION) issues.push("manifest_schema_version_unsupported");
  if (!key || key.byteLength !== 32) return { ok: false, issues: ["backup_key_required"] };
  if (
    manifest.integrity?.algorithm !== "hmac-sha256" ||
    !safeEqualHex(manifest.integrity.digest, manifestDigest(manifest, key))
  ) return { ok: false, issues: ["manifest_authentication_failed"] };
  if (manifest.encryption?.algorithm !== "aes-256-gcm") issues.push("manifest_encryption_unsupported");
  try {
    const stored = JSON.parse(readFileSync(resolve(backupRoot, "manifest.json"), "utf8")) as BackupManifest;
    if (JSON.stringify(stored) !== JSON.stringify(manifest)) issues.push("stored_manifest_mismatch");
  } catch (error) {
    issues.push(`stored_manifest_unreadable:${error instanceof Error ? error.message : String(error)}`);
  }
  const kinds = manifest.resources.map((resource) => resource.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(RESOURCE_KINDS)) issues.push("manifest_resources_incomplete_or_unsorted");
  const ciphertextIdentities = new Set<string>();
  for (const resource of manifest.resources) {
    if (resource.kind === "artifacts") {
      if (JSON.stringify(resource.retainedArtifactRoots) !== JSON.stringify(RETAINED_ARTIFACT_ROOTS)) {
        issues.push("manifest_retained_artifact_roots_incomplete_or_unsorted");
      }
    } else if (resource.retainedArtifactRoots !== undefined) {
      issues.push(`${resource.kind}_unexpected_retained_artifact_roots`);
    }
    if (resource.sha256 !== sha256(JSON.stringify(resource.encryptedFiles))) {
      issues.push(`${resource.kind}_manifest_digest_mismatch`);
    }
    if (resource.fileCount !== resource.encryptedFiles.length) issues.push(`${resource.kind}_file_count_mismatch`);
    if (resource.sizeBytes !== resource.encryptedFiles.reduce((sum, file) => sum + file.sizeBytes, 0)) {
      issues.push(`${resource.kind}_size_mismatch`);
    }
    for (const file of resource.encryptedFiles) {
      try {
        const ciphertextPath = resolveContained(
          backupRoot,
          file.ciphertextPath,
          `manifest_${resource.kind}_ciphertext`,
        );
        assertNoFilesystemRedirect(backupRoot, ciphertextPath);
        const identity = filesystemIdentity(ciphertextPath);
        if (ciphertextIdentities.has(identity)) {
          issues.push("ciphertext_filesystem_identity_aliased");
        }
        ciphertextIdentities.add(identity);
        const ciphertext = readFileSync(ciphertextPath);
        if (sha256(ciphertext) !== file.ciphertextSha256) issues.push(`${resource.kind}_ciphertext_hash_mismatch`);
      } catch {
        issues.push(`${resource.kind}_ciphertext_unreadable`);
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const verificationRoot = `${resolve(tmpdir(), `mendpoint-backup-verify-${randomUUID()}`)}`;
  try {
    decryptBundleToRoot(backupRoot, verificationRoot, manifest, key);
    const resources = Object.fromEntries(
      manifest.resources.map((resource) => [resource.kind, resource.sourceRelativePath]),
    ) as Record<RecoveryResourceKind, string>;
    assertResourceModel(verificationRoot, resources);
  } catch {
    issues.push("backup_decryption_or_semantic_verification_failed");
  } finally {
    rmSync(verificationRoot, { recursive: true, force: true });
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
  assertNoFilesystemRedirect(dirname(resolve(input.targetRoot)), dirname(resolve(input.targetRoot)));
  const verified = verifyBackupBundle(input.backupRoot, input.manifest, input.key);
  if (!verified.ok) throw new Error(`backup_integrity_failed:${verified.issues.join(",")}`);

  const target = resolve(input.targetRoot);
  const stagingRoot = `${target}.staging-${randomUUID()}`;
  try {
    decryptBundleToRoot(input.backupRoot, stagingRoot, input.manifest, input.key);
    const restoredResources = Object.fromEntries(
      input.manifest.resources.map((resource) => [resource.kind, resource.sourceRelativePath]),
    ) as Record<RecoveryResourceKind, string>;
    assertResourceModel(stagingRoot, restoredResources);
    const restoredDigest = digestRestoredResources(stagingRoot);
    renameSync(stagingRoot, target);
    return { atomic: true, isolated: true, restoredDigest };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function evidenceDigest(evidence: LastVerifiedBackupEvidence, key: Buffer): string {
  return hmacSha256(
    derivedKey(key, evidence.backupId, "last-verified-evidence"),
    JSON.stringify(withoutIntegrity(evidence)),
  );
}

type LastVerifiedBackupEvidenceMaterial = {
  key: Buffer;
  keyId: string;
  backupId: string;
  backupRoot: string;
  createdAt: string;
  verifiedAt: string;
  manifestAuthentication: string;
  publication?: ObjectBackupPublication;
};

export function createLastVerifiedBackupEvidence(
  input: LastVerifiedBackupEvidenceMaterial,
): LastVerifiedBackupEvidence {
  if (!isAbsolute(input.backupRoot)) throw new Error("backup_evidence_root_must_be_absolute");
  if (input.key.byteLength !== 32) throw new Error("backup_evidence_key_invalid");
  validDate(input.createdAt, "backup_evidence_created_at");
  validDate(input.verifiedAt, "backup_evidence_verified_at");
  if (!/^[a-f0-9]{64}$/.test(input.manifestAuthentication)) {
    throw new Error("backup_evidence_manifest_authentication_invalid");
  }
  if (input.publication) {
    if (input.publication.backupId !== input.backupId) {
      throw new Error("object_backup_publication_id_mismatch");
    }
    const { backupId: _publicationBackupId, ...publicationIdentity } = input.publication;
    validateObjectPublicationIdentity({ backupId: input.backupId, ...publicationIdentity });
    if (!/^[a-f0-9]{64}$/.test(input.publication.commitDigest)) {
      throw new Error("object_backup_commit_digest_invalid");
    }
    if (!input.publication.prefix.endsWith(`/${input.backupId}`)) {
      throw new Error("object_backup_prefix_id_mismatch");
    }
  }
  const unsigned = {
    schemaVersion: LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION,
    backupId: requiredText(input.backupId, "backup_evidence_backup_id"),
    backupRoot: resolve(input.backupRoot),
    createdAt: input.createdAt,
    verifiedAt: input.verifiedAt,
    keyId: requiredText(input.keyId, "backup_evidence_key_id"),
    manifestAuthentication: input.manifestAuthentication,
    ...(input.publication ? { publication: input.publication } : {}),
  };
  const evidence = {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256" as const,
      keyId: unsigned.keyId,
      digest: hmacSha256(
        derivedKey(input.key, unsigned.backupId, "last-verified-evidence"),
        JSON.stringify(unsigned),
      ),
    },
  } satisfies LastVerifiedBackupEvidence;
  return evidence;
}

export function recordLastVerifiedBackupEvidence(
  input: LastVerifiedBackupEvidenceMaterial & { evidencePath: string },
): LastVerifiedBackupEvidence {
  if (!isAbsolute(input.evidencePath)) throw new Error("backup_evidence_path_must_be_absolute");
  const evidence = createLastVerifiedBackupEvidence(input);
  mkdirSync(dirname(input.evidencePath), { recursive: true, mode: 0o700 });
  const stagingPath = `${resolve(input.evidencePath)}.staging-${randomUUID()}`;
  writeFileSync(stagingPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(stagingPath, resolve(input.evidencePath));
  return evidence;
}

export function loadAuthenticatedLastVerifiedBackupEvidence(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LastVerifiedBackupEvidence {
  const input = customerBackupInputFromEnv(env);
  const evidence = JSON.parse(readFileSync(input.evidencePath!, "utf8")) as LastVerifiedBackupEvidence;
  return verifyAuthenticatedLastVerifiedBackupEvidence(evidence, input.key, input.keyId);
}

export function verifyAuthenticatedLastVerifiedBackupEvidence(
  evidence: LastVerifiedBackupEvidence,
  key: Buffer,
  keyId: string,
): LastVerifiedBackupEvidence {
  if (
    (evidence.schemaVersion !== 1 &&
      evidence.schemaVersion !== LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION) ||
    evidence.integrity?.algorithm !== "hmac-sha256" ||
    evidence.integrity.keyId !== keyId ||
    evidence.keyId !== keyId ||
    !safeEqualHex(evidence.integrity.digest, evidenceDigest(evidence, key)) ||
    !/^[a-f0-9]{64}$/.test(evidence.manifestAuthentication)
  ) throw new Error("last_verified_backup_evidence_invalid");
  if (evidence.publication) {
    if (evidence.publication.backupId !== evidence.backupId) {
      throw new Error("last_verified_backup_publication_invalid");
    }
    const { backupId: _publicationBackupId, ...publicationIdentity } = evidence.publication;
    validateObjectPublicationIdentity({ backupId: evidence.backupId, ...publicationIdentity });
    if (
      evidence.schemaVersion !== LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION ||
      !/^[a-f0-9]{64}$/.test(evidence.publication.commitDigest) ||
      !evidence.publication.prefix.endsWith(`/${evidence.backupId}`)
    ) throw new Error("last_verified_backup_publication_invalid");
  }
  return evidence;
}

export function assessCustomerBackupReadiness(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): { ok: boolean; detail: "not_required" | "current" | "missing_or_invalid" | "overdue" } {
  if (env.MENDPOINT_DEPLOYMENT_PROFILE !== "customer") return { ok: true, detail: "not_required" };
  try {
    const input = customerBackupInputFromEnv(env, now);
    const evidence = JSON.parse(readFileSync(input.evidencePath!, "utf8")) as LastVerifiedBackupEvidence;
    if (
      (evidence.schemaVersion !== 1 &&
        evidence.schemaVersion !== LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION) ||
      evidence.integrity?.algorithm !== "hmac-sha256" ||
      evidence.integrity.keyId !== input.keyId ||
      evidence.keyId !== input.keyId ||
      !safeEqualHex(evidence.integrity.digest, evidenceDigest(evidence, input.key)) ||
      !/^[a-f0-9]{64}$/.test(evidence.manifestAuthentication)
    ) return { ok: false, detail: "missing_or_invalid" };
    if (evidence.publication) {
      const { backupId: publicationBackupId, ...publicationIdentity } = evidence.publication;
      if (publicationBackupId !== evidence.backupId) {
        return { ok: false, detail: "missing_or_invalid" };
      }
      validateObjectPublicationIdentity({ backupId: evidence.backupId, ...publicationIdentity });
      if (
        evidence.schemaVersion !== LAST_VERIFIED_BACKUP_EVIDENCE_SCHEMA_VERSION ||
        !/^[a-f0-9]{64}$/.test(evidence.publication.commitDigest) ||
        !evidence.publication.prefix.endsWith(`/${evidence.backupId}`)
      ) return { ok: false, detail: "missing_or_invalid" };
    } else {
      const outputRoot = resolve(input.outputRoot!);
      const backupRoot = resolve(evidence.backupRoot);
      if (!backupRoot.startsWith(`${outputRoot}${sep}`) || !existsSync(backupRoot)) {
        return { ok: false, detail: "missing_or_invalid" };
      }
      const manifest = loadAuthenticatedBackupManifest(backupRoot, input.key);
      if (
        manifest.backupId !== evidence.backupId ||
        manifest.createdAt !== evidence.createdAt ||
        manifest.integrity.keyId !== evidence.keyId ||
        !safeEqualHex(manifest.integrity.digest, evidence.manifestAuthentication)
      ) return { ok: false, detail: "missing_or_invalid" };
    }
    const createdAt = validDate(evidence.createdAt, "backup_evidence_created_at");
    const verifiedAt = validDate(evidence.verifiedAt, "backup_evidence_verified_at");
    if (verifiedAt < createdAt || verifiedAt > now || createdAt > now) {
      return { ok: false, detail: "missing_or_invalid" };
    }
    const ageSeconds = (now.getTime() - createdAt.getTime()) / 1_000;
    return ageSeconds <= input.policy.rpoSeconds
      ? { ok: true, detail: "current" }
      : { ok: false, detail: "overdue" };
  } catch {
    return { ok: false, detail: "missing_or_invalid" };
  }
}

export function loadAuthenticatedBackupManifest(
  backupRoot: string,
  key: Buffer,
): BackupManifest {
  const manifest = JSON.parse(readFileSync(resolve(backupRoot, "manifest.json"), "utf8")) as BackupManifest;
  const verified = verifyBackupBundle(backupRoot, manifest, key);
  if (!verified.ok) throw new Error(`backup_integrity_failed:${verified.issues.join(",")}`);
  return manifest;
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
  let restoredSemanticsValid = true;
  try {
    assertResourceModel(
      input.targetRoot,
      Object.fromEntries(
        input.manifest.resources.map((resource) => [resource.kind, resource.sourceRelativePath]),
      ) as Record<RecoveryResourceKind, string>,
    );
  } catch {
    restoredSemanticsValid = false;
  }
  if (rollbackDigest !== beforeDigest || !restoredSemanticsValid) {
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
