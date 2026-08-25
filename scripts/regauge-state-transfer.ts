import { createHash, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import {
  acquireRegaugeCutoverFence,
  classifyRegaugeSourceRollback,
  createRegaugeStateTransfer,
  inspectRegaugeCutoverFence,
  parseCustomerBackupKey,
  restoreRegaugeStateTransfer,
  thawRegaugeCutoverFence,
  verifyRegaugeStateTransfer,
  verifyRestoredRegaugeState,
  type RegaugeRollbackProof,
  type RegaugeTransferBindings,
  type RegaugeTransferManifest,
} from "@mendpoint/ops";
import {
  createRcloneCustomerObjectStoreTransport,
  downloadCommittedCustomerBackup,
  loadCustomerBackupRecoveryReceipt,
  loadCustomerObjectStoreConfig,
  publishCustomerBackup,
  publishCustomerBackupRecoveryReceipt,
  resolveCommittedCustomerBackupPublication,
  resolveCustomerRestoreStagingPath,
  type CustomerObjectStoreConfig,
  type CustomerObjectStoreTransport,
} from "./customer-object-store.js";

export type RegaugeStateTransferCommand =
  | "freeze-export"
  | "verify"
  | "verify-receipt"
  | "restore"
  | "attest-restored"
  | "rollback-check"
  | "thaw"
  | "inspect-fence";

export type RegaugeStateTransferRuntime = Readonly<{
  transferId: string;
  createdAt: string;
  sourceRoot: string;
  targetRoot: string;
  fenceRoot: string;
  fenceId: string;
  transferKey: Buffer;
  transferKeyId: string;
  bindings: RegaugeTransferBindings;
  objectStore: CustomerObjectStoreConfig;
}>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`regauge_state_transfer_${name.toLowerCase()}_required`);
  return value;
}

function identifier(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!IDENTIFIER.test(value)) throw new Error(`regauge_state_transfer_${name.toLowerCase()}_invalid`);
  return value;
}

function absolutePath(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) throw new Error(`regauge_state_transfer_${name.toLowerCase()}_absolute_required`);
  return resolve(value);
}

function keyFingerprint(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

function assertDistinctKeys(transferKey: Buffer, applicationKey: Buffer, checkpointKey: Buffer): void {
  if (timingSafeEqual(transferKey, applicationKey) || timingSafeEqual(transferKey, checkpointKey)) {
    throw new Error("regauge_state_transfer_key_must_be_distinct");
  }
}

export function loadRegaugeStateTransferRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
): RegaugeStateTransferRuntime {
  const objectStore = loadCustomerObjectStoreConfig(env);
  const transferId = identifier(env, "MENDPOINT_REGAUGE_TRANSFER_ID");
  const transferKey = parseCustomerBackupKey(required(env, "MENDPOINT_REGAUGE_TRANSFER_KEY"));
  const applicationKey = parseCustomerBackupKey(required(env, "MENDPOINT_APPLICATION_DATA_KEY"));
  const checkpointKey = parseCustomerBackupKey(required(env, "MENDPOINT_REGAUGE_CHECKPOINT_KEY"));
  assertDistinctKeys(transferKey, applicationKey, checkpointKey);
  const transferKeyId = identifier(env, "MENDPOINT_REGAUGE_TRANSFER_KEY_ID");
  const sourceRoot = absolutePath(env, "MENDPOINT_BACKUP_SOURCE_ROOT");
  const targetRoot = absolutePath(env, "MENDPOINT_REGAUGE_TRANSFER_TARGET_ROOT");
  const fenceRoot = absolutePath(env, "MENDPOINT_BACKUP_FENCE_ROOT");
  const fenceId = identifier(env, "MENDPOINT_REGAUGE_TRANSFER_FENCE_ID");
  const createdAt = now.toISOString();
  const bindings = Object.freeze({
    tenantId: identifier(env, "MENDPOINT_REGAUGE_TENANT_ID"),
    campaignId: identifier(env, "MENDPOINT_REGAUGE_CAMPAIGN_ID"),
    sourceApp: identifier(env, "MENDPOINT_REGAUGE_SOURCE_APP"),
    sourceVolume: identifier(env, "MENDPOINT_REGAUGE_SOURCE_VOLUME"),
    sourceRevision: identifier(env, "MENDPOINT_REGAUGE_SOURCE_REVISION"),
    targetApp: identifier(env, "MENDPOINT_REGAUGE_TARGET_APP"),
    targetVolume: identifier(env, "MENDPOINT_REGAUGE_TARGET_VOLUME"),
    objectBucket: objectStore.bucket,
    objectPrefix: `${objectStore.basePrefix}/${transferId}`,
    transferKeyId,
    applicationDataKeyId: keyFingerprint(applicationKey),
    checkpointKeyId: keyFingerprint(checkpointKey),
  });
  return Object.freeze({
    transferId,
    createdAt,
    sourceRoot,
    targetRoot,
    fenceRoot,
    fenceId,
    transferKey,
    transferKeyId,
    bindings,
    objectStore,
  });
}

