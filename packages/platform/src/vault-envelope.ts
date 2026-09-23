import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SecretProvider, SecretReference } from "./credentials.js";
import type { ExternalKeyTransport } from "./external-kek-client.js";

export const ENVELOPE_SECRET_SCHEMA_VERSION = 1 as const;

export type EnvelopeKeyReference = Readonly<{
  provider: string;
  keyId: string;
  version: string;
  customerManaged: boolean;
}>;

export type EnvelopeKeyLocator = Readonly<Omit<EnvelopeKeyReference, "customerManaged">>;

export type EnvelopeKeyAttestation = Readonly<EnvelopeKeyReference & {
  attestation: string;
  keyMaterialFingerprint?: string;
  attestationSha256: string;
}>;

export type EnvelopeKeyState = "active" | "retired" | "revoked";

export type EnvelopeKeyLifecycle = Readonly<{
  tenantId: string;
  key: EnvelopeKeyReference;
  generation: number;
  state: EnvelopeKeyState;
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
}>;

export type SecretAccessContext = Readonly<{
  tenantId: string;
  actorId: string;
  correlationId: string;
  purpose: string;
  at: string;
}>;

export type EnvelopeSecret = Readonly<{
  schemaVersion: typeof ENVELOPE_SECRET_SCHEMA_VERSION;
  tenantId: string;
  secretId: string;
  generation: number;
  key: EnvelopeKeyReference;
  keyAttestationSha256: string;
  algorithm: "AES-256-GCM";
  wrappedDataKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  createdAt: string;
}>;

export type EnvelopeAccessAuditEvent = Readonly<{
  tenantId: string;
  secretId: string;
  actorId: string;
  correlationId: string;
  purpose: string;
  operation: "encrypt" | "decrypt" | "rotate";
  outcome: "granted" | "denied";
  reason: string;
  key: EnvelopeKeyReference;
  occurredAt: string;
}>;

export interface KeyEncryptionKeyProvider {
  readonly provider: string;
  readonly enabled: boolean;
  keyMaterialFingerprints(): readonly string[];
  keyMaterialFingerprint(key: EnvelopeKeyLocator, tenantId: string): Promise<string>;
  attestKey(key: EnvelopeKeyLocator, tenantId: string): Promise<EnvelopeKeyAttestation>;
  wrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    dataKey: Uint8Array,
  ): Promise<string>;
  unwrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    wrappedDataKey: string,
  ): Promise<Uint8Array>;
}

export type ExternalKeyEncryptionKeyBinding = Readonly<{
  tenantId: string;
  keyId: string;
  version: string;
  attestation: string;
  keyMaterialFingerprint: string;
}>;

export type ExternalKeyEncryptionKeyProviderConfig = Readonly<{
  provider: string;
  keys: readonly ExternalKeyEncryptionKeyBinding[];
}>;

export type DurableEnvelopeSecretVersion = Readonly<{
  credentialId: string;
  generation: number;
  state: EnvelopeKeyState;
  key: EnvelopeKeyReference;
  envelope: Readonly<
    Omit<EnvelopeSecret, "generation" | "keyAttestationSha256"> & {
      generation?: number;
      keyAttestationSha256?: string;
    }
  >;
  issuedAt: string;
  retiredAt?: string;
  revokedAt?: string;
  revocationReason?: string;
}>;

