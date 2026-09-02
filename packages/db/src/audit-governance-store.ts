import { createHash } from "node:crypto";
import {
  createGovernedAuditExport,
  evaluateAuditRetention,
  verifyGovernedAuditExport,
  type AuditLegalHold,
  type AuditRedactionProfile,
  type AuditRetentionDecision,
  type AuditRetentionClass,
  type GovernedAuditExport,
  type GovernedAuditRecord,
} from "@mendpoint/shared/audit-governance";
import type { AppDb } from "./index.js";
import type { AuditEvent } from "./schema.js";

export type AuditLegalHoldEventRow = Readonly<{
  id: string;
  tenant_id: string;
  hold_id: string;
  sequence: number;
  action: "active" | "released";
  reason: string;
  resource_type: string | null;
  resource_id: string | null;
  event_ids_json: string;
  actor_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
}>;

export type AuditExportDestinationEventRow = Readonly<{
  id: string;
  tenant_id: string;
  destination_id: string;
  sequence: number;
  status: "active" | "revoked";
  uri: string;
  actor_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
}>;

export type AuditExportManifestRow = Readonly<{
  id: string;
  tenant_id: string;
  destination_id: string;
  requested_by_actor_id: string;
  redaction_profile: AuditRedactionProfile;
  requested_limit: number;
  record_count: number;
  source_first_hash: string | null;
  source_last_hash: string | null;
  export_sha256: string;
  bundle_json: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DESTINATION = /^(customer|s3|gs|azure):\/\/[A-Za-z0-9][A-Za-z0-9._~:/-]{1,1023}$/;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function requireId(value: string, code: string): string {
  if (!ID.test(value)) throw new Error(code);
  return value;
}

function requireActor(value: string, code: string): string {
  if (!/^[^\s\u0000-\u001f]{1,512}$/.test(value)) throw new Error(code);
  return value;
}

function requireIso(value: string, code: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
  return value;
}

function transaction<T>(db: AppDb, operation: () => T): T {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (owns) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function one<T>(db: AppDb, sql: string, values: unknown[] = []): T | undefined {
  return db.raw.prepare(sql).get(...values as never[]) as T | undefined;
}

function many<T>(db: AppDb, sql: string, values: unknown[] = []): T[] {
  return db.raw.prepare(sql).all(...values as never[]) as T[];
}

function fingerprint(value: unknown): string {
  return sha256(canonical(value));
}

function eventHash(value: Record<string, unknown>): string {
  return sha256(canonical(value));
}

function sameReplay<T extends { request_fingerprint: string }>(
  existing: T | undefined,
  expectedFingerprint: string,
  conflictCode: string,
): T | undefined {
  if (!existing) return undefined;
  if (existing.request_fingerprint !== expectedFingerprint) throw new Error(conflictCode);
  return existing;
}

function assertAuditGovernanceIntegrity(db: AppDb, tenantId: string): void {
  const result = verifyAuditGovernanceIntegrity(db, tenantId);
  if (!result.ok) throw new Error("audit_governance_integrity_invalid");
}

export function ensureAuditGovernanceSchema(db: AppDb): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS audit_legal_hold_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      hold_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      action TEXT NOT NULL CHECK (action IN ('active', 'released')),
      reason TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      event_ids_json TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      previous_hash TEXT,
      event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, hold_id, sequence),
      UNIQUE (tenant_id, idempotency_key),
      CHECK ((resource_type IS NULL) = (resource_id IS NULL))
    );
    CREATE INDEX IF NOT EXISTS audit_legal_hold_events_current_idx
      ON audit_legal_hold_events(tenant_id, hold_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS audit_export_destination_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      destination_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
      uri TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      previous_hash TEXT,
      event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, destination_id, sequence),
      UNIQUE (tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS audit_export_destination_events_current_idx
      ON audit_export_destination_events(tenant_id, destination_id, sequence DESC);
    CREATE TABLE IF NOT EXISTS audit_export_manifests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      destination_id TEXT NOT NULL,
      requested_by_actor_id TEXT NOT NULL,
      redaction_profile TEXT NOT NULL CHECK (redaction_profile IN ('support', 'security', 'minimal')),
      requested_limit INTEGER NOT NULL CHECK (requested_limit BETWEEN 1 AND 5000),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      source_first_hash TEXT,
      source_last_hash TEXT,
      export_sha256 TEXT NOT NULL CHECK (length(export_sha256) = 64),
      bundle_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS audit_export_manifests_tenant_created_idx
      ON audit_export_manifests(tenant_id, created_at DESC);
  `);
  for (const table of [
    "audit_legal_hold_events",
    "audit_export_destination_events",
    "audit_export_manifests",
  ]) {
    db.raw.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table}_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table}_append_only'); END;
    `);
  }
}

