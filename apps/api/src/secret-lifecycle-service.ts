import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  completeSecretBreakGlassOperation,
  createSecretLifecycle,
  getActiveSecretLifecycle,
  getSecretBreakGlassOperation,
  getSecretLifecycleOperation,
  getSecretLifecycleVersion,
  revokeSecretLifecycle,
  rotateSecretLifecycle,
  type AppDb,
  type SecretLifecycleInput,
  type SecretLifecycleVersionRow,
} from "@mendpoint/db";
import {
  attestEnvelopeKey,
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
  idempotencyKey: string;
  requestId: string | null;
  apiKeyId: string | null;
  action:
    | "secret.lifecycle.created"
    | "secret.lifecycle.rotated"
    | "secret.lifecycle.revoked"
    | "secret.lifecycle.rotation_source.granted"
    | "secret.lifecycle.rotation_source.denied"
    | "secret.break_glass.granted"
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
  role: Role;
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
  key: EnvelopeKeyLocator;
}>;

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

  #audit(
    action: SecretLifecycleAudit["action"],
    idempotencyKey: string,
    credentialId: string,
    metadata: Readonly<Record<string, unknown>>,
    identity: string = action,
    requestId: string | null = this.options.requestId,
    apiKeyId: string | null = this.options.apiKeyId,
  ): void {
    this.options.audit(Object.freeze({
      id: digest({ tenantId: this.options.tenantId, idempotencyKey, identity }),
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      idempotencyKey,
      requestId,
      apiKeyId,
      action,
      credentialId,
      metadata,
    }));
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
        identity: `secret.break_glass.denied:${attemptIdentity}`,
      }),
      tenantId: auditTenantId,
      actorId: auditActorId,
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
    if (replay) return publicResult(replay);

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
    const nextGeneration = input.expectedGeneration + 1;
    const commitment = this.#commitRequest({
      operation: "rotate",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      expectedGeneration: input.expectedGeneration,
      key: input.key,
    });
    const replay = this.#replay(
      "rotate",
      input.idempotencyKey,
      commitment.digest,
      commitment.keyId,
      input.credentialId,
      nextGeneration,
    );
    if (replay) return publicResult(replay);
    const current = getActiveSecretLifecycle(this.options.db, this.options.tenantId, input.credentialId);
    if (!current) throw new Error("secret_lifecycle_not_found");
    if (current.generation !== input.expectedGeneration) throw new Error("secret_rotation_generation_conflict");
    const at = this.#now();
    let sourceAccess: EnvelopeAccessAuditEvent | undefined;
    const plaintext = await openEnvelopeSecret(envelopeFromRow(current), {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: input.idempotencyKey,
      purpose: "stage durable secret rotation",
      at,
    }, this.options.providers, (event) => {
      sourceAccess = event;
      this.#audit(
        event.outcome === "granted"
          ? "secret.lifecycle.rotation_source.granted"
          : "secret.lifecycle.rotation_source.denied",
        input.idempotencyKey,
        input.credentialId,
        {
          generation: current.generation,
          reason: event.reason,
          outcome: event.outcome,
          keyProvider: event.key.provider,
          keyId: event.key.keyId,
          keyVersion: event.key.version,
          attestationSha256: current.key_attestation_sha256,
        },
        event.outcome === "granted"
          ? "secret.lifecycle.rotation_source.granted"
          : "secret.lifecycle.rotation_source.denied",
        input.idempotencyKey,
        null,
      );
    });
    if (!sourceAccess || sourceAccess.outcome !== "granted") {
      throw new Error("secret_rotation_source_audit_missing");
    }
    const attested = await attestEnvelopeKey(this.options.providers, this.options.tenantId, input.key);
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
      audit: () => {
        this.#audit("secret.lifecycle.rotated", input.idempotencyKey, input.credentialId, {
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

  revoke(input: Readonly<{ credentialId: string; generation: number; reason: string }>) {
    this.#authorizeAdmin();
    const at = this.#now();
    const row = revokeSecretLifecycle(this.options.db, {
      tenantId: this.options.tenantId,
      credentialId: input.credentialId,
      generation: input.generation,
      revokedAt: at,
      reason: input.reason,
    }, {
      audit: () => this.#audit("secret.lifecycle.revoked", `revoke:${input.credentialId}:${input.generation}`, input.credentialId, {
        generation: input.generation,
        reason: input.reason,
      }),
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
      completeSecretBreakGlassOperation(this.options.db, {
        tenantId: this.options.tenantId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: commitment.digest,
        requestCommitmentKeyId: commitment.keyId,
        actorId: this.options.actorId,
        credentialId: input.credentialId,
        generation: current.generation,
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
