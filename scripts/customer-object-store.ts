import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  createObjectBackupRecoveryReceipt,
  createObjectBackupCommit,
  verifyObjectBackupRecoveryReceipt,
  verifyObjectBackupCommit,
  type ObjectBackupRecoveryReceipt,
  type ObjectBackupCommit,
  type ObjectBackupPublication,
} from "@mendpoint/ops";

export interface CustomerObjectStoreConfig {
  bucket: string;
  endpointOrigin: string;
  region: string;
  basePrefix: string;
  stagingRoot: string;
  operationTimeoutMs: number;
  connectionArgs: readonly string[];
}

export interface CustomerObjectStoreTransport {
  put(remote: string, body: Buffer): Promise<void>;
  read(remote: string): Promise<Buffer>;
  remove(remote: string): Promise<void>;
  list(prefix: string): Promise<readonly string[]>;
  uploadDirectory(localRoot: string, remotePrefix: string): Promise<void>;
  verifyDirectory(localRoot: string, remotePrefix: string): Promise<void>;
  downloadDirectory(remotePrefix: string, localRoot: string): Promise<void>;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const BACKUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// rclone resolves its configuration file from HOME when it is not told otherwise.
// scripts/customer-backup.ts builds this config as root and then drops to uid 1000, while
// customerObjectStoreProcessEnv forwards the captured HOME, so rclone runs as uid 1000 and
// reads /root/.rclone.conf: it fails with EACCES on a file it does not need, because
// connectionArgs already specify the remote inline. Pointing --config at the null device
// removes the configuration file, and with it the HOME dependency, for every rclone call.
const RCLONE_NO_CONFIG_PATH = "/dev/null";
const DEFAULT_OPERATION_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MIN_OPERATION_TIMEOUT_MS = 60_000;
const MAX_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path);
  return comparablePath(resolved) === comparablePath(parse(resolved).root);
}

export function resolveCustomerRestoreStagingPath(stagingRoot: string, backupId: string): string {
  if (!isAbsolute(stagingRoot)) throw new Error("customer_restore_staging_root_absolute_required");
  const root = resolve(stagingRoot);
  if (isFilesystemRoot(root) || isFilesystemRoot(dirname(root))) {
    throw new Error("customer_restore_staging_root_unsafe");
  }
  if (!BACKUP_ID.test(backupId)) throw new Error("customer_restore_backup_id_invalid");
  const destination = resolve(root, backupId);
  const rel = relative(root, destination);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("customer_restore_staging_destination_invalid");
  }
  return destination;
}

function safePrefix(value: string, error: string): string {
  if (
    !PREFIX.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error(error);
  return value;
}

export function loadCustomerObjectStoreConfig(
  env: Readonly<Record<string, string | undefined>>,
): CustomerObjectStoreConfig {
  if (env.MENDPOINT_BACKUP_TRANSPORT?.trim() !== "rclone_s3") {
    throw new Error("customer_backup_object_transport_required");
  }
  const bucket = env.BUCKET_NAME?.trim() ?? "";
  if (!BUCKET.test(bucket)) throw new Error("customer_backup_bucket_invalid");
  const endpointText = env.AWS_ENDPOINT_URL_S3?.trim() ?? "";
  let endpoint: URL;
  try {
    endpoint = new URL(endpointText);
  } catch {
    throw new Error("customer_backup_endpoint_invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("customer_backup_endpoint_invalid");
  }
  const stagingRoot = env.MENDPOINT_BACKUP_STAGING_ROOT?.trim() ?? "";
  if (!isAbsolute(stagingRoot)) throw new Error("customer_backup_staging_root_absolute_required");
  if (isFilesystemRoot(stagingRoot) || isFilesystemRoot(dirname(resolve(stagingRoot)))) {
    throw new Error("customer_backup_staging_root_unsafe");
  }
  const basePrefix = safePrefix(
    env.MENDPOINT_BACKUP_OBJECT_PREFIX?.trim() ?? "",
    "customer_backup_object_prefix_invalid",
  );
  if (!env.AWS_ACCESS_KEY_ID?.trim()) throw new Error("customer_backup_aws_access_key_required");
  if (!env.AWS_SECRET_ACCESS_KEY?.trim()) throw new Error("customer_backup_aws_secret_key_required");
  const region = env.AWS_REGION?.trim() || "auto";
  const timeoutText = env.MENDPOINT_BACKUP_OPERATION_TIMEOUT_MS?.trim();
  const operationTimeoutMs = timeoutText === undefined || timeoutText === ""
    ? DEFAULT_OPERATION_TIMEOUT_MS
    : Number(timeoutText);
  if (
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < MIN_OPERATION_TIMEOUT_MS ||
    operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS
  ) throw new Error("customer_backup_operation_timeout_invalid");
  return Object.freeze({
    bucket,
    endpointOrigin: endpoint.origin,
    region,
    basePrefix,
    stagingRoot: resolve(stagingRoot),
    operationTimeoutMs,
    connectionArgs: Object.freeze([
      "--config", RCLONE_NO_CONFIG_PATH,
      "--s3-provider", "Other",
      "--s3-env-auth",
      "--s3-endpoint", endpoint.origin,
      "--s3-region", region,
    ]),
  });
}

export function customerObjectStoreProcessEnv(
  env: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const names = [
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) => env[name] === undefined ? [] : [[name, env[name]]]),
  );
}

