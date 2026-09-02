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
const DEPLOYED_REVISION_TIMEOUT_MS = 10_000;
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
/**
 * Every name `main()` reads from the environment, in one place, because two
 * things depend on the list being exact: `config/required-configuration.json`
 * declares each one as `required_when_active`, and the failure-code allowlist
 * derives the `<name>_required` codes from it. A name added to `main()` but not
 * to this list is undeclared configuration, and its absence reports as an opaque
 * dependency failure instead of naming itself.
 */
export const RECOVERY_PROOF_ENV_NAMES = Object.freeze([
  "MENDPOINT_BACKUP_FENCE_ROOT",
  "MENDPOINT_BACKUP_KEY_ID",
  "MENDPOINT_DATA_DIR",
  "MENDPOINT_RECOVERY_BACKUP_ID",
  "MENDPOINT_RECOVERY_DEPLOYED_REVISION",
  "MENDPOINT_RECOVERY_DEPLOYED_VERSION_URL",
  "MENDPOINT_RECOVERY_ENVIRONMENT",
  "MENDPOINT_RECOVERY_EVIDENCE_PATH",
  "MENDPOINT_RECOVERY_PROOF_ID",
  "MENDPOINT_RECOVERY_REGION",
  "MENDPOINT_RECOVERY_REPOSITORY_REVISION",
  "MENDPOINT_RECOVERY_ROLLBACK_ROOT",
  "MENDPOINT_RECOVERY_SOURCE_REGION",
  "MENDPOINT_RECOVERY_STAGING_ROOT",
  "MENDPOINT_RECOVERY_TARGET_ROOT",
  "MENDPOINT_RECOVERY_TENANT_ID",
] as const);
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

/**
 * What binds a proof to a specific production deploy.
 *
 * The operator supplies the revision they believe is deployed. That is an
 * expectation, not an observation: comparing it against another operator-supplied
 * value proves only that one person typed the same string twice. For a
 * production-targeted run the deployed revision is read from the running target's
 * `/version`, and the proof is published only when the observation matches the
 * expectation. An unreachable or unreadable target fails the run; it never
 * degrades into "assume it matches".
 *
 * Three states, never two. `not_observed` records why the observation is absent,
 * so "we did not look" can never be read as "we looked and it matched". Only
 * `non_production_environment` can accompany a published passing proof; the
 * `observation_not_reached` case exists so a retained failure envelope tells the
 * truth about a run that died before or during the observation.
 */
export type DeployedRevisionEvidence =
  | Readonly<{ state: "observed"; expected: string; observed: string; observedFrom: string }>
  | Readonly<{
      state: "not_observed";
      expected: string;
      reason: "non_production_environment" | "observation_not_reached";
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
  revisions: Readonly<{ repository: string; deployed: DeployedRevisionEvidence }>;
  /**
   * `backupCiphertextSha256` and `restoredPlaintextSha256` are NOT an
   * expected-versus-observed pair and are never compared. The manifest value
   * digests the encrypted-file metadata of the backup
   * (`sha256(JSON.stringify(encryptedFiles))`, `packages/ops/src/disaster-recovery.ts:1544`,
   * re-derived on verification at `:1680`); the restored value digests the
   * decrypted tree on disk. They differ on every successful run by construction.
   * Both are retained because they identify different objects: what was stored,
   * and what came back out.
   */
  resources: readonly Readonly<{
    kind: RecoveryResourceKind;
    backupCiphertextSha256: string;
    restoredPlaintextSha256: string;
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
  revisions: Readonly<{ repository: string; deployed: DeployedRevisionEvidence }>;
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
  /** What the operator expects to be deployed. Never used as the observation. */
  expectedDeployedRevision: string;
  /**
   * The running target's `/version` endpoint, which reports `revision`. Required
   * for a production-targeted run and unused otherwise.
   */
  deployedRevisionSource?: string;
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
  observeDeployedRevision?: (source: string) => Promise<string>;
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

/**
 * A failure code is written into signed evidence and printed to stderr, so the
 * echoed text must not be able to carry material this script holds. A charset
 * allowlist cannot make that promise: sixty-four hex characters are all
 * lowercase alphanumerics, so an error whose message happened to be a digest or a
 * key would have passed through verbatim. No path interpolates key material into
 * a message today, which is the only reason that was not already a leak.
 *
 * `production_recovery_*` is a closed family: every message in it is either a
 * literal in this file, or a literal with one of `RESOURCE_KINDS` or a fixed
 * field name interpolated into it. Nothing else in the family can be constructed
 * here, so matching it by prefix enumerates exactly this module's own codes. The
 * `customer_backup_*` and `customer_restore_*` families are the literal codes of
 * `./customer-object-store.js`, kept echoable so a first-run configuration
 * mistake still names itself. Everything else, a dependency's own code included,
 * reports as a dependency failure.
 */
const OWN_FAILURE_CODE_PREFIXES: readonly string[] = Object.freeze([
  "production_recovery_",
  "customer_backup_",
  "customer_restore_",
]);
const OWN_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "change_source_schema_newer_than_runtime",
  "unsupported_transformer_schema",
  ...RECOVERY_PROOF_ENV_NAMES.map((name) => `${name.toLowerCase()}_required`),
]);
const FAILURE_CODE = /^[a-z][A-Za-z0-9_]{0,127}$/;
const FAILURE_CODE_DETAIL = /^[A-Za-z0-9_,.-]{1,128}$/;

