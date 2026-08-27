import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REGAUGE_MISSION_EVIDENCE_MAX_BYTES } from "@mendpoint/shared";
import { REGAUGE_CUTOVER_FENCE_NAME } from "./disaster-recovery.js";

export const REGAUGE_TRANSFER_DATABASES = Object.freeze([
  "change-sources.sqlite",
  "mendpoint.sqlite",
  "transformer-control-plane.sqlite",
  "transformer-pilot.sqlite",
] as const);
export const REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS = Object.freeze([
  "transformer-candidates",
  "transformer-evidence",
] as const);

export type RegaugeTransferDatabase = (typeof REGAUGE_TRANSFER_DATABASES)[number];
export type RegaugeTransferLegacyArtifactRoot = (typeof REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS)[number];

export type RegaugeTransferBindings = Readonly<{
  tenantId: string;
  campaignId: string;
  sourceApp: string;
  sourceVolume: string;
  sourceRevision: string;
  targetApp: string;
  targetVolume: string;
  objectBucket: string;
  objectPrefix: string;
  transferKeyId: string;
  applicationDataKeyId: string;
  checkpointKeyId: string;
}>;

export type RegaugeLedgerTip = Readonly<{
  table: "domain_events" | "tf_events" | "tf_pilot_events";
  rowCount: number;
  sequence: number | null;
  eventType: string | null;
  rowSha256: string | null;
}>;

export type RegaugeDatabaseEvidence = Readonly<{
  name: RegaugeTransferDatabase;
  ciphertextPath: string;
  plaintextSha256: string;
  encryptedSha256: string;
  plaintextSizeBytes: number;
  encryptedSizeBytes: number;
  schemaSha256: string;
  tableRowCounts: Readonly<Record<string, number>>;
  quickCheck: "ok";
  foreignKeyCheck: readonly [];
  ledgerTips: readonly RegaugeLedgerTip[];
}>;

export type RegaugeLegacyArtifactEvidence = Readonly<{
  root: RegaugeTransferLegacyArtifactRoot;
  relativePath: string;
  ciphertextPath: string;
  plaintextSha256: string;
  encryptedSha256: string;
  plaintextSizeBytes: number;
  encryptedSizeBytes: number;
}>;

type RegaugeTransferManifestBase = Readonly<{
  kind: "mendpoint.regauge.state-transfer";
  transferId: string;
  createdAt: string;
  bindings: RegaugeTransferBindings;
  fence: Readonly<{ id: string; markerSha256: string; held: true }>;
  resources: readonly RegaugeDatabaseEvidence[];
  authentication: Readonly<{
    algorithm: "hmac-sha256";
    keyId: string;
    value: string;
  }>;
}>;

export type RegaugeTransferManifestV1 = RegaugeTransferManifestBase & Readonly<{
  schemaVersion: 1;
}>;

export type RegaugeTransferManifestV2 = RegaugeTransferManifestBase & Readonly<{
  schemaVersion: 2;
  legacyArtifacts: readonly RegaugeLegacyArtifactEvidence[];
}>;

export type RegaugeTransferManifest = RegaugeTransferManifestV1 | RegaugeTransferManifestV2;
type UnsignedRegaugeTransferManifest =
  | Omit<RegaugeTransferManifestV1, "authentication">
  | Omit<RegaugeTransferManifestV2, "authentication">;

export type RegaugeCutoverFence = Readonly<{
  schemaVersion: 1;
  kind: "mendpoint.regauge.cutover-fence";
  fenceId: string;
  transferId: string;
  createdAt: string;
  sourceApp: string;
  sourceVolume: string;
  transferKeyId: string;
  nonce: string;
  exclusiveMarkerSha256: string;
  authentication: Readonly<{ algorithm: "hmac-sha256"; keyId: string; value: string }>;
}>;

const MANIFEST_NAME = "manifest.json";
const FENCE_NAME = REGAUGE_CUTOVER_FENCE_NAME;
const EXCLUSIVE_FENCE_NAME = "exclusive.json";
const RECOVERY_FENCE_NAME = "recovery.json";
const WRITERS_DIRECTORY_NAME = "writers";
const LEGACY_ARTIFACTS_DIRECTORY_NAME = "legacy-artifacts";
const RESTORE_OWNER_NAME = ".regauge-restore-owner.json";
const MAX_LEGACY_ARTIFACT_FILES = 10_000;
const MAX_LEGACY_ARTIFACT_TOTAL_BYTES = 256 * 1024 * 1024;
const PROCESS_STARTED_AT = new Date().toISOString();
const LEDGERS = Object.freeze([
  { table: "domain_events", sequence: "event_sequence", type: "event_type" },
  { table: "tf_events", sequence: "sequence", type: "type" },
  { table: "tf_pilot_events", sequence: "sequence", type: "type" },
] as const);

function fail(code: string): never { throw new Error(code); }

function requiredText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) fail(code);
  return value;
}

