import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import type { SecretLifecycleVersionRow } from "./schema.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._/@:-]+$/;
const MAX_AUDIENCES = 64;
const MAX_REASON_CHARS = 4_096;

export type SecretLifecycleInput = Readonly<{
  tenantId: string;
  credentialId: string;
  sourceRef: string;
  generation: number;
  audiences: readonly string[];
  expiresAt?: string;
  issuedAt: string;
  rotateAfter?: string;
  key: Readonly<{
    provider: string;
    keyId: string;
    version: string;
    customerManaged: boolean;
  }>;
  materialLineageId: string;
  materialLineageKeyId: string;
  envelope: Readonly<{
    schemaVersion: 1;
    algorithm: "AES-256-GCM";
    wrappedDataKey: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    createdAt: string;
    keyAttestationSha256: string;
  }>;
}>;

export type SecretLifecycleCredentialDescriptor = Readonly<{
  credentialId: string;
  secret: Readonly<{ provider: "durable-envelope"; id: string; version: string }>;
  audiences: readonly string[];
  expiresAt?: string;
  revocation?: Readonly<{ revokedAt: string; reason: string }>;
  rotation: Readonly<{
    generation: number;
    issuedAt: string;
    rotatedAt?: string;
    rotateAfter?: string;
  }>;
}>;

export type SecretLifecycleOperationIdentity = Readonly<{
  idempotencyKey: string;
  requestDigest: string;
  requestCommitmentKeyId: string;
  actorId: string;
}>;

export type SecretLifecycleMutationOptions = Readonly<{
  operation?: SecretLifecycleOperationIdentity;
  audit?: (row: SecretLifecycleVersionRow) => void;
  authorizeCommit?: () => void;
}>;

export type SecretLifecycleOperationRow = Readonly<{
  tenant_id: string;
  idempotency_key: string;
  operation: "create" | "rotate";
  request_digest: string;
  request_commitment_key_id: string | null;
  actor_id: string;
  credential_id: string;
  result_generation: number;
  completed_at: string;
}>;

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function validTimestamp(name: string, value: string | undefined): void {
  if (value !== undefined && (
    value.length > 64 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
  )) {
    throw new Error(`${name}_invalid`);
  }
}

