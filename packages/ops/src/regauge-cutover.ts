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
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const REGAUGE_TRANSFER_DATABASES = Object.freeze([
  "change-sources.sqlite",
  "mendpoint.sqlite",
  "transformer-control-plane.sqlite",
  "transformer-pilot.sqlite",
] as const);

export type RegaugeTransferDatabase = (typeof REGAUGE_TRANSFER_DATABASES)[number];

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

export type RegaugeTransferManifest = Readonly<{
  schemaVersion: 1;
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

export type RegaugeRollbackActivity = Readonly<{
  providerObservationCount: number;
  deliveryClaimCount: number;
  authorityEventCount: number;
}>;

export type RegaugeRollbackProof = Readonly<{
  schemaVersion: 1;
  kind: "mendpoint.regauge.rollback-proof";
  transferId: string;
  fenceId: string;
  assessedAt: string;
  reason: "target_unchanged_since_import";
  manifestAuthentication: string;
  activity: RegaugeRollbackActivity;
  ledgerTipsSha256: string;
  authentication: Readonly<{ algorithm: "hmac-sha256"; keyId: string; value: string }>;
}>;

export type RegaugeCutoverFence = Readonly<{
  schemaVersion: 1;
  kind: "mendpoint.regauge.cutover-fence";
  fenceId: string;
  createdAt: string;
  sourceApp: string;
  sourceVolume: string;
  transferKeyId: string;
  nonce: string;
  exclusiveMarkerSha256: string;
  authentication: Readonly<{ algorithm: "hmac-sha256"; keyId: string; value: string }>;
}>;

const MANIFEST_NAME = "manifest.json";
const FENCE_NAME = "regauge-cutover-fence.v1.json";
const EXCLUSIVE_FENCE_NAME = "exclusive.json";
const RECOVERY_FENCE_NAME = "recovery.json";
const WRITERS_DIRECTORY_NAME = "writers";
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
  if (lstatSync(path).isSymbolicLink()) fail(`${code}_aliased`);
  if (!statSync(path).isFile() || realpathSync(path) !== resolve(path)) fail(`${code}_aliased`);
}