export type DurableEnvelopeSecretProviderOptions = Readonly<{
  tenantId: string;
  actorId: string;
  correlationId: string;
  purpose: string;
  at?: () => string;
  keyProviders: readonly KeyEncryptionKeyProvider[];
  resolve: (input: Readonly<{
    tenantId: string;
    credentialId: string;
    generation: number;
  }>) => DurableEnvelopeSecretVersion | undefined | Promise<DurableEnvelopeSecretVersion | undefined>;
  audit: (event: EnvelopeAccessAuditEvent) => void | Promise<void>;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const KEY_MATERIAL_FINGERPRINT_DOMAIN = "mendpoint:cryptographic-key-material-fingerprint:v1\0";
const CUSTOMER_MANAGED_ATTESTATION_BINDING_VERSION = 2 as const;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function cryptographicKeyMaterialFingerprint(material: Uint8Array): string {
  return createHash("sha256")
    .update(KEY_MATERIAL_FINGERPRINT_DOMAIN, "utf8")
    .update(material)
    .digest("hex");
}

function keyIdentity(tenantId: string, key: EnvelopeKeyReference): string {
  return `${tenantId}\0${key.provider}\0${key.keyId}\0${key.version}\0${key.customerManaged ? "1" : "0"}`;
}

function locatorIdentity(tenantId: string, key: EnvelopeKeyLocator): string {
  return `${tenantId}\0${key.provider}\0${key.keyId}\0${key.version}`;
}

function attestationDigest(input: Omit<EnvelopeKeyAttestation, "attestationSha256">): string {
  const authority = input.customerManaged
    ? (() => {
      if (!input.keyMaterialFingerprint || !/^[a-f0-9]{64}$/.test(input.keyMaterialFingerprint)) {
        throw new Error("vault_key_attestation_mismatch");
      }
      return {
        provider: input.provider,
        keyId: input.keyId,
        version: input.version,
        customerManaged: input.customerManaged,
        attestation: input.attestation,
        authorityVersion: CUSTOMER_MANAGED_ATTESTATION_BINDING_VERSION,
        keyMaterialFingerprint: input.keyMaterialFingerprint,
      };
    })()
    : {
      provider: input.provider,
      keyId: input.keyId,
      version: input.version,
      customerManaged: input.customerManaged,
      attestation: input.attestation,
    };
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

async function assertProviderAttestation(
  provider: KeyEncryptionKeyProvider,
  tenantId: string,
  key: EnvelopeKeyReference,
): Promise<EnvelopeKeyAttestation> {
  const attested = await provider.attestKey(key, tenantId);
  if (
    attested.provider !== key.provider ||
    attested.keyId !== key.keyId ||
    attested.version !== key.version ||
    attested.customerManaged !== key.customerManaged ||
    attested.attestationSha256 !== attestationDigest(attested)
  ) throw new Error("vault_key_attestation_mismatch");
  return attested;
}

export async function attestEnvelopeKey(
  providers: readonly KeyEncryptionKeyProvider[],
  tenantId: string,
  locator: EnvelopeKeyLocator,
): Promise<EnvelopeKeyAttestation> {
  const provider = providers.find((candidate) => candidate.provider === locator.provider);
  if (!provider?.enabled) throw new Error("vault_provider_disabled");
  const attested = await provider.attestKey(locator, tenantId);
  if (
    attested.provider !== locator.provider || attested.keyId !== locator.keyId ||
    attested.version !== locator.version || attested.attestationSha256 !== attestationDigest(attested)
  ) throw new Error("vault_key_attestation_mismatch");
  return attested;
}

export async function sealEnvelopeSecret(
  secretId: string,
  plaintext: string,
  generation: number,
  key: EnvelopeKeyReference,
  context: SecretAccessContext,
  providers: readonly KeyEncryptionKeyProvider[],
): Promise<EnvelopeSecret> {
  validContext(context);
  if (!ID.test(secretId) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("vault_secret_generation_invalid");
  }
  const provider = providers.find((candidate) => candidate.provider === key.provider);
  if (!provider?.enabled) throw new Error("vault_provider_disabled");
  const attested = await assertProviderAttestation(provider, context.tenantId, key);
  const dataKey = randomBytes(32);
  const wrappedDataKey = await provider.wrapDataKey(key, context.tenantId, dataKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(envelopeAad(
    context.tenantId,
    secretId,
    generation,
    key,
    attested.attestationSha256,
  ));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Object.freeze({
    schemaVersion: ENVELOPE_SECRET_SCHEMA_VERSION,
    tenantId: context.tenantId,
    secretId,
    generation,
    key: Object.freeze({ ...key }),
    keyAttestationSha256: attested.attestationSha256,
    algorithm: "AES-256-GCM" as const,
    wrappedDataKey,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: context.at,
  });
}

async function emitAudit(
  audit: (event: EnvelopeAccessAuditEvent) => void | Promise<void>,
  event: EnvelopeAccessAuditEvent,
): Promise<void> {
  try {
    await audit(Object.freeze(event));
  } catch {
    throw new Error("vault_access_audit_failed");
  }
}

export async function openEnvelopeSecret(
  envelope: EnvelopeSecret,
  context: SecretAccessContext,
  providers: readonly KeyEncryptionKeyProvider[],
  audit: (event: EnvelopeAccessAuditEvent) => void | Promise<void>,
): Promise<string> {
  validContext(context);
  if (envelope.tenantId !== context.tenantId) throw new Error("tenant_mismatch");
  try {
    const provider = providers.find((candidate) => candidate.provider === envelope.key.provider);
    if (!provider?.enabled) throw new Error("vault_provider_disabled");
    if (!/^[a-f0-9]{64}$/.test(envelope.keyAttestationSha256)) {
      throw new Error("vault_key_attestation_invalid");
    }
    const attested = await assertProviderAttestation(provider, context.tenantId, envelope.key);
    if (attested.attestationSha256 !== envelope.keyAttestationSha256) {
      throw new Error("vault_key_attestation_drift");
    }
    const dataKey = await provider.unwrapDataKey(
      envelope.key,
      context.tenantId,
      envelope.wrappedDataKey,
    );
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(envelopeAad(
      context.tenantId,
      envelope.secretId,
      envelope.generation,
      envelope.key,
      envelope.keyAttestationSha256,
    ));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    await emitAudit(audit, {
      tenantId: context.tenantId,
      secretId: envelope.secretId,
      actorId: context.actorId,
      correlationId: context.correlationId,
      purpose: context.purpose,
      operation: "decrypt",
      outcome: "granted",
      reason: "granted",
      key: envelope.key,
      occurredAt: context.at,
    });
    return plaintext;
  } catch (error) {
    if (error instanceof Error && error.message === "vault_access_audit_failed") throw error;
    await emitAudit(audit, {
      tenantId: context.tenantId,
      secretId: envelope.secretId,
      actorId: context.actorId,
      correlationId: context.correlationId,
      purpose: context.purpose,
      operation: "decrypt",
      outcome: "denied",
      reason: "vault_decrypt_denied",
      key: envelope.key,
      occurredAt: context.at,
    });
    throw new Error("vault_decrypt_denied");
  }
}

function envelopeAad(
  tenantId: string,
  secretId: string,
  generation: number,
  key: EnvelopeKeyReference,
  keyAttestationSha256: string,
): Buffer {
  return Buffer.from(
    `${tenantId}\0${secretId}\0${generation}\0${key.provider}\0${key.keyId}\0${key.version}\0${key.customerManaged ? "1" : "0"}\0${keyAttestationSha256}`,
  );
}

function validContext(context: SecretAccessContext): void {
  if (!ID.test(context.tenantId)) throw new Error("vault_tenant_invalid");
  if (!ID.test(context.actorId)) throw new Error("vault_actor_invalid");
  if (!ID.test(context.correlationId)) throw new Error("vault_correlation_invalid");
  if (context.purpose.trim().length === 0) throw new Error("vault_purpose_required");
  if (!Number.isFinite(Date.parse(context.at))) throw new Error("vault_access_time_invalid");
}

function validKey(key: EnvelopeKeyReference): void {
  if (
    !ID.test(key.provider)
    || !ID.test(key.keyId)
    || !ID.test(key.version)
    || typeof key.customerManaged !== "boolean"
  ) {
    throw new Error("vault_key_reference_invalid");
  }
}

export class EnvelopeKeyLifecycleRegistry {
  readonly #keys = new Map<string, EnvelopeKeyLifecycle>();

  register(input: EnvelopeKeyLifecycle): EnvelopeKeyLifecycle {
    validKey(input.key);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error("vault_key_generation_invalid");
    }
    if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("vault_key_created_at_invalid");
    const identity = keyIdentity(input.tenantId, input.key);
    if (this.#keys.has(identity)) throw new Error("vault_key_version_exists");
    const lifecycle = Object.freeze({ ...input, key: Object.freeze({ ...input.key }) });
    this.#keys.set(identity, lifecycle);
    return lifecycle;
  }

  get(tenantId: string, key: EnvelopeKeyReference): EnvelopeKeyLifecycle | undefined {
    return this.#keys.get(keyIdentity(tenantId, key));
  }

  assertEncryptable(tenantId: string, key: EnvelopeKeyReference): EnvelopeKeyLifecycle {
    const lifecycle = this.get(tenantId, key);
    if (!lifecycle) throw new Error("vault_key_not_registered");
    if (lifecycle.state !== "active") throw new Error(`vault_key_not_active:${lifecycle.state}`);
    return lifecycle;
  }

  assertDecryptable(tenantId: string, key: EnvelopeKeyReference): EnvelopeKeyLifecycle {
    const lifecycle = this.get(tenantId, key);
    if (!lifecycle) throw new Error("vault_key_not_registered");
    if (lifecycle.state === "revoked") throw new Error("vault_key_revoked");
    return lifecycle;
  }

  rotate(
    tenantId: string,
    current: EnvelopeKeyReference,
    next: EnvelopeKeyLifecycle,
    rotatedAt: string,
  ): void {
    const existing = this.assertRotation(tenantId, current, next, rotatedAt);
    this.register(next);
    this.#keys.set(
      keyIdentity(tenantId, current),
      Object.freeze({ ...existing, state: "retired", rotatedAt }),
    );
  }

  assertRotation(
    tenantId: string,
    current: EnvelopeKeyReference,
    next: EnvelopeKeyLifecycle,
    rotatedAt: string,
  ): EnvelopeKeyLifecycle {
    const existing = this.assertEncryptable(tenantId, current);
    validKey(next.key);
    if (next.tenantId !== tenantId || next.state !== "active") throw new Error("vault_rotation_target_invalid");
    if (next.generation !== existing.generation + 1) throw new Error("vault_rotation_generation_invalid");
    if (!Number.isFinite(Date.parse(next.createdAt))) throw new Error("vault_key_created_at_invalid");
    if (!Number.isFinite(Date.parse(rotatedAt))) throw new Error("vault_rotation_time_invalid");
    if (this.get(tenantId, next.key)) throw new Error("vault_key_version_exists");
    return existing;
  }

  revoke(
    tenantId: string,
    key: EnvelopeKeyReference,
    input: Readonly<{ revokedAt: string; reason: string }>,
  ): EnvelopeKeyLifecycle {
    const existing = this.get(tenantId, key);
    if (!existing) throw new Error("vault_key_not_registered");
    if (existing.state === "revoked") return existing;
    if (!Number.isFinite(Date.parse(input.revokedAt)) || input.reason.trim().length === 0) {
      throw new Error("vault_revocation_invalid");
    }
    const revoked = Object.freeze({
      ...existing,
      state: "revoked" as const,
      revokedAt: input.revokedAt,
      revocationReason: input.reason,
    });
    this.#keys.set(keyIdentity(tenantId, key), revoked);
    return revoked;
  }
}

const EXTERNAL_WRAPPED_DATA_KEY_MAX_BYTES = 64 * 1_024;

function externalKeyBindingIdentity(
  tenantId: string,
  provider: string,
  keyId: string,
  version: string,
): string {
  return `${tenantId}\0${provider}\0${keyId}\0${version}`;
}

function strictBase64(value: unknown, maximumBytes: number): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > Math.ceil(maximumBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("external_kek_response_invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0 || decoded.byteLength > maximumBytes || decoded.toString("base64") !== value) {
    throw new Error("external_kek_response_invalid");
  }
  return decoded;
}

class ExternalKeyEncryptionKeyProvider implements KeyEncryptionKeyProvider {
  readonly enabled = true;
  readonly provider: string;
  readonly #transport: ExternalKeyTransport;
  readonly #bindings = new Map<string, ExternalKeyEncryptionKeyBinding>();
  readonly #fingerprints: readonly string[];

  constructor(config: ExternalKeyEncryptionKeyProviderConfig, transport: ExternalKeyTransport) {
    if (
      !config
      || typeof config !== "object"
      || !isIdentifier(config.provider)
      || !Array.isArray(config.keys)
      || config.keys.length === 0
      || !transport
      || typeof transport.attestKey !== "function"
      || typeof transport.wrapDataKey !== "function"
      || typeof transport.unwrapDataKey !== "function"
    ) {
      throw new Error("external_kek_configuration_invalid");
    }
    this.provider = config.provider;
    this.#transport = transport;
    for (const binding of config.keys) {
      if (
        !binding
        || typeof binding !== "object"
        || !isIdentifier(binding.tenantId)
        || !isIdentifier(binding.keyId)
        || !isIdentifier(binding.version)
        || typeof binding.attestation !== "string"
        || binding.attestation.trim().length === 0
        || binding.attestation.length > 4_096
        || !/^[a-f0-9]{64}$/.test(binding.keyMaterialFingerprint)
      ) {
        throw new Error("external_kek_configuration_invalid");
      }
      const identity = externalKeyBindingIdentity(
        binding.tenantId,
        this.provider,
        binding.keyId,
        binding.version,
      );
      if (this.#bindings.has(identity)) throw new Error("external_kek_configuration_invalid");
      this.#bindings.set(identity, Object.freeze({ ...binding }));
    }
    this.#fingerprints = Object.freeze([...new Set(
      [...this.#bindings.values()].map((binding) => binding.keyMaterialFingerprint),
    )].sort());
  }

  #binding(key: EnvelopeKeyLocator, tenantId: string): ExternalKeyEncryptionKeyBinding {
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      throw new Error("external_kek_operation_failed");
    }
    const keyRecord = key as unknown as Record<string, unknown>;
    const provider = keyRecord.provider;
    const keyId = keyRecord.keyId;
    const version = keyRecord.version;
    if (
      !isIdentifier(tenantId)
      || !isIdentifier(provider)
      || provider !== this.provider
      || !isIdentifier(keyId)
      || !isIdentifier(version)
      || ("customerManaged" in keyRecord && keyRecord.customerManaged !== true)
    ) {
      throw new Error("external_kek_operation_failed");
    }
    const binding = this.#bindings.get(externalKeyBindingIdentity(
      tenantId,
      this.provider,
      keyId,
      version,
    ));
    if (!binding) throw new Error("external_kek_operation_failed");
    return binding;
  }

  #attestation(
    response: unknown,
    key: EnvelopeKeyLocator,
    tenantId: string,
    binding: ExternalKeyEncryptionKeyBinding,
  ): EnvelopeKeyAttestation {
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("external_kek_response_invalid");
    }
    const record = response as Record<string, unknown>;
    if (
      record.provider !== this.provider
      || record.tenantId !== tenantId
      || record.keyId !== key.keyId
      || record.version !== key.version
      || record.customerManaged !== true
      || record.attestation !== binding.attestation
      || record.keyMaterialFingerprint !== binding.keyMaterialFingerprint
    ) {
      throw new Error("external_kek_response_invalid");
    }
    const base = {
      provider: this.provider,
      keyId: binding.keyId,
      version: binding.version,
      customerManaged: true,
      attestation: binding.attestation,
      keyMaterialFingerprint: binding.keyMaterialFingerprint,
    } as const;
    return Object.freeze({ ...base, attestationSha256: attestationDigest(base) });
  }

  async #remote<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof Error && error.message === "external_kek_destination_invalid") {
        throw new Error("external_kek_destination_invalid");
      }
      throw new Error("external_kek_operation_failed");
    }
  }

  keyMaterialFingerprints(): readonly string[] {
    return this.#fingerprints;
  }

  async keyMaterialFingerprint(key: EnvelopeKeyLocator, tenantId: string): Promise<string> {
    const binding = this.#binding(key, tenantId);
    await this.#remote(async () => {
      const response = await this.#transport.attestKey(key, tenantId);
      this.#attestation(response, key, tenantId, binding);
    });
    return binding.keyMaterialFingerprint;
  }

  async attestKey(key: EnvelopeKeyLocator, tenantId: string): Promise<EnvelopeKeyAttestation> {
    const binding = this.#binding(key, tenantId);
    return this.#remote(async () => this.#attestation(
      await this.#transport.attestKey(key, tenantId),
      key,
      tenantId,
      binding,
    ));
  }

  async wrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    dataKey: Uint8Array,
  ): Promise<string> {
    const binding = this.#binding(key, tenantId);
    if (!(dataKey instanceof Uint8Array) || dataKey.byteLength !== 32) {
      throw new Error("external_kek_operation_failed");
    }
    return this.#remote(async () => {
      const response = await this.#transport.wrapDataKey(key, tenantId, dataKey);
      this.#attestation(response, key, tenantId, binding);
      const wrappedDataKey = (response as Record<string, unknown>).wrappedDataKey;
      strictBase64(wrappedDataKey, EXTERNAL_WRAPPED_DATA_KEY_MAX_BYTES);
      return wrappedDataKey as string;
    });
  }

  async unwrapDataKey(
    key: EnvelopeKeyReference,
    tenantId: string,
    wrappedDataKey: string,
  ): Promise<Uint8Array> {
    const binding = this.#binding(key, tenantId);
    try {
      strictBase64(wrappedDataKey, EXTERNAL_WRAPPED_DATA_KEY_MAX_BYTES);
    } catch {
      throw new Error("external_kek_operation_failed");
    }
    return this.#remote(async () => {
      const response = await this.#transport.unwrapDataKey(key, tenantId, wrappedDataKey);
      this.#attestation(response, key, tenantId, binding);
      const dataKey = strictBase64((response as Record<string, unknown>).dataKeyBase64, 32);
      if (dataKey.byteLength !== 32) throw new Error("external_kek_response_invalid");
      return dataKey;
    });
  }
}