function validateInput(input: SecretLifecycleInput): void {
  if (!ID.test(input.tenantId)) throw new Error("secret_tenant_invalid");
  if (!ID.test(input.credentialId)) throw new Error("secret_credential_id_invalid");
  if (input.sourceRef.length > 512 || !SECRET_REF.test(input.sourceRef)) {
    throw new Error("secret_source_reference_invalid");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("secret_generation_invalid");
  }
  if (input.audiences.length < 1 || input.audiences.length > MAX_AUDIENCES ||
      input.audiences.some((audience) => !ID.test(audience)) ||
      new Set(input.audiences).size !== input.audiences.length) {
    throw new Error("secret_audiences_invalid");
  }
  validTimestamp("secret_issued_at", input.issuedAt);
  validTimestamp("secret_expires_at", input.expiresAt);
  validTimestamp("secret_rotate_after", input.rotateAfter);
  validTimestamp("secret_envelope_created_at", input.envelope.createdAt);
  if (!ID.test(input.key.provider) || !ID.test(input.key.keyId) || !ID.test(input.key.version)) {
    throw new Error("secret_key_reference_invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.materialLineageId)) {
    throw new Error("secret_material_lineage_invalid");
  }
  if (!ID.test(input.materialLineageKeyId)) {
    throw new Error("secret_material_lineage_key_id_invalid");
  }
  if (
    input.envelope.schemaVersion !== 1 ||
    input.envelope.algorithm !== "AES-256-GCM" ||
    !input.envelope.wrappedDataKey || input.envelope.wrappedDataKey.length > 16_384 ||
    !input.envelope.iv || input.envelope.iv.length > 512 ||
    !input.envelope.authTag || input.envelope.authTag.length > 512 ||
    !input.envelope.ciphertext || input.envelope.ciphertext.length > 1_500_000
    || !/^[a-f0-9]{64}$/.test(input.envelope.keyAttestationSha256)
  ) {
    throw new Error("secret_envelope_invalid");
  }
}

function transaction<T>(db: AppDb, fn: () => T): T {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (owns) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function validateOperation(operation: SecretLifecycleOperationIdentity): void {
  if (!ID.test(operation.idempotencyKey)) throw new Error("secret_lifecycle_idempotency_key_invalid");
  if (!/^[a-f0-9]{64}$/.test(operation.requestDigest)) {
    throw new Error("secret_lifecycle_request_digest_invalid");
  }
  if (!ID.test(operation.requestCommitmentKeyId)) {
    throw new Error("secret_lifecycle_commitment_key_id_invalid");
  }
  if (!ID.test(operation.actorId)) throw new Error("secret_lifecycle_actor_invalid");
}

function replayedOperation(
  db: AppDb,
  input: SecretLifecycleInput,
  kind: "create" | "rotate",
  operation: SecretLifecycleOperationIdentity,
): SecretLifecycleVersionRow | undefined {
  validateOperation(operation);
  const existing = one<SecretLifecycleOperationRow>(
    db,
    `SELECT * FROM secret_lifecycle_operations WHERE tenant_id = ? AND idempotency_key = ?`,
    [input.tenantId, operation.idempotencyKey],
  );
  if (!existing) return undefined;
  if (
    existing.operation !== kind || existing.request_digest !== operation.requestDigest ||
    existing.request_commitment_key_id !== operation.requestCommitmentKeyId ||
    existing.actor_id !== operation.actorId || existing.credential_id !== input.credentialId ||
    existing.result_generation !== input.generation
  ) throw new Error("secret_lifecycle_idempotency_conflict");
  const row = getSecretLifecycleVersion(
    db,
    input.tenantId,
    existing.credential_id,
    existing.result_generation,
  );
  if (!row) throw new Error("secret_lifecycle_idempotency_corrupt");
  return row;
}

function completeOperation(
  db: AppDb,
  input: SecretLifecycleInput,
  kind: "create" | "rotate",
  operation: SecretLifecycleOperationIdentity,
): void {
  db.raw.prepare(`
    INSERT INTO secret_lifecycle_operations (
      tenant_id, idempotency_key, operation, request_digest, request_commitment_key_id, actor_id,
      credential_id, result_generation, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tenantId,
    operation.idempotencyKey,
    kind,
    operation.requestDigest,
    operation.requestCommitmentKeyId,
    operation.actorId,
    input.credentialId,
    input.generation,
    input.issuedAt,
  );
}

function insertVersion(db: AppDb, input: SecretLifecycleInput): SecretLifecycleVersionRow {
  db.raw.prepare(`
    INSERT INTO secret_lifecycle_versions (
      tenant_id, credential_id, source_ref, generation, state, audiences_json,
      expires_at, issued_at, rotate_after, retired_at, revoked_at, revocation_reason,
      key_provider, key_id, key_version, customer_managed, envelope_schema_version,
      key_attestation_sha256, material_lineage_id, material_lineage_key_id,
      algorithm, wrapped_data_key, iv, auth_tag,
      ciphertext, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.tenantId,
    input.credentialId,
    input.sourceRef,
    input.generation,
    JSON.stringify([...input.audiences]),
    input.expiresAt ?? null,
    input.issuedAt,
    input.rotateAfter ?? null,
    input.key.provider,
    input.key.keyId,
    input.key.version,
    input.key.customerManaged ? 1 : 0,
    input.envelope.schemaVersion,
    input.envelope.keyAttestationSha256,
    input.materialLineageId,
    input.materialLineageKeyId,
    input.envelope.algorithm,
    input.envelope.wrappedDataKey,
    input.envelope.iv,
    input.envelope.authTag,
    input.envelope.ciphertext,
    input.envelope.createdAt,
  );
  return getSecretLifecycleVersion(
    db,
    input.tenantId,
    input.credentialId,
    input.generation,
  )!;
}

export function createSecretLifecycle(
  db: AppDb,
  input: SecretLifecycleInput,
  options: SecretLifecycleMutationOptions = {},
): SecretLifecycleVersionRow {
  validateInput(input);
  if (input.generation !== 1) throw new Error("secret_initial_generation_invalid");
  return transaction(db, () => {
    const replay = options.operation
      ? replayedOperation(db, input, "create", options.operation)
      : undefined;
    if (replay) {
      options.authorizeCommit?.();
      return replay;
    }
    const row = insertVersion(db, input);
    options.audit?.(row);
    if (options.operation) completeOperation(db, input, "create", options.operation);
    options.authorizeCommit?.();
    return row;
  });
}

export function rotateSecretLifecycle(
  db: AppDb,
  input: Readonly<{
    expectedGeneration: number;
    rotatedAt: string;
    next: SecretLifecycleInput;
  }>,
  options: SecretLifecycleMutationOptions & Readonly<{
    materialLineageCandidates?: readonly Readonly<{ keyId: string; lineageId: string }>[];
  }> = {},
): SecretLifecycleVersionRow {
  validateInput(input.next);
  validTimestamp("secret_rotated_at", input.rotatedAt);
  return transaction(db, () => {
    const replay = options.operation
      ? replayedOperation(db, input.next, "rotate", options.operation)
      : undefined;
    if (replay) {
      options.authorizeCommit?.();
      return replay;
    }
    const current = one<SecretLifecycleVersionRow>(
      db,
      `SELECT * FROM secret_lifecycle_versions
       WHERE tenant_id = ? AND credential_id = ? AND state = 'active'`,
      [input.next.tenantId, input.next.credentialId],
    );
    if (!current || current.generation !== input.expectedGeneration) {
      throw new Error("secret_rotation_generation_conflict");
    }
    if (
      input.next.generation !== current.generation + 1 ||
      input.next.sourceRef !== current.source_ref
    ) {
      throw new Error("secret_rotation_target_invalid");
    }
    const candidates = options.materialLineageCandidates ?? Object.freeze([Object.freeze({
      keyId: input.next.materialLineageKeyId,
      lineageId: input.next.materialLineageId,
    })]);
    if (candidates.length === 0 || candidates.some((candidate) =>
      !ID.test(candidate.keyId) || !/^[a-f0-9]{64}$/.test(candidate.lineageId)
    )) throw new Error("secret_material_lineage_invalid");
    let retainedLineage: Readonly<{ keyId: string; lineageId: string }> | undefined;
    for (const candidate of candidates) {
      const matching = one<Pick<SecretLifecycleVersionRow,
        "generation" | "state" | "material_lineage_id" | "material_lineage_key_id">>(
        db,
        `SELECT generation, state, material_lineage_id, material_lineage_key_id
         FROM secret_lifecycle_versions
         WHERE tenant_id = ? AND credential_id = ? AND material_lineage_id = ?
           AND (material_lineage_key_id = ? OR material_lineage_key_id IS NULL)
         ORDER BY CASE WHEN state = 'revoked' THEN 0 ELSE 1 END, generation LIMIT 1`,
        [input.next.tenantId, input.next.credentialId, candidate.lineageId, candidate.keyId],
      );
      if (!matching) continue;
      if (matching.state === "revoked") throw new Error("secret_material_lineage_revoked");
      retainedLineage ??= Object.freeze({
        keyId: matching.material_lineage_key_id ?? candidate.keyId,
        lineageId: matching.material_lineage_id ?? candidate.lineageId,
      });
    }
    const next = retainedLineage
      ? Object.freeze({
        ...input.next,
        materialLineageId: retainedLineage.lineageId,
        materialLineageKeyId: retainedLineage.keyId,
      })
      : input.next;
    db.raw.prepare(`
      UPDATE secret_lifecycle_versions
      SET state = 'retired', retired_at = ?
      WHERE tenant_id = ? AND credential_id = ? AND generation = ? AND state = 'active'
    `).run(input.rotatedAt, current.tenant_id, current.credential_id, current.generation);
    const row = insertVersion(db, next);
    options.audit?.(row);
    if (options.operation) completeOperation(db, input.next, "rotate", options.operation);
    options.authorizeCommit?.();
    return row;
  });
}

export type SecretRewrapOperationRow = Readonly<{
  tenant_id: string;
  idempotency_key: string;
  request_digest: string;
  request_commitment_key_id: string;
  actor_id: string;
  credential_id: string;
  result_generation: number;
  completed_at: string;
}>;

export type SecretRevokeOperationRow = Readonly<{
  tenant_id: string;
  idempotency_key: string;
  request_digest: string;
  request_commitment_key_id: string;
  actor_id: string;
  credential_id: string;
  generation: number;
  completed_at: string;
}>;

export function getSecretRewrapOperation(
  db: AppDb,
  tenantId: string,
  idempotencyKey: string,
): SecretRewrapOperationRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_rewrap_operations WHERE tenant_id = ? AND idempotency_key = ?`,
    [tenantId, idempotencyKey],
  );
}

export function rewrapSecretLifecycle(
  db: AppDb,
  input: Readonly<{
    expectedGeneration: number;
    rotatedAt: string;
    next: SecretLifecycleInput;
  }>,
  options: Readonly<{
    operation: SecretLifecycleOperationIdentity;
    materialLineageCandidates?: readonly Readonly<{ keyId: string; lineageId: string }>[];
    audit?: (row: SecretLifecycleVersionRow) => void;
    authorizeCommit?: () => void;
  }>,
): SecretLifecycleVersionRow {
  validateOperation(options.operation);
  return transaction(db, () => {
    const existing = getSecretRewrapOperation(db, input.next.tenantId, options.operation.idempotencyKey);
    if (existing) {
      if (
        existing.request_digest !== options.operation.requestDigest ||
        existing.request_commitment_key_id !== options.operation.requestCommitmentKeyId ||
        existing.actor_id !== options.operation.actorId ||
        existing.credential_id !== input.next.credentialId ||
        existing.result_generation !== input.next.generation
      ) throw new Error("secret_lifecycle_idempotency_conflict");
      const replay = getSecretLifecycleVersion(
        db, input.next.tenantId, existing.credential_id, existing.result_generation,
      );
      if (!replay) throw new Error("secret_lifecycle_idempotency_corrupt");
      options.authorizeCommit?.();
      return replay;
    }
    const row = rotateSecretLifecycle(db, input, {
      audit: options.audit,
      materialLineageCandidates: options.materialLineageCandidates,
    });
    db.raw.prepare(`INSERT INTO secret_rewrap_operations (
      tenant_id, idempotency_key, request_digest, request_commitment_key_id, actor_id,
      credential_id, result_generation, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        input.next.tenantId, options.operation.idempotencyKey, options.operation.requestDigest,
        options.operation.requestCommitmentKeyId, options.operation.actorId,
        input.next.credentialId, input.next.generation, input.next.issuedAt,
      );
    options.authorizeCommit?.();
    return row;
  });
}