async function runRclone(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdin?: Buffer,
): Promise<Buffer> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn("rclone", [...args], {
      env,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(Buffer.concat(stdout));
      else rejectRun(new Error(`customer_backup_rclone_failed:${code ?? "signal"}:${Buffer.concat(stderr).toString("utf8").slice(0, 512)}`));
    });
    if (stdin) child.stdin?.end(stdin);
  });
}

export function createRcloneCustomerObjectStoreTransport(
  config: CustomerObjectStoreConfig,
  env: Readonly<NodeJS.ProcessEnv>,
): CustomerObjectStoreTransport {
  const processEnv = customerObjectStoreProcessEnv(env);
  const remote = (path: string) => `:s3:${config.bucket}/${safePrefix(path, "customer_backup_remote_path_invalid")}`;
  const args = (...operation: string[]) => [...operation, ...config.connectionArgs];
  return {
    async put(path, body) {
      const temporary = join(tmpdir(), `mendpoint-rclone-put-${randomUUID()}`);
      try {
        writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
        await runRclone(args("copyto", temporary, remote(path), "--immutable"), processEnv, config.operationTimeoutMs);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
    async read(path) { return await runRclone(args("cat", remote(path)), processEnv, config.operationTimeoutMs); },
    async remove(path) { await runRclone(args("deletefile", remote(path)), processEnv, config.operationTimeoutMs); },
    async list(prefix) {
      const output = await runRclone(args("lsf", remote(prefix), "--recursive", "--files-only"), processEnv, config.operationTimeoutMs);
      return output.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    },
    async uploadDirectory(localRoot, remotePrefix) {
      await runRclone(args("copy", localRoot, remote(remotePrefix), "--immutable"), processEnv, config.operationTimeoutMs);
    },
    async verifyDirectory(localRoot, remotePrefix) {
      await runRclone(args("check", localRoot, remote(remotePrefix), "--download", "--one-way"), processEnv, config.operationTimeoutMs);
    },
    async downloadDirectory(remotePrefix, localRoot) {
      mkdirSync(localRoot, { recursive: true, mode: 0o700 });
      await runRclone(args("copy", remote(remotePrefix), localRoot), processEnv, config.operationTimeoutMs);
    },
  };
}

export async function probeCustomerObjectStore(
  _config: CustomerObjectStoreConfig,
  transport: CustomerObjectStoreTransport,
  identity: { machineId: string; nonce?: string },
): Promise<void> {
  const machine = identity.machineId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const nonce = (identity.nonce ?? randomUUID()).replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const path = `readiness/${machine}/${nonce}`;
  const body = Buffer.from(`mendpoint-object-readiness:${machine}:${nonce}`, "utf8");
  try {
    await transport.put(path, body);
    const read = await transport.read(path);
    if (!read.equals(body)) throw new Error("customer_backup_object_probe_mismatch");
  } finally {
    await transport.remove(path).catch(() => undefined);
  }
}

function directorySummary(root: string): { objectCount: number; sizeBytes: number } {
  let objectCount = 0;
  let sizeBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isSymbolicLink()) throw new Error("customer_backup_object_symlink_rejected");
      else {
        const stat = statSync(path);
        objectCount += 1;
        sizeBytes += stat.size;
      }
    }
  };
  visit(root);
  return { objectCount, sizeBytes };
}

