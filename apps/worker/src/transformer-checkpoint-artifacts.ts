import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type TransformerCheckpointArtifactErrorCode =
  | "artifact_store_disabled"
  | "artifact_store_config_invalid"
  | "artifact_scope_denied"
  | "artifact_key_invalid"
  | "artifact_too_large"
  | "artifact_read_too_large"
  | "artifact_operation_limit"
  | "artifact_collision"
  | "artifact_authentication_failed"
  | "artifact_backend_unavailable";

export class TransformerCheckpointArtifactError extends Error {
  constructor(public readonly code: TransformerCheckpointArtifactErrorCode) {
    super(code);
    this.name = "TransformerCheckpointArtifactError";
  }
}

export type TransformerCheckpointArtifactBackend = Readonly<{
  createOnly(storageKey: string, encryptedBytes: Uint8Array): Promise<"created" | "exists">;
  read(storageKey: string): Promise<Uint8Array | null>;
  mark(storageKey: string, state: "pending" | "referenced" | "unreferenced"): Promise<void>;
}>;

export type TransformerCheckpointArtifactConfig = Readonly<{
  enabled: boolean;
  tenantPrefix: string;
  storagePrefix: string;
  encryptionKey: Uint8Array;
  maxArtifactBytes: number;
  maxReadBytes: number;
  maxOperations: number;
}>;

export type TransformerCheckpointArtifactStore = Readonly<{
  publishImmutable(input: Readonly<{ tenantId: string; artifactKey: string; bytes: Uint8Array }>): Promise<Readonly<{ storageKey: string; digest: string; created: boolean }>>;
  read(input: Readonly<{ tenantId: string; storageKey: string }>): Promise<Uint8Array | null>;
  recordPending(input: Readonly<{ tenantId: string; storageKey: string }>): Promise<void>;
  recordReferenced(input: Readonly<{ tenantId: string; storageKey: string }>): Promise<void>;
  recordUnreferenced(input: Readonly<{ tenantId: string; storageKey: string }>): Promise<void>;
}>;