export function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const separator = message.indexOf(":");
  const code = separator === -1 ? message : message.slice(0, separator);
  const known = OWN_FAILURE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)) ||
    OWN_FAILURE_CODES.has(code);
  if (!known || !FAILURE_CODE.test(code)) return "production_recovery_dependency_failed";
  const detail = separator === -1 ? "" : message.slice(separator + 1);
  return detail && FAILURE_CODE_DETAIL.test(detail) ? `${code}:${detail}` : code;
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
    expectedDeployedRevision: input.expectedDeployedRevision,
    deployedRevisionSource: input.deployedRevisionSource ?? null,
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

/**
 * The observation endpoint must be an exact https origin the operator names, with
 * no credentials in the URL and nothing that could redirect the read somewhere
 * else. A revision read over a channel that can be rewritten in transit is not an
 * observation.
 */
function requiredDeployedRevisionSource(value: string | undefined): string {
  const text = value?.trim() ?? "";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("production_recovery_deployed_revision_source_invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("production_recovery_deployed_revision_source_invalid");
  }
  return url.toString();
}

function validateInput(input: ProductionRecoveryProofInput): {
  evidencePath: string;
  requestDigest: string;
  deployedRevisionSource: string | null;
} {
  requiredId(input.proofId, "production_recovery_proof_id");
  requiredId(input.tenantId, "production_recovery_tenant_id");
  requiredId(input.keyId, "production_recovery_key_id");
  if (!new Set<ProofEnvironment>(["local", "synthetic", "production"]).has(input.environment)) {
    throw new Error("production_recovery_environment_invalid");
  }
  if (input.key.byteLength !== 32) throw new Error("production_recovery_key_invalid");
  requiredRevision(input.repositoryRevision, "production_recovery_repository_revision");
  requiredRevision(input.expectedDeployedRevision, "production_recovery_deployed_revision");
  // Operator-side consistency only: both values come from the same caller, so
  // this catches a typo, not a wrong deploy. The binding to the running target is
  // the observation in runProductionRecoveryProof.
  if (input.environment === "production" && input.repositoryRevision !== input.expectedDeployedRevision) {
    throw new Error("production_recovery_revision_mismatch");
  }
  const deployedRevisionSource = input.environment === "production"
    ? requiredDeployedRevisionSource(input.deployedRevisionSource)
    : null;
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
    deployedRevisionSource,
  };
}

/**
 * Read the revision the target is actually serving. `/version` on the customer
 * app answers `{ "revision": "<40-64 hex>" }`; anything else — an unreachable
 * host, a non-200, a body that is not JSON, a missing or malformed `revision` —
 * fails the run. There is deliberately no "could not tell" result: the caller
 * cannot publish a passing production proof without a revision it actually read.
 */
async function observeDeployedRevisionOverHttps(source: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(source, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(DEPLOYED_REVISION_TIMEOUT_MS),
    });
  } catch {
    throw new Error("production_recovery_deployed_revision_unreachable");
  }
  if (!response.ok) throw new Error("production_recovery_deployed_revision_unreachable");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("production_recovery_deployed_revision_unreadable");
  }
  const revision = (payload as { revision?: unknown } | null)?.revision;
  if (typeof revision !== "string" || !REVISION.test(revision)) {
    throw new Error("production_recovery_deployed_revision_unreadable");
  }
  return revision;
}