function assertIso(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("regauge_transfer_created_at_invalid");
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) fail("regauge_transfer_key_invalid");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("regauge_transfer_canonical_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") fail("regauge_transfer_canonical_value_invalid");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => {
    if (record[key] === undefined) fail("regauge_transfer_canonical_value_invalid");
    return `${JSON.stringify(key)}:${canonical(record[key])}`;
  }).join(",")}}`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertPlainFile(path: string, code: string): void {
  if (!existsSync(path)) fail(`${code}_missing`);
  const observed = lstatSync(path, { bigint: true });
  if (observed.isSymbolicLink() || !observed.isFile() || observed.nlink !== 1n ||
      realpathSync(path) !== resolve(path)) fail(`${code}_aliased`);
}

function assertPlainDirectory(path: string, code: string): void {
  const resolved = resolve(path);
  if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink() ||
      !statSync(resolved).isDirectory() || realpathSync(resolved) !== resolved) {
    fail(code);
  }
}

function portableRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.endsWith("/") ||
      value.split("/").some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..")) {
    fail("regauge_transfer_legacy_artifact_path_invalid");
  }
  return value;
}

function collectLegacyArtifactFiles(sourceRoot: string, rejectUnexpectedFiles = false): Array<Readonly<{
  root: RegaugeTransferLegacyArtifactRoot;
  relativePath: string;
  path: string;
  size: number;
  identity: string;
}>> {
  const files: Array<Readonly<{
    root: RegaugeTransferLegacyArtifactRoot;
    relativePath: string;
    path: string;
    size: number;
    identity: string;
  }>> = [];
  let totalBytes = 0;
  for (const rootName of REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS) {
    const root = resolve(sourceRoot, rootName);
    assertPlainDirectory(root, "regauge_transfer_legacy_artifact_root_invalid");
    const visit = (directory: string, prefix = ""): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) fail("regauge_transfer_legacy_artifact_aliased");
        const path = join(directory, entry.name);
        const relativePath = portableRelativePath(prefix ? `${prefix}/${entry.name}` : entry.name);
        const observed = lstatSync(path, { bigint: true });
        if (entry.isDirectory()) {
          if (!observed.isDirectory() || realpathSync(path) !== resolve(path)) {
            fail("regauge_transfer_legacy_artifact_aliased");
          }
          visit(path, relativePath);
          continue;
        }
        if (!entry.isFile() || !observed.isFile() || observed.nlink !== 1n || realpathSync(path) !== resolve(path)) {
          fail("regauge_transfer_legacy_artifact_aliased");
        }
        const scopePattern = "tenant-[a-f0-9]{32}/campaign-[a-f0-9]{32}/unit-[a-f0-9]{32}/attempt-[a-f0-9]{32}";
        const adoptionArtifact = rootName === "transformer-candidates"
          ? new RegExp(`^${scopePattern}/manifest\\.json$`).test(relativePath)
          : new RegExp(`^${scopePattern}/tre_execution_[a-f0-9]{64}\\.json$`).test(relativePath);
        if (!adoptionArtifact) {
          if (rejectUnexpectedFiles) fail("regauge_transfer_target_extra_or_missing_resource");
          continue;
        }
        const size = Number(observed.size);
        if (!Number.isSafeInteger(size) || size < 1 || size > REGAUGE_MISSION_EVIDENCE_MAX_BYTES) {
          fail("regauge_transfer_legacy_artifact_size_invalid");
        }
        totalBytes += size;
        if (files.length >= MAX_LEGACY_ARTIFACT_FILES || totalBytes > MAX_LEGACY_ARTIFACT_TOTAL_BYTES) {
          fail("regauge_transfer_legacy_artifact_bounds_exceeded");
        }
        files.push(Object.freeze({
          root: rootName,
          relativePath,
          path,
          size,
          identity: `${observed.dev}:${observed.ino}`,
        }));
      }
    };
    visit(root);
  }
  if (new Set(files.map((file) => file.identity)).size !== files.length) {
    fail("regauge_transfer_legacy_artifact_aliased");
  }
  return files.sort((a, b) => `${a.root}/${a.relativePath}`.localeCompare(`${b.root}/${b.relativePath}`));
}

function legacyArtifactTree(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) fail("regauge_transfer_target_extra_or_missing_resource");
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        paths.push(`${relativePath}/`);
        visit(path, relativePath);
      } else if (entry.isFile()) paths.push(relativePath);
      else fail("regauge_transfer_target_extra_or_missing_resource");
    }
  };
  visit(root);
  return paths;
}

function expectedLegacyArtifactTree(
  manifest: RegaugeTransferManifest,
  root: RegaugeTransferLegacyArtifactRoot,
): string[] {
  const paths = new Set<string>();
  for (const artifact of manifestLegacyArtifacts(manifest).filter((candidate) => candidate.root === root)) {
    const segments = artifact.relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(`${segments.slice(0, index).join("/")}/`);
    }
    paths.add(artifact.relativePath);
  }
  return [...paths].sort();
}

function manifestLegacyArtifacts(
  manifest: RegaugeTransferManifest,
): readonly RegaugeLegacyArtifactEvidence[] {
  return manifest.schemaVersion === 2 ? manifest.legacyArtifacts : [];
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

function exactRowCount(db: DatabaseSync, table: string): number {
  const result = db.prepare(`SELECT COUNT(*) AS count FROM ${sqlIdentifier(table)}`).get() as
    { count: number | bigint };
  const count = Number(result.count);
  if (!Number.isSafeInteger(count) || count < 0) fail("regauge_transfer_row_count_invalid");
  return count;
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(
    ([key, value]) => [key, typeof value === "bigint" ? value.toString() : value],
  ));
}

function inspectDatabase(path: string, name: RegaugeTransferDatabase): RegaugeDatabaseEvidence {
  const plaintext = readFileSync(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const quick = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") {
      fail("regauge_transfer_sqlite_quick_check_failed");
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      fail("regauge_transfer_sqlite_foreign_key_check_failed");
    }
    const tables = tableNames(db);
    const tableSet = new Set(tables);
    const tableRowCounts = Object.fromEntries(tables.map((table) => [table, exactRowCount(db, table)]));
    const schema = {
      userVersion: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      objects: (db.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
      ).all() as Array<Record<string, unknown>>).map(normalizeSqliteRow),
    };
    const ledgerTips = LEDGERS.filter(({ table }) => tableSet.has(table)).map((ledger) => {
      const rowCount = tableRowCounts[ledger.table]!;
      const row = db.prepare(
        `SELECT * FROM ${sqlIdentifier(ledger.table)} ORDER BY ${sqlIdentifier(ledger.sequence)} DESC LIMIT 1`,
      ).get() as Record<string, unknown> | undefined;
      if (!row) return { table: ledger.table, rowCount, sequence: null, eventType: null, rowSha256: null };
      const normalized = normalizeSqliteRow(row);
      const sequence = Number(row[ledger.sequence]);
      if (!Number.isSafeInteger(sequence) || sequence < 0) fail("regauge_transfer_ledger_sequence_invalid");
      return {
        table: ledger.table,
        rowCount,
        sequence,
        eventType: requiredText(row[ledger.type], "regauge_transfer_ledger_type_invalid"),
        rowSha256: sha256(canonical(normalized)),
      };
    });
    return {
      name,
      ciphertextPath: `resources/${name}.aes256gcm`,
      plaintextSha256: sha256(plaintext),
      encryptedSha256: "",
      plaintextSizeBytes: plaintext.byteLength,
      encryptedSizeBytes: 0,
      schemaSha256: sha256(canonical(schema)),
      tableRowCounts,
      quickCheck: "ok",
      foreignKeyCheck: [],
      ledgerTips,
    };
  } finally {
    db.close();
  }
}

function sameFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryIdentity(path: string, expected: BigIntStats): boolean {
  if (!existsSync(path)) return false;
  const observed = lstatSync(path, { bigint: true });
  return observed.isDirectory() && !observed.isSymbolicLink() &&
    observed.dev === expected.dev && observed.ino === expected.ino;
}

function ownsRestoreTarget(
  targetRoot: string,
  targetIdentity: BigIntStats,
  ownerPath: string,
  ownerBytes: Buffer,
): boolean {
  if (!sameDirectoryIdentity(targetRoot, targetIdentity)) return false;
  try {
    return readFileSync(ownerPath).equals(ownerBytes);
  } catch {
    return false;
  }
}

function snapshotDatabase(source: string, destination: string, expected: BigIntStats): void {
  const before = lstatSync(source, { bigint: true });
  if (before.nlink !== 1n || !sameFileIdentity(before, expected)) {
    fail("regauge_transfer_source_changed");
  }
  const db = new DatabaseSync(source);
  try { db.exec(`VACUUM INTO ${sqlLiteral(destination)}`); } finally { db.close(); }
  const after = lstatSync(source, { bigint: true });
  if (after.nlink !== 1n || !sameFileIdentity(after, expected)) {
    fail("regauge_transfer_source_changed");
  }
}

function deriveKey(key: Buffer, purpose: "encryption" | "authentication" | "fence" | "rollback"): Buffer {
  return createHmac("sha256", key).update(`mendpoint:regauge-state-transfer:v1:${purpose}`).digest();
}

function unsignedFence(fence: RegaugeCutoverFence): Omit<RegaugeCutoverFence, "authentication"> {
  const { authentication: _authentication, ...body } = fence;
  return body;
}

function authenticateFence(body: Omit<RegaugeCutoverFence, "authentication">, key: Buffer): string {
  return createHmac("sha256", deriveKey(key, "fence")).update(canonical(body)).digest("hex");
}

function validateFence(value: unknown): RegaugeCutoverFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("regauge_cutover_fence_invalid");
  const fence = value as RegaugeCutoverFence;
  exactKeys(value as Record<string, unknown>, [
    "schemaVersion", "kind", "fenceId", "transferId", "createdAt", "sourceApp", "sourceVolume", "transferKeyId", "nonce",
    "exclusiveMarkerSha256",
    "authentication",
  ], "regauge_cutover_fence_invalid");
  if (fence.schemaVersion !== 1 || fence.kind !== "mendpoint.regauge.cutover-fence") {
    fail("regauge_cutover_fence_invalid");
  }
  requiredText(fence.fenceId, "regauge_cutover_fence_invalid");
  requiredText(fence.transferId, "regauge_cutover_fence_invalid");
  assertIso(requiredText(fence.createdAt, "regauge_cutover_fence_invalid"));
  requiredText(fence.sourceApp, "regauge_cutover_fence_invalid");
  requiredText(fence.sourceVolume, "regauge_cutover_fence_invalid");
  requiredText(fence.transferKeyId, "regauge_cutover_fence_invalid");
  if (!/^[a-f0-9]{32}$/.test(fence.nonce)) fail("regauge_cutover_fence_invalid");
  if (!/^[a-f0-9]{64}$/.test(fence.exclusiveMarkerSha256)) fail("regauge_cutover_fence_invalid");
  if (!fence.authentication || typeof fence.authentication !== "object") fail("regauge_cutover_fence_invalid");
  exactKeys(fence.authentication as unknown as Record<string, unknown>, ["algorithm", "keyId", "value"],
    "regauge_cutover_fence_invalid");
  if (fence.authentication.algorithm !== "hmac-sha256" ||
      fence.authentication.keyId !== fence.transferKeyId ||
      !/^[a-f0-9]{64}$/.test(fence.authentication.value)) fail("regauge_cutover_fence_invalid");
  return fence;
}

function fencePath(fenceRoot: string): string {
  return join(resolve(fenceRoot), FENCE_NAME);
}

function exclusiveFencePath(fenceRoot: string): string {
  return join(resolve(fenceRoot), EXCLUSIVE_FENCE_NAME);
}

function assertCooperativeExclusiveFence(fenceRoot: string, fence: RegaugeCutoverFence): void {
  const path = exclusiveFencePath(fenceRoot);
  assertPlainFile(path, "regauge_cutover_exclusive_fence");
  const raw = readFileSync(path);
  if (sha256(raw) !== fence.exclusiveMarkerSha256) {
    fail("regauge_cutover_exclusive_fence_changed");
  }
  let marker: Record<string, unknown>;
  try { marker = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
  catch { return fail("regauge_cutover_exclusive_fence_invalid"); }
  exactKeys(marker, [
    "schemaVersion", "kind", "id", "ownerToken", "hostname", "pid", "processStartedAt", "acquiredAt",
  ], "regauge_cutover_exclusive_fence_invalid");
  if (marker.schemaVersion !== 1 || marker.kind !== "exclusive" || marker.id !== fence.fenceId ||
      typeof marker.ownerToken !== "string" || marker.ownerToken.length === 0 ||
      typeof marker.hostname !== "string" || marker.hostname.length === 0 ||
      !Number.isSafeInteger(marker.pid) || Number(marker.pid) <= 0 ||
      typeof marker.processStartedAt !== "string" || !Number.isFinite(Date.parse(marker.processStartedAt)) ||
      marker.acquiredAt !== fence.createdAt) {
    fail("regauge_cutover_exclusive_fence_invalid");
  }
}

export function acquireRegaugeCutoverFence(input: Readonly<{
  fenceRoot: string;
  fenceId: string;
  transferId: string;
  createdAt: string;
  sourceApp: string;
  sourceVolume: string;
  transferKeyId: string;
  transferKey: Buffer;
}>): RegaugeCutoverFence {
  assertKey(input.transferKey);
  requiredText(input.fenceId, "regauge_cutover_fence_id_invalid");
  requiredText(input.transferId, "regauge_transfer_id_invalid");
  assertIso(input.createdAt);
  requiredText(input.sourceApp, "regauge_cutover_fence_source_invalid");
  requiredText(input.sourceVolume, "regauge_cutover_fence_source_invalid");
  requiredText(input.transferKeyId, "regauge_cutover_fence_key_id_invalid");
  const root = resolve(input.fenceRoot);
  mkdirSync(join(root, WRITERS_DIRECTORY_NAME), { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) fail("regauge_cutover_fence_root_aliased");
  if (lstatSync(join(root, WRITERS_DIRECTORY_NAME)).isSymbolicLink() ||
      realpathSync(join(root, WRITERS_DIRECTORY_NAME)) !== join(root, WRITERS_DIRECTORY_NAME)) {
    fail("regauge_cutover_fence_root_aliased");
  }
  if (existsSync(fencePath(root)) || existsSync(exclusiveFencePath(root))) {
    fail("regauge_cutover_fence_exists");
  }
  const exclusiveMarker = {
    schemaVersion: 1 as const,
    kind: "exclusive" as const,
    id: input.fenceId,
    ownerToken: randomBytes(32).toString("hex"),
    hostname: hostname(),
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    acquiredAt: input.createdAt,
  };
  const exclusiveEncoded = Buffer.from(`${JSON.stringify(exclusiveMarker)}\n`, "utf8");
  try {
    writeFileSync(exclusiveFencePath(root), exclusiveEncoded, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (existsSync(exclusiveFencePath(root))) fail("regauge_cutover_fence_exists");
    throw error;
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "mendpoint.regauge.cutover-fence" as const,
    fenceId: input.fenceId,
    transferId: input.transferId,
    createdAt: input.createdAt,
    sourceApp: input.sourceApp,
    sourceVolume: input.sourceVolume,
    transferKeyId: input.transferKeyId,
    nonce: randomBytes(16).toString("hex"),
    exclusiveMarkerSha256: sha256(exclusiveEncoded),
  };
  const fence: RegaugeCutoverFence = Object.freeze({ ...body, authentication: Object.freeze({
    algorithm: "hmac-sha256" as const,
    keyId: input.transferKeyId,
    value: authenticateFence(body, input.transferKey),
  }) });
  let authenticatedMarkerCreated = false;
  try {
    if (existsSync(join(root, RECOVERY_FENCE_NAME))) fail("regauge_cutover_recovery_fence_active");
    writeFileSync(fencePath(root), `${canonical(fence)}\n`, { flag: "wx", mode: 0o600 });
    authenticatedMarkerCreated = true;
    const activeWriters = readdirSync(join(root, WRITERS_DIRECTORY_NAME), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (activeWriters.length !== 0) fail("regauge_cutover_writer_active");
  } catch (error) {
    if (authenticatedMarkerCreated) rmSync(fencePath(root), { force: true });
    rmSync(exclusiveFencePath(root), { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("regauge_cutover_fence_exists");
    throw error;
  }
  return fence;
}

export function inspectRegaugeCutoverFence(input: Readonly<{
  fenceRoot: string;
  fenceId: string;
  transferKey: Buffer;
}>): Readonly<{ fence: RegaugeCutoverFence; markerSha256: string }> {
  assertKey(input.transferKey);
  const path = fencePath(input.fenceRoot);
  assertPlainFile(path, "regauge_cutover_fence");
  let fence: RegaugeCutoverFence;
  try { fence = validateFence(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("regauge_")) throw error;
    return fail("regauge_cutover_fence_invalid");
  }
  if (fence.fenceId !== input.fenceId) fail("regauge_cutover_fence_id_mismatch");
  const expected = Buffer.from(authenticateFence(unsignedFence(fence), input.transferKey), "hex");
  const actual = Buffer.from(fence.authentication.value, "hex");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    fail("regauge_cutover_fence_authentication_failed");
  }
  assertCooperativeExclusiveFence(input.fenceRoot, fence);
  return Object.freeze({ fence, markerSha256: sha256(readFileSync(path)) });
}

function aad(bindings: RegaugeTransferBindings, transferId: string, name: string): Buffer {
  return Buffer.from(canonical({ schemaVersion: 1, transferId, bindings, name }), "utf8");
}

function legacyArtifactAad(
  bindings: RegaugeTransferBindings,
  transferId: string,
  artifact: Pick<RegaugeLegacyArtifactEvidence, "root" | "relativePath">,
): Buffer {
  return Buffer.from(canonical({
    schemaVersion: 2,
    kind: "mendpoint.regauge.legacy-artifact",
    transferId,
    bindings,
    root: artifact.root,
    relativePath: artifact.relativePath,
  }), "utf8");
}

function encrypt(plain: Buffer, key: Buffer, associatedData: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key, "encryption"), nonce);
  cipher.setAAD(associatedData);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]);
}

function decrypt(ciphertext: Buffer, key: Buffer, associatedData: Buffer): Buffer {
  if (ciphertext.byteLength < 29) fail("regauge_transfer_ciphertext_invalid");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(key, "encryption"),
      ciphertext.subarray(0, 12),
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(ciphertext.subarray(12, 28));
    return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
  } catch { return fail("regauge_transfer_decryption_failed"); }
}

function unsigned(manifest: RegaugeTransferManifest): UnsignedRegaugeTransferManifest {
  const { authentication: _authentication, ...body } = manifest;
  return body as UnsignedRegaugeTransferManifest;
}

function authenticate(body: UnsignedRegaugeTransferManifest, key: Buffer): string {
  return createHmac("sha256", deriveKey(key, "authentication")).update(canonical(body)).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  if (canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) fail(code);
}

function validateManifest(value: unknown): RegaugeTransferManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("regauge_transfer_manifest_invalid");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    fail("regauge_transfer_manifest_version_invalid");
  }
  exactKeys(record, record.schemaVersion === 2 ? [
    "schemaVersion", "kind", "transferId", "createdAt", "bindings", "fence", "resources",
    "legacyArtifacts", "authentication",
  ] : [
    "schemaVersion", "kind", "transferId", "createdAt", "bindings", "fence", "resources", "authentication",
  ], "regauge_transfer_manifest_extra_or_missing");
  const manifest = value as unknown as RegaugeTransferManifest;
  if (manifest.kind !== "mendpoint.regauge.state-transfer") {
    fail("regauge_transfer_manifest_version_invalid");
  }
  requiredText(manifest.transferId, "regauge_transfer_id_invalid");
  assertIso(requiredText(manifest.createdAt, "regauge_transfer_created_at_invalid"));
  if (!manifest.bindings || typeof manifest.bindings !== "object") fail("regauge_transfer_bindings_invalid");
  exactKeys(manifest.bindings as unknown as Record<string, unknown>, [
    "tenantId", "campaignId", "sourceApp", "sourceVolume", "sourceRevision", "targetApp", "targetVolume",
    "objectBucket", "objectPrefix", "transferKeyId", "applicationDataKeyId", "checkpointKeyId",
  ], "regauge_transfer_bindings_extra_or_missing");
  for (const value of Object.values(manifest.bindings)) requiredText(value, "regauge_transfer_binding_invalid");
  if (!manifest.fence || typeof manifest.fence !== "object" || manifest.fence.held !== true) {
    fail("regauge_transfer_fence_not_held");
  }
  exactKeys(manifest.fence as unknown as Record<string, unknown>, ["id", "markerSha256", "held"], "regauge_transfer_fence_invalid");
  requiredText(manifest.fence.id, "regauge_transfer_fence_id_invalid");
  if (!/^[a-f0-9]{64}$/.test(manifest.fence.markerSha256)) fail("regauge_transfer_fence_invalid");
  if (!Array.isArray(manifest.resources) || manifest.resources.length !== REGAUGE_TRANSFER_DATABASES.length) {
    fail("regauge_transfer_resources_incomplete");
  }
  if (canonical(manifest.resources.map((resource) => resource.name)) !== canonical(REGAUGE_TRANSFER_DATABASES)) {
    fail("regauge_transfer_resources_extra_missing_or_aliased");
  }
  for (const resource of manifest.resources) {
    exactKeys(resource as unknown as Record<string, unknown>, [
      "name", "ciphertextPath", "plaintextSha256", "encryptedSha256", "plaintextSizeBytes",
      "encryptedSizeBytes", "schemaSha256", "tableRowCounts", "quickCheck", "foreignKeyCheck", "ledgerTips",
    ], "regauge_transfer_resource_invalid");
    if (resource.ciphertextPath !== `resources/${resource.name}.aes256gcm` ||
        !/^[a-f0-9]{64}$/.test(resource.plaintextSha256) ||
        !/^[a-f0-9]{64}$/.test(resource.encryptedSha256) ||
        !/^[a-f0-9]{64}$/.test(resource.schemaSha256) ||
        !Number.isSafeInteger(resource.plaintextSizeBytes) || resource.plaintextSizeBytes < 1 ||
        !Number.isSafeInteger(resource.encryptedSizeBytes) || resource.encryptedSizeBytes < 29 ||
        resource.quickCheck !== "ok" || !Array.isArray(resource.foreignKeyCheck) || resource.foreignKeyCheck.length) {
      fail("regauge_transfer_resource_evidence_invalid");
    }
  }
  let legacyBytes = 0;
  let previousLegacyKey = "";
  const legacyArtifacts = manifestLegacyArtifacts(manifest);
  if (manifest.schemaVersion === 2 && (!Array.isArray(manifest.legacyArtifacts) ||
      manifest.legacyArtifacts.length > MAX_LEGACY_ARTIFACT_FILES)) {
    fail("regauge_transfer_legacy_artifacts_invalid");
  }
  for (const artifact of legacyArtifacts) {
    exactKeys(artifact as unknown as Record<string, unknown>, [
      "root", "relativePath", "ciphertextPath", "plaintextSha256", "encryptedSha256",
      "plaintextSizeBytes", "encryptedSizeBytes",
    ], "regauge_transfer_legacy_artifact_invalid");
    if (!(REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS as readonly string[]).includes(artifact.root)) {
      fail("regauge_transfer_legacy_artifact_root_invalid");
    }
    portableRelativePath(artifact.relativePath);
    const legacyKey = `${artifact.root}/${artifact.relativePath}`;
    if (legacyKey <= previousLegacyKey || artifact.ciphertextPath !==
        `${LEGACY_ARTIFACTS_DIRECTORY_NAME}/${legacyKey}.aes256gcm` ||
        !/^[a-f0-9]{64}$/.test(artifact.plaintextSha256) ||
        !/^[a-f0-9]{64}$/.test(artifact.encryptedSha256) ||
        !Number.isSafeInteger(artifact.plaintextSizeBytes) || artifact.plaintextSizeBytes < 1 ||
        artifact.plaintextSizeBytes > REGAUGE_MISSION_EVIDENCE_MAX_BYTES ||
        !Number.isSafeInteger(artifact.encryptedSizeBytes) ||
        artifact.encryptedSizeBytes !== artifact.plaintextSizeBytes + 28) {
      fail("regauge_transfer_legacy_artifact_evidence_invalid");
    }
    previousLegacyKey = legacyKey;
    legacyBytes += artifact.plaintextSizeBytes;
    if (legacyBytes > MAX_LEGACY_ARTIFACT_TOTAL_BYTES) {
      fail("regauge_transfer_legacy_artifact_bounds_exceeded");
    }
  }
  if (!manifest.authentication || typeof manifest.authentication !== "object") {
    fail("regauge_transfer_authentication_invalid");
  }
  exactKeys(manifest.authentication as unknown as Record<string, unknown>, ["algorithm", "keyId", "value"],
    "regauge_transfer_authentication_invalid");
  if (manifest.authentication.algorithm !== "hmac-sha256" ||
      manifest.authentication.keyId !== manifest.bindings.transferKeyId ||
      !/^[a-f0-9]{64}$/.test(manifest.authentication.value)) {
    fail("regauge_transfer_authentication_invalid");
  }
  return manifest;
}

function assertBundleFiles(bundleRoot: string, manifest: RegaugeTransferManifest): void {
  const rootEntries = readdirSync(bundleRoot, { withFileTypes: true });
  const expectedRootEntries = manifest.schemaVersion === 2
    ? [MANIFEST_NAME, "resources", LEGACY_ARTIFACTS_DIRECTORY_NAME]
    : [MANIFEST_NAME, "resources"];
  if (rootEntries.some((entry) => entry.isSymbolicLink()) ||
      canonical(rootEntries.map((entry) => entry.name).sort()) !==
        canonical(expectedRootEntries.sort()) ||
      !rootEntries.find((entry) => entry.name === MANIFEST_NAME)?.isFile() ||
      !rootEntries.find((entry) => entry.name === "resources")?.isDirectory() ||
      (manifest.schemaVersion === 2 &&
        !rootEntries.find((entry) => entry.name === LEGACY_ARTIFACTS_DIRECTORY_NAME)?.isDirectory())) {
    fail("regauge_transfer_bundle_extra_or_missing_resource");
  }
  const actual = [MANIFEST_NAME];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail("regauge_transfer_bundle_extra_or_missing_resource");
      const relativePath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), relativePath);
      else if (entry.isFile()) actual.push(relativePath);
      else fail("regauge_transfer_bundle_extra_or_missing_resource");
    }
  };
  visit(join(bundleRoot, "resources"), "resources");
  if (manifest.schemaVersion === 2) {
    visit(join(bundleRoot, LEGACY_ARTIFACTS_DIRECTORY_NAME), LEGACY_ARTIFACTS_DIRECTORY_NAME);
  }
  actual.sort();
  const expected = [MANIFEST_NAME,
    ...manifest.resources.map((resource) => resource.ciphertextPath),
    ...manifestLegacyArtifacts(manifest).map((artifact) => artifact.ciphertextPath),
  ].sort();
  if (canonical(actual) !== canonical(expected)) fail("regauge_transfer_bundle_extra_or_missing_resource");
}

function verifyAuthentication(manifest: RegaugeTransferManifest, key: Buffer): void {
  const expected = Buffer.from(authenticate(unsigned(manifest), key), "hex");
  const actual = Buffer.from(manifest.authentication.value, "hex");
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    fail("regauge_transfer_authentication_failed");
  }
}

function evidenceComparable(evidence: RegaugeDatabaseEvidence): Omit<RegaugeDatabaseEvidence, "encryptedSha256" | "encryptedSizeBytes"> {
  const { encryptedSha256: _digest, encryptedSizeBytes: _size, ...rest } = evidence;
  return rest;
}

function decryptAndVerifyResource(
  bundleRoot: string,
  outputPath: string,
  manifest: RegaugeTransferManifest,
  resource: RegaugeDatabaseEvidence,
  key: Buffer,
): void {
  const ciphertextPath = resolve(bundleRoot, resource.ciphertextPath);
  if (!ciphertextPath.startsWith(`${resolve(bundleRoot)}${sep}`)) fail("regauge_transfer_resource_path_invalid");
  assertPlainFile(ciphertextPath, "regauge_transfer_ciphertext");
  const encrypted = readFileSync(ciphertextPath);
  if (encrypted.byteLength !== resource.encryptedSizeBytes || sha256(encrypted) !== resource.encryptedSha256) {
    fail("regauge_transfer_ciphertext_evidence_mismatch");
  }
  const plain = decrypt(encrypted, key, aad(manifest.bindings, manifest.transferId, resource.name));
  if (plain.byteLength !== resource.plaintextSizeBytes || sha256(plain) !== resource.plaintextSha256) {
    fail("regauge_transfer_plaintext_evidence_mismatch");
  }
  writeFileSync(outputPath, plain, { mode: 0o600, flag: "wx" });
  const observed = inspectDatabase(outputPath, resource.name);
  if (canonical(evidenceComparable(observed)) !== canonical(evidenceComparable(resource))) {
    fail("regauge_transfer_database_evidence_mismatch");
  }
}

function decryptAndVerifyLegacyArtifact(
  bundleRoot: string,
  outputRoot: string,
  manifest: RegaugeTransferManifest,
  artifact: RegaugeLegacyArtifactEvidence,
  key: Buffer,
): void {
  const ciphertextPath = resolve(bundleRoot, artifact.ciphertextPath);
  if (!ciphertextPath.startsWith(`${resolve(bundleRoot)}${sep}`)) {
    fail("regauge_transfer_legacy_artifact_path_invalid");
  }
  assertPlainFile(ciphertextPath, "regauge_transfer_legacy_artifact_ciphertext");
  const encrypted = readFileSync(ciphertextPath);
  if (encrypted.byteLength !== artifact.encryptedSizeBytes || sha256(encrypted) !== artifact.encryptedSha256) {
    fail("regauge_transfer_legacy_artifact_ciphertext_evidence_mismatch");
  }
  const plain = decrypt(encrypted, key, legacyArtifactAad(manifest.bindings, manifest.transferId, artifact));
  if (plain.byteLength !== artifact.plaintextSizeBytes || sha256(plain) !== artifact.plaintextSha256) {
    fail("regauge_transfer_legacy_artifact_plaintext_evidence_mismatch");
  }
  const artifactRoot = join(outputRoot, artifact.root);
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const outputPath = resolve(artifactRoot, ...portableRelativePath(artifact.relativePath).split("/"));
  if (!outputPath.startsWith(`${resolve(artifactRoot)}${sep}`)) {
    fail("regauge_transfer_legacy_artifact_path_invalid");
  }
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, plain, { mode: 0o600, flag: "wx" });
  assertPlainFile(outputPath, "regauge_transfer_legacy_artifact_target");
  const readback = readFileSync(outputPath);
  if (readback.byteLength !== artifact.plaintextSizeBytes || sha256(readback) !== artifact.plaintextSha256) {
    fail("regauge_transfer_legacy_artifact_target_evidence_mismatch");
  }
}

export function createRegaugeStateTransfer(input: Readonly<{
  transferId: string;
  createdAt: string;
  sourceRoot: string;
  bundleRoot: string;
  bindings: RegaugeTransferBindings;
  transferKey: Buffer;
  fenceRoot: string;
  fenceId: string;
}>): RegaugeTransferManifestV2 {
  assertKey(input.transferKey);
  requiredText(input.transferId, "regauge_transfer_id_invalid");
  assertIso(input.createdAt);
  requiredText(input.fenceId, "regauge_transfer_fence_id_invalid");
  for (const value of Object.values(input.bindings)) requiredText(value, "regauge_transfer_binding_invalid");
  const assertFence = () => {
    const inspected = inspectRegaugeCutoverFence({
      fenceRoot: input.fenceRoot,
      fenceId: input.fenceId,
      transferKey: input.transferKey,
    });
    if (inspected.fence.transferId !== input.transferId ||
        inspected.fence.sourceApp !== input.bindings.sourceApp ||
        inspected.fence.sourceVolume !== input.bindings.sourceVolume ||
        inspected.fence.transferKeyId !== input.bindings.transferKeyId) {
      fail("regauge_cutover_fence_binding_mismatch");
    }
    return inspected;
  };
  const initialFence = assertFence();
  if (existsSync(input.bundleRoot)) fail("regauge_transfer_bundle_exists");
  const sourceRoot = resolve(input.sourceRoot);
  const sources = REGAUGE_TRANSFER_DATABASES.map((name) => {
    const path = resolve(sourceRoot, name);
    if (!path.startsWith(`${sourceRoot}${sep}`)) fail("regauge_transfer_source_path_invalid");
    assertPlainFile(path, `regauge_transfer_source_${name}`);
    return { name, path, identity: lstatSync(path, { bigint: true }) };
  });
  const identities = new Set(sources.map(({ identity }) => `${identity.dev}:${identity.ino}`));
  if (identities.size !== sources.length) fail("regauge_transfer_sources_aliased");
  const legacySources = collectLegacyArtifactFiles(sourceRoot);
  const staging = `${resolve(input.bundleRoot)}.staging-${randomBytes(8).toString("hex")}`;
  mkdirSync(join(staging, "resources"), { recursive: true, mode: 0o700 });
  mkdirSync(join(staging, LEGACY_ARTIFACTS_DIRECTORY_NAME), { recursive: true, mode: 0o700 });
  try {
    const resources = sources.map(({ name, path, identity }) => {
      assertFence();
      const snapshot = join(staging, `${name}.snapshot`);
      snapshotDatabase(path, snapshot, identity);
      assertFence();
      const baseEvidence = inspectDatabase(snapshot, name);
      const encrypted = encrypt(readFileSync(snapshot), input.transferKey, aad(input.bindings, input.transferId, name));
      const ciphertext = join(staging, baseEvidence.ciphertextPath);
      writeFileSync(ciphertext, encrypted, { mode: 0o600, flag: "wx" });
      rmSync(snapshot);
      return {
        ...baseEvidence,
        encryptedSha256: sha256(encrypted),
        encryptedSizeBytes: encrypted.byteLength,
      };
    });
    const legacyArtifacts = legacySources.map((source) => {
      assertFence();
      const plain = readFileSync(source.path);
      const observed = lstatSync(source.path, { bigint: true });
      if (!observed.isFile() || observed.nlink !== 1n || Number(observed.size) !== source.size ||
          `${observed.dev}:${observed.ino}` !== source.identity || realpathSync(source.path) !== resolve(source.path)) {
        fail("regauge_transfer_legacy_artifact_changed");
      }
      const evidenceBase = {
        root: source.root,
        relativePath: source.relativePath,
      } as const;
      const encrypted = encrypt(
        plain,
        input.transferKey,
        legacyArtifactAad(input.bindings, input.transferId, evidenceBase),
      );
      const ciphertextPath = `${LEGACY_ARTIFACTS_DIRECTORY_NAME}/${source.root}/${source.relativePath}.aes256gcm`;
      const ciphertext = join(staging, ...ciphertextPath.split("/"));
      mkdirSync(dirname(ciphertext), { recursive: true, mode: 0o700 });
      writeFileSync(ciphertext, encrypted, { mode: 0o600, flag: "wx" });
      assertFence();
      return Object.freeze({
        ...evidenceBase,
        ciphertextPath,
        plaintextSha256: sha256(plain),
        encryptedSha256: sha256(encrypted),
        plaintextSizeBytes: plain.byteLength,
        encryptedSizeBytes: encrypted.byteLength,
      });
    });
    const body = {
      schemaVersion: 2 as const,
      kind: "mendpoint.regauge.state-transfer" as const,
      transferId: input.transferId,
      createdAt: input.createdAt,
      bindings: Object.freeze({ ...input.bindings }),
      fence: Object.freeze({ id: input.fenceId, markerSha256: initialFence.markerSha256, held: true as const }),
      resources: Object.freeze(resources),
      legacyArtifacts: Object.freeze(legacyArtifacts),
    };
    const manifest: RegaugeTransferManifestV2 = Object.freeze({
      ...body,
      authentication: Object.freeze({
        algorithm: "hmac-sha256" as const,
        keyId: input.bindings.transferKeyId,
        value: authenticate(body, input.transferKey),
      }),
    });
    writeFileSync(join(staging, MANIFEST_NAME), `${canonical(manifest)}\n`, { mode: 0o600, flag: "wx" });
    if (assertFence().markerSha256 !== initialFence.markerSha256) fail("regauge_cutover_fence_changed");
    mkdirSync(dirname(resolve(input.bundleRoot)), { recursive: true, mode: 0o700 });
    renameSync(staging, resolve(input.bundleRoot));
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function verifyRegaugeStateTransfer(input: Readonly<{
  bundleRoot: string;
  transferKey: Buffer;
}>): RegaugeTransferManifest {
  assertKey(input.transferKey);
  const bundleRoot = resolve(input.bundleRoot);
  assertPlainFile(join(bundleRoot, MANIFEST_NAME), "regauge_transfer_manifest");
  let manifest: RegaugeTransferManifest;
  try { manifest = validateManifest(JSON.parse(readFileSync(join(bundleRoot, MANIFEST_NAME), "utf8"))); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("regauge_")) throw error;
    return fail("regauge_transfer_manifest_invalid");
  }
  verifyAuthentication(manifest, input.transferKey);
  assertBundleFiles(bundleRoot, manifest);
  const verificationRoot = join(dirname(bundleRoot), `.regauge-verify-${randomBytes(8).toString("hex")}`);
  mkdirSync(verificationRoot, { mode: 0o700 });
  try {
    for (const resource of manifest.resources) {
      decryptAndVerifyResource(bundleRoot, join(verificationRoot, resource.name), manifest, resource, input.transferKey);
    }
    for (const artifact of manifestLegacyArtifacts(manifest)) {
      decryptAndVerifyLegacyArtifact(bundleRoot, verificationRoot, manifest, artifact, input.transferKey);
    }
  } finally { rmSync(verificationRoot, { recursive: true, force: true }); }
  return manifest;
}

export function restoreRegaugeStateTransfer(input: Readonly<{
  bundleRoot: string;
  targetRoot: string;
  transferKey: Buffer;
}>): RegaugeTransferManifest {
  if (existsSync(input.targetRoot)) fail("regauge_transfer_target_exists");
  const manifest = verifyRegaugeStateTransfer({ bundleRoot: input.bundleRoot, transferKey: input.transferKey });
  const targetRoot = resolve(input.targetRoot);
  const targetParent = dirname(targetRoot);
  assertPlainDirectory(targetParent, "regauge_transfer_target_parent_invalid");
  const owner = Object.freeze({
    schemaVersion: 1 as const,
    kind: "mendpoint.regauge.restore-owner" as const,
    nonce: randomBytes(32).toString("hex"),
  });
  const ownerBytes = Buffer.from(`${canonical(owner)}\n`, "utf8");
  try {
    mkdirSync(targetRoot, { mode: 0o700 });
  } catch (error) {
    if (existsSync(targetRoot)) fail("regauge_transfer_target_exists");
    throw error;
  }
  const targetIdentity = lstatSync(targetRoot, { bigint: true });
  const ownerPath = join(targetRoot, RESTORE_OWNER_NAME);
  try {
    writeFileSync(ownerPath, ownerBytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (sameDirectoryIdentity(targetRoot, targetIdentity)) rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  }
  const assertOwnership = (): void => {
    if (!ownsRestoreTarget(targetRoot, targetIdentity, ownerPath, ownerBytes)) {
      fail("regauge_transfer_target_ownership_changed");
    }
  };
  try {
    assertOwnership();
    for (const resource of manifest.resources) {
      assertOwnership();
      decryptAndVerifyResource(resolve(input.bundleRoot), join(targetRoot, resource.name), manifest, resource, input.transferKey);
      assertOwnership();
    }
    for (const root of REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS) {
      assertOwnership();
      mkdirSync(join(targetRoot, root), { recursive: true, mode: 0o700 });
      assertOwnership();
    }
    for (const artifact of manifestLegacyArtifacts(manifest)) {
      assertOwnership();
      decryptAndVerifyLegacyArtifact(resolve(input.bundleRoot), targetRoot, manifest, artifact, input.transferKey);
      assertOwnership();
    }
    unlinkSync(ownerPath);
    return manifest;
  } catch (error) {
    if (ownsRestoreTarget(targetRoot, targetIdentity, ownerPath, ownerBytes)) {
      rmSync(targetRoot, { recursive: true, force: true });
    } else {
      fail("regauge_transfer_target_ownership_changed");
    }
    throw error;
  }
}

export function inspectRegaugeLedgerTips(targetRoot: string): Readonly<Record<RegaugeTransferDatabase, readonly RegaugeLedgerTip[]>> {
  return Object.freeze(Object.fromEntries(REGAUGE_TRANSFER_DATABASES.map((name) => {
    const path = join(resolve(targetRoot), name);
    assertPlainFile(path, `regauge_transfer_target_${name}`);
    return [name, inspectDatabase(path, name).ledgerTips];
  })) as Record<RegaugeTransferDatabase, readonly RegaugeLedgerTip[]>);
}

export function verifyRestoredRegaugeState(input: Readonly<{
  targetRoot: string;
  importManifest: RegaugeTransferManifest;
  transferKey: Buffer;
}>): RegaugeTransferManifest {
  assertKey(input.transferKey);
  const manifest = validateManifest(input.importManifest);
  verifyAuthentication(manifest, input.transferKey);
  const targetRoot = resolve(input.targetRoot);
  if (!existsSync(targetRoot) || lstatSync(targetRoot).isSymbolicLink() ||
      !statSync(targetRoot).isDirectory() || realpathSync(targetRoot) !== targetRoot) {
    fail("regauge_transfer_target_invalid");
  }
  const entries = readdirSync(targetRoot, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()) ||
      canonical(entries.map((entry) => entry.name).sort()) !==
        canonical([...REGAUGE_TRANSFER_DATABASES, ...REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS].sort()) ||
      REGAUGE_TRANSFER_DATABASES.some((name) => !entries.find((entry) => entry.name === name)?.isFile()) ||
      REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS.some((name) => !entries.find((entry) => entry.name === name)?.isDirectory())) {
    fail("regauge_transfer_target_extra_or_missing_resource");
  }
  for (const resource of manifest.resources) {
    const observed = inspectDatabase(join(targetRoot, resource.name), resource.name);
    if (canonical(evidenceComparable(observed)) !== canonical(evidenceComparable(resource))) {
      fail("regauge_transfer_target_evidence_mismatch");
    }
  }
  const observedLegacy = collectLegacyArtifactFiles(targetRoot, true).map(({ root, relativePath, path, size }) => ({
    root,
    relativePath,
    plaintextSha256: sha256(readFileSync(path)),
    plaintextSizeBytes: size,
  }));
  const expectedLegacy = manifestLegacyArtifacts(manifest).map((artifact) => ({
    root: artifact.root,
    relativePath: artifact.relativePath,
    plaintextSha256: artifact.plaintextSha256,
    plaintextSizeBytes: artifact.plaintextSizeBytes,
  }));
  if (canonical(observedLegacy) !== canonical(expectedLegacy)) {
    fail("regauge_transfer_target_legacy_artifact_evidence_mismatch");
  }
  for (const root of REGAUGE_TRANSFER_LEGACY_ARTIFACT_ROOTS) {
    if (canonical(legacyArtifactTree(join(targetRoot, root))) !==
        canonical(expectedLegacyArtifactTree(manifest, root))) {
      fail("regauge_transfer_target_extra_or_missing_resource");
    }
  }
  return manifest;
}