function assertPlainDirectory(path: string, code: string): void {
  const resolved = resolve(path);
  if (!existsSync(resolved) || lstatSync(resolved).isSymbolicLink() ||
      !statSync(resolved).isDirectory() || realpathSync(resolved) !== resolved) {
    fail(code);
  }
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

function snapshotDatabase(source: string, destination: string): void {
  const db = new DatabaseSync(source);
  try { db.exec(`VACUUM INTO ${sqlLiteral(destination)}`); } finally { db.close(); }
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
    "schemaVersion", "kind", "fenceId", "createdAt", "sourceApp", "sourceVolume", "transferKeyId", "nonce",
    "exclusiveMarkerSha256",
    "authentication",
  ], "regauge_cutover_fence_invalid");
  if (fence.schemaVersion !== 1 || fence.kind !== "mendpoint.regauge.cutover-fence") {
    fail("regauge_cutover_fence_invalid");
  }
  requiredText(fence.fenceId, "regauge_cutover_fence_invalid");
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
  createdAt: string;
  sourceApp: string;
  sourceVolume: string;
  transferKeyId: string;
  transferKey: Buffer;
}>): RegaugeCutoverFence {
  assertKey(input.transferKey);
  requiredText(input.fenceId, "regauge_cutover_fence_id_invalid");
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

function unsigned(manifest: RegaugeTransferManifest): Omit<RegaugeTransferManifest, "authentication"> {
  const { authentication: _authentication, ...body } = manifest;
  return body;
}

function authenticate(body: Omit<RegaugeTransferManifest, "authentication">, key: Buffer): string {
  return createHmac("sha256", deriveKey(key, "authentication")).update(canonical(body)).digest("hex");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  if (canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) fail(code);
}

function validateManifest(value: unknown): RegaugeTransferManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("regauge_transfer_manifest_invalid");
  const manifest = value as unknown as RegaugeTransferManifest;
  exactKeys(value as Record<string, unknown>, [
    "schemaVersion", "kind", "transferId", "createdAt", "bindings", "fence", "resources", "authentication",
  ], "regauge_transfer_manifest_extra_or_missing");
  if (manifest.schemaVersion !== 1 || manifest.kind !== "mendpoint.regauge.state-transfer") {
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
  if (rootEntries.some((entry) => entry.isSymbolicLink()) ||
      canonical(rootEntries.map((entry) => entry.name).sort()) !== canonical([MANIFEST_NAME, "resources"].sort()) ||
      !rootEntries.find((entry) => entry.name === MANIFEST_NAME)?.isFile() ||
      !rootEntries.find((entry) => entry.name === "resources")?.isDirectory()) {
    fail("regauge_transfer_bundle_extra_or_missing_resource");
  }
  const resourceEntries = readdirSync(join(bundleRoot, "resources"), { withFileTypes: true });
  if (resourceEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    fail("regauge_transfer_bundle_extra_or_missing_resource");
  }
  const actual = [MANIFEST_NAME, ...resourceEntries.map((entry) => `resources/${entry.name}`)].sort();
  const expected = [MANIFEST_NAME, ...manifest.resources.map((resource) => resource.ciphertextPath)].sort();
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

export function createRegaugeStateTransfer(input: Readonly<{
  transferId: string;
  createdAt: string;
  sourceRoot: string;
  bundleRoot: string;
  bindings: RegaugeTransferBindings;
  transferKey: Buffer;
  fenceRoot: string;
  fenceId: string;
}>): RegaugeTransferManifest {
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
    if (inspected.fence.sourceApp !== input.bindings.sourceApp ||
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
    return { name, path, identity: statSync(path, { bigint: true }) };
  });
  const identities = new Set(sources.map(({ identity }) => `${identity.dev}:${identity.ino}`));
  if (identities.size !== sources.length) fail("regauge_transfer_sources_aliased");
  const staging = `${resolve(input.bundleRoot)}.staging-${randomBytes(8).toString("hex")}`;
  mkdirSync(join(staging, "resources"), { recursive: true, mode: 0o700 });
  try {
    const resources = sources.map(({ name, path }) => {
      assertFence();
      const snapshot = join(staging, `${name}.snapshot`);
      snapshotDatabase(path, snapshot);
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
    const body = {
      schemaVersion: 1 as const,
      kind: "mendpoint.regauge.state-transfer" as const,
      transferId: input.transferId,
      createdAt: input.createdAt,
      bindings: Object.freeze({ ...input.bindings }),
      fence: Object.freeze({ id: input.fenceId, markerSha256: initialFence.markerSha256, held: true as const }),
      resources: Object.freeze(resources),
    };
    const manifest: RegaugeTransferManifest = Object.freeze({
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
  const staging = join(targetParent, `.regauge-restore-${randomBytes(8).toString("hex")}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const resource of manifest.resources) {
      decryptAndVerifyResource(resolve(input.bundleRoot), join(staging, resource.name), manifest, resource, input.transferKey);
    }
    renameSync(staging, targetRoot);
    return manifest;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
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
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
      canonical(entries.map((entry) => entry.name).sort()) !== canonical([...REGAUGE_TRANSFER_DATABASES].sort())) {
    fail("regauge_transfer_target_extra_or_missing_resource");
  }
  for (const resource of manifest.resources) {
    const observed = inspectDatabase(join(targetRoot, resource.name), resource.name);
    if (canonical(evidenceComparable(observed)) !== canonical(evidenceComparable(resource))) {
      fail("regauge_transfer_target_evidence_mismatch");
    }
  }
  return manifest;
}

export function classifyRegaugeSourceRollback(input: Readonly<{
  importManifest: RegaugeTransferManifest;
  transferKey: Buffer;
  targetRoot: string;
  importActivity: RegaugeRollbackActivity;
  currentActivity: RegaugeRollbackActivity;
  assessedAt: string;
}>): RegaugeRollbackProof {
  assertKey(input.transferKey);
  assertIso(input.assessedAt);
  const manifest = validateManifest(input.importManifest);
  verifyAuthentication(manifest, input.transferKey);
  const currentTips = inspectRegaugeLedgerTips(input.targetRoot);
  const baselineTips = Object.fromEntries(manifest.resources.map((resource) => [resource.name, resource.ledgerTips]));
  const validActivity = (activity: RegaugeRollbackActivity) => Object.values(activity).every(
    (count) => Number.isSafeInteger(count) && count >= 0,
  );
  if (!validActivity(input.importActivity) || !validActivity(input.currentActivity) ||
      canonical(currentTips) !== canonical(baselineTips) ||
      input.currentActivity.providerObservationCount !== input.importActivity.providerObservationCount ||
      input.currentActivity.deliveryClaimCount !== input.importActivity.deliveryClaimCount ||
      input.currentActivity.authorityEventCount !== input.importActivity.authorityEventCount) {
    fail("regauge_rollback_replay_risk");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "mendpoint.regauge.rollback-proof" as const,
    transferId: manifest.transferId,
    fenceId: manifest.fence.id,
    assessedAt: input.assessedAt,
    reason: "target_unchanged_since_import" as const,
    manifestAuthentication: manifest.authentication.value,
    activity: Object.freeze({ ...input.currentActivity }),
    ledgerTipsSha256: sha256(canonical(currentTips)),
  };
  return Object.freeze({
    ...body,
    authentication: Object.freeze({
      algorithm: "hmac-sha256" as const,
      keyId: manifest.bindings.transferKeyId,
      value: createHmac("sha256", deriveKey(input.transferKey, "rollback"))
        .update(canonical(body)).digest("hex"),
    }),
  });
}

export function thawRegaugeCutoverFence(input: Readonly<{
  fenceRoot: string;
  fenceId: string;
  transferKey: Buffer;
  rollbackProof: RegaugeRollbackProof;
}>): void {
  assertKey(input.transferKey);
  const proof = input.rollbackProof;
  if (!proof || typeof proof !== "object") fail("regauge_rollback_proof_invalid");
  exactKeys(proof as unknown as Record<string, unknown>, [
    "schemaVersion", "kind", "transferId", "fenceId", "assessedAt", "reason",
    "manifestAuthentication", "activity", "ledgerTipsSha256", "authentication",
  ], "regauge_rollback_proof_invalid");
  if (proof.schemaVersion !== 1 || proof.kind !== "mendpoint.regauge.rollback-proof" ||
      proof.fenceId !== input.fenceId || proof.reason !== "target_unchanged_since_import" ||
      !/^[a-f0-9]{64}$/.test(proof.manifestAuthentication) ||
      !/^[a-f0-9]{64}$/.test(proof.ledgerTipsSha256)) fail("regauge_rollback_proof_invalid");
  assertIso(proof.assessedAt);
  const { authentication, ...body } = proof;
  if (!authentication || authentication.algorithm !== "hmac-sha256" ||
      !/^[a-f0-9]{64}$/.test(authentication.value)) fail("regauge_rollback_proof_invalid");
  const inspected = inspectRegaugeCutoverFence({
    fenceRoot: input.fenceRoot,
    fenceId: input.fenceId,
    transferKey: input.transferKey,
  });
  if (authentication.keyId !== inspected.fence.transferKeyId) fail("regauge_rollback_proof_invalid");
  const expected = Buffer.from(createHmac("sha256", deriveKey(input.transferKey, "rollback"))
    .update(canonical(body)).digest("hex"), "hex");
  const actual = Buffer.from(authentication.value, "hex");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    fail("regauge_rollback_proof_authentication_failed");
  }
  rmSync(fencePath(input.fenceRoot));
  rmSync(exclusiveFencePath(input.fenceRoot));
}