export function getSecretLifecycleOperation(
  db: AppDb,
  tenantId: string,
  idempotencyKey: string,
): SecretLifecycleOperationRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_lifecycle_operations WHERE tenant_id = ? AND idempotency_key = ?`,
    [tenantId, idempotencyKey],
  );
}

export type SecretBreakGlassOperationRow = Readonly<{
  tenant_id: string;
  idempotency_key: string;
  request_digest: string;
  request_commitment_key_id: string;
  actor_id: string;
  credential_id: string;
  generation: number;
  completed_at: string;
}>;

export function getSecretBreakGlassOperation(
  db: AppDb,
  tenantId: string,
  idempotencyKey: string,
): SecretBreakGlassOperationRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_break_glass_operations WHERE tenant_id = ? AND idempotency_key = ?`,
    [tenantId, idempotencyKey],
  );
}

export function getSecretRevokeOperation(
  db: AppDb,
  tenantId: string,
  idempotencyKey: string,
): SecretRevokeOperationRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_revoke_operations WHERE tenant_id = ? AND idempotency_key = ?`,
    [tenantId, idempotencyKey],
  );
}

export function completeSecretBreakGlassOperation(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    idempotencyKey: string;
    requestDigest: string;
    requestCommitmentKeyId: string;
    actorId: string;
    credentialId: string;
    generation: number;
    key: Readonly<{
      provider: string;
      keyId: string;
      version: string;
      attestationSha256: string;
    }>;
    completedAt: string;
  }>,
  options: Readonly<{ audit: () => void; authorizeCommit?: () => void }>,
): Readonly<{ replayed: boolean }> {
  validateOperation({
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
    requestCommitmentKeyId: input.requestCommitmentKeyId,
    actorId: input.actorId,
  });
  if (!ID.test(input.tenantId) || !ID.test(input.credentialId)) {
    throw new Error("secret_lifecycle_authority_invalid");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("secret_generation_invalid");
  }
  validTimestamp("secret_break_glass_completed_at", input.completedAt);
  return transaction(db, () => {
    const current = getSecretLifecycleVersion(
      db,
      input.tenantId,
      input.credentialId,
      input.generation,
    );
    if (
      !current || current.state !== "active" ||
      current.key_provider !== input.key.provider || current.key_id !== input.key.keyId ||
      current.key_version !== input.key.version ||
      current.key_attestation_sha256 !== input.key.attestationSha256
    ) throw new Error("secret_break_glass_generation_inactive");
    const existing = getSecretBreakGlassOperation(db, input.tenantId, input.idempotencyKey);
    if (existing) {
      if (
        existing.request_digest !== input.requestDigest ||
        existing.request_commitment_key_id !== input.requestCommitmentKeyId ||
        existing.actor_id !== input.actorId || existing.credential_id !== input.credentialId ||
        existing.generation !== input.generation
      ) throw new Error("secret_lifecycle_idempotency_conflict");
      options.authorizeCommit?.();
      return Object.freeze({ replayed: true });
    }
    options.authorizeCommit?.();
    options.audit();
    db.raw.prepare(`
      INSERT INTO secret_break_glass_operations (
        tenant_id, idempotency_key, request_digest, request_commitment_key_id,
        actor_id, credential_id, generation, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.tenantId,
      input.idempotencyKey,
      input.requestDigest,
      input.requestCommitmentKeyId,
      input.actorId,
      input.credentialId,
      input.generation,
      input.completedAt,
    );
    return Object.freeze({ replayed: false });
  });
}

