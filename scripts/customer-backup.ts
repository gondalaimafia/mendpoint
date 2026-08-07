import {
  createApplicationConsistentBackup,
  customerBackupInputFromEnv,
  prepareCustomerBackupDirectories,
  recordLastVerifiedBackupEvidence,
  verifyBackupBundle,
} from "@mendpoint/ops";

async function main(): Promise<void> {
  const input = customerBackupInputFromEnv();
  prepareCustomerBackupDirectories(input);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    process.setgid(1000);
    process.setuid(1000);
  }
  const manifest = await createApplicationConsistentBackup(input);
  const verification = verifyBackupBundle(input.backupRoot, manifest, input.key);
  if (!verification.ok) {
    throw new Error(`customer_backup_verification_failed:${verification.issues.join(",")}`);
  }
  recordLastVerifiedBackupEvidence({
    evidencePath: input.evidencePath!,
    key: input.key,
    keyId: input.keyId,
    backupId: manifest.backupId,
    backupRoot: input.backupRoot,
    createdAt: manifest.createdAt,
    verifiedAt: new Date().toISOString(),
    manifestAuthentication: manifest.integrity.digest,
  });
  console.log(JSON.stringify({
    backupId: manifest.backupId,
    backupRoot: input.backupRoot,
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "customer_backup_failed");
  process.exitCode = 1;
});