function assertExpectedBindings(
  manifest: RegaugeTransferManifest,
  expected: RegaugeTransferBindings,
): void {
  for (const name of Object.keys(expected) as Array<keyof RegaugeTransferBindings>) {
    if (manifest.bindings[name] !== expected[name]) {
      throw new Error(`regauge_state_transfer_binding_mismatch:${name}`);
    }
  }
}

async function downloadTransfer(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<{ bundleRoot: string; manifest: RegaugeTransferManifest }> {
  const publication = await resolveCommittedCustomerBackupPublication({
    backupId: runtime.transferId,
    key: runtime.transferKey,
    config: runtime.objectStore,
  }, transport);
  const bundleRoot = resolveCustomerRestoreStagingPath(
    runtime.objectStore.stagingRoot,
    `download-${runtime.transferId}`,
  );
  rmSync(bundleRoot, { recursive: true, force: true });
  try {
    await downloadCommittedCustomerBackup({
      publication,
      key: runtime.transferKey,
      destination: bundleRoot,
    }, transport);
    const manifest = verifyRegaugeStateTransfer({ bundleRoot, transferKey: runtime.transferKey });
    assertExpectedBindings(manifest, runtime.bindings);
    return { bundleRoot, manifest };
  } catch (error) {
    rmSync(bundleRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function freezeAndExportRegaugeState(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<Record<string, unknown>> {
  const bundleRoot = resolveCustomerRestoreStagingPath(runtime.objectStore.stagingRoot, runtime.transferId);
  rmSync(bundleRoot, { recursive: true, force: true });
  acquireRegaugeCutoverFence({
    fenceRoot: runtime.fenceRoot,
    fenceId: runtime.fenceId,
    transferId: runtime.transferId,
    createdAt: runtime.createdAt,
    sourceApp: runtime.bindings.sourceApp,
    sourceVolume: runtime.bindings.sourceVolume,
    transferKeyId: runtime.transferKeyId,
    transferKey: runtime.transferKey,
  });
  try {
    const manifest = createRegaugeStateTransfer({
      transferId: runtime.transferId,
      createdAt: runtime.createdAt,
      sourceRoot: runtime.sourceRoot,
      bundleRoot,
      bindings: runtime.bindings,
      transferKey: runtime.transferKey,
      fenceRoot: runtime.fenceRoot,
      fenceId: runtime.fenceId,
    });
    const publication = await publishCustomerBackup({
      localBackupRoot: bundleRoot,
      backupId: runtime.transferId,
      manifestAuthentication: manifest.authentication.value,
      key: runtime.transferKey,
      config: runtime.objectStore,
      publishedAt: new Date().toISOString(),
    }, transport);
    return Object.freeze({
      transferId: manifest.transferId,
      createdAt: manifest.createdAt,
      manifestAuthentication: manifest.authentication.value,
      fenceId: manifest.fence.id,
      resources: manifest.resources.map(({ name, plaintextSha256, schemaSha256, tableRowCounts, ledgerTips }) => ({
        name, plaintextSha256, schemaSha256, tableRowCounts, ledgerTips,
      })),
      publication,
    });
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}

export async function verifyPublishedRegaugeState(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<Record<string, unknown>> {
  const downloaded = await downloadTransfer(runtime, transport);
  try {
    return Object.freeze({
      transferId: downloaded.manifest.transferId,
      manifestAuthentication: downloaded.manifest.authentication.value,
      resources: downloaded.manifest.resources.map(({ name, plaintextSha256, schemaSha256 }) => ({
        name, plaintextSha256, schemaSha256,
      })),
    });
  } finally {
    rmSync(downloaded.bundleRoot, { recursive: true, force: true });
  }
}

export async function restorePublishedRegaugeState(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<Record<string, unknown>> {
  const downloaded = await downloadTransfer(runtime, transport);
  try {
    const manifest = restoreRegaugeStateTransfer({
      bundleRoot: downloaded.bundleRoot,
      targetRoot: runtime.targetRoot,
      transferKey: runtime.transferKey,
    });
    const publication = await resolveCommittedCustomerBackupPublication({
      backupId: runtime.transferId,
      key: runtime.transferKey,
      config: runtime.objectStore,
    }, transport);
    const receipt = await publishCustomerBackupRecoveryReceipt({
      backupId: runtime.transferId,
      keyId: runtime.transferKeyId,
      verifiedAt: new Date().toISOString(),
      manifestAuthentication: manifest.authentication.value,
      publication,
      key: runtime.transferKey,
      config: runtime.objectStore,
    }, transport);
    return Object.freeze({
      transferId: manifest.transferId,
      targetRoot: runtime.targetRoot,
      manifestAuthentication: manifest.authentication.value,
      recoveryReceiptDigest: receipt.integrity.digest,
      resources: manifest.resources.map(({ name, plaintextSha256, schemaSha256, tableRowCounts, ledgerTips }) => ({
        name, plaintextSha256, schemaSha256, tableRowCounts, ledgerTips,
      })),
    });
  } finally {
    rmSync(downloaded.bundleRoot, { recursive: true, force: true });
  }
}

export async function verifyRegaugeRestoreReceipt(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<Record<string, unknown>> {
  const receipt = await loadCustomerBackupRecoveryReceipt({
    backupId: runtime.transferId,
    keyId: runtime.transferKeyId,
    key: runtime.transferKey,
    config: runtime.objectStore,
  }, transport);
  const downloaded = await downloadTransfer(runtime, transport);
  try {
    if (receipt.manifestAuthentication !== downloaded.manifest.authentication.value ||
        receipt.publication.commitDigest.length !== 64) {
      throw new Error("regauge_state_transfer_recovery_receipt_mismatch");
    }
    return Object.freeze({
      transferId: runtime.transferId,
      verifiedAt: receipt.verifiedAt,
      manifestAuthentication: receipt.manifestAuthentication,
      recoveryReceiptDigest: receipt.integrity.digest,
      targetApp: downloaded.manifest.bindings.targetApp,
      targetVolume: downloaded.manifest.bindings.targetVolume,
      resources: downloaded.manifest.resources.map(({ name, plaintextSha256, schemaSha256 }) => ({
        name, plaintextSha256, schemaSha256,
      })),
    });
  } finally {
    rmSync(downloaded.bundleRoot, { recursive: true, force: true });
  }
}

export async function attestRestoredRegaugeState(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<Record<string, unknown>> {
  const downloaded = await downloadTransfer(runtime, transport);
  try {
    const manifest = verifyRestoredRegaugeState({
      targetRoot: runtime.targetRoot,
      importManifest: downloaded.manifest,
      transferKey: runtime.transferKey,
    });
    const publication = await resolveCommittedCustomerBackupPublication({
      backupId: runtime.transferId,
      key: runtime.transferKey,
      config: runtime.objectStore,
    }, transport);
    const verifiedAt = new Date().toISOString();
    const receipt = await publishCustomerBackupRecoveryReceipt({
      backupId: runtime.transferId,
      keyId: runtime.transferKeyId,
      verifiedAt,
      manifestAuthentication: manifest.authentication.value,
      publication,
      key: runtime.transferKey,
      config: runtime.objectStore,
    }, transport);
    return Object.freeze({
      transferId: runtime.transferId,
      targetRoot: runtime.targetRoot,
      manifestAuthentication: manifest.authentication.value,
      recoveryReceiptDigest: receipt.integrity.digest,
      attested: true,
      verifiedAt,
      sourceRevision: manifest.bindings.sourceRevision,
      targetApp: manifest.bindings.targetApp,
      targetVolume: manifest.bindings.targetVolume,
    });
  } finally {
    rmSync(downloaded.bundleRoot, { recursive: true, force: true });
  }
}

export async function createRegaugeRollbackProof(
  runtime: RegaugeStateTransferRuntime,
  transport: CustomerObjectStoreTransport,
): Promise<RegaugeRollbackProof> {
  const downloaded = await downloadTransfer(runtime, transport);
  try {
    return classifyRegaugeSourceRollback({
      importManifest: downloaded.manifest,
      transferKey: runtime.transferKey,
      targetRoot: runtime.targetRoot,
      fenceRoot: runtime.fenceRoot,
      assessedAt: new Date().toISOString(),
    });
  } finally {
    rmSync(downloaded.bundleRoot, { recursive: true, force: true });
  }
}

function parseRollbackProof(value: string | undefined): RegaugeRollbackProof {
  try { return JSON.parse(value ?? "") as RegaugeRollbackProof; }
  catch { throw new Error("regauge_state_transfer_rollback_proof_invalid"); }
}

export async function runRegaugeStateTransferCommand(
  command: RegaugeStateTransferCommand,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now = new Date(),
  providedTransport?: CustomerObjectStoreTransport,
): Promise<Record<string, unknown> | RegaugeRollbackProof> {
  const runtime = loadRegaugeStateTransferRuntime(env, now);
  const transport = providedTransport ?? createRcloneCustomerObjectStoreTransport(runtime.objectStore, process.env);
  if (command === "freeze-export") return await freezeAndExportRegaugeState(runtime, transport);
  if (command === "verify") return await verifyPublishedRegaugeState(runtime, transport);
  if (command === "verify-receipt") return await verifyRegaugeRestoreReceipt(runtime, transport);
  if (command === "restore") return await restorePublishedRegaugeState(runtime, transport);
  if (command === "attest-restored") return await attestRestoredRegaugeState(runtime, transport);
  if (command === "rollback-check") {
    return await createRegaugeRollbackProof(runtime, transport);
  }
  if (command === "thaw") {
    thawRegaugeCutoverFence({
      fenceRoot: runtime.fenceRoot,
      fenceId: runtime.fenceId,
      transferId: runtime.transferId,
      transferKey: runtime.transferKey,
      rollbackProof: parseRollbackProof(env.MENDPOINT_REGAUGE_ROLLBACK_PROOF_JSON),
    });
    return Object.freeze({ transferId: runtime.transferId, fenceId: runtime.fenceId, thawed: true });
  }
  const inspected = inspectRegaugeCutoverFence({
    fenceRoot: runtime.fenceRoot,
    fenceId: runtime.fenceId,
    transferKey: runtime.transferKey,
  });
  return Object.freeze({
    transferId: runtime.transferId,
    fenceId: inspected.fence.fenceId,
    sourceApp: inspected.fence.sourceApp,
    sourceVolume: inspected.fence.sourceVolume,
    markerSha256: inspected.markerSha256,
    held: true,
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] as RegaugeStateTransferCommand | undefined;
  if (!command || !["freeze-export", "verify", "verify-receipt", "restore", "attest-restored", "rollback-check", "thaw", "inspect-fence"].includes(command)) {
    throw new Error("regauge_state_transfer_command_invalid");
  }
  const result = await runRegaugeStateTransferCommand(command);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "regauge_state_transfer_failed");
    process.exitCode = 1;
  });
}
