import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  completeSecretBreakGlassOperation,
  createSecretLifecycle,
  getActiveSecretLifecycle,
  getSecretBreakGlassOperation,
  getSecretLifecycleOperation,
  getSecretRewrapOperation,
  getSecretLifecycleVersion,
  revokeSecretLifecycle,
  rewrapSecretLifecycle,
  rotateSecretLifecycle,
  type AppDb,
  type SecretLifecycleInput,
  type SecretLifecycleVersionRow,
} from "@mendpoint/db";
import {
  attestEnvelopeKey,
  cryptographicKeyMaterialFingerprint,
  openEnvelopeSecret,
  sealEnvelopeSecret,
  type EnvelopeKeyLocator,
  type EnvelopeAccessAuditEvent,
  type EnvelopeSecret,
  type KeyEncryptionKeyProvider,
  type Role,
} from "@mendpoint/platform";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export type SecretLifecycleAudit = Readonly<{
  id: string;
  tenantId: string;
  actorId: string;
  credentialPrincipalId: string;
  idempotencyKey: string;
  requestId: string | null;
  apiKeyId: string | null;
  action:
    | "secret.lifecycle.created"
    | "secret.lifecycle.create_replayed"
    | "secret.lifecycle.rotated"
    | "secret.lifecycle.rotate_replayed"
    | "secret.lifecycle.rewrapped"
    | "secret.lifecycle.rewrap_replayed"
    | "secret.lifecycle.revoked"
    | "secret.lifecycle.revoke_replayed"
    | "secret.lifecycle.revoke_denied"
    | "secret.lifecycle.rotation_source.granted"
    | "secret.lifecycle.rotation_source.denied"
    | "secret.lifecycle.rotation_source.attempted"
    | "secret.lifecycle.rewrap_source.granted"
    | "secret.lifecycle.rewrap_source.denied"
    | "secret.lifecycle.rewrap_source.attempted"
    | "secret.break_glass.granted"
    | "secret.break_glass.replayed"
    | "secret.break_glass.denied";
  credentialId: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type SecretLifecycleRequestCommitment = Readonly<{
  keyId: string;
  key: Uint8Array;
}>;

export type DurableSecretLifecycleServiceOptions = Readonly<{
  db: AppDb;
  tenantId: string;
  actorId: string;
  credentialPrincipalId: string;
  role: Role;
  authorityRole: Role;
  providers: readonly KeyEncryptionKeyProvider[];
  breakGlassEnabled: boolean;
  requestId: string | null;
  apiKeyId: string | null;
  requestCommitment?: SecretLifecycleRequestCommitment;
  audit: (event: SecretLifecycleAudit) => void;
  now?: () => string;
}>;

type CreateInput = Readonly<{
  idempotencyKey: string;
  credentialId: string;
  sourceRef: string;
  plaintext: string;
  audiences: readonly string[];
  expiresAt?: string;
  rotateAfter?: string;
  key: EnvelopeKeyLocator;
}>;

type RotateInput = Readonly<{
  idempotencyKey: string;
  credentialId: string;
  expectedGeneration: number;
  plaintext: string;
  key: EnvelopeKeyLocator;
}>;

type RewrapInput = Readonly<Omit<RotateInput, "plaintext">>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const REQUEST_COMMITMENT_DOMAIN = "mendpoint:secret-lifecycle:request-commitment:v1\0";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("secret_lifecycle_commitment_request_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`;
  }
  throw new Error("secret_lifecycle_commitment_request_invalid");
}

export function secretLifecycleRequestCommitmentFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SecretLifecycleRequestCommitment | undefined {
  const keyId = env.MENDPOINT_SECRET_IDEMPOTENCY_KEY_ID?.trim();
  const encoded = env.MENDPOINT_SECRET_IDEMPOTENCY_KEY_BASE64?.trim();
  if (!keyId && !encoded) return undefined;
  if (!keyId || !encoded || !ID.test(keyId)) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  return Object.freeze({ keyId, key });
}