export function createExternalKeyEncryptionKeyProvider(
  config: ExternalKeyEncryptionKeyProviderConfig,
  transport: ExternalKeyTransport,
): KeyEncryptionKeyProvider {
  return new ExternalKeyEncryptionKeyProvider(config, transport);
}

/** Explicitly disabled until a real vault implementation and authority are configured. */
export class DisabledExternalVaultProvider implements KeyEncryptionKeyProvider {
  readonly enabled = false;
  constructor(readonly provider = "external-vault") {}
  keyMaterialFingerprints(): readonly string[] {
    return Object.freeze([]);
  }
  async keyMaterialFingerprint(): Promise<string> {
    throw new Error("external_vault_disabled");
  }
  async attestKey(): Promise<EnvelopeKeyAttestation> {
    throw new Error("external_vault_disabled");
  }
  async wrapDataKey(): Promise<string> {
    throw new Error("external_vault_disabled");
  }
  async unwrapDataKey(): Promise<Uint8Array> {
    throw new Error("external_vault_disabled");
  }
}

/** In-memory KEK provider for tests and local development only. */
export class LocalEnvelopeKeyProvider implements KeyEncryptionKeyProvider {
  readonly provider = "local-envelope";
  readonly enabled = true;
  readonly #keys = new Map<string, { key: EnvelopeKeyReference; material: Buffer }>();

