import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ENVELOPE_SECRET_SCHEMA_VERSION = 1 as const;

export type EnvelopeKeyReference = Readonly<{
  provider: string;
  keyId: string;
  version: string;
  customerManaged: boolean;
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
  key: EnvelopeKeyReference;
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

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function keyIdentity(tenantId: string, key: EnvelopeKeyReference): string {
  return `${tenantId}\0${key.provider}\0${key.keyId}\0${key.version}`;
}

function validContext(context: SecretAccessContext): void {
  if (!ID.test(context.tenantId)) throw new Error("vault_tenant_invalid");
  if (!ID.test(context.actorId)) throw new Error("vault_actor_invalid");
  if (!ID.test(context.correlationId)) throw new Error("vault_correlation_invalid");
  if (context.purpose.trim().length === 0) throw new Error("vault_purpose_required");
  if (!Number.isFinite(Date.parse(context.at))) throw new Error("vault_access_time_invalid");
}

function validKey(key: EnvelopeKeyReference): void {
  if (!ID.test(key.provider) || !ID.test(key.keyId) || !ID.test(key.version)) {
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
    const existing = this.assertEncryptable(tenantId, current);
    if (next.tenantId !== tenantId || next.state !== "active") throw new Error("vault_rotation_target_invalid");
    if (next.generation !== existing.generation + 1) throw new Error("vault_rotation_generation_invalid");
    if (!Number.isFinite(Date.parse(rotatedAt))) throw new Error("vault_rotation_time_invalid");
    this.register(next);
    this.#keys.set(
      keyIdentity(tenantId, current),
      Object.freeze({ ...existing, state: "retired", rotatedAt }),
    );
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

/** Explicitly disabled until a real vault implementation and authority are configured. */
export class DisabledExternalVaultProvider implements KeyEncryptionKeyProvider {
  readonly enabled = false;
  constructor(readonly provider = "external-vault") {}
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
  readonly #keys = new Map<string, Buffer>();

  putKey(tenantId: string, key: EnvelopeKeyReference, material: Uint8Array): void {
    if (key.provider !== this.provider || material.byteLength !== 32) {
      throw new Error("local_envelope_key_invalid");
    }
    this.#keys.set(keyIdentity(tenantId, key), Buffer.from(material));
  }

  removeKey(tenantId: string, key: EnvelopeKeyReference): void {
    this.#keys.delete(keyIdentity(tenantId, key));
  }

  async wrapDataKey(key: EnvelopeKeyReference, tenantId: string, dataKey: Uint8Array): Promise<string> {
    const material = this.#keys.get(keyIdentity(tenantId, key));
    if (!material) throw new Error("local_envelope_key_missing");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", material, iv);
    cipher.setAAD(Buffer.from(`${tenantId}\0${key.keyId}\0${key.version}`));
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`;
  }

  async unwrapDataKey(key: EnvelopeKeyReference, tenantId: string, wrappedDataKey: string): Promise<Uint8Array> {
    const material = this.#keys.get(keyIdentity(tenantId, key));
    if (!material) throw new Error("local_envelope_key_missing");
    const [iv, tag, ciphertext, extra] = wrappedDataKey.split(".");
    if (!iv || !tag || !ciphertext || extra) throw new Error("wrapped_data_key_invalid");
    const decipher = createDecipheriv("aes-256-gcm", material, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`${tenantId}\0${key.keyId}\0${key.version}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  }
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
    this.lifecycle.assertEncryptable(context.tenantId, key);
    const provider = this.#providers.get(key.provider);
    if (!provider || !provider.enabled) {
      await this.#emit(secretId, key, context, operation, "denied", "vault_provider_disabled");
      throw new Error("vault_provider_disabled");
    }
    try {
      const dataKey = randomBytes(32);
      const wrappedDataKey = await provider.wrapDataKey(key, context.tenantId, dataKey);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      cipher.setAAD(Buffer.from(`${context.tenantId}\0${secretId}\0${key.provider}\0${key.keyId}\0${key.version}`));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const result = Object.freeze({
        schemaVersion: ENVELOPE_SECRET_SCHEMA_VERSION,
        tenantId: context.tenantId,
        secretId,
        key: Object.freeze({ ...key }),
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
      this.lifecycle.assertDecryptable(context.tenantId, envelope.key);
      const provider = this.#providers.get(envelope.key.provider);
      if (!provider || !provider.enabled) throw new Error("vault_provider_disabled");
      const dataKey = await provider.unwrapDataKey(envelope.key, context.tenantId, envelope.wrappedDataKey);
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(Buffer.from(`${context.tenantId}\0${envelope.secretId}\0${envelope.key.provider}\0${envelope.key.keyId}\0${envelope.key.version}`));
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
    this.lifecycle.rotate(context.tenantId, envelope.key, next, context.at);
    return this.encrypt(envelope.secretId, plaintext, next.key, context, "rotate");
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
