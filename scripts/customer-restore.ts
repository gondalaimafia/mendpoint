import { isAbsolute, join } from "node:path";
import { chmodSync, chownSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import {
  loadAuthenticatedBackupManifest,
  loadAuthenticatedLastVerifiedBackupEvidence,
  parseCustomerBackupKey,
  restoreBackupAtomically,
  validateCustomerRestorePathSafety,
} from "@mendpoint/ops";
import {
  createRcloneCustomerObjectStoreTransport,
  downloadCommittedCustomerBackup,
  loadCustomerBackupRecoveryReceipt,
  loadCustomerObjectStoreConfig,
  resolveCustomerRestoreStagingPath,
} from "./customer-object-store.js";

async function main(): Promise<void> {
if (process.env.MENDPOINT_DEPLOYMENT_PROFILE !== "customer") {
  throw new Error("customer_restore_profile_required");
}
const key = parseCustomerBackupKey(process.env.MENDPOINT_BACKUP_KEY);
const expectedKeyId = process.env.MENDPOINT_BACKUP_KEY_ID?.trim();
if (!expectedKeyId) throw new Error("customer_backup_key_id_required");
const objectStore = loadCustomerObjectStoreConfig(process.env);
const transport = createRcloneCustomerObjectStoreTransport(objectStore, process.env);
const requestedBackupId = process.env.MENDPOINT_RESTORE_BACKUP_ID?.trim();
const evidence = requestedBackupId
  ? await loadCustomerBackupRecoveryReceipt({
      backupId: requestedBackupId,
      key,
      keyId: expectedKeyId,
      config: objectStore,
    }, transport)
  : loadAuthenticatedLastVerifiedBackupEvidence(process.env);
const publication = "publication" in evidence ? evidence.publication : undefined;
if (!publication) throw new Error("customer_restore_object_publication_required");
const stagingParent = process.env.MENDPOINT_RESTORE_STAGING_ROOT?.trim() || "/tmp/mendpoint-restore";
const backupRoot = resolveCustomerRestoreStagingPath(stagingParent, evidence.backupId);
const targetRoot = process.env.MENDPOINT_RESTORE_TARGET_ROOT?.trim() ?? "";
if (!targetRoot || !isAbsolute(targetRoot)) throw new Error("customer_restore_target_root_absolute_required");
const safePaths = validateCustomerRestorePathSafety({
  backupRoot,
  targetRoot,
  dataRoot: process.env.MENDPOINT_DATA_DIR,
  sourceRoot: process.env.MENDPOINT_BACKUP_SOURCE_ROOT,
});
rmSync(safePaths.backupRoot, { recursive: true, force: true });
try {
await downloadCommittedCustomerBackup({
  publication,
  key,
  destination: safePaths.backupRoot,
}, transport);
const restoreParent = safePaths.targetParent;
mkdirSync(restoreParent, { recursive: true, mode: 0o700 });
if (typeof process.getuid === "function" && process.getuid() === 0) {
  const chownTree = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("customer_restore_staging_symlink_rejected");
    chownSync(path, 1000, 1000);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) chownTree(join(path, entry));
    }
  };
  chownTree(safePaths.backupRoot);
  chownSync(restoreParent, 1000, 1000);
  chmodSync(restoreParent, 0o700);
  process.setgid(1000);
  process.setuid(1000);
}
  const manifest = loadAuthenticatedBackupManifest(safePaths.backupRoot, key);
  if (manifest.integrity.keyId !== expectedKeyId) throw new Error("customer_restore_key_id_mismatch");
  const restored = restoreBackupAtomically({
    backupRoot: safePaths.backupRoot,
    targetRoot: safePaths.targetRoot,
    manifest,
    key,
  });
  console.log(JSON.stringify({
    backupId: manifest.backupId,
    targetRoot: safePaths.targetRoot,
    keyId: manifest.integrity.keyId,
    ...restored,
  }, null, 2));
} finally {
  rmSync(safePaths.backupRoot, { recursive: true, force: true });
}
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "customer_restore_failed");
  process.exitCode = 1;
});