  putKey(tenantId: string, key: EnvelopeKeyReference, material: Uint8Array): void {
    if (key.provider !== this.provider || material.byteLength !== 32) {
      throw new Error("local_envelope_key_invalid");
    }
    if (key.customerManaged) {
      throw new Error("local_envelope_customer_managed_evidence_required");
    }
    this.#keys.set(locatorIdentity(tenantId, key), { key: Object.freeze({ ...key }), material: Buffer.from(material) });
  }

  removeKey(tenantId: string, key: EnvelopeKeyReference): void {
    this.#keys.delete(locatorIdentity(tenantId, key));
  }

  keyMaterialFingerprints(): readonly string[] {
    return Object.freeze([...new Set(
      [...this.#keys.values()].map((record) => cryptographicKeyMaterialFingerprint(record.material)),
    )].sort());
  }

  async keyMaterialFingerprint(key: EnvelopeKeyLocator, tenantId: string): Promise<string> {
    const record = this.#keys.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("local_envelope_key_missing");
    await this.attestKey(key, tenantId);
    return cryptographicKeyMaterialFingerprint(record.material);
  }

  async attestKey(key: EnvelopeKeyLocator, tenantId: string): Promise<EnvelopeKeyAttestation> {
    const record = this.#keys.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("local_envelope_key_missing");
    const base = {
      ...record.key,
      attestation: `local:${tenantId}:${record.key.keyId}:${record.key.version}`,
    };
    return Object.freeze({ ...base, attestationSha256: attestationDigest(base) });
  }

  async wrapDataKey(key: EnvelopeKeyReference, tenantId: string, dataKey: Uint8Array): Promise<string> {
    const record = this.#keys.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("local_envelope_key_missing");
    await assertProviderAttestation(this, tenantId, key);
    const material = record.material;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", material, iv);
    cipher.setAAD(Buffer.from(`${tenantId}\0${key.keyId}\0${key.version}`));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
  }

  async unwrapDataKey(key: EnvelopeKeyReference, tenantId: string, wrappedDataKey: string): Promise<Uint8Array> {
    const record = this.#keys.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("local_envelope_key_missing");
    await assertProviderAttestation(this, tenantId, key);
    const material = record.material;
    const [iv, tag, ciphertext, extra] = wrappedDataKey.split(".");
    if (!iv || !tag || !ciphertext || extra) throw new Error("wrapped_data_key_invalid");
    const decipher = createDecipheriv("aes-256-gcm", material, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`${tenantId}\0${key.keyId}\0${key.version}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  }
}

type ConfiguredKeyRecord = Readonly<{
  tenantId: string;
  provider: string;
  keyId: string;
  version: string;
  customerManaged: boolean;
  attestation: string;
  materialBase64: string;
}>;

/** Environment-backed production adapter. Configuration is validated as one authoritative key catalog. */
export class ConfiguredEnvelopeKeyProvider implements KeyEncryptionKeyProvider {
  readonly enabled = true;
  readonly provider: string;
  readonly #records = new Map<string, { key: EnvelopeKeyAttestation; material: Buffer }>();

  private constructor(records: readonly ConfiguredKeyRecord[]) {
    if (records.length === 0) throw new Error("external_vault_configuration_invalid");
    this.provider = records[0]!.provider;
    for (const record of records) {
      const material = Buffer.from(record.materialBase64, "base64");
      if (
        record.provider !== this.provider || !ID.test(record.tenantId) || !ID.test(record.provider) ||
        !ID.test(record.keyId) || !ID.test(record.version) || typeof record.customerManaged !== "boolean" ||
        !record.attestation.trim() || material.byteLength !== 32
      ) throw new Error("external_vault_configuration_invalid");
      if (record.customerManaged) {
        throw new Error("external_vault_customer_managed_evidence_required");
      }
      const base = {
        provider: record.provider,
        keyId: record.keyId,
        version: record.version,
        customerManaged: record.customerManaged,
        attestation: record.attestation,
      };
      const identity = locatorIdentity(record.tenantId, base);
      if (this.#records.has(identity)) throw new Error("external_vault_configuration_invalid");
      this.#records.set(identity, {
        key: Object.freeze({ ...base, attestationSha256: attestationDigest(base) }),
        material,
      });
    }
  }

  static fromJson(value: string): ConfiguredEnvelopeKeyProvider {
    try {
      const parsed = JSON.parse(value) as { schemaVersion?: unknown; keys?: unknown };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.keys)) {
        throw new Error("external_vault_configuration_invalid");
      }
      return new ConfiguredEnvelopeKeyProvider(parsed.keys as ConfiguredKeyRecord[]);
    } catch (error) {
      if (error instanceof Error && (
        error.message === "external_vault_configuration_invalid" ||
        error.message === "external_vault_customer_managed_evidence_required"
      )) throw error;
      throw new Error("external_vault_configuration_invalid");
    }
  }

  keyMaterialFingerprints(): readonly string[] {
    return Object.freeze([...new Set(
      [...this.#records.values()].map((record) => cryptographicKeyMaterialFingerprint(record.material)),
    )].sort());
  }

  async keyMaterialFingerprint(key: EnvelopeKeyLocator, tenantId: string): Promise<string> {
    const record = this.#records.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("external_vault_key_not_attested");
    await this.attestKey(key, tenantId);
    return cryptographicKeyMaterialFingerprint(record.material);
  }

  async attestKey(key: EnvelopeKeyLocator, tenantId: string): Promise<EnvelopeKeyAttestation> {
    const record = this.#records.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("external_vault_key_not_attested");
    return record.key;
  }

  async wrapDataKey(key: EnvelopeKeyReference, tenantId: string, dataKey: Uint8Array): Promise<string> {
    const record = this.#records.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("external_vault_key_not_attested");
    await assertProviderAttestation(this, tenantId, key);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", record.material, iv);
    cipher.setAAD(Buffer.from(`${tenantId}\0${key.keyId}\0${key.version}`));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
  }

  async unwrapDataKey(key: EnvelopeKeyReference, tenantId: string, wrappedDataKey: string): Promise<Uint8Array> {
    const record = this.#records.get(locatorIdentity(tenantId, key));
    if (!record) throw new Error("external_vault_key_not_attested");
    await assertProviderAttestation(this, tenantId, key);
    const [iv, tag, ciphertext, extra] = wrappedDataKey.split(".");
    if (!iv || !tag || !ciphertext || extra) throw new Error("wrapped_data_key_invalid");
    const decipher = createDecipheriv("aes-256-gcm", record.material, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`${tenantId}\0${key.keyId}\0${key.version}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  }
}

export function envelopeKeyProvidersFromEnvironment(
  configuration: string | undefined,
): readonly KeyEncryptionKeyProvider[] {
  if (!configuration?.trim()) return Object.freeze([new DisabledExternalVaultProvider()]);
  return Object.freeze([ConfiguredEnvelopeKeyProvider.fromJson(configuration)]);
}

export class EnvelopeSecretVault {
  readonly #providers: ReadonlyMap<string, KeyEncryptionKeyProvider>;

  constructor(
    readonly lifecycle: EnvelopeKeyLifecycleRegistry,
    providers: readonly KeyEncryptionKeyProvider[],
    readonly audit: (event: EnvelopeAccessAuditEvent) => void | Promise<void>,
  ) {
    this.#providers = new Map(providers.map((provider) => [provider.provider, provider]));
  }

  async encrypt(
    secretId: string,
    plaintext: string,
    key: EnvelopeKeyReference,
    context: SecretAccessContext,
    operation: EnvelopeAccessAuditEvent["operation"] = "encrypt",
  ): Promise<EnvelopeSecret> {
    validContext(context);
    if (context.tenantId.trim().length === 0 || !ID.test(secretId)) throw new Error("vault_secret_id_invalid");
    const lifecycle = this.lifecycle.assertEncryptable(context.tenantId, key);
    return this.#encrypt(secretId, plaintext, lifecycle.generation, key, context, operation);
  }

  async #encrypt(
    secretId: string,
    plaintext: string,
    generation: number,
    key: EnvelopeKeyReference,
    context: SecretAccessContext,
    operation: EnvelopeAccessAuditEvent["operation"],
  ): Promise<EnvelopeSecret> {
    const provider = this.#providers.get(key.provider);
    if (!provider || !provider.enabled) {
      await this.#emit(secretId, key, context, operation, "denied", "vault_provider_disabled");
      throw new Error("vault_provider_disabled");
    }
    try {
      const attested = await assertProviderAttestation(provider, context.tenantId, key);
      const dataKey = randomBytes(32);
      const wrappedDataKey = await provider.wrapDataKey(key, context.tenantId, dataKey);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      cipher.setAAD(envelopeAad(
        context.tenantId,
        secretId,
        generation,
        key,
        attested.attestationSha256,
      ));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const result = Object.freeze({
        schemaVersion: ENVELOPE_SECRET_SCHEMA_VERSION,
        tenantId: context.tenantId,
        secretId,
        generation,
        key: Object.freeze({ ...key }),
        keyAttestationSha256: attested.attestationSha256,
        algorithm: "AES-256-GCM" as const,
        wrappedDataKey,
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        createdAt: context.at,
      });
      await this.#emit(secretId, key, context, operation, "granted", "granted");
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === "vault_access_audit_failed") throw error;
      await this.#emit(secretId, key, context, operation, "denied", "vault_operation_failed");
      throw new Error("vault_operation_failed");
    }
  }