function validateHoldScope(
  db: AppDb,
  tenantId: string,
  resourceType: string | null,
  resourceId: string | null,
  eventIds: readonly string[],
): void {
  if ((resourceType === null) !== (resourceId === null)) throw new Error("audit_hold_scope_invalid");
  if (resourceType === null && eventIds.length === 0) throw new Error("audit_hold_scope_required");
  for (const eventId of eventIds) {
    requireId(eventId, "audit_hold_event_id_invalid");
    const event = one<{ tenant_id: string }>(db, "SELECT tenant_id FROM audit_events WHERE id = ?", [eventId]);
    if (!event || event.tenant_id !== tenantId) throw new Error("audit_hold_event_not_found");
  }
}

export function createAuditLegalHold(db: AppDb, input: Readonly<{
  id: string;
  holdId: string;
  tenantId: string;
  reason: string;
  resourceType?: string | null;
  resourceId?: string | null;
  eventIds?: readonly string[];
  actorId: string;
  idempotencyKey: string;
  createdAt: string;
}>): AuditLegalHoldEventRow {
  requireId(input.id, "audit_hold_event_id_invalid");
  requireId(input.holdId, "audit_hold_id_invalid");
  requireId(input.tenantId, "audit_hold_tenant_invalid");
  requireActor(input.actorId, "audit_hold_actor_invalid");
  requireId(input.idempotencyKey, "audit_hold_idempotency_invalid");
  requireIso(input.createdAt, "audit_hold_created_at_invalid");
  if (!input.reason.trim() || input.reason.length > 1024) throw new Error("audit_hold_reason_invalid");
  const resourceType = input.resourceType ?? null;
  const resourceId = input.resourceId ?? null;
  const eventIds = Object.freeze([...(input.eventIds ?? [])].sort());
  const request = {
    action: "active",
    holdId: input.holdId,
    tenantId: input.tenantId,
    reason: input.reason,
    resourceType,
    resourceId,
    eventIds,
    actorId: input.actorId,
    createdAt: input.createdAt,
  };
  const requestFingerprint = fingerprint(request);
  return transaction(db, () => {
    assertAuditGovernanceIntegrity(db, input.tenantId);
    const replay = sameReplay(one<AuditLegalHoldEventRow>(db,
      "SELECT * FROM audit_legal_hold_events WHERE tenant_id = ? AND idempotency_key = ?",
      [input.tenantId, input.idempotencyKey]), requestFingerprint, "audit_hold_idempotency_conflict");
    if (replay) return replay;
    if (one(db, "SELECT 1 FROM audit_legal_hold_events WHERE tenant_id = ? AND hold_id = ?", [input.tenantId, input.holdId])) {
      throw new Error("audit_hold_exists");
    }
    validateHoldScope(db, input.tenantId, resourceType, resourceId, eventIds);
    const hashInput = {
      ...request,
      eventId: input.id,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      sequence: 1,
      previousHash: null,
    };
    const hash = eventHash(hashInput);
    db.raw.prepare(`INSERT INTO audit_legal_hold_events
      (id, tenant_id, hold_id, sequence, action, reason, resource_type, resource_id,
       event_ids_json, actor_id, idempotency_key, request_fingerprint, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(input.id, input.tenantId, input.holdId, input.reason, resourceType, resourceId,
        JSON.stringify(eventIds), input.actorId, input.idempotencyKey, requestFingerprint, hash, input.createdAt);
    return one<AuditLegalHoldEventRow>(db, "SELECT * FROM audit_legal_hold_events WHERE id = ?", [input.id])!;
  });
}

export function releaseAuditLegalHold(db: AppDb, input: Readonly<{
  id: string;
  holdId: string;
  tenantId: string;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  createdAt: string;
}>): AuditLegalHoldEventRow {
  requireId(input.id, "audit_hold_event_id_invalid");
  requireId(input.holdId, "audit_hold_id_invalid");
  requireId(input.tenantId, "audit_hold_tenant_invalid");
  requireActor(input.actorId, "audit_hold_actor_invalid");
  requireId(input.idempotencyKey, "audit_hold_idempotency_invalid");
  requireIso(input.createdAt, "audit_hold_created_at_invalid");
  if (!input.reason.trim() || input.reason.length > 1024) throw new Error("audit_hold_reason_invalid");
  const request = { action: "released", holdId: input.holdId, tenantId: input.tenantId,
    reason: input.reason, actorId: input.actorId, createdAt: input.createdAt };
  const requestFingerprint = fingerprint(request);
  return transaction(db, () => {
    assertAuditGovernanceIntegrity(db, input.tenantId);
    const replay = sameReplay(one<AuditLegalHoldEventRow>(db,
      "SELECT * FROM audit_legal_hold_events WHERE tenant_id = ? AND idempotency_key = ?",
      [input.tenantId, input.idempotencyKey]), requestFingerprint, "audit_hold_idempotency_conflict");
    if (replay) return replay;
    const previous = one<AuditLegalHoldEventRow>(db, `SELECT * FROM audit_legal_hold_events
      WHERE tenant_id = ? AND hold_id = ? ORDER BY sequence DESC LIMIT 1`, [input.tenantId, input.holdId]);
    if (!previous) throw new Error("audit_hold_not_found");
    if (previous.action !== "active") throw new Error("audit_hold_not_active");
    const sequence = previous.sequence + 1;
    const hash = eventHash({
      ...request,
      eventId: input.id,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      sequence,
      previousHash: previous.event_hash,
    });
    db.raw.prepare(`INSERT INTO audit_legal_hold_events
      (id, tenant_id, hold_id, sequence, action, reason, resource_type, resource_id,
       event_ids_json, actor_id, idempotency_key, request_fingerprint, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, ?, 'released', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.tenantId, input.holdId, sequence, input.reason,
        previous.resource_type, previous.resource_id, previous.event_ids_json, input.actorId,
        input.idempotencyKey, requestFingerprint, previous.event_hash, hash, input.createdAt);
    return one<AuditLegalHoldEventRow>(db, "SELECT * FROM audit_legal_hold_events WHERE id = ?", [input.id])!;
  });
}

export function listAuditLegalHolds(db: AppDb, tenantId: string): AuditLegalHoldEventRow[] {
  requireId(tenantId, "audit_hold_tenant_invalid");
  return many(db, `SELECT event.* FROM audit_legal_hold_events event
    WHERE event.tenant_id = ? AND event.sequence = (
      SELECT MAX(candidate.sequence) FROM audit_legal_hold_events candidate
      WHERE candidate.tenant_id = event.tenant_id AND candidate.hold_id = event.hold_id)
    ORDER BY event.created_at DESC, event.hold_id`, [tenantId]);
}

export function registerAuditExportDestination(db: AppDb, input: Readonly<{
  id: string; destinationId: string; tenantId: string; uri: string; actorId: string;
  idempotencyKey: string; createdAt: string;
}>): AuditExportDestinationEventRow {
  for (const [value, code] of [[input.id, "audit_destination_event_id_invalid"],
    [input.destinationId, "audit_destination_id_invalid"], [input.tenantId, "audit_destination_tenant_invalid"],
    [input.idempotencyKey, "audit_destination_idempotency_invalid"]] as const) requireId(value, code);
  requireActor(input.actorId, "audit_destination_actor_invalid");
  requireIso(input.createdAt, "audit_destination_created_at_invalid");
  if (!DESTINATION.test(input.uri)) throw new Error("audit_export_destination_invalid");
  if (input.uri.startsWith("customer://") &&
    !input.uri.startsWith(`customer://${input.tenantId}/`)) {
    throw new Error("audit_export_destination_tenant_mismatch");
  }
  const request = { status: "active", destinationId: input.destinationId, tenantId: input.tenantId,
    uri: input.uri, actorId: input.actorId, createdAt: input.createdAt };
  const requestFingerprint = fingerprint(request);
  return transaction(db, () => {
    assertAuditGovernanceIntegrity(db, input.tenantId);
    const replay = sameReplay(one<AuditExportDestinationEventRow>(db,
      "SELECT * FROM audit_export_destination_events WHERE tenant_id = ? AND idempotency_key = ?",
      [input.tenantId, input.idempotencyKey]), requestFingerprint, "audit_destination_idempotency_conflict");
    if (replay) return replay;
    if (one(db, "SELECT 1 FROM audit_export_destination_events WHERE tenant_id = ? AND destination_id = ?", [input.tenantId, input.destinationId])) throw new Error("audit_destination_exists");
    const hash = eventHash({
      ...request,
      eventId: input.id,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      sequence: 1,
      previousHash: null,
    });
    db.raw.prepare(`INSERT INTO audit_export_destination_events
      (id, tenant_id, destination_id, sequence, status, uri, actor_id, idempotency_key,
       request_fingerprint, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?, NULL, ?, ?)`)
      .run(input.id, input.tenantId, input.destinationId, input.uri, input.actorId,
        input.idempotencyKey, requestFingerprint, hash, input.createdAt);
    return one<AuditExportDestinationEventRow>(db, "SELECT * FROM audit_export_destination_events WHERE id = ?", [input.id])!;
  });
}

export function revokeAuditExportDestination(db: AppDb, input: Readonly<{
  id: string; destinationId: string; tenantId: string; actorId: string;
  idempotencyKey: string; createdAt: string;
}>): AuditExportDestinationEventRow {
  for (const [value, code] of [[input.id, "audit_destination_event_id_invalid"],
    [input.destinationId, "audit_destination_id_invalid"], [input.tenantId, "audit_destination_tenant_invalid"],
    [input.idempotencyKey, "audit_destination_idempotency_invalid"]] as const) requireId(value, code);
  requireActor(input.actorId, "audit_destination_actor_invalid");
  requireIso(input.createdAt, "audit_destination_created_at_invalid");
  const request = { status: "revoked", destinationId: input.destinationId, tenantId: input.tenantId,
    actorId: input.actorId, createdAt: input.createdAt };
  const requestFingerprint = fingerprint(request);
  return transaction(db, () => {
    assertAuditGovernanceIntegrity(db, input.tenantId);
    const replay = sameReplay(one<AuditExportDestinationEventRow>(db,
      "SELECT * FROM audit_export_destination_events WHERE tenant_id = ? AND idempotency_key = ?",
      [input.tenantId, input.idempotencyKey]), requestFingerprint, "audit_destination_idempotency_conflict");
    if (replay) return replay;
    const previous = one<AuditExportDestinationEventRow>(db, `SELECT * FROM audit_export_destination_events
      WHERE tenant_id = ? AND destination_id = ? ORDER BY sequence DESC LIMIT 1`, [input.tenantId, input.destinationId]);
    if (!previous) throw new Error("audit_destination_not_found");
    if (previous.status !== "active") throw new Error("audit_destination_not_active");
    const sequence = previous.sequence + 1;
    const hash = eventHash({
      ...request,
      uri: previous.uri,
      eventId: input.id,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint,
      sequence,
      previousHash: previous.event_hash,
    });
    db.raw.prepare(`INSERT INTO audit_export_destination_events
      (id, tenant_id, destination_id, sequence, status, uri, actor_id, idempotency_key,
       request_fingerprint, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, ?, 'revoked', ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.tenantId, input.destinationId, sequence, previous.uri, input.actorId,
        input.idempotencyKey, requestFingerprint, previous.event_hash, hash, input.createdAt);
    return one<AuditExportDestinationEventRow>(db, "SELECT * FROM audit_export_destination_events WHERE id = ?", [input.id])!;
  });
}

export function listAuditExportDestinations(db: AppDb, tenantId: string): AuditExportDestinationEventRow[] {
  requireId(tenantId, "audit_destination_tenant_invalid");
  return many(db, `SELECT event.* FROM audit_export_destination_events event
    WHERE event.tenant_id = ? AND event.sequence = (
      SELECT MAX(candidate.sequence) FROM audit_export_destination_events candidate
      WHERE candidate.tenant_id = event.tenant_id AND candidate.destination_id = event.destination_id)
    ORDER BY event.created_at DESC, event.destination_id`, [tenantId]);
}

function auditHash(input: AuditEvent): string {
  return sha256(JSON.stringify({
    tenantId: input.tenant_id,
    sequence: input.event_sequence,
    schemaVersion: input.schema_version,
    previousHash: input.prev_hash,
    id: input.id,
    actor: input.actor,
    principalId: input.principal_id,
    apiKeyId: input.api_key_id,
    requestId: input.request_id,
    action: input.action,
    resourceType: input.resource_type,
    resourceId: input.resource_id,
    metadataSha256: input.metadata_sha256,
    createdAt: input.created_at,
  }));
}

type AuditSourceIndex =
  | Readonly<{ ok: true; hashById: ReadonlyMap<string, string> }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Recompute the tenant audit chain once and index every row hash by id.
 *
 * Manifest verification needs both the chain proof and per-record hashes. Doing
 * that inside each manifest made an admin request O(manifests x audit_events)
 * plus one row lookup per exported record; sharing one pass makes a governance
 * sweep a single linear scan regardless of how many manifests a tenant holds.
 */
function auditSourceIndex(db: AppDb, tenantId: string): AuditSourceIndex {
  try {
    const hashById = new Map<string, string>();
    for (const row of verifiedAuditRows(db, tenantId, Number.MAX_SAFE_INTEGER)) {
      hashById.set(row.id, row.event_hash);
    }
    return Object.freeze({ ok: true as const, hashById });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      error: error instanceof Error ? error.message : "audit_source_integrity_invalid",
    });
  }
}

function verifiedAuditRows(db: AppDb, tenantId: string, limit: number): AuditEvent[] {
  const allRows = many<AuditEvent>(db,
    "SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY event_sequence", [tenantId]);
  let previous: string | null = null;
  for (let index = 0; index < allRows.length; index += 1) {
    const row = allRows[index]!;
    const metadataHash = sha256(JSON.stringify(row.metadata_json ?? null));
    if (row.event_sequence !== index + 1 || row.prev_hash !== previous ||
      row.metadata_sha256 !== metadataHash || row.event_hash !== auditHash(row)) {
      throw new Error(`audit_source_integrity_invalid:${row.id}`);
    }
    previous = row.event_hash;
  }
  return allRows.slice(Math.max(0, allRows.length - limit));
}

/**
 * Classify one audit row for retention. An action no pattern recognises falls
 * through to the longest retention, not the shortest: an unclassified security
 * or compliance event must never be the first record to become eligible for
 * deletion simply because nobody taught the classifier about it. Shortening a
 * class is a deliberate act — add the action to a pattern above.
 */
function retentionClass(row: AuditEvent): AuditRetentionClass {
  const subject = `${row.action}:${row.resource_type}`.toLowerCase();
  if (/(billing|invoice|usage|credit|refund|payment|mcu)/.test(subject)) return "financial";
  if (/(consent|legal_hold|retention|compliance)/.test(subject)) return "regulated";
  if (/(auth|identity|secret|policy|audit|security|deploy|repository)/.test(subject)) return "security";
  return "regulated";
}

function metadata(row: AuditEvent): Readonly<Record<string, unknown>> {
  if (!row.metadata_json) return Object.freeze({});
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.freeze(parsed as Record<string, unknown>) : Object.freeze({});
  } catch {
    throw new Error(`audit_source_metadata_invalid:${row.id}`);
  }
}

function governedRecord(row: AuditEvent): GovernedAuditRecord {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.principal_id ?? row.actor,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id ?? row.id,
    retentionClass: retentionClass(row),
    occurredAt: row.created_at,
    metadata: metadata(row),
    sourceEventHash: row.event_hash,
  });
}

export function listAuditRetentionDecisions(
  db: AppDb,
  tenantId: string,
  at: string,
  limit = 5000,
): readonly AuditRetentionDecision[] {
  requireId(tenantId, "audit_retention_tenant_invalid");
  requireIso(at, "audit_retention_at_invalid");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("audit_retention_limit_invalid");
  }
  const records = verifiedAuditRows(db, tenantId, limit).map(governedRecord);
  const holds: AuditLegalHold[] = listAuditLegalHolds(db, tenantId).map((row) => Object.freeze({
    id: row.hold_id,
    tenantId: row.tenant_id,
    status: row.action,
    reason: row.reason,
    resourceType: row.resource_type ?? undefined,
    resourceId: row.resource_id ?? undefined,
    eventIds: (() => {
      try {
        const parsed = JSON.parse(row.event_ids_json) as unknown;
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
          throw new Error("invalid");
        }
        return parsed as string[];
      } catch {
        throw new Error(`audit_hold_event_ids_invalid:${row.id}`);
      }
    })(),
    createdAt: row.created_at,
    releasedAt: row.action === "released" ? row.created_at : undefined,
  }));
  return Object.freeze(records.map((record) => evaluateAuditRetention(record, holds, new Date(at))));
}

export function createAuditExportManifest(db: AppDb, input: Readonly<{
  id: string; tenantId: string; destinationId: string; requestedByActorId: string;
  redactionProfile: AuditRedactionProfile; limit: number; idempotencyKey: string; createdAt: string;
}>): Readonly<{ manifest: AuditExportManifestRow; bundle: GovernedAuditExport }> {
  for (const [value, code] of [[input.id, "audit_export_id_invalid"], [input.tenantId, "audit_export_tenant_invalid"],
    [input.destinationId, "audit_destination_id_invalid"],
    [input.idempotencyKey, "audit_export_idempotency_invalid"]] as const) requireId(value, code);
  requireActor(input.requestedByActorId, "audit_export_actor_invalid");
  requireIso(input.createdAt, "audit_export_created_at_invalid");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5000) throw new Error("audit_export_limit_invalid");
  const request = { tenantId: input.tenantId, destinationId: input.destinationId,
    requestedByActorId: input.requestedByActorId, redactionProfile: input.redactionProfile,
    limit: input.limit, createdAt: input.createdAt };
  const requestFingerprint = fingerprint(request);
  return transaction(db, () => {
    assertAuditGovernanceIntegrity(db, input.tenantId);
    const replay = sameReplay(one<AuditExportManifestRow>(db,
      "SELECT * FROM audit_export_manifests WHERE tenant_id = ? AND idempotency_key = ?",
      [input.tenantId, input.idempotencyKey]), requestFingerprint, "audit_export_idempotency_conflict");
    if (replay) {
      const bundle = JSON.parse(replay.bundle_json) as GovernedAuditExport;
      const verification = verifyStoredAuditExport(db, input.tenantId, replay.id);
      if (!verification.ok || bundle.sha256 !== replay.export_sha256) {
        throw new Error("audit_export_replay_invalid");
      }
      return Object.freeze({ manifest: replay, bundle });
    }
    const destination = one<AuditExportDestinationEventRow>(db, `SELECT * FROM audit_export_destination_events
      WHERE tenant_id = ? AND destination_id = ? ORDER BY sequence DESC LIMIT 1`,
      [input.tenantId, input.destinationId]);
    if (!destination || destination.status !== "active") throw new Error("audit_destination_not_active");
    const rows = verifiedAuditRows(db, input.tenantId, input.limit);
    const records: GovernedAuditRecord[] = rows.map(governedRecord);
    const bundle = createGovernedAuditExport({
      exportId: input.id,
      tenantId: input.tenantId,
      requestedByActorId: input.requestedByActorId,
      destination: { uri: destination.uri, ownerTenantId: input.tenantId },
      redactionProfile: input.redactionProfile,
      createdAt: input.createdAt,
      records,
    });
    if (!verifyGovernedAuditExport(bundle).ok) throw new Error("audit_export_generation_invalid");
    const bundleJson = JSON.stringify(bundle);
    db.raw.prepare(`INSERT INTO audit_export_manifests
      (id, tenant_id, destination_id, requested_by_actor_id, redaction_profile, requested_limit, record_count,
       source_first_hash, source_last_hash, export_sha256, bundle_json, idempotency_key,
       request_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.tenantId, input.destinationId, input.requestedByActorId,
        input.redactionProfile, input.limit, bundle.records.length, bundle.records[0]?.sourceEventHash ?? null,
        bundle.records.at(-1)?.sourceEventHash ?? null, bundle.sha256, bundleJson,
        input.idempotencyKey, requestFingerprint, input.createdAt);
    return Object.freeze({
      manifest: one<AuditExportManifestRow>(db, "SELECT * FROM audit_export_manifests WHERE id = ?", [input.id])!,
      bundle,
    });
  });
}

export function getAuditExportManifest(db: AppDb, tenantId: string, id: string):
  Readonly<{ manifest: AuditExportManifestRow; bundle: GovernedAuditExport }> | undefined {
  const manifest = one<AuditExportManifestRow>(db,
    "SELECT * FROM audit_export_manifests WHERE tenant_id = ? AND id = ?", [tenantId, id]);
  if (!manifest) return undefined;
  return Object.freeze({ manifest, bundle: JSON.parse(manifest.bundle_json) as GovernedAuditExport });
}

export function verifyStoredAuditExport(db: AppDb, tenantId: string, id: string): Readonly<{
  ok: boolean; checked: number; error?: string;
}> {
  return verifyStoredAuditExportAgainst(db, tenantId, id, auditSourceIndex(db, tenantId));
}

function verifyStoredAuditExportAgainst(
  db: AppDb,
  tenantId: string,
  id: string,
  source: AuditSourceIndex,
): Readonly<{ ok: boolean; checked: number; error?: string }> {
  let stored: ReturnType<typeof getAuditExportManifest>;
  try {
    stored = getAuditExportManifest(db, tenantId, id);
  } catch {
    return { ok: false, checked: 0, error: "audit_export_bundle_invalid" };
  }
  if (!stored) return { ok: false, checked: 0, error: "audit_export_not_found" };
  const result = verifyGovernedAuditExport(stored.bundle);
  if (!result.ok) return result;
  const expectedRequestFingerprint = fingerprint({
    tenantId: stored.manifest.tenant_id,
    destinationId: stored.manifest.destination_id,
    requestedByActorId: stored.manifest.requested_by_actor_id,
    redactionProfile: stored.manifest.redaction_profile,
    limit: stored.manifest.requested_limit,
    createdAt: stored.manifest.created_at,
  });
  const destination = one<AuditExportDestinationEventRow>(db, `SELECT * FROM audit_export_destination_events
    WHERE tenant_id = ? AND destination_id = ? ORDER BY sequence DESC LIMIT 1`,
    [tenantId, stored.manifest.destination_id]);
  if (stored.bundle.exportId !== stored.manifest.id ||
    stored.bundle.tenantId !== stored.manifest.tenant_id ||
    stored.bundle.requestedByActorId !== stored.manifest.requested_by_actor_id ||
    stored.bundle.redactionProfile !== stored.manifest.redaction_profile ||
    stored.bundle.createdAt !== stored.manifest.created_at ||
    stored.bundle.destination.ownerTenantId !== stored.manifest.tenant_id ||
    !destination || stored.bundle.destination.uri !== destination.uri ||
    stored.manifest.request_fingerprint !== expectedRequestFingerprint ||
    stored.bundle.sha256 !== stored.manifest.export_sha256 ||
    stored.bundle.records.length !== stored.manifest.record_count ||
    (stored.bundle.records[0]?.sourceEventHash ?? null) !== stored.manifest.source_first_hash ||
    (stored.bundle.records.at(-1)?.sourceEventHash ?? null) !== stored.manifest.source_last_hash) {
    return { ok: false, checked: result.checked, error: "audit_export_manifest_mismatch" };
  }
  if (!source.ok) return { ok: false, checked: result.checked, error: source.error };
  for (const record of stored.bundle.records) {
    if (source.hashById.get(record.id) !== record.sourceEventHash) {
      return { ok: false, checked: result.checked, error: `audit_export_source_mismatch:${record.id}` };
    }
  }
  return result;
}

export function verifyAuditGovernanceIntegrity(db: AppDb, tenantId: string): Readonly<{
  ok: boolean; checked: number; error?: string;
}> {
  let checked = 0;
  const holds = many<AuditLegalHoldEventRow>(db,
    "SELECT * FROM audit_legal_hold_events WHERE tenant_id = ? ORDER BY hold_id, sequence", [tenantId]);
  const holdPrevious = new Map<string, string | null>();
  const holdSequence = new Map<string, number>();
  for (const row of holds) {
    const expectedSequence = (holdSequence.get(row.hold_id) ?? 0) + 1;
    const previousHash = holdPrevious.get(row.hold_id) ?? null;
    let expected: string;
    if (row.action === "active") {
      let parsedEventIds: unknown;
      try {
        parsedEventIds = JSON.parse(row.event_ids_json) as unknown;
      } catch {
        return { ok: false, checked, error: `audit_hold_event_ids_invalid:${row.id}` };
      }
      if (!Array.isArray(parsedEventIds) ||
        parsedEventIds.some((item) => typeof item !== "string")) {
        return { ok: false, checked, error: `audit_hold_event_ids_invalid:${row.id}` };
      }
      expected = eventHash({
        action: "active", holdId: row.hold_id, tenantId: row.tenant_id, reason: row.reason,
        resourceType: row.resource_type, resourceId: row.resource_id,
        eventIds: parsedEventIds, actorId: row.actor_id,
        createdAt: row.created_at, eventId: row.id, idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint, sequence: row.sequence,
        previousHash: row.previous_hash,
      });
    } else {
      expected = eventHash({
        action: "released", holdId: row.hold_id, tenantId: row.tenant_id, reason: row.reason,
        actorId: row.actor_id, createdAt: row.created_at, eventId: row.id,
        idempotencyKey: row.idempotency_key, requestFingerprint: row.request_fingerprint,
        sequence: row.sequence,
        previousHash: row.previous_hash,
      });
    }
    if (row.sequence !== expectedSequence || row.previous_hash !== previousHash ||
      row.event_hash !== expected) {
      return { ok: false, checked, error: `audit_hold_chain_invalid:${row.id}` };
    }
    holdSequence.set(row.hold_id, row.sequence);
    holdPrevious.set(row.hold_id, row.event_hash);
    checked += 1;
  }

  const destinations = many<AuditExportDestinationEventRow>(db,
    "SELECT * FROM audit_export_destination_events WHERE tenant_id = ? ORDER BY destination_id, sequence",
    [tenantId]);
  const destinationPrevious = new Map<string, string | null>();
  const destinationSequence = new Map<string, number>();
  for (const row of destinations) {
    const expectedSequence = (destinationSequence.get(row.destination_id) ?? 0) + 1;
    const previousHash = destinationPrevious.get(row.destination_id) ?? null;
    const expected = row.status === "active"
      ? eventHash({ status: "active", destinationId: row.destination_id, tenantId: row.tenant_id,
        uri: row.uri, actorId: row.actor_id, createdAt: row.created_at,
        eventId: row.id, idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint, sequence: row.sequence,
        previousHash: row.previous_hash })
      : eventHash({ status: "revoked", destinationId: row.destination_id, tenantId: row.tenant_id,
        actorId: row.actor_id, createdAt: row.created_at, uri: row.uri,
        eventId: row.id, idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint, sequence: row.sequence,
        previousHash: row.previous_hash });
    if (row.sequence !== expectedSequence || row.previous_hash !== previousHash || row.event_hash !== expected) {
      return { ok: false, checked, error: `audit_destination_chain_invalid:${row.id}` };
    }
    destinationSequence.set(row.destination_id, row.sequence);
    destinationPrevious.set(row.destination_id, row.event_hash);
    checked += 1;
  }

  const manifests = many<{ id: string }>(db,
    "SELECT id FROM audit_export_manifests WHERE tenant_id = ? ORDER BY created_at, id", [tenantId]);
  if (manifests.length > 0) {
    // One source-chain pass for the whole sweep. Computed only when there is a
    // manifest to check so hold-only and destination-only tenants never pay it.
    const source = auditSourceIndex(db, tenantId);
    for (const manifest of manifests) {
      const result = verifyStoredAuditExportAgainst(db, tenantId, manifest.id, source);
      if (!result.ok) return { ok: false, checked, error: result.error ?? "audit_export_replay_invalid" };
      checked += 1;
    }
  }
  return { ok: true, checked };
}