export function revokeSecretLifecycle(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    credentialId: string;
    generation: number;
    revokedAt: string;
    reason: string;
  }>,
  options: Readonly<{
    operation?: SecretLifecycleOperationIdentity;
    audit?: (row: SecretLifecycleVersionRow) => void;
    replayAudit?: (row: SecretLifecycleVersionRow) => void;
    authorizeCommit?: () => void;
  }> = {},
): SecretLifecycleVersionRow {
  validTimestamp("secret_revoked_at", input.revokedAt);
  if (!input.reason.trim()) throw new Error("secret_revocation_reason_required");
  if (input.reason.length > MAX_REASON_CHARS) throw new Error("secret_revocation_reason_invalid");
  return transaction(db, () => {
    if (options.operation) {
      validateOperation(options.operation);
      const replay = one<{
        request_digest: string;
        request_commitment_key_id: string;
        actor_id: string;
        credential_id: string;
        generation: number;
      }>(db, `SELECT * FROM secret_revoke_operations
        WHERE tenant_id = ? AND idempotency_key = ?`, [input.tenantId, options.operation.idempotencyKey]);
      if (replay) {
        if (
          replay.request_digest !== options.operation.requestDigest ||
          replay.request_commitment_key_id !== options.operation.requestCommitmentKeyId ||
          replay.actor_id !== options.operation.actorId || replay.credential_id !== input.credentialId ||
          replay.generation !== input.generation
        ) throw new Error("secret_lifecycle_idempotency_conflict");
        const row = getSecretLifecycleVersion(db, input.tenantId, input.credentialId, input.generation);
        if (!row) throw new Error("secret_lifecycle_idempotency_corrupt");
        options.replayAudit?.(row);
        options.authorizeCommit?.();
        return row;
      }
    }
    const existing = getSecretLifecycleVersion(
      db,
      input.tenantId,
      input.credentialId,
      input.generation,
    );
    if (!existing) throw new Error("secret_lifecycle_version_not_found");
    if (existing.state === "revoked") throw new Error("secret_lifecycle_already_revoked");
    const lineage = existing.material_lineage_id;
    const lineageKeyId = existing.material_lineage_key_id;
    db.raw.prepare(`
      UPDATE secret_lifecycle_versions
      SET state = 'revoked', revoked_at = ?, revocation_reason = ?
      WHERE tenant_id = ? AND credential_id = ? AND state IN ('active', 'retired')
        AND (? IS NULL OR (
          material_lineage_id = ? AND
          (? IS NULL OR material_lineage_key_id = ? OR material_lineage_key_id IS NULL)
        ))
    `).run(
      input.revokedAt,
      input.reason.trim(),
      input.tenantId,
      input.credentialId,
      lineage,
      lineage,
      lineageKeyId,
      lineageKeyId,
    );
    const row = getSecretLifecycleVersion(
      db,
      input.tenantId,
      input.credentialId,
      input.generation,
    )!;
    options.audit?.(row);
    if (options.operation) {
      db.raw.prepare(`INSERT INTO secret_revoke_operations (
        tenant_id, idempotency_key, request_digest, request_commitment_key_id, actor_id,
        credential_id, generation, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.tenantId, options.operation.idempotencyKey, options.operation.requestDigest,
          options.operation.requestCommitmentKeyId, options.operation.actorId,
          input.credentialId, input.generation, input.revokedAt,
        );
    }
    options.authorizeCommit?.();
    return row;
  });
}

export function getActiveSecretLifecycle(
  db: AppDb,
  tenantId: string,
  credentialId: string,
): SecretLifecycleVersionRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_lifecycle_versions
     WHERE tenant_id = ? AND credential_id = ? AND state = 'active'`,
    [tenantId, credentialId],
  );
}

export function getSecretLifecycleVersion(
  db: AppDb,
  tenantId: string,
  credentialId: string,
  generation: number,
): SecretLifecycleVersionRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_lifecycle_versions
     WHERE tenant_id = ? AND credential_id = ? AND generation = ?`,
    [tenantId, credentialId, generation],
  );
}

export function getActiveSecretLifecycleByReference(
  db: AppDb,
  tenantId: string,
  sourceRef: string,
): SecretLifecycleVersionRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_lifecycle_versions
     WHERE tenant_id = ? AND source_ref = ? AND state = 'active'`,
    [tenantId, sourceRef],
  );
}

export function getLatestSecretLifecycleByReference(
  db: AppDb,
  tenantId: string,
  sourceRef: string,
): SecretLifecycleVersionRow | undefined {
  return one(
    db,
    `SELECT * FROM secret_lifecycle_versions
     WHERE tenant_id = ? AND source_ref = ? ORDER BY generation DESC LIMIT 1`,
    [tenantId, sourceRef],
  );
}

export function listSecretLifecycleVersions(
  db: AppDb,
  tenantId: string,
  credentialId: string,
): SecretLifecycleVersionRow[] {
  return many(
    db,
    `SELECT * FROM secret_lifecycle_versions
     WHERE tenant_id = ? AND credential_id = ? ORDER BY generation`,
    [tenantId, credentialId],
  );
}

export function secretLifecycleCredentialDescriptor(
  row: SecretLifecycleVersionRow,
): SecretLifecycleCredentialDescriptor {
  const audiences = JSON.parse(row.audiences_json) as unknown;
  if (!Array.isArray(audiences) || audiences.some((audience) => typeof audience !== "string")) {
    throw new Error("secret_audiences_invalid");
  }
  return Object.freeze({
    credentialId: row.credential_id,
    secret: Object.freeze({
      provider: "durable-envelope" as const,
      id: row.credential_id,
      version: String(row.generation),
    }),
    audiences: Object.freeze([...audiences]),
    expiresAt: row.expires_at ?? undefined,
    revocation: row.revoked_at && row.revocation_reason
      ? Object.freeze({ revokedAt: row.revoked_at, reason: row.revocation_reason })
      : undefined,
    rotation: Object.freeze({
      generation: row.generation,
      issuedAt: row.issued_at,
      rotatedAt: row.retired_at ?? undefined,
      rotateAfter: row.rotate_after ?? undefined,
    }),
  });
}
