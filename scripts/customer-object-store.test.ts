import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  customerObjectStoreProcessEnv,
  downloadCommittedCustomerBackup,
  loadCustomerBackupRecoveryReceipt,
  loadCustomerObjectStoreConfig,
  probeCustomerObjectStore,
  publishCustomerBackup,
  publishCustomerBackupRecoveryReceipt,
  resolveCustomerRestoreStagingPath,
  type CustomerObjectStoreTransport,
} from "./customer-object-store.js";
import { createObjectBackupCommit, verifyObjectBackupCommit } from "@mendpoint/ops";

const roots: string[] = [];
const key = Buffer.alloc(32, 0x5a);

class MemoryTransport implements CustomerObjectStoreTransport {
  readonly objects = new Map<string, Buffer>();
  readonly calls: string[] = [];

  async put(remote: string, body: Buffer): Promise<void> {
    this.calls.push(`put:${remote}`);
    if (this.objects.has(remote)) throw new Error("remote_object_exists");
    this.objects.set(remote, Buffer.from(body));
  }
  async read(remote: string): Promise<Buffer> {
    this.calls.push(`read:${remote}`);
    const body = this.objects.get(remote);
    if (!body) throw new Error("remote_object_missing");
    return Buffer.from(body);
  }
  async remove(remote: string): Promise<void> {
    this.calls.push(`remove:${remote}`);
    this.objects.delete(remote);
  }
  async list(prefix: string): Promise<readonly string[]> {
    this.calls.push(`list:${prefix}`);
    return [...this.objects.keys()].filter((name) => name.startsWith(prefix));
  }
  async uploadDirectory(localRoot: string, remotePrefix: string): Promise<void> {
    this.calls.push(`upload:${remotePrefix}`);
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else this.objects.set(`${remotePrefix}/${relative(localRoot, path).replaceAll("\\", "/")}`, readFileSync(path));
      }
    };
    visit(localRoot);
  }
  async verifyDirectory(localRoot: string, remotePrefix: string): Promise<void> {
    this.calls.push(`verify:${remotePrefix}`);
    const manifest = readFileSync(join(localRoot, "manifest.json"));
    expect(this.objects.get(`${remotePrefix}/manifest.json`)).toEqual(manifest);
  }
  async downloadDirectory(remotePrefix: string, localRoot: string): Promise<void> {
    this.calls.push(`download:${remotePrefix}`);
    for (const [remote, body] of this.objects) {
      if (!remote.startsWith(`${remotePrefix}/`)) continue;
      const local = resolve(localRoot, remote.slice(remotePrefix.length + 1));
      mkdirSync(resolve(local, ".."), { recursive: true });
      writeFileSync(local, body);
    }
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config() {
  return loadCustomerObjectStoreConfig({
    MENDPOINT_BACKUP_TRANSPORT: "rclone_s3",
    MENDPOINT_BACKUP_STAGING_ROOT: "/tmp/mendpoint-backups",
    MENDPOINT_BACKUP_OBJECT_PREFIX: "backups",
    BUCKET_NAME: "customer-bucket",
    AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
    AWS_REGION: "auto",
    AWS_ACCESS_KEY_ID: "access",
    AWS_SECRET_ACCESS_KEY: "secret",
  });
}

describe("customer object store", () => {
  it("pins rclone to no configuration file so the privilege drop cannot break the transport", () => {
    // customer-backup.ts builds this config as root and then drops to uid 1000 while forwarding
    // the root HOME, so any rclone call that still resolves a configuration file from HOME dies
    // with EACCES on /root/.rclone.conf. The remote is fully specified by these args instead.
    expect(config().connectionArgs).toEqual([
      "--config", "/dev/null",
      "--s3-provider", "Other",
      "--s3-env-auth",
      "--s3-endpoint", "https://fly.storage.tigris.dev",
      "--s3-region", "auto",
    ]);
    const configIndex = config().connectionArgs.indexOf("--config");
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(config().connectionArgs[configIndex + 1]).toBe("/dev/null");
    expect(customerObjectStoreProcessEnv({ HOME: "/root" }).HOME).toBe("/root");
  });

  it("scopes credentials to rclone and proves startup write, read, and delete", async () => {
    const env = customerObjectStoreProcessEnv({
      PATH: "safe-path",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      GITHUB_APP_PRIVATE_KEY: "must-not-leak",
      MENDPOINT_BACKUP_KEY: "must-not-leak",
    });
    expect(env).toMatchObject({ PATH: "safe-path", AWS_ACCESS_KEY_ID: "access", AWS_SECRET_ACCESS_KEY: "secret" });
    expect(env.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(env.MENDPOINT_BACKUP_KEY).toBeUndefined();
    expect(() => loadCustomerObjectStoreConfig({
      MENDPOINT_BACKUP_TRANSPORT: "rclone_s3",
      MENDPOINT_BACKUP_STAGING_ROOT: parse(process.cwd()).root,
      MENDPOINT_BACKUP_OBJECT_PREFIX: "backups",
      BUCKET_NAME: "customer-bucket",
      AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    })).toThrow("customer_backup_staging_root_unsafe");
    expect(config().operationTimeoutMs).toBe(4 * 60 * 60 * 1_000);
    expect(() => loadCustomerObjectStoreConfig({
      MENDPOINT_BACKUP_TRANSPORT: "rclone_s3",
      MENDPOINT_BACKUP_STAGING_ROOT: "/tmp/mendpoint-backups",
      MENDPOINT_BACKUP_OBJECT_PREFIX: "backups",
      MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS: "59999",
      BUCKET_NAME: "customer-bucket",
      AWS_ENDPOINT_URL_S3: "https://fly.storage.tigris.dev",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    })).toThrow("customer_backup_operation_timeout_invalid");

    const transport = new MemoryTransport();
    await probeCustomerObjectStore(config(), transport, { machineId: "machine-1", nonce: "probe-1" });
    expect(transport.calls).toEqual([
      "put:readiness/machine-1/probe-1",
      "read:readiness/machine-1/probe-1",
      "remove:readiness/machine-1/probe-1",
    ]);
  });

  it("publishes an authenticated commit last and restores only a committed prefix", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-object-backup-"));
    roots.push(root);
    writeFileSync(join(root, "manifest.json"), '{"backupId":"backup-1"}\n');
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "000.bin"), "ciphertext");
    const manifestAuthentication = "a".repeat(64);
    const transport = new MemoryTransport();
    const publication = await publishCustomerBackup({
      localBackupRoot: root,
      backupId: "backup-1",
      manifestAuthentication,
      key,
      config: config(),
      publishedAt: "2026-08-10T12:00:00.000Z",
    }, transport);

    expect(transport.calls.at(-2)).toBe("put:backups/backup-1/commit.json");
    expect(transport.calls.at(-1)).toBe("read:backups/backup-1/commit.json");
    expect(publication.commitDigest).toMatch(/^[a-f0-9]{64}$/);
    const storedCommit = JSON.parse(
      transport.objects.get("backups/backup-1/commit.json")!.toString("utf8"),
    ) as { objectCount: number };
    expect(storedCommit.objectCount).toBe(2);
    const restoreRoot = join(root, "restore-download");
    await downloadCommittedCustomerBackup({ publication, key, destination: restoreRoot }, transport);
    expect(readFileSync(join(restoreRoot, "manifest.json"), "utf8")).toContain("backup-1");
    expect(() => readFileSync(join(restoreRoot, "commit.json"))).toThrow();

    transport.objects.set("backups/backup-1/uncommitted-extra.bin", Buffer.from("extra"));
    await expect(downloadCommittedCustomerBackup({
      publication,
      key,
      destination: join(root, "summary-mismatch"),
    }, transport)).rejects.toThrow("customer_backup_download_summary_mismatch");
    await expect(downloadCommittedCustomerBackup({
      publication: { ...publication, bucket: "different-bucket" },
      key,
      destination: join(root, "mismatched-locator"),
    }, transport)).rejects.toThrow("customer_backup_remote_commit_locator_mismatch");

    const uncommitted = new MemoryTransport();
    uncommitted.objects.set("backups/backup-2/manifest.json", Buffer.from("{}"));
    await expect(downloadCommittedCustomerBackup({
      publication: { ...publication, prefix: "backups/backup-2" },
      key,
      destination: join(root, "uncommitted"),
    }, uncommitted)).rejects.toThrow("remote_object_missing");
  });

  it("detects commit tampering", () => {
    const commit = createObjectBackupCommit({
      backupId: "backup-1",
      bucket: "customer-bucket",
      prefix: "backups/backup-1",
      endpointOrigin: "https://fly.storage.tigris.dev",
      manifestSha256: createHash("sha256").update("manifest").digest("hex"),
      manifestAuthentication: "a".repeat(64),
      objectCount: 2,
      sizeBytes: 10,
      publishedAt: "2026-08-10T12:00:00.000Z",
    }, key);
    expect(commit.integrity.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyObjectBackupCommit({
      ...commit,
      integrity: { ...commit.integrity, algorithm: "sha256" as "hmac-sha256" },
    }, key)).toEqual({
      ok: false,
      issues: ["object_backup_commit_integrity_algorithm_invalid"],
    });
  });

  it("restores publication authority from a signed remote receipt after local loss", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-object-receipt-"));
    roots.push(root);
    writeFileSync(join(root, "manifest.json"), '{"backupId":"backup-receipt"}\n');
    mkdirSync(join(root, "resources"));
    writeFileSync(join(root, "resources", "000.bin"), "ciphertext");
    const transport = new MemoryTransport();
    const publication = await publishCustomerBackup({
      localBackupRoot: root,
      backupId: "backup-receipt",
      manifestAuthentication: "b".repeat(64),
      key,
      config: config(),
      publishedAt: "2026-08-10T12:00:00.000Z",
    }, transport);
    await publishCustomerBackupRecoveryReceipt({
      backupId: "backup-receipt",
      keyId: "customer-key-v1",
      verifiedAt: "2026-08-10T12:01:00.000Z",
      manifestAuthentication: "b".repeat(64),
      publication,
      key,
      config: config(),
    }, transport);

    rmSync(root, { recursive: true, force: true });
    const receipt = await loadCustomerBackupRecoveryReceipt({
      backupId: "backup-receipt",
      keyId: "customer-key-v1",
      key,
      config: config(),
    }, transport);
    expect(receipt.publication).toEqual(publication);

    const receiptPath = "backups-verified/backup-receipt.json";
    const tampered = JSON.parse(transport.objects.get(receiptPath)!.toString("utf8")) as {
      verifiedAt: string;
    };
    tampered.verifiedAt = "2026-08-11T12:01:00.000Z";
    transport.objects.set(receiptPath, Buffer.from(JSON.stringify(tampered)));
    await expect(loadCustomerBackupRecoveryReceipt({
      backupId: "backup-receipt",
      keyId: "customer-key-v1",
      key,
      config: config(),
    }, transport)).rejects.toThrow("object_backup_recovery_receipt_authentication_failed");
  });

  it("rejects unsafe restore staging roots before a recursive cleanup can run", () => {
    const filesystemRoot = parse(process.cwd()).root;
    expect(() => resolveCustomerRestoreStagingPath(filesystemRoot, "backup-1"))
      .toThrow("customer_restore_staging_root_unsafe");
    expect(() => resolveCustomerRestoreStagingPath(join(filesystemRoot, "tmp"), "backup-1"))
      .toThrow("customer_restore_staging_root_unsafe");
    expect(() => resolveCustomerRestoreStagingPath("relative/staging", "backup-1"))
      .toThrow("customer_restore_staging_root_absolute_required");
    expect(() => resolveCustomerRestoreStagingPath(join(filesystemRoot, "tmp", "mendpoint-restore"), "../escape"))
      .toThrow("customer_restore_backup_id_invalid");
  });
});
