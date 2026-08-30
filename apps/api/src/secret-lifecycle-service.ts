import { createHash } from "node:crypto";
import {
  createSecretLifecycle,
  getActiveSecretLifecycle,
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

export type DurableSecretLifecycleServiceOptions = Readonly<{
  db: AppDb;
  tenantId: string;
  actorId: string;
  role: Role;
  providers: readonly KeyEncryptionKeyProvider[];
  breakGlassEnabled: boolean;
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
  constructor(private readonly options: DurableSecretLifecycleServiceOptions) {}

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
    credentialId: string,
    generation: number,
  ): SecretLifecycleVersionRow | undefined {
    const existing = getSecretLifecycleOperation(this.options.db, this.options.tenantId, idempotencyKey);
    if (!existing) return undefined;
    if (
      existing.operation !== kind || existing.request_digest !== requestDigest ||
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
  ): void {
    this.options.audit(Object.freeze({
      id: digest({ tenantId: this.options.tenantId, idempotencyKey, identity }),
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      idempotencyKey,
      action,
      credentialId,
      metadata,
    }));
  }

  async create(input: CreateInput) {
    this.#authorizeAdmin();
    const requestDigest = digest({
      operation: "create",
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      sourceRef: input.sourceRef,
      plaintextSha256: digest(input.plaintext),
      audiences: [...input.audiences],
      expiresAt: input.expiresAt ?? null,
      rotateAfter: input.rotateAfter ?? null,
      key: input.key,
    });
    const replay = this.#replay("create", input.idempotencyKey, requestDigest, input.credentialId, 1);
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
      operation: { idempotencyKey: input.idempotencyKey, requestDigest, actorId: this.options.actorId },
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
    const requestDigest = digest({
      operation: "rotate",
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      expectedGeneration: input.expectedGeneration,
      key: input.key,
    });
    const replay = this.#replay(
      "rotate",
      input.idempotencyKey,
      requestDigest,
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
      operation: { idempotencyKey: input.idempotencyKey, requestDigest, actorId: this.options.actorId },
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
    reason: string;
    idempotencyKey: string;
  }>): Promise<string> {
    this.#authorizeAdmin();
    if (this.options.role !== "owner") throw new Error("secret_break_glass_owner_required");
    if (!this.options.breakGlassEnabled) throw new Error("secret_break_glass_disabled");
    if (!input.reason.trim()) throw new Error("secret_break_glass_reason_required");
    if (!ID.test(input.idempotencyKey)) throw new Error("secret_lifecycle_idempotency_key_invalid");
    const current = getActiveSecretLifecycle(this.options.db, this.options.tenantId, input.credentialId);
    if (!current) throw new Error("secret_lifecycle_not_found");
    const at = this.#now();
    return openEnvelopeSecret(envelopeFromRow(current), {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: input.idempotencyKey,
      purpose: `break glass: ${input.reason.trim()}`,
      at,
    }, this.options.providers, (event) => this.#audit(
      event.outcome === "granted" ? "secret.break_glass.granted" : "secret.break_glass.denied",
      input.idempotencyKey,
      input.credentialId,
      {
        generation: current.generation,
        reason: input.reason.trim(),
        accessReason: event.reason,
        outcome: event.outcome,
        keyProvider: event.key.provider,
        keyId: event.key.keyId,
        keyVersion: event.key.version,
        attestationSha256: current.key_attestation_sha256,
      },
      "secret.break_glass.attempt",
    ));
  }
}
