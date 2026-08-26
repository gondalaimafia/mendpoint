const RELEASE_REVISION = /^[a-f0-9]{40}$/;

export function resolveCustomerBackupReleaseAuthority(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const expected = env.MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION?.trim() ?? "";
  if (!RELEASE_REVISION.test(expected)) {
    throw new Error("customer_backup_expected_release_revision_invalid");
  }
  const actual = env.MENDPOINT_RELEASE_REVISION?.trim() ?? "";
  if (!RELEASE_REVISION.test(actual)) {
    throw new Error("customer_backup_release_revision_invalid");
  }
  if (actual !== expected) {
    throw new Error("customer_backup_release_revision_mismatch");
  }
  return actual;
}
