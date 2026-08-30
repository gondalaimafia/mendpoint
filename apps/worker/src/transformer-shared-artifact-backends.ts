import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TransformerCheckpointArtifactBackend } from "./transformer-checkpoint-artifacts.js";

const STORAGE_KEY = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export type S3CompatibleArtifactTransport = Readonly<{
  putObject(input: Readonly<{ bucket: string; key: string; body: Uint8Array; ifNoneMatch: "*" }>): Promise<Readonly<{ status: number }>>;
  getObject(input: Readonly<{ bucket: string; key: string }>): Promise<Readonly<{
    status: number;
    contentLength?: number;
    body: Uint8Array | AsyncIterable<Uint8Array> | null;
  }>>;
}>;

export function createFilesystemTransformerArtifactBackend(config: Readonly<{ root: string; maxStoredBytes: number }>): TransformerCheckpointArtifactBackend {
  if (!isAbsolute(config.root) || !positive(config.maxStoredBytes)) throw new Error("filesystem_artifact_config_invalid");
  const configuredRoot = resolve(config.root);
  const maxStoredBytes = config.maxStoredBytes;
  let rootPromise: Promise<string> | undefined;
  const root = async (): Promise<string> => {
    rootPromise ??= (async () => {
      await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
      const stat = await lstat(configuredRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("filesystem_artifact_root_invalid");
      return realpath(configuredRoot);
    })();
    return rootPromise;
  };
  const pathFor = async (key: string): Promise<string> => {
    if (!STORAGE_KEY.test(key)) throw new Error("filesystem_artifact_key_invalid");
    const base = await root();
    const target = resolve(base, ...key.split("/"));
    const rel = relative(base, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("filesystem_artifact_key_invalid");
    return target;
  };
  const create = async (key: string, bytes: Uint8Array): Promise<"created" | "exists"> => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxStoredBytes) throw new Error("filesystem_artifact_too_large");
    const target = await pathFor(key);
    const parent = resolve(target, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const base = await root();
    const actualParent = await realpath(parent);
    if (actualParent !== base && !actualParent.startsWith(`${base}${sep}`)) throw new Error("filesystem_artifact_path_escape");
    try {
      const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return "created";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw error;
    }
  };
  return Object.freeze({
    createOnly: create,
    async read(key) {
      const path = await pathFor(key);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxStoredBytes) throw new Error("filesystem_artifact_read_invalid");
        const bytes = await readFile(path);
        if (bytes.byteLength > maxStoredBytes) throw new Error("filesystem_artifact_read_invalid");
        return new Uint8Array(bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async mark(key, state) {
      const marker = `${key}.state/${state}`;
      const result = await create(marker, new TextEncoder().encode(state));
      if (result !== "created" && result !== "exists") throw new Error("filesystem_artifact_mark_failed");
    },
  });
}

export function createS3CompatibleTransformerArtifactBackend(
  config: Readonly<{ bucket: string; keyPrefix: string; maxStoredBytes: number }>,
  transport: S3CompatibleArtifactTransport,
): TransformerCheckpointArtifactBackend {
  if (!BUCKET.test(config.bucket) || !PREFIX.test(config.keyPrefix) || !positive(config.maxStoredBytes) || !transport || typeof transport.putObject !== "function" || typeof transport.getObject !== "function") throw new Error("s3_artifact_config_invalid");
  const bucket = config.bucket;
  const keyPrefix = config.keyPrefix;
  const maxStoredBytes = config.maxStoredBytes;
  const putObject = transport.putObject.bind(transport);
  const getObject = transport.getObject.bind(transport);
  const objectKey = (storageKey: string): string => {
    if (!STORAGE_KEY.test(storageKey)) throw new Error("s3_artifact_key_invalid");
    return `${keyPrefix}/${storageKey}`;
  };
  const read = async (storageKey: string): Promise<Uint8Array | null> => {
    const response = await getObject({ bucket, key: objectKey(storageKey) });
    if (response.status === 404) return null;
    if (response.status === 401 || response.status === 403) throw new Error("s3_artifact_access_denied");
    if (response.status < 200 || response.status >= 300 || response.body === null) throw new Error("s3_artifact_backend_unavailable");
    if (response.contentLength !== undefined && (!Number.isSafeInteger(response.contentLength) || response.contentLength < 0 || response.contentLength > maxStoredBytes)) throw new Error("s3_artifact_read_too_large");
    if (response.body instanceof Uint8Array) {
      if (response.body.byteLength > maxStoredBytes) throw new Error("s3_artifact_read_too_large");
      return new Uint8Array(response.body);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error("s3_artifact_response_invalid");
      total += chunk.byteLength;
      if (total > maxStoredBytes) throw new Error("s3_artifact_read_too_large");
      chunks.push(new Uint8Array(chunk));
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  };
  const createOnly = async (storageKey: string, encryptedBytes: Uint8Array): Promise<"created" | "exists"> => {
    if (!(encryptedBytes instanceof Uint8Array) || encryptedBytes.byteLength > maxStoredBytes) throw new Error("s3_artifact_too_large");
    const response = await putObject({ bucket, key: objectKey(storageKey), body: new Uint8Array(encryptedBytes), ifNoneMatch: "*" });
    if (response.status === 409 || response.status === 412) return "exists";
    if (response.status === 401 || response.status === 403) throw new Error("s3_artifact_access_denied");
    if (response.status === 404) throw new Error("s3_artifact_bucket_not_found");
    if (response.status < 200 || response.status >= 300) throw new Error("s3_artifact_backend_unavailable");
    return "created";
  };
  return Object.freeze({
    createOnly,
    read,
    async mark(storageKey, state) {
      const markerKey = `${storageKey}.state/${state}`;
      const marker = new TextEncoder().encode(state);
      try {
        await createOnly(markerKey, marker);
      } catch (error) {
        const existing = await read(markerKey).catch(() => null);
        if (!existing || new TextDecoder().decode(existing) !== state) throw error;
      }
    },
  });
}

function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
