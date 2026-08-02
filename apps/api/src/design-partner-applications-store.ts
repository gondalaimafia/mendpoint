import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import type { AppDb } from "@mendpoint/db";

const PURPOSE_CODE = "design_partner_evaluation_v1";
const CONSENT_VERSION = "2026-08-01";
const MIN_COMPLETION_MS = 3_000;
const MAX_FORM_AGE_MS = 60 * 60 * 1_000;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const RATE_LIMIT = 3;
const MAX_APPLICATION_BYTES = 16 * 1_024;
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const DISPOSABLE_DOMAINS = new Set([
  "10minutemail.com",
  "dispostable.com",
  "fakeinbox.com",
  "guerrillamail.com",
  "maildrop.cc",
  "mailinator.com",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "yopmail.com",
]);

const PRIVATE_EMAIL_SUFFIXES = [
  ".example",
  ".invalid",
  ".local",
  ".localhost",
  ".test",
  ".internal",
];

const URL_PATTERN = /(?:https?:\/\/|www\.|git@|ssh:\/\/|\b(?:github|gitlab|bitbucket):|\b(?:[a-z0-9-]+\.)+(?:app|ai|cloud|co|com|dev|io|net|org|site|tech|xyz)(?:\/[^\s]*)?)/i;
const SECRET_PATTERN = /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:api[_ -]?key|authorization|password|passwd|secret|token)\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:gh[opusr]_|npm_|xox[baprs]-|sk[_-](?:live[_-]|test[_-]|proj[_-])?)[A-Za-z0-9_-]{12,})/i;
const SOURCE_PATTERN = /(?:```|<script\b|\bfunction\s+[A-Za-z_$][\w$]*\s*\(|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|\bimport\s+.+\s+from\s+["']|\bclass\s+[A-Za-z_$][\w$]*\s*\{|\bdef\s+[a-zA-Z_]\w*\s*\(|\bpackage\s+main\b|\bSELECT\s+.+\s+FROM\s+\w+)/i;

const SERVER_OWNED_FIELDS = new Set([
  "id",
  "applicationId",
  "tenant",
  "tenantId",
  "actor",
  "actorId",
  "actorPrincipalId",
  "status",
  "createdAt",
  "updatedAt",
  "emailHash",
  "contentDigest",
]);

export type DesignPartnerApplicationBody = Readonly<{
  name: string;
  workEmail: string;
  company: string;
  role: string;
  providerChange: string;
  repositoryScope: string;
  successMetric: string;
  authorized: boolean;
  consent: boolean;
  website: string;
  startedAt: number;
}>;

export type ApplicationSourceMetadata = Readonly<{
  bridge: string | null;
  origin: string | null;
  referrerPath: string | null;
  userAgent: string | null;
}>;

export type DesignPartnerApplicationMetadata = Readonly<{
  id: string;
  status: "new";
  purposeCode: typeof PURPOSE_CODE;
  consentVersion: typeof CONSENT_VERSION;
  consentGranted: true;
  authorizationConfirmed: true;
  createdAt: string;
  retentionExpiresAt: string;
  payloadState: "available" | "erased";
  erasedAt: string | null;
  erasureReasonCode: ApplicationErasureReasonCode | null;
}>;

export type DesignPartnerPrivatePayload = Readonly<{
  contact: Readonly<{
    name: string;
    workEmail: string;
    company: string;
    role: string;
  }>;
  application: Readonly<{
    providerChange: string;
    repositoryScope: string;
    successMetric: string;
  }>;
  evidence: Readonly<{
    actorPrincipalId: string;
    requestId: string;
    purposeCode: typeof PURPOSE_CODE;
    consentVersion: typeof CONSENT_VERSION;
    consentGranted: true;
    authorizationConfirmed: true;
    formStartedAt: string;
    acceptedAt: string;
    source: ApplicationSourceMetadata;
  }>;
}>;

export type DesignPartnerApplicationStoreOptions = Readonly<{
  db: AppDb;
  key?: Buffer | string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createId?: () => string;
  rateLimit?: number;
  rateWindowMs?: number;
  retentionMs?: number;
}>;

export type CreateDesignPartnerApplicationInput = Readonly<{
  tenantId: string;
  actorPrincipalId: string;
  requestId: string;
  body: unknown;
  source: ApplicationSourceMetadata;
}>;

export type CreateDesignPartnerApplicationResult = Readonly<{
  application: DesignPartnerApplicationMetadata;
  replayed: boolean;
}>;

export type ApplicationRevealPurposeCode =
  | "application_review"
  | "applicant_follow_up"
  | "privacy_request";

export type ApplicationErasureReasonCode =
  | "applicant_request"
  | "operator_request"
  | "retention_expired";

export type ApplicationAuditEvent = Readonly<{
  id: string;
  tenantId: string;
  actorPrincipalId: string;
  requestId: string;
  action: "design_partner_application.reveal";
  resourceId: string;
  purposeCode: ApplicationRevealPurposeCode;
  occurredAt: string;
}>;

export type ApplicationAuditCallback = (event: ApplicationAuditEvent) => void;

export type RevealDesignPartnerApplicationInput = Readonly<{
  tenantId: string;
  actorPrincipalId: string;
  requestId: string;
  applicationId: string;
  purposeCode: ApplicationRevealPurposeCode;
}>;

export type EraseDesignPartnerApplicationInput = Readonly<{
  tenantId: string;
  actorPrincipalId: string;
  requestId: string;
  applicationId: string;
  reasonCode: ApplicationErasureReasonCode;
}>;

export type ApplicationErasureEvent = Readonly<{
  id: string;
  applicationId: string;
  reasonCode: ApplicationErasureReasonCode;
  createdAt: string;
}>;

export type EraseDesignPartnerApplicationResult = Readonly<{
  application: DesignPartnerApplicationMetadata;
  erasure: ApplicationErasureEvent;
  replayed: boolean;
}>;

export type PurgeExpiredApplicationsInput = Readonly<{
  tenantId: string;
  actorPrincipalId: string;
  requestId: string;
  limit?: number;
}>;

type ApplicationRow = {
  id: string;
  tenant_id: string;
  request_id: string;
  request_digest: string;
  email_hash: string;
  content_digest: string;
  encrypted_payload: string;
  purpose_code: typeof PURPOSE_CODE;
  consent_version: typeof CONSENT_VERSION;
  consent_granted: 1;
  authorization_confirmed: 1;
  actor_hash: string;
  status: "new";
  created_at: string;
};

type RetentionRow = {
  retention_expires_at: string;
};

type PayloadKeyRow = {
  wrapped_dek: string;
};

type ErasureRow = {
  id: string;
  application_id: string;
  request_id: string;
  request_digest: string;
  reason_code: ApplicationErasureReasonCode;
  created_at: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function decodeKey(value: Buffer | string | undefined, env: NodeJS.ProcessEnv): Buffer {
  const configured = value ?? env.MENDPOINT_APPLICATION_DATA_KEY;
  if (!configured) throw new Error("application_data_key_required");
  if (typeof configured === "string") {
    const raw = configured.trim();
    for (const name of [
      "MENDPOINT_API_KEY",
      "MENDPOINT_WEB_ACCESS_TOKEN",
      "MENDPOINT_CREDENTIAL_DATA_KEY",
      "MENDPOINT_ENCRYPTION_KEY",
      "DATABASE_ENCRYPTION_KEY",
    ]) {
      const other = env[name]?.trim();
      if (other && raw === other) throw new Error("application_data_key_not_distinct");
    }
    const unwrapped = raw.replace(/^(?:base64|base64url|hex):/i, "");
    const hexadecimal = /^(?:[a-f0-9]{64})$/i.test(unwrapped);
    if (!hexadecimal && !/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(unwrapped)) {
      throw new Error("application_data_key_invalid");
    }
    const decoded = hexadecimal ? Buffer.from(unwrapped, "hex") : Buffer.from(unwrapped, "base64url");
    if (decoded.length !== 32) throw new Error("application_data_key_invalid");
    return decoded;
  }
  if (configured.length !== 32) throw new Error("application_data_key_invalid");
  return Buffer.from(configured);
}

function deriveKey(master: Buffer, purpose: string): Buffer {
  return createHmac("sha256", master).update(`mendpoint:${purpose}:v1`, "utf8").digest();
}

function keyedDigest(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(canonicalJson(value), "utf8").digest("hex");
}

function encryptBytes(key: Buffer, plaintext: Buffer, associatedData: string, version: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function decryptBytes(
  key: Buffer,
  envelopeText: string,
  associatedData: string,
  expectedVersion: number,
): Buffer {
  const envelope = JSON.parse(envelopeText) as Record<string, unknown>;
  if (
    envelope.version !== expectedVersion ||
    envelope.algorithm !== "A256GCM" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("application_payload_envelope_invalid");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);
}

function encryptPayload(key: Buffer, payload: DesignPartnerPrivatePayload, associatedData: string): string {
  return encryptBytes(key, Buffer.from(canonicalJson(payload), "utf8"), associatedData, 2);
}

function decryptPayload(key: Buffer, envelopeText: string, associatedData: string): DesignPartnerPrivatePayload {
  return JSON.parse(decryptBytes(key, envelopeText, associatedData, 2).toString("utf8")) as DesignPartnerPrivatePayload;
}

function decryptLegacyPayload(
  key: Buffer,
  envelopeText: string,
  associatedData: string,
): DesignPartnerPrivatePayload {
  return JSON.parse(decryptBytes(key, envelopeText, associatedData, 1).toString("utf8")) as DesignPartnerPrivatePayload;
}

function wrapDataKey(key: Buffer, dataKey: Buffer, tenantId: string, applicationId: string): string {
  return encryptBytes(key, dataKey, `${tenantId}\n${applicationId}\ndek`, 1);
}

function unwrapDataKey(key: Buffer, envelope: string, tenantId: string, applicationId: string): Buffer {
  const dataKey = decryptBytes(key, envelope, `${tenantId}\n${applicationId}\ndek`, 1);
  if (dataKey.length !== 32) throw new Error("application_data_key_envelope_invalid");
  return dataKey;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("application_payload_invalid");
  }
  return value as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string, min: number, max: number): string {
  const value = body[field];
  if (typeof value !== "string") throw new Error(`application_${field}_invalid`);
  const normalized = value.trim().replace(/\r\n?/g, "\n");
  if (normalized.length < min || normalized.length > max) {
    throw new Error(`application_${field}_invalid`);
  }
  return normalized;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new Error("application_work_email_invalid");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error("application_work_email_invalid");
  }
  const [local, domain] = email.split("@");
  const labels = domain?.split(".") ?? [];
  const finalLabel = labels.at(-1) ?? "";
  if (
    !local ||
    !domain ||
    local.length > 64 ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.length > 253 ||
    !domain.includes(".") ||
    isIP(domain) !== 0 ||
    domain.startsWith("[") ||
    domain.endsWith(".") ||
    labels.some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    (!/^xn--/.test(finalLabel) && !/^[a-z]{2,63}$/.test(finalLabel)) ||
    ["example.com", "example.net", "example.org"].includes(domain) ||
    DISPOSABLE_DOMAINS.has(domain) ||
    PRIVATE_EMAIL_SUFFIXES.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix))
  ) {
    throw new Error(DISPOSABLE_DOMAINS.has(domain)
      ? "application_disposable_email_rejected"
      : "application_work_email_invalid");
  }
  return email;
}

function assertSafeNarrative(value: string): void {
  if (URL_PATTERN.test(value)) throw new Error("application_url_rejected");
  if (SECRET_PATTERN.test(value)) throw new Error("application_secret_rejected");
  if (SOURCE_PATTERN.test(value)) throw new Error("application_source_code_rejected");
}

function validateBody(value: unknown, acceptedAt: Date): DesignPartnerApplicationBody {
  const body = asObject(value);
  if (Object.keys(body).some((field) => SERVER_OWNED_FIELDS.has(field))) {
    throw new Error("application_server_owned_field_rejected");
  }
  if (typeof body.website !== "string" || body.website.trim() !== "") {
    throw new Error("application_honeypot_rejected");
  }
  if (body.authorized !== true) throw new Error("application_authorization_required");
  if (body.consent !== true) throw new Error("application_consent_required");
  if (typeof body.startedAt !== "number" || !Number.isFinite(body.startedAt)) {
    throw new Error("application_started_at_invalid");
  }
  const elapsed = acceptedAt.getTime() - body.startedAt;
  if (elapsed < MIN_COMPLETION_MS) throw new Error("application_submitted_too_fast");
  if (elapsed > MAX_FORM_AGE_MS) throw new Error("application_form_expired");

  const validated: DesignPartnerApplicationBody = {
    name: requiredText(body, "name", 2, 120),
    workEmail: normalizeEmail(body.workEmail),
    company: requiredText(body, "company", 2, 160),
    role: requiredText(body, "role", 2, 120),
    providerChange: requiredText(body, "providerChange", 20, 2_000),
    repositoryScope: requiredText(body, "repositoryScope", 20, 2_000),
    successMetric: requiredText(body, "successMetric", 20, 1_200),
    authorized: true,
    consent: true,
    website: "",
    startedAt: body.startedAt,
  };
  for (const narrative of [validated.providerChange, validated.repositoryScope, validated.successMetric]) {
    assertSafeNarrative(narrative);
  }
  return validated;
}

function metadata(db: AppDb, row: ApplicationRow): DesignPartnerApplicationMetadata {
  const retention = db.raw.prepare(`SELECT retention_expires_at FROM design_partner_application_retention
    WHERE tenant_id = ? AND application_id = ?`).get(row.tenant_id, row.id) as RetentionRow | undefined;
  if (!retention) throw new Error("application_retention_evidence_missing");
  const payloadKey = db.raw.prepare(`SELECT 1 AS found FROM design_partner_application_payload_keys
    WHERE tenant_id = ? AND application_id = ?`).get(row.tenant_id, row.id);
  const erasure = db.raw.prepare(`SELECT * FROM design_partner_application_erasures
    WHERE tenant_id = ? AND application_id = ?`).get(row.tenant_id, row.id) as ErasureRow | undefined;
  return {
    id: row.id,
    status: "new",
    purposeCode: PURPOSE_CODE,
    consentVersion: CONSENT_VERSION,
    consentGranted: true,
    authorizationConfirmed: true,
    createdAt: row.created_at,
    retentionExpiresAt: retention.retention_expires_at,
    payloadState: payloadKey ? "available" : "erased",
    erasedAt: erasure?.created_at ?? null,
    erasureReasonCode: erasure?.reason_code ?? null,
  };
}

function ensureSchema(db: AppDb): void {
  db.raw.exec("PRAGMA secure_delete = ON");
  db.raw.exec(`CREATE TABLE IF NOT EXISTS design_partner_applications (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    encrypted_payload TEXT NOT NULL,
    purpose_code TEXT NOT NULL CHECK (purpose_code = '${PURPOSE_CODE}'),
    consent_version TEXT NOT NULL CHECK (consent_version = '${CONSENT_VERSION}'),
    consent_granted INTEGER NOT NULL CHECK (consent_granted = 1),
    authorization_confirmed INTEGER NOT NULL CHECK (authorization_confirmed = 1),
    actor_hash TEXT NOT NULL CHECK (length(actor_hash) = 64),
    status TEXT NOT NULL CHECK (status = 'new'),
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, request_id),
    UNIQUE (tenant_id, content_digest)
  );
  CREATE INDEX IF NOT EXISTS design_partner_applications_tenant_created_idx
    ON design_partner_applications (tenant_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS design_partner_applications_rate_idx
    ON design_partner_applications (tenant_id, email_hash, created_at DESC);
  CREATE TABLE IF NOT EXISTS design_partner_application_payload_keys (
    tenant_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    wrapped_dek TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, application_id)
  );
  CREATE TRIGGER IF NOT EXISTS design_partner_application_payload_keys_no_update
    BEFORE UPDATE ON design_partner_application_payload_keys BEGIN
      SELECT RAISE(ABORT, 'design_partner_application_payload_keys_no_update');
    END;
  CREATE TABLE IF NOT EXISTS design_partner_application_retention (
    tenant_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    retention_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, application_id)
  );
  CREATE TRIGGER IF NOT EXISTS design_partner_application_retention_append_only_update
    BEFORE UPDATE ON design_partner_application_retention BEGIN
      SELECT RAISE(ABORT, 'design_partner_application_retention_append_only');
    END;
  CREATE TRIGGER IF NOT EXISTS design_partner_application_retention_append_only_delete
    BEFORE DELETE ON design_partner_application_retention BEGIN
      SELECT RAISE(ABORT, 'design_partner_application_retention_append_only');
    END;
  CREATE TABLE IF NOT EXISTS design_partner_application_erasures (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    actor_hash TEXT NOT NULL CHECK (length(actor_hash) = 64),
    reason_code TEXT NOT NULL CHECK (reason_code IN ('applicant_request', 'operator_request', 'retention_expired')),
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, application_id),
    UNIQUE (tenant_id, request_id)
  );
  CREATE TRIGGER IF NOT EXISTS design_partner_application_erasures_append_only_update
    BEFORE UPDATE ON design_partner_application_erasures BEGIN
      SELECT RAISE(ABORT, 'design_partner_application_erasures_append_only');
    END;
  CREATE TRIGGER IF NOT EXISTS design_partner_application_erasures_append_only_delete
    BEFORE DELETE ON design_partner_application_erasures BEGIN
      SELECT RAISE(ABORT, 'design_partner_application_erasures_append_only');
    END;
  CREATE TRIGGER IF NOT EXISTS design_partner_applications_append_only_update
    BEFORE UPDATE ON design_partner_applications BEGIN
      SELECT RAISE(ABORT, 'design_partner_applications_append_only');
    END;
  CREATE TRIGGER IF NOT EXISTS design_partner_applications_append_only_delete
    BEFORE DELETE ON design_partner_applications BEGIN
      SELECT RAISE(ABORT, 'design_partner_applications_append_only');
    END;`);
}

function payloadAssociatedData(row: ApplicationRow): string {
  return `${row.tenant_id}\n${row.id}\n${row.request_digest}\n${row.content_digest}`;
}

function migratePayloadProtection(
  db: AppDb,
  legacyEncryptionKey: Buffer,
  wrappingKey: Buffer,
  retentionMs: number,
): void {
  const rows = db.raw.prepare("SELECT * FROM design_partner_applications")
    .all() as unknown as ApplicationRow[];
  const legacy: Array<Readonly<{
    row: ApplicationRow;
    encryptedPayload: string;
    wrappedKey: string;
  }>> = [];
  for (const row of rows) {
    const existingKey = db.raw.prepare(`SELECT 1 AS found FROM design_partner_application_payload_keys
      WHERE tenant_id = ? AND application_id = ?`).get(row.tenant_id, row.id);
    const erased = db.raw.prepare(`SELECT 1 AS found FROM design_partner_application_erasures
      WHERE tenant_id = ? AND application_id = ?`).get(row.tenant_id, row.id);
    const envelope = JSON.parse(row.encrypted_payload) as { version?: unknown };
    if (!existingKey && !erased && envelope.version === 1) {
      const payload = decryptLegacyPayload(legacyEncryptionKey, row.encrypted_payload, payloadAssociatedData(row));
      const dataKey = randomBytes(32);
      legacy.push({
        row,
        encryptedPayload: encryptPayload(dataKey, payload, payloadAssociatedData(row)),
        wrappedKey: wrapDataKey(wrappingKey, dataKey, row.tenant_id, row.id),
      });
    } else if (!existingKey && !erased && envelope.version === 2) {
      throw new Error("application_payload_key_missing");
    }
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (legacy.length > 0) {
      db.raw.exec("DROP TRIGGER IF EXISTS design_partner_applications_append_only_update");
      for (const migrated of legacy) {
        db.raw.prepare("UPDATE design_partner_applications SET encrypted_payload = ? WHERE tenant_id = ? AND id = ?")
          .run(migrated.encryptedPayload, migrated.row.tenant_id, migrated.row.id);
        db.raw.prepare(`INSERT INTO design_partner_application_payload_keys
          (tenant_id, application_id, wrapped_dek, created_at) VALUES (?, ?, ?, ?)`)
          .run(
            migrated.row.tenant_id,
            migrated.row.id,
            migrated.wrappedKey,
            migrated.row.created_at,
          );
      }
    }
    for (const row of rows) {
      const expiresAt = new Date(Date.parse(row.created_at) + retentionMs).toISOString();
      db.raw.prepare(`INSERT OR IGNORE INTO design_partner_application_retention
        (tenant_id, application_id, retention_expires_at, created_at) VALUES (?, ?, ?, ?)`)
        .run(row.tenant_id, row.id, expiresAt, row.created_at);
    }
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  } finally {
    db.raw.exec(`CREATE TRIGGER IF NOT EXISTS design_partner_applications_append_only_update
      BEFORE UPDATE ON design_partner_applications BEGIN
        SELECT RAISE(ABORT, 'design_partner_applications_append_only');
      END`);
  }
}

function rowByRequest(db: AppDb, tenantId: string, requestId: string): ApplicationRow | undefined {
  return db.raw.prepare(`SELECT * FROM design_partner_applications
    WHERE tenant_id = ? AND request_id = ?`).get(tenantId, requestId) as ApplicationRow | undefined;
}

function constantDigestEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class DesignPartnerApplicationStore {
  readonly db: AppDb;
  readonly #encryptionKey: Buffer;
  readonly #wrappingKey: Buffer;
  readonly #requestDigestKey: Buffer;
  readonly #emailDigestKey: Buffer;
  readonly #contentDigestKey: Buffer;
  readonly #actorDigestKey: Buffer;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #rateLimit: number;
  readonly #rateWindowMs: number;
  readonly #retentionMs: number;

  constructor(options: DesignPartnerApplicationStoreOptions) {
    this.db = options.db;
    const masterKey = decodeKey(options.key, options.env ?? process.env);
    this.#encryptionKey = deriveKey(masterKey, "application-encryption");
    this.#wrappingKey = deriveKey(masterKey, "application-dek-wrap");
    this.#requestDigestKey = deriveKey(masterKey, "application-request-digests");
    this.#emailDigestKey = deriveKey(masterKey, "application-email-digests");
    this.#contentDigestKey = deriveKey(masterKey, "application-content-digests");
    this.#actorDigestKey = deriveKey(masterKey, "application-actor-digests");
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => `application-${randomUUID()}`);
    this.#rateLimit = options.rateLimit ?? RATE_LIMIT;
    this.#rateWindowMs = options.rateWindowMs ?? RATE_WINDOW_MS;
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    if (!Number.isFinite(this.#retentionMs) || this.#retentionMs < 24 * 60 * 60 * 1_000) {
      throw new Error("application_retention_invalid");
    }
    ensureSchema(this.db);
    migratePayloadProtection(this.db, this.#encryptionKey, this.#wrappingKey, this.#retentionMs);
  }

  create(input: CreateDesignPartnerApplicationInput): CreateDesignPartnerApplicationResult {
    if (!input.tenantId.trim() || !input.actorPrincipalId.trim()) {
      throw new Error("application_principal_required");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.requestId)) {
      throw new Error("application_request_id_invalid");
    }
    let serializedBody: string;
    try {
      const serialized = JSON.stringify(input.body);
      if (typeof serialized !== "string") throw new Error("application_payload_invalid");
      serializedBody = serialized;
    } catch {
      throw new Error("application_payload_invalid");
    }
    if (Buffer.byteLength(serializedBody, "utf8") > MAX_APPLICATION_BYTES) {
      throw new Error("application_payload_too_large");
    }
    const requestDigest = keyedDigest(this.#requestDigestKey, input.body);
    const prior = rowByRequest(this.db, input.tenantId, input.requestId);
    if (prior) {
      if (!constantDigestEqual(prior.request_digest, requestDigest)) {
        throw new Error("application_idempotency_conflict");
      }
      return { application: metadata(this.db, prior), replayed: true };
    }

    const acceptedAt = this.#now();
    if (!Number.isFinite(acceptedAt.getTime())) throw new Error("application_server_time_invalid");
    const body = validateBody(input.body, acceptedAt);
    const emailHash = keyedDigest(this.#emailDigestKey, body.workEmail);
    const contentDigest = keyedDigest(this.#contentDigestKey, {
      name: body.name,
      workEmail: body.workEmail,
      company: body.company,
      role: body.role,
      providerChange: body.providerChange,
      repositoryScope: body.repositoryScope,
      successMetric: body.successMetric,
      purposeCode: PURPOSE_CODE,
    });
    const actorHash = keyedDigest(this.#actorDigestKey, input.actorPrincipalId);
    const createdAt = acceptedAt.toISOString();
    const cutoff = new Date(acceptedAt.getTime() - this.#rateWindowMs).toISOString();
    const rate = this.db.raw.prepare(`SELECT COUNT(*) AS count FROM design_partner_applications
      WHERE tenant_id = ? AND email_hash = ? AND created_at >= ?`)
      .get(input.tenantId, emailHash, cutoff) as { count: number };
    if (Number(rate.count) >= this.#rateLimit) throw new Error("application_rate_limited");
    const duplicate = this.db.raw.prepare(`SELECT 1 AS found FROM design_partner_applications
      WHERE tenant_id = ? AND content_digest = ?`).get(input.tenantId, contentDigest);
    if (duplicate) throw new Error("application_duplicate_rejected");

    const id = this.#createId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      throw new Error("application_id_invalid");
    }
    const payload: DesignPartnerPrivatePayload = {
      contact: {
        name: body.name,
        workEmail: body.workEmail,
        company: body.company,
        role: body.role,
      },
      application: {
        providerChange: body.providerChange,
        repositoryScope: body.repositoryScope,
        successMetric: body.successMetric,
      },
      evidence: {
        actorPrincipalId: input.actorPrincipalId,
        requestId: input.requestId,
        purposeCode: PURPOSE_CODE,
        consentVersion: CONSENT_VERSION,
        consentGranted: true,
        authorizationConfirmed: true,
        formStartedAt: new Date(body.startedAt).toISOString(),
        acceptedAt: createdAt,
        source: input.source,
      },
    };
    const associatedData = `${input.tenantId}\n${id}\n${requestDigest}\n${contentDigest}`;
    const dataKey = randomBytes(32);
    const encryptedPayload = encryptPayload(dataKey, payload, associatedData);
    const wrappedDataKey = wrapDataKey(this.#wrappingKey, dataKey, input.tenantId, id);
    const retentionExpiresAt = new Date(acceptedAt.getTime() + this.#retentionMs).toISOString();

    try {
      this.db.raw.exec("BEGIN IMMEDIATE");
      this.db.raw.prepare(`INSERT INTO design_partner_applications (
        id, tenant_id, request_id, request_digest, email_hash, content_digest,
        encrypted_payload, purpose_code, consent_version, consent_granted,
        authorization_confirmed, actor_hash, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 'new', ?)`)
        .run(
          id,
          input.tenantId,
          input.requestId,
          requestDigest,
          emailHash,
          contentDigest,
          encryptedPayload,
          PURPOSE_CODE,
          CONSENT_VERSION,
          actorHash,
          createdAt,
        );
      this.db.raw.prepare(`INSERT INTO design_partner_application_payload_keys
        (tenant_id, application_id, wrapped_dek, created_at) VALUES (?, ?, ?, ?)`)
        .run(input.tenantId, id, wrappedDataKey, createdAt);
      this.db.raw.prepare(`INSERT INTO design_partner_application_retention
        (tenant_id, application_id, retention_expires_at, created_at) VALUES (?, ?, ?, ?)`)
        .run(input.tenantId, id, retentionExpiresAt, createdAt);
      this.db.raw.exec("COMMIT");
    } catch (error) {
      try {
        this.db.raw.exec("ROLLBACK");
      } catch {
        // The insert may fail before opening the transaction in a raced caller.
      }
      const raced = rowByRequest(this.db, input.tenantId, input.requestId);
      if (raced) {
        if (!constantDigestEqual(raced.request_digest, requestDigest)) {
          throw new Error("application_idempotency_conflict");
        }
        return { application: metadata(this.db, raced), replayed: true };
      }
      const racedDuplicate = this.db.raw.prepare(`SELECT 1 AS found FROM design_partner_applications
        WHERE tenant_id = ? AND content_digest = ?`).get(input.tenantId, contentDigest);
      if (racedDuplicate) throw new Error("application_duplicate_rejected");
      throw error;
    }
    const row = rowByRequest(this.db, input.tenantId, input.requestId);
    if (!row) throw new Error("application_insert_failed");
    return { application: metadata(this.db, row), replayed: false };
  }

  list(tenantId: string, limit = 50): readonly DesignPartnerApplicationMetadata[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db.raw.prepare(`SELECT * FROM design_partner_applications
      WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(tenantId, boundedLimit) as unknown as ApplicationRow[];
    return rows.map((row) => metadata(this.db, row));
  }

  get(tenantId: string, id: string): DesignPartnerApplicationMetadata | undefined {
    const row = this.db.raw.prepare(`SELECT * FROM design_partner_applications
      WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as ApplicationRow | undefined;
    return row ? metadata(this.db, row) : undefined;
  }

  reveal(
    input: RevealDesignPartnerApplicationInput,
    audit: ApplicationAuditCallback,
  ): Readonly<{
    application: DesignPartnerApplicationMetadata;
    payload: DesignPartnerPrivatePayload;
  }> {
    if (typeof audit !== "function") throw new Error("application_audit_callback_required");
    if (!IDENTIFIER_PATTERN.test(input.requestId) || !IDENTIFIER_PATTERN.test(input.applicationId)) {
      throw new Error("application_request_id_invalid");
    }
    if (!["application_review", "applicant_follow_up", "privacy_request"].includes(input.purposeCode)) {
      throw new Error("application_reveal_purpose_invalid");
    }
    const row = this.db.raw.prepare(`SELECT * FROM design_partner_applications
      WHERE tenant_id = ? AND id = ?`).get(input.tenantId, input.applicationId) as ApplicationRow | undefined;
    if (!row) throw new Error("application_not_found");
    const application = metadata(this.db, row);
    if (application.payloadState !== "available") throw new Error("application_payload_erased");
    const now = this.#now();
    if (Date.parse(application.retentionExpiresAt) <= now.getTime()) {
      throw new Error("application_payload_expired");
    }
    const keyRow = this.db.raw.prepare(`SELECT wrapped_dek FROM design_partner_application_payload_keys
      WHERE tenant_id = ? AND application_id = ?`).get(input.tenantId, input.applicationId) as PayloadKeyRow | undefined;
    if (!keyRow) throw new Error("application_payload_erased");
    const auditId = `application-reveal-${keyedDigest(this.#requestDigestKey, {
      tenantId: input.tenantId,
      requestId: input.requestId,
    }).slice(0, 40)}`;
    audit({
      id: auditId,
      tenantId: input.tenantId,
      actorPrincipalId: input.actorPrincipalId,
      requestId: input.requestId,
      action: "design_partner_application.reveal",
      resourceId: input.applicationId,
      purposeCode: input.purposeCode,
      occurredAt: now.toISOString(),
    });
    const dataKey = unwrapDataKey(this.#wrappingKey, keyRow.wrapped_dek, input.tenantId, input.applicationId);
    return {
      application,
      payload: decryptPayload(dataKey, row.encrypted_payload, payloadAssociatedData(row)),
    };
  }

  erase(input: EraseDesignPartnerApplicationInput): EraseDesignPartnerApplicationResult {
    if (!IDENTIFIER_PATTERN.test(input.requestId) || !IDENTIFIER_PATTERN.test(input.applicationId)) {
      throw new Error("application_request_id_invalid");
    }
    if (!["applicant_request", "operator_request", "retention_expired"].includes(input.reasonCode)) {
      throw new Error("application_erasure_reason_invalid");
    }
    const row = this.db.raw.prepare(`SELECT * FROM design_partner_applications
      WHERE tenant_id = ? AND id = ?`).get(input.tenantId, input.applicationId) as ApplicationRow | undefined;
    if (!row) throw new Error("application_not_found");
    const requestDigest = keyedDigest(this.#requestDigestKey, {
      applicationId: input.applicationId,
      actorPrincipalId: input.actorPrincipalId,
      reasonCode: input.reasonCode,
    });
    const priorRequest = this.db.raw.prepare(`SELECT * FROM design_partner_application_erasures
      WHERE tenant_id = ? AND request_id = ?`).get(input.tenantId, input.requestId) as ErasureRow | undefined;
    if (priorRequest) {
      if (!constantDigestEqual(priorRequest.request_digest, requestDigest)) {
        throw new Error("application_idempotency_conflict");
      }
      return {
        application: metadata(this.db, row),
        erasure: {
          id: priorRequest.id,
          applicationId: priorRequest.application_id,
          reasonCode: priorRequest.reason_code,
          createdAt: priorRequest.created_at,
        },
        replayed: true,
      };
    }
    const existing = this.db.raw.prepare(`SELECT * FROM design_partner_application_erasures
      WHERE tenant_id = ? AND application_id = ?`).get(input.tenantId, input.applicationId) as ErasureRow | undefined;
    if (existing) {
      return {
        application: metadata(this.db, row),
        erasure: {
          id: existing.id,
          applicationId: existing.application_id,
          reasonCode: existing.reason_code,
          createdAt: existing.created_at,
        },
        replayed: true,
      };
    }
    const createdAt = this.#now().toISOString();
    const erasureId = `application-erasure-${keyedDigest(this.#requestDigestKey, {
      tenantId: input.tenantId,
      applicationId: input.applicationId,
    }).slice(0, 40)}`;
    const actorHash = keyedDigest(this.#actorDigestKey, input.actorPrincipalId);
    this.db.raw.exec("BEGIN IMMEDIATE");
    try {
      this.db.raw.prepare(`INSERT INTO design_partner_application_erasures
        (id, tenant_id, application_id, request_id, request_digest, actor_hash, reason_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          erasureId,
          input.tenantId,
          input.applicationId,
          input.requestId,
          requestDigest,
          actorHash,
          input.reasonCode,
          createdAt,
        );
      this.db.raw.prepare(`DELETE FROM design_partner_application_payload_keys
        WHERE tenant_id = ? AND application_id = ?`).run(input.tenantId, input.applicationId);
      this.db.raw.exec("COMMIT");
    } catch (error) {
      this.db.raw.exec("ROLLBACK");
      throw error;
    }
    try {
      this.db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // The wrapped key is absent from live state even if a busy reader delays WAL compaction.
    }
    const erasure: ApplicationErasureEvent = {
      id: erasureId,
      applicationId: input.applicationId,
      reasonCode: input.reasonCode,
      createdAt,
    };
    return { application: metadata(this.db, row), erasure, replayed: false };
  }

  purgeExpired(input: PurgeExpiredApplicationsInput): Readonly<{
    purgedApplicationIds: readonly string[];
    purgedCount: number;
  }> {
    if (!IDENTIFIER_PATTERN.test(input.requestId)) throw new Error("application_request_id_invalid");
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 100)));
    const now = this.#now().toISOString();
    const candidates = this.db.raw.prepare(`SELECT a.id FROM design_partner_applications a
      INNER JOIN design_partner_application_retention r
        ON r.tenant_id = a.tenant_id AND r.application_id = a.id
      INNER JOIN design_partner_application_payload_keys k
        ON k.tenant_id = a.tenant_id AND k.application_id = a.id
      WHERE a.tenant_id = ? AND r.retention_expires_at <= ?
      ORDER BY r.retention_expires_at ASC, a.id ASC LIMIT ?`)
      .all(input.tenantId, now, limit) as unknown as Array<{ id: string }>;
    const purgedApplicationIds: string[] = [];
    for (const candidate of candidates) {
      const childRequestId = `purge-${keyedDigest(this.#requestDigestKey, {
        requestId: input.requestId,
        applicationId: candidate.id,
      }).slice(0, 48)}`;
      this.erase({
        tenantId: input.tenantId,
        actorPrincipalId: input.actorPrincipalId,
        requestId: childRequestId,
        applicationId: candidate.id,
        reasonCode: "retention_expired",
      });
      purgedApplicationIds.push(candidate.id);
    }
    return { purgedApplicationIds, purgedCount: purgedApplicationIds.length };
  }
}

export function createDesignPartnerApplicationStore(
  options: DesignPartnerApplicationStoreOptions,
): DesignPartnerApplicationStore {
  return new DesignPartnerApplicationStore(options);
}
