import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  completeSecretBreakGlassOperation,
  createSecretLifecycle,
  getActiveSecretLifecycle,
  getSecretBreakGlassOperation,
  getSecretLifecycleOperation,
  getSecretRevokeOperation,
  getSecretRewrapOperation,
  getSecretLifecycleVersion,
  listSecretLifecycleVersions,
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
const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._/@:-]+$/;
const MAX_SECRET_MATERIAL_CHARS = 1_048_576;
const MAX_REASON_CHARS = 4_096;
const MAX_AUDIENCES = 64;

function exactKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function validateLocator(value: unknown): asserts value is EnvelopeKeyLocator {
  if (!exactKeys(value, ["provider", "keyId", "version"]) ||
      typeof value.provider !== "string" || typeof value.keyId !== "string" ||
      typeof value.version !== "string" || !ID.test(value.provider) || !ID.test(value.keyId) ||
      !ID.test(value.version)) {
    throw new Error("secret_key_reference_invalid");
  }
}

function validateCommonMutationInput(
  input: Readonly<{ idempotencyKey: unknown; credentialId: unknown }>,
): void {
  if (!ID.test(typeof input.idempotencyKey === "string" ? input.idempotencyKey : "")) {
    throw new Error("secret_lifecycle_idempotency_key_invalid");
  }
  if (!ID.test(typeof input.credentialId === "string" ? input.credentialId : "")) {
    throw new Error("secret_credential_id_invalid");
  }
}

function validateTimestamp(value: unknown, code: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new Error(code);
  }
}

function boundedAuditReason(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_REASON_CHARS) return null;
  return value.trim() || null;
}

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

export type SecretLifecycleCommitmentKeyring = Readonly<{
  activeKeyId: string;
  keys: readonly SecretLifecycleRequestCommitment[];
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
  requestCommitment?: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring;
  materialLineageCommitment?: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring;
  audit: (event: SecretLifecycleAudit) => void;
  revalidateAuthority?: (requiredRole: "admin" | "owner") => Readonly<{ version: string }>;
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
const MATERIAL_LINEAGE_DOMAIN = "mendpoint:secret-lifecycle:material-lineage:v1\0";

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

function normalizeCommitmentKeyring(
  input: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring,
): Readonly<{ activeKeyId: string; keys: ReadonlyMap<string, Buffer> }> {
  const source = "activeKeyId" in input
    ? input
    : Object.freeze({ activeKeyId: input.keyId, keys: Object.freeze([input]) });
  if (!ID.test(source.activeKeyId) || source.keys.length === 0) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  const keys = new Map<string, Buffer>();
  for (const item of source.keys) {
    if (!ID.test(item.keyId) || item.key.byteLength !== 32 || keys.has(item.keyId)) {
      throw new Error("secret_lifecycle_commitment_configuration_invalid");
    }
    keys.set(item.keyId, Buffer.from(item.key));
  }
  if (!keys.has(source.activeKeyId)) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  return Object.freeze({ activeKeyId: source.activeKeyId, keys });
}

function commitmentKeyringFromJson(
  raw: string | undefined,
): SecretLifecycleCommitmentKeyring | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  if (!exactKeys(parsed, ["schemaVersion", "activeKeyId", "keys"]) ||
      parsed.schemaVersion !== 1 || typeof parsed.activeKeyId !== "string" ||
      !Array.isArray(parsed.keys)) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  const keys = parsed.keys.map((value) => {
    if (!exactKeys(value, ["keyId", "keyBase64"]) || typeof value.keyId !== "string" ||
        typeof value.keyBase64 !== "string") {
      throw new Error("secret_lifecycle_commitment_configuration_invalid");
    }
    const key = Buffer.from(value.keyBase64, "base64");
    if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !==
        value.keyBase64.replace(/=+$/u, "")) {
      throw new Error("secret_lifecycle_commitment_configuration_invalid");
    }
    return Object.freeze({ keyId: value.keyId, key });
  });
  const keyring = Object.freeze({ activeKeyId: parsed.activeKeyId, keys: Object.freeze(keys) });
  normalizeCommitmentKeyring(keyring);
  return keyring;
}

export function secretLifecycleCommitmentAuthorityFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<{
  requestCommitment?: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring;
  materialLineageCommitment?: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring;
}> {
  const requestKeyring = commitmentKeyringFromJson(env.MENDPOINT_SECRET_IDEMPOTENCY_KEYRING_JSON);
  const lineageKeyring = commitmentKeyringFromJson(env.MENDPOINT_SECRET_LINEAGE_KEYRING_JSON);
  if (requestKeyring || lineageKeyring) {
    if (!requestKeyring || !lineageKeyring) {
      throw new Error("secret_lifecycle_commitment_configuration_invalid");
    }
    return Object.freeze({ requestCommitment: requestKeyring, materialLineageCommitment: lineageKeyring });
  }
  const requestCommitment = secretLifecycleRequestCommitmentFromEnvironment(env);
  const lineageKeyId = env.MENDPOINT_SECRET_LINEAGE_KEY_ID?.trim();
  const lineageEncoded = env.MENDPOINT_SECRET_LINEAGE_KEY_BASE64?.trim();
  if (!lineageKeyId && !lineageEncoded) {
    return requestCommitment ? Object.freeze({ requestCommitment }) : Object.freeze({});
  }
  if (!lineageKeyId || !lineageEncoded || !ID.test(lineageKeyId)) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  const lineageKey = Buffer.from(lineageEncoded, "base64");
  if (lineageKey.length !== 32 || lineageKey.toString("base64").replace(/=+$/u, "") !==
      lineageEncoded.replace(/=+$/u, "") || !requestCommitment) {
    throw new Error("secret_lifecycle_commitment_configuration_invalid");
  }
  return Object.freeze({
    requestCommitment,
    materialLineageCommitment: Object.freeze({ keyId: lineageKeyId, key: lineageKey }),
  });
}