export async function publishCustomerBackup(
  input: {
    localBackupRoot: string;
    backupId: string;
    manifestAuthentication: string;
    key: Buffer;
    config: CustomerObjectStoreConfig;
    publishedAt: string;
  },
  transport: CustomerObjectStoreTransport,
): Promise<ObjectBackupPublication> {
  if (!BACKUP_ID.test(input.backupId)) throw new Error("customer_backup_id_invalid");
  const prefix = `${input.config.basePrefix}/${input.backupId}`;
  if ((await transport.list(prefix)).length > 0) throw new Error("customer_backup_remote_prefix_not_empty");
  const manifest = readFileSync(join(input.localBackupRoot, "manifest.json"));
  const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  const summary = directorySummary(input.localBackupRoot);
  await transport.uploadDirectory(input.localBackupRoot, prefix);
  await transport.verifyDirectory(input.localBackupRoot, prefix);
  if (!(await transport.read(`${prefix}/manifest.json`)).equals(manifest)) {
    throw new Error("customer_backup_remote_manifest_mismatch");
  }
  const commit = createObjectBackupCommit({
    backupId: input.backupId,
    bucket: input.config.bucket,
    prefix,
    endpointOrigin: input.config.endpointOrigin,
    manifestSha256,
    manifestAuthentication: input.manifestAuthentication,
    objectCount: summary.objectCount,
    sizeBytes: summary.sizeBytes,
    publishedAt: input.publishedAt,
  }, input.key);
  const encoded = Buffer.from(`${JSON.stringify(commit, null, 2)}\n`, "utf8");
  await transport.put(`${prefix}/commit.json`, encoded);
  const stored = JSON.parse((await transport.read(`${prefix}/commit.json`)).toString("utf8")) as ObjectBackupCommit;
  const verified = verifyObjectBackupCommit(stored, input.key);
  if (!verified.ok || !Buffer.from(JSON.stringify(stored)).equals(Buffer.from(JSON.stringify(commit)))) {
    throw new Error(`customer_backup_remote_commit_invalid:${verified.issues.join(",")}`);
  }
  return Object.freeze({
    kind: "s3",
    backupId: input.backupId,
    bucket: input.config.bucket,
    prefix,
    endpointOrigin: input.config.endpointOrigin,
    commitDigest: commit.integrity.digest,
    manifestSha256,
  });
}

export async function downloadCommittedCustomerBackup(
  input: {
    publication: ObjectBackupPublication;
    key: Buffer;
    destination: string;
  },
  transport: CustomerObjectStoreTransport,
): Promise<string> {
  const commit = JSON.parse((await transport.read(`${input.publication.prefix}/commit.json`)).toString("utf8")) as ObjectBackupCommit;
  const verified = verifyObjectBackupCommit(commit, input.key);
  if (!verified.ok || commit.integrity.digest !== input.publication.commitDigest) {
    throw new Error(`customer_backup_remote_commit_invalid:${verified.issues.join(",")}`);
  }
  if (
    commit.backupId !== input.publication.backupId ||
    commit.bucket !== input.publication.bucket ||
    commit.prefix !== input.publication.prefix ||
    commit.endpointOrigin !== input.publication.endpointOrigin ||
    commit.manifestSha256 !== input.publication.manifestSha256
  ) throw new Error("customer_backup_remote_commit_locator_mismatch");
  await transport.downloadDirectory(input.publication.prefix, input.destination);
  const manifest = readFileSync(join(input.destination, "manifest.json"));
  if (createHash("sha256").update(manifest).digest("hex") !== input.publication.manifestSha256) {
    throw new Error("customer_backup_download_manifest_mismatch");
  }
  rmSync(join(input.destination, "commit.json"), { force: true });
  const summary = directorySummary(input.destination);
  if (summary.objectCount !== commit.objectCount || summary.sizeBytes !== commit.sizeBytes) {
    throw new Error("customer_backup_download_summary_mismatch");
  }
  return resolve(input.destination);
}

