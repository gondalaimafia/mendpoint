import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const authorityPath = resolve(root, "scripts/customer-backup-release-authority.ts");

async function resolveAuthority(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  expect(existsSync(authorityPath), "release-authority helper must exist").toBe(true);
  const module = await import(pathToFileURL(authorityPath).href) as {
    resolveCustomerBackupReleaseAuthority: (
      value: Readonly<Record<string, string | undefined>>,
    ) => string;
  };
  return module.resolveCustomerBackupReleaseAuthority(env);
}

describe("customer backup release authority", () => {
  it("rejects a missing expected or actual release revision", async () => {
    const revision = "a".repeat(40);
    await expect(resolveAuthority({ MENDPOINT_RELEASE_REVISION: revision }))
      .rejects.toThrow("customer_backup_expected_release_revision_invalid");
    await expect(resolveAuthority({ MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: revision }))
      .rejects.toThrow("customer_backup_release_revision_invalid");
  });

  it("rejects malformed expected and actual release revisions", async () => {
    const revision = "a".repeat(40);
    await expect(resolveAuthority({
      MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: "main",
      MENDPOINT_RELEASE_REVISION: revision,
    })).rejects.toThrow("customer_backup_expected_release_revision_invalid");
    await expect(resolveAuthority({
      MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: revision,
      MENDPOINT_RELEASE_REVISION: "A".repeat(40),
    })).rejects.toThrow("customer_backup_release_revision_invalid");
  });

  it("accepts canonical 64 character release identities without weakening exact matching", async () => {
    const revision = "c".repeat(64);
    await expect(resolveAuthority({
      MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: revision,
      MENDPOINT_RELEASE_REVISION: revision,
    })).resolves.toBe(revision);
    await expect(resolveAuthority({
      MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: revision,
      MENDPOINT_RELEASE_REVISION: "d".repeat(64),
    })).rejects.toThrow("customer_backup_release_revision_mismatch");
  });

  it("requires the manual entrypoint to receive explicit release authority", () => {
    const producer = readFileSync(resolve(root, "scripts/customer-backup.ts"), "utf8");
    expect(producer).toContain("--expected-release");
    expect(producer).not.toContain("resolveCustomerBackupReleaseAuthority(process.env)");
  });

  it("rejects a stale live release and returns only an exact match", async () => {
    await expect(resolveAuthority({
      MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: "a".repeat(40),
      MENDPOINT_RELEASE_REVISION: "b".repeat(40),
    })).rejects.toThrow("customer_backup_release_revision_mismatch");
    await expect(resolveAuthority({
      MENDPOINT_EXPECTED_BACKUP_RELEASE_REVISION: "c".repeat(40),
      MENDPOINT_RELEASE_REVISION: "c".repeat(40),
    })).resolves.toBe("c".repeat(40));
  });

  it("enforces release authority before the backup entrypoint is resolved", () => {
    const producer = readFileSync(resolve(root, "scripts/customer-backup.ts"), "utf8");
    const authority = producer.indexOf(
      "const releaseRevision = resolveCustomerBackupReleaseAuthority({",
    );
    const input = producer.indexOf("customerBackupInputFromEnv()");
    expect(authority).toBeGreaterThanOrEqual(0);
    expect(authority).toBeLessThan(input);
    expect(producer).toContain("releaseRevision,");
    expect(producer).not.toContain(
      'releaseRevision: process.env.MENDPOINT_RELEASE_REVISION?.trim() ?? ""',
    );
  });
});