  async decrypt(envelope: EnvelopeSecret, context: SecretAccessContext): Promise<string> {
    validContext(context);
    if (envelope.tenantId !== context.tenantId) {
      await this.#emit(envelope.secretId, envelope.key, context, "decrypt", "denied", "tenant_mismatch");
      throw new Error("tenant_mismatch");
    }
    try {
      const lifecycle = this.lifecycle.assertDecryptable(context.tenantId, envelope.key);
      if (
        !Number.isSafeInteger(envelope.generation) ||
        (envelope.generation ?? 0) < 1 ||
        envelope.generation !== lifecycle.generation
      ) {
        throw new Error("vault_secret_generation_invalid");
      }
      const provider = this.#providers.get(envelope.key.provider);
      if (!provider || !provider.enabled) throw new Error("vault_provider_disabled");
      if (!/^[a-f0-9]{64}$/.test(envelope.keyAttestationSha256)) {
        throw new Error("vault_key_attestation_invalid");
      }
      const attested = await assertProviderAttestation(provider, context.tenantId, envelope.key);
      if (attested.attestationSha256 !== envelope.keyAttestationSha256) {
        throw new Error("vault_key_attestation_drift");
      }
      const dataKey = await provider.unwrapDataKey(envelope.key, context.tenantId, envelope.wrappedDataKey);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(envelopeAad(
        context.tenantId,
        envelope.secretId,
        envelope.generation,
        envelope.key,
        envelope.keyAttestationSha256,
      ));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      await this.#emit(envelope.secretId, envelope.key, context, "decrypt", "granted", "granted");
      return plaintext;
    } catch (error) {
      if (error instanceof Error && error.message === "vault_access_audit_failed") throw error;
      const reason = error instanceof Error && error.message === "vault_key_revoked" ? "vault_key_revoked" : "vault_decrypt_denied";
      await this.#emit(envelope.secretId, envelope.key, context, "decrypt", "denied", reason);
      throw new Error(reason);
    }
  }

