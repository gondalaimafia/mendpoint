import { isAbsolute } from "node:path";
import { chmodSync, chownSync, mkdirSync } from "node:fs";
import {
  loadAuthenticatedBackupManifest,
  parseCustomerBackupKey,
  restoreBackupAtomically,
  validateCustomerRestorePathSafety,
} from "@mendpoint/ops";

if (process.env.MENDPOINT_DEPLOYMENT_PROFILE !== "customer") {
  throw new Error("customer_restore_profile_required");
}
const backupRoot = process.env.MENDPOINT_RESTORE_BACKUP_ROOT?.trim() ?? "";
const targetRoot = process.env.MENDPOINT_RESTORE_TARGET_ROOT?.trim() ?? "";
if (!backupRoot || !isAbsolute(backupRoot)) throw new Error("customer_restore_backup_root_absolute_required");
if (!targetRoot || !isAbsolute(targetRoot)) throw new Error("customer_restore_target_root_absolute_required");
const safePaths = validateCustomerRestorePathSafety({
  backupRoot,
  targetRoot,
  dataRoot: process.env.MENDPOINT_DATA_DIR,
  sourceRoot: process.env.MENDPOINT_BACKUP_SOURCE_ROOT,
});
const key = parseCustomerBackupKey(process.env.MENDPOINT_BACKUP_KEY);
const expectedKeyId = process.env.MENDPOINT_BACKUP_KEY_ID?.trim();
if (!expectedKeyId) throw new Error("customer_backup_key_id_required");
const restoreParent = safePaths.targetParent;
mkdirSync(restoreParent, { recursive: true, mode: 0o700 });
if (typeof process.getuid === "function" && process.getuid() === 0) {
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