/**
 * Deliberately not `packages/ops/src/disaster-recovery.ts:556`, whose digest
 * arithmetic this reproduces exactly. That one checks the leaf for a symlink and
 * treats every non-directory entry as a readable file; this one rejects a symlink
 * anywhere in the ancestor chain and rejects a non-regular entry outright
 * (`production_recovery_resource_type_invalid`). Collapsing onto the shared
 * implementation would drop both checks on the path that decides whether evidence
 * gets published, so the duplication is kept and the divergence is the point.
 */
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

/**
 * The restore digests its staging tree and then renames it into place; this
 * re-reads the tree at its final path and requires the two to agree. Exported so
 * the guard has a test of its own: it is unreachable from an end-to-end run
 * (nothing can perturb the tree inside the rename), which is exactly the shape of
 * check that gets deleted as dead weight because no test dies with it.
 */
export function assertRestoredTreeMatchesRestore(observed: string, reported: string): void {
  if (!safeEqual(observed, reported)) throw new Error("production_recovery_restore_digest_mismatch");
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
  const { evidencePath, requestDigest, deployedRevisionSource } = validateInput(input);
  const replay = readCompletedReplay(input, evidencePath, requestDigest);
  if (replay) return replay;

  const now = dependencies.now ?? Date.now;
  const monotonic = dependencies.monotonic ?? (() => globalThis.performance.now());
  const startedAt = requiredDate(input.startedAt ?? new Date(now()).toISOString(), "production_recovery_started_at");
  const startedMs = Date.parse(startedAt);
  const perfStarted = monotonic();
  let manifest: BackupManifest | undefined;
  let lease: ReturnType<typeof tryAcquireMutationLease> | null = null;
  let deployed: DeployedRevisionEvidence = Object.freeze({
    state: "not_observed" as const,
    expected: input.expectedDeployedRevision,
    reason: input.environment === "production"
      ? ("observation_not_reached" as const)
      : ("non_production_environment" as const),
  });
  try {
    // Observed before anything is downloaded, restored, or leased: a proof
    // against the wrong deploy is worthless, so learn that first and cheaply.
    if (deployedRevisionSource !== null) {
      const observed = await (dependencies.observeDeployedRevision ?? observeDeployedRevisionOverHttps)(
        deployedRevisionSource,
      );
      if (typeof observed !== "string" || !REVISION.test(observed)) {
        throw new Error("production_recovery_deployed_revision_unreadable");
      }
      if (observed !== input.expectedDeployedRevision) {
        throw new Error("production_recovery_deployed_revision_mismatch");
      }
      deployed = Object.freeze({
        state: "observed" as const,
        expected: input.expectedDeployedRevision,
        observed,
        observedFrom: deployedRevisionSource,
      });
    }
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
    assertRestoredTreeMatchesRestore(restoredDigest, restore.restoredDigest);
    const resourceDigests = Object.freeze(manifest.resources.map((resource) => {
      const restoredResource = digestPath(paths[resource.kind]);
      return Object.freeze({
        kind: resource.kind,
        backupCiphertextSha256: resource.sha256,
        restoredPlaintextSha256: restoredResource.sha256,
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
      revisions: Object.freeze({ repository: input.repositoryRevision, deployed }),
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
        revisions: Object.freeze({ repository: input.repositoryRevision, deployed }),
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

export async function main(): Promise<void> {
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
  const environment = requiredEnv("MENDPOINT_RECOVERY_ENVIRONMENT") as ProofEnvironment;
  const proof = await runProductionRecoveryProof({
    proofId: requiredEnv("MENDPOINT_RECOVERY_PROOF_ID"),
    tenantId: requiredEnv("MENDPOINT_RECOVERY_TENANT_ID"),
    environment,
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
    expectedDeployedRevision: requiredEnv("MENDPOINT_RECOVERY_DEPLOYED_REVISION"),
    // Required only where there is a running deployment to read. A local or
    // synthetic drill has none, and must not be able to invent one.
    deployedRevisionSource: environment === "production"
      ? requiredEnv("MENDPOINT_RECOVERY_DEPLOYED_VERSION_URL")
      : undefined,
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
