import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import type { SecretLifecycleVersionRow } from "./schema.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._/@:-]+$/;

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
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name}_invalid`);
  }
}

function validateInput(input: SecretLifecycleInput): void {
  if (!ID.test(input.tenantId)) throw new Error("secret_tenant_invalid");
  if (!ID.test(input.credentialId)) throw new Error("secret_credential_id_invalid");
  if (!SECRET_REF.test(input.sourceRef)) throw new Error("secret_source_reference_invalid");
  if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error("secret_generation_invalid");
  }
  if (input.audiences.length < 1 || input.audiences.some((audience) => !ID.test(audience))) {
    throw new Error("secret_audiences_invalid");
  }
  validTimestamp("secret_issued_at", input.issuedAt);
  validTimestamp("secret_expires_at", input.expiresAt);
  validTimestamp("secret_rotate_after", input.rotateAfter);
  validTimestamp("secret_envelope_created_at", input.envelope.createdAt);
  if (!ID.test(input.key.provider) || !ID.test(input.key.keyId) || !ID.test(input.key.version)) {
    throw new Error("secret_key_reference_invalid");
  }
  if (
    input.envelope.schemaVersion !== 1 ||
    input.envelope.algorithm !== "AES-256-GCM" ||
    !input.envelope.wrappedDataKey ||
    !input.envelope.iv ||
    !input.envelope.authTag ||
    !input.envelope.ciphertext
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
      key_attestation_sha256, algorithm, wrapped_data_key, iv, auth_tag, ciphertext, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    if (replay) return replay;
    const row = insertVersion(db, input);
    options.audit?.(row);
    if (options.operation) completeOperation(db, input, "create", options.operation);
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
  options: SecretLifecycleMutationOptions = {},
): SecretLifecycleVersionRow {
  validateInput(input.next);
  validTimestamp("secret_rotated_at", input.rotatedAt);
  return transaction(db, () => {
    const replay = options.operation
      ? replayedOperation(db, input.next, "rotate", options.operation)
      : undefined;
    if (replay) return replay;
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
    db.raw.prepare(`
      UPDATE secret_lifecycle_versions
      SET state = 'retired', retired_at = ?
      WHERE tenant_id = ? AND credential_id = ? AND generation = ? AND state = 'active'
    `).run(input.rotatedAt, current.tenant_id, current.credential_id, current.generation);
    const row = insertVersion(db, input.next);
    options.audit?.(row);
    if (options.operation) completeOperation(db, input.next, "rotate", options.operation);
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
    completedAt: string;
  }>,
  options: Readonly<{ audit: () => void }>,
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
    const existing = getSecretBreakGlassOperation(db, input.tenantId, input.idempotencyKey);
    if (existing) {
      if (
        existing.request_digest !== input.requestDigest ||
        existing.request_commitment_key_id !== input.requestCommitmentKeyId ||
        existing.actor_id !== input.actorId || existing.credential_id !== input.credentialId ||
        existing.generation !== input.generation
      ) throw new Error("secret_lifecycle_idempotency_conflict");
      return Object.freeze({ replayed: true });
    }
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
  options: Readonly<{ audit?: (row: SecretLifecycleVersionRow) => void }> = {},
): SecretLifecycleVersionRow {
  validTimestamp("secret_revoked_at", input.revokedAt);
  if (!input.reason.trim()) throw new Error("secret_revocation_reason_required");
  return transaction(db, () => {
    const existing = getSecretLifecycleVersion(
      db,
      input.tenantId,
      input.credentialId,
      input.generation,
    );
    if (!existing) throw new Error("secret_lifecycle_version_not_found");
    if (existing.state === "revoked") return existing;
    db.raw.prepare(`
      UPDATE secret_lifecycle_versions
      SET state = 'revoked', revoked_at = ?, revocation_reason = ?
      WHERE tenant_id = ? AND credential_id = ? AND generation = ?
    `).run(
      input.revokedAt,
      input.reason.trim(),
      input.tenantId,
      input.credentialId,
      input.generation,
    );
    const row = getSecretLifecycleVersion(
      db,
      input.tenantId,
      input.credentialId,
      input.generation,
    )!;
    options.audit?.(row);
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