const CONFIG_KEYS = ["enabled", "encryptionKey", "maxArtifactBytes", "maxOperations", "maxReadBytes", "storagePrefix", "tenantPrefix"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ARTIFACT_KEY = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const PREFIX = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const TENANT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}[._-]$/;
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createTransformerCheckpointArtifactStore(config: TransformerCheckpointArtifactConfig, backend: TransformerCheckpointArtifactBackend): TransformerCheckpointArtifactStore {
  validateConfig(config, backend);
  const settings = Object.freeze({
    maxArtifactBytes: config.maxArtifactBytes,
    maxOperations: config.maxOperations,
    maxReadBytes: config.maxReadBytes,
    storagePrefix: config.storagePrefix,
    tenantPrefix: config.tenantPrefix,
  });
  const key = new Uint8Array(config.encryptionKey);
  const createOnly = backend.createOnly.bind(backend);
  const read = backend.read.bind(backend);
  const markState = backend.mark.bind(backend);
  let operations = 0;
  const reserve = (): void => { if (operations >= settings.maxOperations) fail("artifact_operation_limit"); operations += 1; };
  const scope = (tenantId: string, storageKey?: string): string => {
    if (!ID.test(tenantId) || !tenantId.startsWith(settings.tenantPrefix)) fail("artifact_scope_denied");
    const prefix = `${settings.storagePrefix}/${tenantId}/`;
    if (storageKey !== undefined && (!storageKey.startsWith(prefix) || !ARTIFACT_KEY.test(storageKey.slice(prefix.length)))) fail("artifact_scope_denied");
    return prefix;
  };
  const readEncrypted = async (storageKey: string): Promise<Uint8Array | null> => {
    let bytes: Uint8Array | null;
    try { bytes = await read(storageKey); } catch { fail("artifact_backend_unavailable"); }
    if (bytes !== null && (!(bytes instanceof Uint8Array) || bytes.byteLength > settings.maxReadBytes)) fail("artifact_read_too_large");
    return bytes === null ? null : new Uint8Array(bytes);
  };
  const readPlain = async (storageKey: string): Promise<Uint8Array | null> => {
    const encrypted = await readEncrypted(storageKey);
    return encrypted === null ? null : decrypt(encrypted, key, storageKey);
  };
  const mark = async (tenantId: string, storageKey: string, state: "pending" | "referenced" | "unreferenced"): Promise<void> => {
    scope(tenantId, storageKey);
    reserve();
    try { await markState(storageKey, state); } catch { fail("artifact_backend_unavailable"); }
  };

  return Object.freeze({
    async publishImmutable(input) {
      const prefix = scope(input.tenantId);
      if (!ARTIFACT_KEY.test(input.artifactKey)) fail("artifact_key_invalid");
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > settings.maxArtifactBytes) fail("artifact_too_large");
      const storageKey = `${prefix}${input.artifactKey}`;
      const plaintext = new Uint8Array(input.bytes);
      const digest = sha256(plaintext);
      reserve();
      const existing = await readPlain(storageKey);
      if (existing !== null) {
        if (!same(existing, plaintext)) fail("artifact_collision");
        return Object.freeze({ storageKey, digest, created: false });
      }
      const encrypted = encrypt(plaintext, key, storageKey);
      let result: "created" | "exists";
      try {
        result = await createOnly(storageKey, encrypted);
      } catch {
        const recovered = await readPlain(storageKey);
        if (recovered !== null && same(recovered, plaintext)) return Object.freeze({ storageKey, digest, created: true });
        if (recovered !== null) fail("artifact_collision");
        fail("artifact_backend_unavailable");
      }
      const readback = await readPlain(storageKey);
      if (readback === null || !same(readback, plaintext)) {
        if (result === "exists") fail("artifact_collision");
        fail("artifact_authentication_failed");
      }
      return Object.freeze({ storageKey, digest, created: result === "created" });
    },
    async read(input) {
      scope(input.tenantId, input.storageKey);
      reserve();
      return readPlain(input.storageKey);
    },
    recordPending: (input) => mark(input.tenantId, input.storageKey, "pending"),
    recordReferenced: (input) => mark(input.tenantId, input.storageKey, "referenced"),
    recordUnreferenced: (input) => mark(input.tenantId, input.storageKey, "unreferenced"),
  });
}

function encrypt(plaintext: Uint8Array, key: Uint8Array, aad: string): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]));
}

function decrypt(envelope: Uint8Array, key: Uint8Array, aad: string): Uint8Array {
  try {
    if (envelope.byteLength < 1 + IV_BYTES + TAG_BYTES || envelope[0] !== VERSION) fail("artifact_authentication_failed");
    const iv = envelope.slice(1, 1 + IV_BYTES);
    const tag = envelope.slice(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = envelope.slice(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch (error) {
    if (error instanceof TransformerCheckpointArtifactError) throw error;
    fail("artifact_authentication_failed");
  }
}

function validateConfig(config: TransformerCheckpointArtifactConfig, backend: TransformerCheckpointArtifactBackend): void {
  if (!config || typeof config !== "object" || Object.keys(config).sort().join(",") !== CONFIG_KEYS.join(",")) fail("artifact_store_config_invalid");
  if (config.enabled !== true) fail("artifact_store_disabled");
  if (!TENANT_PREFIX.test(config.tenantPrefix) || !PREFIX.test(config.storagePrefix) || !(config.encryptionKey instanceof Uint8Array) || config.encryptionKey.byteLength !== 32 || !positive(config.maxArtifactBytes) || !positive(config.maxReadBytes) || config.maxReadBytes < config.maxArtifactBytes + 1 + IV_BYTES + TAG_BYTES || !positive(config.maxOperations) || !backend || typeof backend.createOnly !== "function" || typeof backend.read !== "function" || typeof backend.mark !== "function" || "delete" in backend) fail("artifact_store_config_invalid");
}

function sha256(bytes: Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function same(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && timingSafeEqual(left, right); }
function positive(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function hasText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function fail(code: TransformerCheckpointArtifactErrorCode): never { throw new TransformerCheckpointArtifactError(code); }