export async function resolveCommittedCustomerBackupPublication(
  input: {
    backupId: string;
    key: Buffer;
    config: CustomerObjectStoreConfig;
  },
  transport: CustomerObjectStoreTransport,
): Promise<ObjectBackupPublication> {
  if (!BACKUP_ID.test(input.backupId)) throw new Error("customer_restore_backup_id_invalid");
  const prefix = `${input.config.basePrefix}/${input.backupId}`;
  const commit = JSON.parse(
    (await transport.read(`${prefix}/commit.json`)).toString("utf8"),
  ) as ObjectBackupCommit;
  const verified = verifyObjectBackupCommit(commit, input.key);
  if (!verified.ok) {
    throw new Error(`customer_backup_remote_commit_invalid:${verified.issues.join(",")}`);
  }
  if (
    commit.backupId !== input.backupId ||
    commit.bucket !== input.config.bucket ||
    commit.prefix !== prefix ||
    commit.endpointOrigin !== input.config.endpointOrigin
  ) throw new Error("customer_backup_remote_commit_locator_mismatch");
  return Object.freeze({
    kind: "s3",
    backupId: commit.backupId,
    bucket: commit.bucket,
    prefix: commit.prefix,
    endpointOrigin: commit.endpointOrigin,
    commitDigest: commit.integrity.digest,
    manifestSha256: commit.manifestSha256,
  });
}

function recoveryReceiptPath(config: CustomerObjectStoreConfig, backupId: string): string {
  if (!BACKUP_ID.test(backupId)) throw new Error("customer_restore_backup_id_invalid");
  return safePrefix(
    `${config.basePrefix}-verified/${backupId}.json`,
    "customer_backup_recovery_receipt_path_invalid",
  );
}

export async function publishCustomerBackupRecoveryReceipt(
  input: {
    backupId: string;
    keyId: string;
    verifiedAt: string;
    manifestAuthentication: string;
    publication: ObjectBackupPublication;
    key: Buffer;
    config: CustomerObjectStoreConfig;
  },
  transport: CustomerObjectStoreTransport,
): Promise<ObjectBackupRecoveryReceipt> {
  const receipt = createObjectBackupRecoveryReceipt({
    backupId: input.backupId,
    keyId: input.keyId,
    verifiedAt: input.verifiedAt,
    manifestAuthentication: input.manifestAuthentication,
    publication: input.publication,
  }, input.key);
  const path = recoveryReceiptPath(input.config, input.backupId);
  const encoded = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await transport.put(path, encoded);
  if (!(await transport.read(path)).equals(encoded)) {
    throw new Error("customer_backup_recovery_receipt_mismatch");
  }
  return receipt;
}

export async function loadCustomerBackupRecoveryReceipt(
  input: {
    backupId: string;
    keyId: string;
    key: Buffer;
    config: CustomerObjectStoreConfig;
  },
  transport: CustomerObjectStoreTransport,
): Promise<ObjectBackupRecoveryReceipt> {
  const path = recoveryReceiptPath(input.config, input.backupId);
  const receipt = JSON.parse(
    (await transport.read(path)).toString("utf8"),
  ) as ObjectBackupRecoveryReceipt;
  const verified = verifyObjectBackupRecoveryReceipt(receipt, input.key, input.keyId);
  if (!verified.ok) {
    throw new Error(`customer_backup_recovery_receipt_invalid:${verified.issues.join(",")}`);
  }
  if (
    receipt.backupId !== input.backupId ||
    receipt.publication.backupId !== input.backupId ||
    receipt.publication.bucket !== input.config.bucket ||
    receipt.publication.endpointOrigin !== input.config.endpointOrigin ||
    receipt.publication.prefix !== `${input.config.basePrefix}/${input.backupId}`
  ) throw new Error("customer_backup_recovery_receipt_locator_mismatch");
  return receipt;
}
