import { rmSync } from "node:fs";

import {
  createLastVerifiedBackupEvidence,
  createApplicationConsistentBackup,
  customerBackupInputFromEnv,
  prepareCustomerBackupDirectories,
  recordLastVerifiedBackupEvidence,
  verifyBackupBundle,
} from "@mendpoint/ops";
import {
  createRcloneCustomerObjectStoreTransport,
  loadCustomerObjectStoreConfig,
  publishCustomerBackup,
  publishCustomerBackupRecoveryReceipt,
} from "./customer-object-store.js";

async function main(): Promise<void> {
  const input = customerBackupInputFromEnv();
  const objectStore = loadCustomerObjectStoreConfig(process.env);
  const transport = createRcloneCustomerObjectStoreTransport(objectStore, process.env);
  prepareCustomerBackupDirectories(input);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    process.setgid(1000);
    process.setuid(1000);
  }
  try {
    const manifest = await createApplicationConsistentBackup(input);
    const verification = verifyBackupBundle(input.backupRoot, manifest, input.key);
    if (!verification.ok) {
      throw new Error(`customer_backup_verification_failed:${verification.issues.join(",")}`);
    }
    const publishedAt = new Date().toISOString();
    const publication = await publishCustomerBackup({
      localBackupRoot: input.backupRoot,
      backupId: manifest.backupId,
      manifestAuthentication: manifest.integrity.digest,
      key: input.key,
      config: objectStore,
      publishedAt,
    }, transport);
    const evidence = createLastVerifiedBackupEvidence({
      key: input.key,
      keyId: input.keyId,
      backupId: manifest.backupId,
      backupRoot: input.backupRoot,
      createdAt: manifest.createdAt,
      verifiedAt: publishedAt,
      manifestAuthentication: manifest.integrity.digest,
      publication,
    });
    await publishCustomerBackupRecoveryReceipt({
      backupId: evidence.backupId,
      keyId: evidence.keyId,
      verifiedAt: evidence.verifiedAt,
      manifestAuthentication: evidence.manifestAuthentication,
      publication,
      key: input.key,
      config: objectStore,
    }, transport);
    recordLastVerifiedBackupEvidence({
      evidencePath: input.evidencePath!,
      key: input.key,
      keyId: input.keyId,
      backupId: manifest.backupId,
      backupRoot: input.backupRoot,
      createdAt: manifest.createdAt,
      verifiedAt: publishedAt,
      manifestAuthentication: manifest.integrity.digest,
      publication,
    });
    console.log(JSON.stringify({
      backupId: manifest.backupId,
      publication,
      createdAt: manifest.createdAt,
      manifestAuthentication: manifest.integrity.digest,
      keyId: manifest.integrity.keyId,
      resources: manifest.resources.map((resource) => ({
        kind: resource.kind,
        sha256: resource.sha256,
        sizeBytes: resource.sizeBytes,
        fileCount: resource.fileCount,
      })),
    }, null, 2));
  } finally {
    rmSync(input.backupRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "customer_backup_failed");
  process.exitCode = 1;
});