export function assertSecretLifecycleKeySeparation(
  providers: readonly KeyEncryptionKeyProvider[],
  requestCommitment?: SecretLifecycleRequestCommitment,
): void {
  if (!requestCommitment) return;
  const commitmentFingerprint = cryptographicKeyMaterialFingerprint(requestCommitment.key);
  for (const provider of providers) {
    if (provider.keyMaterialFingerprints().includes(commitmentFingerprint)) {
      throw new Error("secret_lifecycle_key_material_reuse");
    }
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "secret_break_glass_denied";
}

export class AuditedBreakGlassError extends Error {
  readonly auditHandled = true;
}

export function isAuditedBreakGlassError(error: unknown): error is AuditedBreakGlassError {
  return error instanceof AuditedBreakGlassError;
}

function envelopeFromRow(row: SecretLifecycleVersionRow): EnvelopeSecret {
  return Object.freeze({
    schemaVersion: 1,
    tenantId: row.tenant_id,
    secretId: row.credential_id,
    generation: row.generation,
    key: Object.freeze({
      provider: row.key_provider,
      keyId: row.key_id,
      version: row.key_version,
      customerManaged: row.customer_managed === 1,
    }),
    keyAttestationSha256: row.key_attestation_sha256 ?? "",
    algorithm: "AES-256-GCM",
    wrappedDataKey: row.wrapped_data_key,
    iv: row.iv,
    authTag: row.auth_tag,
    ciphertext: row.ciphertext,
    createdAt: row.created_at,
  });
}

function publicResult(row: SecretLifecycleVersionRow) {
  return Object.freeze({
    credentialId: row.credential_id,
    sourceRef: row.source_ref,
    generation: row.generation,
    state: row.state,
    customerManaged: row.customer_managed === 1,
    custody: row.customer_managed === 1 ? "customer-managed" : "mendpoint-custodied",
    key: Object.freeze({ provider: row.key_provider, keyId: row.key_id, version: row.key_version }),
    issuedAt: row.issued_at,
    retiredAt: row.retired_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
  });
}

export class DurableSecretLifecycleService {
  private readonly requestCommitment?: Readonly<{ keyId: string; key: Buffer }>;

  constructor(private readonly options: DurableSecretLifecycleServiceOptions) {
    assertSecretLifecycleKeySeparation(options.providers, options.requestCommitment);
    if (options.requestCommitment) {
      if (!ID.test(options.requestCommitment.keyId) || options.requestCommitment.key.byteLength !== 32) {
        throw new Error("secret_lifecycle_commitment_configuration_invalid");
      }
      this.requestCommitment = Object.freeze({
        keyId: options.requestCommitment.keyId,
        key: Buffer.from(options.requestCommitment.key),
      });
    }
  }

  #now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  #authorizeAdmin(): void {
    if (this.options.role !== "owner" && this.options.role !== "admin") {
      throw new Error("secret_lifecycle_authority_required");
    }
    if (!ID.test(this.options.tenantId) || !ID.test(this.options.actorId)) {
      throw new Error("secret_lifecycle_authority_invalid");
    }
  }

  #replay(
    kind: "create" | "rotate",
    idempotencyKey: string,
    requestDigest: string,
    requestCommitmentKeyId: string,
    credentialId: string,
    generation: number,
  ): SecretLifecycleVersionRow | undefined {
    const existing = getSecretLifecycleOperation(this.options.db, this.options.tenantId, idempotencyKey);
    if (!existing) return undefined;
    if (
      existing.operation !== kind || existing.request_digest !== requestDigest ||
      existing.request_commitment_key_id !== requestCommitmentKeyId ||
      existing.actor_id !== this.options.actorId || existing.credential_id !== credentialId ||
      existing.result_generation !== generation
    ) throw new Error("secret_lifecycle_idempotency_conflict");
    const row = getSecretLifecycleVersion(
      this.options.db,
      this.options.tenantId,
      credentialId,
      generation,
    );
    if (!row) throw new Error("secret_lifecycle_idempotency_corrupt");
    return row;
  }

  #rewrapReplay(
    idempotencyKey: string,
    requestDigest: string,
    requestCommitmentKeyId: string,
    credentialId: string,
    generation: number,
  ): SecretLifecycleVersionRow | undefined {
    const existing = getSecretRewrapOperation(this.options.db, this.options.tenantId, idempotencyKey);
    if (!existing) return undefined;
    if (
      existing.request_digest !== requestDigest ||
      existing.request_commitment_key_id !== requestCommitmentKeyId ||
      existing.actor_id !== this.options.actorId || existing.credential_id !== credentialId ||
      existing.result_generation !== generation
    ) throw new Error("secret_lifecycle_idempotency_conflict");
    const row = getSecretLifecycleVersion(
      this.options.db, this.options.tenantId, credentialId, generation,
    );
    if (!row) throw new Error("secret_lifecycle_idempotency_corrupt");
    return row;
  }

  #audit(
    action: SecretLifecycleAudit["action"],
    idempotencyKey: string,
    credentialId: string,
    metadata: Readonly<Record<string, unknown>>,
    identity: string = action,
    requestId: string | null = this.options.requestId,
    apiKeyId: string | null = this.options.apiKeyId,
    credentialPrincipalId: string = this.options.credentialPrincipalId,
  ): void {
    this.options.audit(Object.freeze({
      id: digest({ tenantId: this.options.tenantId, idempotencyKey, identity }),
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialPrincipalId,
      idempotencyKey,
      requestId,
      apiKeyId,
      action,
      credentialId,
      metadata: Object.freeze({
        ...metadata,
        authorityPrincipalId: this.options.actorId,
        credentialPrincipalId,
      }),
    }));
  }

  #auditReplay(
    action: Extract<
      SecretLifecycleAudit["action"],
      | "secret.lifecycle.create_replayed"
      | "secret.lifecycle.rotate_replayed"
      | "secret.lifecycle.rewrap_replayed"
      | "secret.lifecycle.revoke_replayed"
      | "secret.break_glass.replayed"
    >,
    idempotencyKey: string,
    credentialId: string,
    generation: number,
  ): void {
    try {
      this.#audit(
        action,
        idempotencyKey,
        credentialId,
        { replayed: true, generation },
        `${action}:${this.options.requestId ?? randomUUID()}:${this.options.credentialPrincipalId}:${this.options.apiKeyId ?? "no-api-key"}`,
      );
    } catch {
      throw new Error("vault_access_audit_failed");
    }
  }

  #commitRequest(value: unknown): Readonly<{ digest: string; keyId: string }> {
    if (!this.requestCommitment) throw new Error("secret_lifecycle_commitment_unconfigured");
    const canonical = canonicalJson({
      schemaVersion: 1,
      keyId: this.requestCommitment.keyId,
      request: value,
    });
    return Object.freeze({
      digest: createHmac("sha256", this.requestCommitment.key)
        .update(REQUEST_COMMITMENT_DOMAIN, "utf8")
        .update(canonical, "utf8")
        .digest("hex"),
      keyId: this.requestCommitment.keyId,
    });
  }

  async #openMutationSource(
    current: SecretLifecycleVersionRow,
    idempotencyKey: string,
    operation: "rotation" | "rewrap",
    purpose: string,
  ): Promise<string> {
    const attemptedAction = operation === "rotation"
      ? "secret.lifecycle.rotation_source.attempted"
      : "secret.lifecycle.rewrap_source.attempted";
    const grantedAction = operation === "rotation"
      ? "secret.lifecycle.rotation_source.granted"
      : "secret.lifecycle.rewrap_source.granted";
    const deniedAction = operation === "rotation"
      ? "secret.lifecycle.rotation_source.denied"
      : "secret.lifecycle.rewrap_source.denied";
    try {
      this.#audit(
        attemptedAction,
        idempotencyKey,
        current.credential_id,
        { generation: current.generation, outcome: "attempted", purpose },
        `${attemptedAction}:${this.options.requestId ?? randomUUID()}:${this.options.credentialPrincipalId}:${this.options.apiKeyId ?? "no-api-key"}`,
      );
    } catch {
      throw new Error("vault_access_audit_failed");
    }
    let sourceAccess: EnvelopeAccessAuditEvent | undefined;
    const plaintext = await openEnvelopeSecret(envelopeFromRow(current), {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: idempotencyKey,
      purpose,
      at: this.#now(),
    }, this.options.providers, (event) => {
      sourceAccess = event;
      this.#audit(
        event.outcome === "granted" ? grantedAction : deniedAction,
        idempotencyKey,
        current.credential_id,
        {
          generation: current.generation,
          purpose,
          reason: event.reason,
          outcome: event.outcome,
          keyProvider: event.key.provider,
          keyId: event.key.keyId,
          keyVersion: event.key.version,
          attestationSha256: current.key_attestation_sha256,
        },
        event.outcome === "granted" ? grantedAction : deniedAction,
        idempotencyKey,
        null,
        this.options.actorId,
      );
    });
    if (!sourceAccess || sourceAccess.outcome !== "granted") {
      throw new Error("secret_rotation_source_audit_missing");
    }
    return plaintext;
  }

  #auditBreakGlassDenied(
    input: Readonly<{ credentialId: string; reason: unknown; idempotencyKey: string }>,
    failure: string,
    current?: SecretLifecycleVersionRow,
    access?: EnvelopeAccessAuditEvent,
  ): void {
    const attemptIdentity = this.options.requestId ?? randomUUID();
    const auditTenantId = ID.test(this.options.tenantId)
      ? this.options.tenantId
      : "tenant_unattributed";
    const auditActorId = ID.test(this.options.actorId)
      ? this.options.actorId
      : "principal_unattributed";
    const auditIdempotencyKey = input.idempotencyKey || "invalid-idempotency-key";
    this.options.audit(Object.freeze({
      id: digest({
        tenantId: auditTenantId,
        idempotencyKey: auditIdempotencyKey,
        identity: `secret.break_glass.denied:${attemptIdentity}:${this.options.credentialPrincipalId}:${this.options.apiKeyId ?? "no-api-key"}`,
      }),
      tenantId: auditTenantId,
      actorId: auditActorId,
      credentialPrincipalId: this.options.credentialPrincipalId,
      idempotencyKey: auditIdempotencyKey,
      requestId: this.options.requestId,
      apiKeyId: this.options.apiKeyId,
      action: "secret.break_glass.denied",
      credentialId: input.credentialId || "invalid-credential-id",
      metadata: Object.freeze({
        outcome: "denied",
        failure,
        role: this.options.role,
        tenantId: this.options.tenantId,
        actorId: this.options.actorId,
        authorityPrincipalId: this.options.actorId,
        credentialPrincipalId: this.options.credentialPrincipalId,
        requestId: this.options.requestId,
        reason: typeof input.reason === "string" ? input.reason.trim() || null : null,
        idempotencyKey: input.idempotencyKey || null,
        generation: current?.generation ?? null,
        accessReason: access?.reason ?? null,
        keyProvider: access?.key.provider ?? current?.key_provider ?? null,
        keyId: access?.key.keyId ?? current?.key_id ?? null,
        keyVersion: access?.key.version ?? current?.key_version ?? null,
        attestationSha256: current?.key_attestation_sha256 ?? null,
      }),
    }));
  }

  async create(input: CreateInput) {
    this.#authorizeAdmin();
    const commitment = this.#commitRequest({
      operation: "create",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      sourceRef: input.sourceRef,
      plaintext: input.plaintext,
      audiences: [...input.audiences],
      expiresAt: input.expiresAt ?? null,
      rotateAfter: input.rotateAfter ?? null,
      key: input.key,
    });
    const replay = this.#replay(
      "create",
      input.idempotencyKey,
      commitment.digest,
      commitment.keyId,
      input.credentialId,
      1,
    );
    if (replay) {
      this.#auditReplay(
        "secret.lifecycle.create_replayed",
        input.idempotencyKey,
        input.credentialId,
        replay.generation,
      );
      return publicResult(replay);
    }

    const at = this.#now();
    const attested = await attestEnvelopeKey(this.options.providers, this.options.tenantId, input.key);
    const envelope = await sealEnvelopeSecret(input.credentialId, input.plaintext, 1, attested, {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: input.idempotencyKey,
      purpose: "create durable secret",
      at,
    }, this.options.providers);
    const lifecycle: SecretLifecycleInput = {
      tenantId: this.options.tenantId,
      credentialId: input.credentialId,
      sourceRef: input.sourceRef,
      generation: 1,
      audiences: input.audiences,
      expiresAt: input.expiresAt,
      issuedAt: at,
      rotateAfter: input.rotateAfter,
      key: attested,
      materialLineageId: commitment.digest,
      envelope,
    };
    const row = createSecretLifecycle(this.options.db, lifecycle, {
      operation: {
        idempotencyKey: input.idempotencyKey,
        requestDigest: commitment.digest,
        requestCommitmentKeyId: commitment.keyId,
        actorId: this.options.actorId,
      },
      audit: () => this.#audit("secret.lifecycle.created", input.idempotencyKey, input.credentialId, {
        generation: 1,
        keyProvider: attested.provider,
        keyId: attested.keyId,
        keyVersion: attested.version,
        customerManaged: attested.customerManaged,
        attestationSha256: attested.attestationSha256,
      }),
    });
    return publicResult(row);
  }

  async rotate(input: RotateInput) {
    this.#authorizeAdmin();
    if (typeof input.plaintext !== "string" || input.plaintext.length === 0) {
      throw new Error("secret_rotation_material_required");
    }
    const nextGeneration = input.expectedGeneration + 1;
    const commitment = this.#commitRequest({
      operation: "rotate",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      expectedGeneration: input.expectedGeneration,
      plaintext: input.plaintext,
      key: input.key,
    });
    const replay = this.#replay(
      "rotate", input.idempotencyKey, commitment.digest, commitment.keyId,
      input.credentialId, nextGeneration,
    );
    if (replay) {
      this.#auditReplay("secret.lifecycle.rotate_replayed", input.idempotencyKey, input.credentialId, replay.generation);
      return publicResult(replay);
    }
    const current = getActiveSecretLifecycle(this.options.db, this.options.tenantId, input.credentialId);
    if (!current) throw new Error("secret_lifecycle_not_found");
    if (current.generation !== input.expectedGeneration) throw new Error("secret_rotation_generation_conflict");
    const currentPlaintext = await this.#openMutationSource(
      current,
      input.idempotencyKey,
      "rotation",
      "validate replacement credential material",
    );
    const currentBytes = Buffer.from(currentPlaintext, "utf8");
    const replacementBytes = Buffer.from(input.plaintext, "utf8");
    if (
      currentBytes.length === replacementBytes.length &&
      timingSafeEqual(currentBytes, replacementBytes)
    ) {
      throw new Error("secret_rotation_material_unchanged");
    }
    const at = this.#now();
    const attested = await attestEnvelopeKey(this.options.providers, this.options.tenantId, input.key);
    const envelope = await sealEnvelopeSecret(input.credentialId, input.plaintext, nextGeneration, attested, {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: input.idempotencyKey,
      purpose: "rotate durable credential material",
      at,
    }, this.options.providers);
    const next: SecretLifecycleInput = {
      tenantId: current.tenant_id,
      credentialId: current.credential_id,
      sourceRef: current.source_ref,
      generation: nextGeneration,
      audiences: JSON.parse(current.audiences_json) as string[],
      expiresAt: current.expires_at ?? undefined,
      issuedAt: at,
      rotateAfter: current.rotate_after ?? undefined,
      key: attested,
      materialLineageId: commitment.digest,
      envelope,
    };
    const row = rotateSecretLifecycle(this.options.db, {
      expectedGeneration: input.expectedGeneration,
      rotatedAt: at,
      next,
    }, {
      operation: {
        idempotencyKey: input.idempotencyKey,
        requestDigest: commitment.digest,
        requestCommitmentKeyId: commitment.keyId,
        actorId: this.options.actorId,
      },
      audit: () => this.#audit("secret.lifecycle.rotated", input.idempotencyKey, input.credentialId, {
        previousGeneration: input.expectedGeneration,
        generation: nextGeneration,
        keyProvider: attested.provider,
        keyId: attested.keyId,
        keyVersion: attested.version,
        customerManaged: attested.customerManaged,
        attestationSha256: attested.attestationSha256,
        materialReplaced: true,
      }),
    });
    return publicResult(row);
  }

  async rewrap(input: RewrapInput) {
    this.#authorizeAdmin();
    const nextGeneration = input.expectedGeneration + 1;
    const commitment = this.#commitRequest({
      operation: "rewrap",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      expectedGeneration: input.expectedGeneration,
      key: input.key,
    });
    const replay = this.#rewrapReplay(
      input.idempotencyKey,
      commitment.digest,
      commitment.keyId,
      input.credentialId,
      nextGeneration,
    );
    if (replay) {
      this.#auditReplay(
        "secret.lifecycle.rewrap_replayed",
        input.idempotencyKey,
        input.credentialId,
        replay.generation,
      );
      return publicResult(replay);
    }
    const current = getActiveSecretLifecycle(this.options.db, this.options.tenantId, input.credentialId);
    if (!current) throw new Error("secret_lifecycle_not_found");
    if (current.generation !== input.expectedGeneration) throw new Error("secret_rotation_generation_conflict");
    if (!current.material_lineage_id) throw new Error("secret_material_lineage_missing");
    if (
      input.key.provider === current.key_provider &&
      input.key.keyId === current.key_id &&
      input.key.version === current.key_version
    ) {
      throw new Error("secret_rewrap_key_unchanged");
    }
    const at = this.#now();
    const plaintext = await this.#openMutationSource(
      current,
      input.idempotencyKey,
      "rewrap",
      "rewrap durable credential material",
    );
    const attested = await attestEnvelopeKey(this.options.providers, this.options.tenantId, input.key);
    const currentProvider = this.options.providers.find(
      (provider) => provider.provider === current.key_provider && provider.enabled,
    );
    const targetProvider = this.options.providers.find(
      (provider) => provider.provider === attested.provider && provider.enabled,
    );
    if (!currentProvider || !targetProvider) throw new Error("vault_provider_disabled");
    const [currentMaterial, targetMaterial] = await Promise.all([
      currentProvider.keyMaterialFingerprint({
        provider: current.key_provider,
        keyId: current.key_id,
        version: current.key_version,
      }, this.options.tenantId),
      targetProvider.keyMaterialFingerprint(input.key, this.options.tenantId),
    ]);
    if (currentMaterial === targetMaterial) {
      throw new Error("secret_rewrap_key_material_unchanged");
    }
    const envelope = await sealEnvelopeSecret(input.credentialId, plaintext, nextGeneration, attested, {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: input.idempotencyKey,
      purpose: "rotate durable secret",
      at,
    }, this.options.providers);
    const next: SecretLifecycleInput = {
      tenantId: current.tenant_id,
      credentialId: current.credential_id,
      sourceRef: current.source_ref,
      generation: nextGeneration,
      audiences: JSON.parse(current.audiences_json) as string[],
      expiresAt: current.expires_at ?? undefined,
      issuedAt: at,
      rotateAfter: current.rotate_after ?? undefined,
      key: attested,
      materialLineageId: current.material_lineage_id,
      envelope,
    };
    const row = rewrapSecretLifecycle(this.options.db, {
      expectedGeneration: input.expectedGeneration,
      rotatedAt: at,
      next,
    }, {
      operation: {
        idempotencyKey: input.idempotencyKey,
        requestDigest: commitment.digest,
        requestCommitmentKeyId: commitment.keyId,
        actorId: this.options.actorId,
      },
      audit: () => {
        this.#audit("secret.lifecycle.rewrapped", input.idempotencyKey, input.credentialId, {
          previousGeneration: input.expectedGeneration,
          generation: nextGeneration,
          keyProvider: attested.provider,
          keyId: attested.keyId,
          keyVersion: attested.version,
          customerManaged: attested.customerManaged,
          attestationSha256: attested.attestationSha256,
        });
      },
    });
    return publicResult(row);
  }

  revoke(input: Readonly<{
    idempotencyKey: string;
    credentialId: string;
    generation: number;
    reason: string;
  }>) {
    this.#authorizeAdmin();
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    const commitment = this.#commitRequest({
      operation: "revoke",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      generation: input.generation,
      reason,
    });
    const at = this.#now();
    const row = revokeSecretLifecycle(this.options.db, {
      tenantId: this.options.tenantId,
      credentialId: input.credentialId,
      generation: input.generation,
      revokedAt: at,
      reason,
    }, {
      operation: {
        idempotencyKey: input.idempotencyKey,
        requestDigest: commitment.digest,
        requestCommitmentKeyId: commitment.keyId,
        actorId: this.options.actorId,
      },
      audit: () => this.#audit("secret.lifecycle.revoked", input.idempotencyKey, input.credentialId, {
        generation: input.generation,
        reason,
      }),
      replayAudit: () => this.#auditReplay(
        "secret.lifecycle.revoke_replayed",
        input.idempotencyKey,
        input.credentialId,
        input.generation,
      ),
    });
    return publicResult(row);
  }

  async breakGlass(input: Readonly<{
    credentialId: string;
    reason: unknown;
    idempotencyKey: string;
  }>): Promise<string> {
    let current: SecretLifecycleVersionRow | undefined;
    let denialAudited = false;
    try {
      this.#authorizeAdmin();
      if (this.options.role !== "owner") throw new Error("secret_break_glass_owner_required");
      if (this.options.authorityRole !== "owner") throw new Error("secret_break_glass_owner_required");
      if (!this.options.breakGlassEnabled) throw new Error("secret_break_glass_disabled");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (!reason) throw new Error("secret_break_glass_reason_required");
      if (!ID.test(input.idempotencyKey)) throw new Error("secret_lifecycle_idempotency_key_invalid");
      const commitment = this.#commitRequest({
        operation: "break_glass",
        idempotencyKey: input.idempotencyKey,
        tenantId: this.options.tenantId,
        actorId: this.options.actorId,
        credentialId: input.credentialId,
        reason,
      });
      const existing = getSecretBreakGlassOperation(
        this.options.db,
        this.options.tenantId,
        input.idempotencyKey,
      );
      if (existing && (
        existing.request_digest !== commitment.digest ||
        existing.request_commitment_key_id !== commitment.keyId ||
        existing.actor_id !== this.options.actorId ||
        existing.credential_id !== input.credentialId
      )) throw new Error("secret_lifecycle_idempotency_conflict");
      current = getActiveSecretLifecycle(this.options.db, this.options.tenantId, input.credentialId);
      if (!current) throw new Error("secret_lifecycle_not_found");
      if (existing && existing.generation !== current.generation) {
        throw new Error("secret_lifecycle_idempotency_conflict");
      }
      const at = this.#now();
      let access: EnvelopeAccessAuditEvent | undefined;
      const plaintext = await openEnvelopeSecret(envelopeFromRow(current), {
        tenantId: this.options.tenantId,
        actorId: this.options.actorId,
        correlationId: input.idempotencyKey,
        purpose: `break glass: ${reason}`,
        at,
      }, this.options.providers, (event) => {
        access = event;
        if (event.outcome === "denied") {
          this.#auditBreakGlassDenied(input, event.reason, current, event);
          denialAudited = true;
        }
      });
      if (!access || access.outcome !== "granted") {
        throw new Error("secret_break_glass_access_audit_missing");
      }
      const completion = completeSecretBreakGlassOperation(this.options.db, {
        tenantId: this.options.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: commitment.digest,
        requestCommitmentKeyId: commitment.keyId,
        actorId: this.options.actorId,
        credentialId: input.credentialId,
        generation: current.generation,
        key: {
          provider: current.key_provider,
          keyId: current.key_id,
          version: current.key_version,
          attestationSha256: current.key_attestation_sha256 ?? "",
        },
        completedAt: at,
      }, {
        audit: () => this.#audit("secret.break_glass.granted", input.idempotencyKey, input.credentialId, {
          generation: current!.generation,
          reason,
          accessReason: access!.reason,
          outcome: access!.outcome,
          keyProvider: access!.key.provider,
          keyId: access!.key.keyId,
          keyVersion: access!.key.version,
          attestationSha256: current!.key_attestation_sha256,
          requestCommitmentKeyId: commitment.keyId,
        }, "secret.break_glass.operation"),
      });
      if (completion.replayed) {
        this.#auditReplay(
          "secret.break_glass.replayed",
          input.idempotencyKey,
          input.credentialId,
          current.generation,
        );
      }
      return plaintext;
    } catch (error) {
      if (isAuditedBreakGlassError(error)) throw error;
      if (!denialAudited) {
        try {
          this.#auditBreakGlassDenied(input, errorCode(error), current);
        } catch {
          throw new AuditedBreakGlassError("vault_access_audit_failed");
        }
      }
      throw new AuditedBreakGlassError(errorCode(error));
    }
  }
}