export function assertSecretLifecycleKeySeparation(
  providers: readonly KeyEncryptionKeyProvider[],
  requestCommitment?: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring,
  materialLineageCommitment?: SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring,
): void {
  const authorities = [requestCommitment, materialLineageCommitment].filter(
    (value): value is SecretLifecycleRequestCommitment | SecretLifecycleCommitmentKeyring => Boolean(value),
  ).map(normalizeCommitmentKeyring);
  const fingerprints = new Set<string>();
  const keyIds = new Set<string>();
  for (const authority of authorities) {
    for (const [keyId, key] of authority.keys) {
      if (keyIds.has(keyId)) throw new Error("secret_lifecycle_key_material_reuse");
      keyIds.add(keyId);
      const fingerprint = cryptographicKeyMaterialFingerprint(key);
      if (fingerprints.has(fingerprint)) throw new Error("secret_lifecycle_key_material_reuse");
      fingerprints.add(fingerprint);
      for (const provider of providers) {
        if (provider.keyMaterialFingerprints().includes(fingerprint)) {
          throw new Error("secret_lifecycle_key_material_reuse");
        }
      }
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
  private readonly requestCommitments?: Readonly<{
    activeKeyId: string;
    keys: ReadonlyMap<string, Buffer>;
  }>;
  private readonly materialLineageCommitments?: Readonly<{
    activeKeyId: string;
    keys: ReadonlyMap<string, Buffer>;
  }>;

  constructor(private readonly options: DurableSecretLifecycleServiceOptions) {
    assertSecretLifecycleKeySeparation(
      options.providers,
      options.requestCommitment,
      options.materialLineageCommitment,
    );
    if (Boolean(options.requestCommitment) !== Boolean(options.materialLineageCommitment)) {
      throw new Error("secret_lifecycle_commitment_configuration_invalid");
    }
    if (options.requestCommitment && options.materialLineageCommitment) {
      this.requestCommitments = normalizeCommitmentKeyring(options.requestCommitment);
      this.materialLineageCommitments = normalizeCommitmentKeyring(options.materialLineageCommitment);
    }
  }

  #now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  #authorizeAdmin(): string | null {
    if (this.options.role !== "owner" && this.options.role !== "admin") {
      throw new Error("secret_lifecycle_authority_required");
    }
    if (!ID.test(this.options.tenantId) || !ID.test(this.options.actorId)) {
      throw new Error("secret_lifecycle_authority_invalid");
    }
    if (this.options.authorityRole !== "owner" && this.options.authorityRole !== "admin") {
      throw new Error("secret_lifecycle_authority_required");
    }
    return this.options.revalidateAuthority?.("admin").version ?? null;
  }

  #authorizeCommit(expectedVersion: string | null, requiredRole: "admin" | "owner" = "admin"): void {
    const current = this.options.revalidateAuthority?.(requiredRole);
    if (expectedVersion !== null && current && current.version !== expectedVersion) {
      throw new Error("secret_lifecycle_authority_changed");
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

  #commitRequest(value: unknown, retainedKeyId?: string | null): Readonly<{ digest: string; keyId: string }> {
    if (!this.requestCommitments) throw new Error("secret_lifecycle_commitment_unconfigured");
    if (retainedKeyId === null) throw new Error("secret_lifecycle_commitment_key_unavailable");
    const keyId = retainedKeyId === undefined ? this.requestCommitments.activeKeyId : retainedKeyId;
    const key = this.requestCommitments.keys.get(keyId);
    if (!key) throw new Error("secret_lifecycle_commitment_key_unavailable");
    const canonical = canonicalJson({
      schemaVersion: 1,
      keyId,
      request: value,
    });
    return Object.freeze({
      digest: createHmac("sha256", key)
        .update(REQUEST_COMMITMENT_DOMAIN, "utf8")
        .update(canonical, "utf8")
        .digest("hex"),
      keyId,
    });
  }

  #materialLineageCandidates(
    credentialId: string,
    plaintext: string,
  ): readonly Readonly<{ keyId: string; lineageId: string }>[] {
    if (!this.materialLineageCommitments) {
      throw new Error("secret_lifecycle_commitment_unconfigured");
    }
    const versions = listSecretLifecycleVersions(
      this.options.db,
      this.options.tenantId,
      credentialId,
    );
    if (versions.some((row) => row.material_lineage_key_id === null)) {
      throw new Error("secret_material_lineage_key_unavailable");
    }
    const historicalIds = new Set(versions.map((row) => row.material_lineage_key_id!));
    if ([...historicalIds].some((keyId) =>
      !this.materialLineageCommitments!.keys.has(keyId) && !this.requestCommitments?.keys.has(keyId)
    )) {
      throw new Error("secret_material_lineage_key_unavailable");
    }
    const lineageIds = [
      this.materialLineageCommitments.activeKeyId,
      ...[...this.materialLineageCommitments.keys.keys()].filter(
        (keyId) => keyId !== this.materialLineageCommitments!.activeKeyId,
      ).sort(),
    ];
    const legacyReplayIds = [...(this.requestCommitments?.keys.keys() ?? [])]
      .filter((keyId) => historicalIds.has(keyId))
      .sort();
    return Object.freeze([...lineageIds, ...legacyReplayIds].map((keyId) => {
      const key = this.materialLineageCommitments!.keys.get(keyId) ??
        this.requestCommitments?.keys.get(keyId);
      if (!key) throw new Error("secret_material_lineage_key_unavailable");
      const canonical = canonicalJson({
        schemaVersion: 1,
        keyId,
        tenantId: this.options.tenantId,
        credentialId,
        plaintext,
      });
      return Object.freeze({
        keyId,
        lineageId: createHmac("sha256", key)
          .update(MATERIAL_LINEAGE_DOMAIN, "utf8")
          .update(canonical, "utf8")
          .digest("hex"),
      });
    }));
  }

  async #openMutationSource(
    current: SecretLifecycleVersionRow,
    idempotencyKey: string,
    operation: "rotation" | "rewrap",
    purpose: string,
  ): Promise<string> {
    const decryptAttemptId = randomUUID();
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
        { generation: current.generation, outcome: "attempted", purpose, decryptAttemptId },
        `${attemptedAction}:${decryptAttemptId}`,
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
          decryptAttemptId,
        },
        `${event.outcome === "granted" ? grantedAction : deniedAction}:${decryptAttemptId}`,
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
    const auditIdempotencyKey = ID.test(input.idempotencyKey)
      ? input.idempotencyKey
      : "invalid-idempotency-key";
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
        reason: boundedAuditReason(input.reason),
        idempotencyKey: ID.test(input.idempotencyKey) ? input.idempotencyKey : null,
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
    const authorityVersion = this.#authorizeAdmin();
    if (!exactKeys(input, [
      "idempotencyKey", "credentialId", "sourceRef", "plaintext", "audiences",
      "expiresAt", "rotateAfter", "key",
    ])) throw new Error("secret_lifecycle_request_invalid");
    validateCommonMutationInput(input);
    if (typeof input.sourceRef !== "string" || input.sourceRef.length > 512 ||
        !SECRET_REF.test(input.sourceRef)) throw new Error("secret_source_reference_invalid");
    if (typeof input.plaintext !== "string" || input.plaintext.length === 0 ||
        input.plaintext.length > MAX_SECRET_MATERIAL_CHARS) {
      throw new Error("secret_rotation_material_required");
    }
    if (!Array.isArray(input.audiences) || input.audiences.length < 1 ||
        input.audiences.length > MAX_AUDIENCES ||
        input.audiences.some((audience) => typeof audience !== "string" || !ID.test(audience)) ||
        new Set(input.audiences).size !== input.audiences.length) {
      throw new Error("secret_audiences_invalid");
    }
    validateTimestamp(input.expiresAt, "secret_expires_at_invalid");
    validateTimestamp(input.rotateAfter, "secret_rotate_after_invalid");
    validateLocator(input.key);
    const request = {
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
    };
    const existingOperation = getSecretLifecycleOperation(
      this.options.db,
      this.options.tenantId,
      input.idempotencyKey,
    );
    const commitment = this.#commitRequest(request, existingOperation?.request_commitment_key_id);
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
    const atMs = Date.parse(at);
    const expiresAtMs = input.expiresAt === undefined ? null : Date.parse(input.expiresAt);
    const rotateAfterMs = input.rotateAfter === undefined ? null : Date.parse(input.rotateAfter);
    if ((expiresAtMs !== null && (!Number.isFinite(expiresAtMs) || expiresAtMs <= atMs)) ||
        (rotateAfterMs !== null && (!Number.isFinite(rotateAfterMs) || rotateAfterMs <= atMs)) ||
        (expiresAtMs !== null && rotateAfterMs !== null && rotateAfterMs >= expiresAtMs)) {
      throw new Error("secret_timestamp_order_invalid");
    }
    const attested = await attestEnvelopeKey(this.options.providers, this.options.tenantId, input.key);
    const envelope = await sealEnvelopeSecret(input.credentialId, input.plaintext, 1, attested, {
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      correlationId: input.idempotencyKey,
      purpose: "create durable secret",
      at,
    }, this.options.providers);
    const lineageCandidates = this.#materialLineageCandidates(input.credentialId, input.plaintext);
    const activeLineage = lineageCandidates[0]!;
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
      materialLineageId: activeLineage.lineageId,
      materialLineageKeyId: activeLineage.keyId,
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
      authorizeCommit: () => this.#authorizeCommit(authorityVersion),
    });
    return publicResult(row);
  }

  async rotate(input: RotateInput) {
    const authorityVersion = this.#authorizeAdmin();
    if (!exactKeys(input, ["idempotencyKey", "credentialId", "expectedGeneration", "plaintext", "key"])) {
      throw new Error("secret_lifecycle_request_invalid");
    }
    validateCommonMutationInput(input);
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
      throw new Error("secret_generation_invalid");
    }
    if (typeof input.plaintext !== "string" || input.plaintext.length === 0 ||
        input.plaintext.length > MAX_SECRET_MATERIAL_CHARS) {
      throw new Error("secret_rotation_material_required");
    }
    validateLocator(input.key);
    const nextGeneration = input.expectedGeneration + 1;
    const request = {
      operation: "rotate",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      expectedGeneration: input.expectedGeneration,
      plaintext: input.plaintext,
      key: input.key,
    };
    const existingOperation = getSecretLifecycleOperation(
      this.options.db,
      this.options.tenantId,
      input.idempotencyKey,
    );
    const commitment = this.#commitRequest(request, existingOperation?.request_commitment_key_id);
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
    const lineageCandidates = this.#materialLineageCandidates(input.credentialId, input.plaintext);
    const activeLineage = lineageCandidates[0]!;
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
      materialLineageId: activeLineage.lineageId,
      materialLineageKeyId: activeLineage.keyId,
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
      materialLineageCandidates: lineageCandidates,
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
      authorizeCommit: () => this.#authorizeCommit(authorityVersion),
    });
    return publicResult(row);
  }

  async rewrap(input: RewrapInput) {
    const authorityVersion = this.#authorizeAdmin();
    if (!exactKeys(input, ["idempotencyKey", "credentialId", "expectedGeneration", "key"])) {
      throw new Error("secret_lifecycle_request_invalid");
    }
    validateCommonMutationInput(input);
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) {
      throw new Error("secret_generation_invalid");
    }
    validateLocator(input.key);
    const nextGeneration = input.expectedGeneration + 1;
    const request = {
      operation: "rewrap",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      expectedGeneration: input.expectedGeneration,
      key: input.key,
    };
    const existingOperation = getSecretRewrapOperation(
      this.options.db,
      this.options.tenantId,
      input.idempotencyKey,
    );
    const commitment = this.#commitRequest(request, existingOperation?.request_commitment_key_id);
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
    const lineageCandidates = this.#materialLineageCandidates(input.credentialId, plaintext);
    const retainedLineage = lineageCandidates.find((candidate) =>
      candidate.lineageId === current.material_lineage_id &&
      (current.material_lineage_key_id === null || candidate.keyId === current.material_lineage_key_id)
    );
    if (!retainedLineage) throw new Error("secret_material_lineage_invalid");
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
      materialLineageId: retainedLineage.lineageId,
      materialLineageKeyId: retainedLineage.keyId,
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
      materialLineageCandidates: lineageCandidates,
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
      authorizeCommit: () => this.#authorizeCommit(authorityVersion),
    });
    return publicResult(row);
  }

  revoke(input: Readonly<{
    idempotencyKey: string;
    credentialId: string;
    generation: number;
    reason: string;
  }>) {
    const authorityVersion = this.#authorizeAdmin();
    if (!exactKeys(input, ["idempotencyKey", "credentialId", "generation", "reason"])) {
      throw new Error("secret_lifecycle_request_invalid");
    }
    validateCommonMutationInput(input);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error("secret_generation_invalid");
    }
    if (typeof input.reason !== "string" || input.reason.length > MAX_REASON_CHARS) {
      throw new Error("secret_revocation_reason_invalid");
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    const request = {
      operation: "revoke",
      idempotencyKey: input.idempotencyKey,
      tenantId: this.options.tenantId,
      actorId: this.options.actorId,
      credentialId: input.credentialId,
      generation: input.generation,
      reason,
    };
    const existingOperation = getSecretRevokeOperation(
      this.options.db,
      this.options.tenantId,
      input.idempotencyKey,
    );
    const commitment = this.#commitRequest(request, existingOperation?.request_commitment_key_id);
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
      authorizeCommit: () => this.#authorizeCommit(authorityVersion),
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
      if (!exactKeys(input, ["credentialId", "reason", "idempotencyKey"])) {
        throw new Error("secret_lifecycle_request_invalid");
      }
      validateCommonMutationInput(input);
      if (this.options.role !== "owner") throw new Error("secret_break_glass_owner_required");
      if (this.options.authorityRole !== "owner") throw new Error("secret_break_glass_owner_required");
      if (!this.options.breakGlassEnabled) throw new Error("secret_break_glass_disabled");
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (!reason) throw new Error("secret_break_glass_reason_required");
      if ((input.reason as string).length > MAX_REASON_CHARS) {
        throw new Error("secret_break_glass_reason_invalid");
      }
      if (!ID.test(input.idempotencyKey)) throw new Error("secret_lifecycle_idempotency_key_invalid");
      const existing = getSecretBreakGlassOperation(
        this.options.db,
        this.options.tenantId,
        input.idempotencyKey,
      );
      const commitment = this.#commitRequest({
        operation: "break_glass",
        idempotencyKey: input.idempotencyKey,
        tenantId: this.options.tenantId,
        actorId: this.options.actorId,
        credentialId: input.credentialId,
        reason,
      }, existing?.request_commitment_key_id);
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
      const authority = this.options.revalidateAuthority?.("owner");
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
      const currentAuthority = this.options.revalidateAuthority?.("owner");
      if (authority && currentAuthority && authority.version !== currentAuthority.version) {
        throw new Error("secret_lifecycle_authority_changed");
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
        authorizeCommit: () => this.#authorizeCommit(authority?.version ?? null, "owner"),
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
          authorityVersion: currentAuthority?.version ?? authority?.version ?? null,
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