  async rotate(
    envelope: EnvelopeSecret,
    next: EnvelopeKeyLifecycle,
    context: SecretAccessContext,
  ): Promise<EnvelopeSecret> {
    const plaintext = await this.decrypt(envelope, { ...context, purpose: `${context.purpose}:read_for_rotation` });
    this.lifecycle.assertRotation(context.tenantId, envelope.key, next, context.at);
    const replacement = await this.#encrypt(
      envelope.secretId,
      plaintext,
      next.generation,
      next.key,
      context,
      "rotate",
    );
    this.lifecycle.rotate(context.tenantId, envelope.key, next, context.at);
    return replacement;
  }

  async #emit(
    secretId: string,
    key: EnvelopeKeyReference,
    context: SecretAccessContext,
    operation: EnvelopeAccessAuditEvent["operation"],
    outcome: EnvelopeAccessAuditEvent["outcome"],
    reason: string,
  ): Promise<void> {
    try {
      await this.audit(Object.freeze({
        tenantId: context.tenantId,
        secretId,
        actorId: context.actorId,
        correlationId: context.correlationId,
        purpose: context.purpose,
        operation,
        outcome,
        reason,
        key: Object.freeze({ ...key }),
        occurredAt: context.at,
      }));
    } catch {
      throw new Error("vault_access_audit_failed");
    }
  }
}

/**
 * Request scoped bridge from CredentialBroker to durable envelope metadata.
 * It deliberately retains no plaintext cache: every read reloads the exact
 * generation and therefore observes rotation or incident revocation immediately.
 */
export class DurableEnvelopeSecretProvider implements SecretProvider {
  readonly provider = "durable-envelope";

  constructor(private readonly options: DurableEnvelopeSecretProviderOptions) {}

  async read(reference: SecretReference): Promise<string | undefined> {
    if (reference.provider !== this.provider) return undefined;
    if (!ID.test(reference.id) || !reference.version || !/^[1-9][0-9]*$/.test(reference.version)) {
      throw new Error("vault_secret_reference_invalid");
    }
    const generation = Number(reference.version);
    if (!Number.isSafeInteger(generation)) throw new Error("vault_secret_reference_invalid");
    const version = await this.options.resolve({
      tenantId: this.options.tenantId,
      credentialId: reference.id,
      generation,
    });
    if (!version) return undefined;
    if (
      version.credentialId !== reference.id ||
      version.generation !== generation ||
      version.envelope.tenantId !== this.options.tenantId ||
      version.envelope.secretId !== reference.id ||
      (version.envelope.generation !== undefined && version.envelope.generation !== generation) ||
      !version.envelope.keyAttestationSha256 ||
      !/^[a-f0-9]{64}$/.test(version.envelope.keyAttestationSha256) ||
      keyIdentity(this.options.tenantId, version.envelope.key) !==
        keyIdentity(this.options.tenantId, version.key)
    ) {
      throw new Error("vault_secret_binding_invalid");
    }
    if (version.state !== "active") throw new Error("vault_secret_generation_inactive");

    return openEnvelopeSecret(Object.freeze({
      ...version.envelope,
      generation,
      keyAttestationSha256: version.envelope.keyAttestationSha256,
    }), {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: this.options.correlationId,
      purpose: this.options.purpose,
      at: this.options.at?.() ?? new Date().toISOString(),
    }, this.options.keyProviders, this.options.audit);
  }
}
