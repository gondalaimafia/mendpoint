import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import type {
  ArtifactManifestRow,
  DomainEventRow,
  EvidenceRecordRow,
  PrincipalRow,
  ReviewDecisionRow,
} from "./schema.js";

const SHA256 = /^[a-f0-9]{64}$/;
const PRINCIPAL_KINDS = new Set(["human", "service", "api_key", "webhook"]);
const EVIDENCE_VERDICTS = new Set(["passed", "failed", "unknown", "waived"]);
const REVIEW_DECISIONS = new Set([
  "approve",
  "reject",
  "request_changes",
  "regenerate",
  "waive",
]);

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireText(name: string, value: string) {
  if (value.trim().length === 0) throw new Error(`${name}_required`);
}

function requireTenantRecord(
  db: AppDb,
  table: string,
  id: string,
  tenantId: string,
) {
  const found = one<{ id: string }>(
    db,
    `SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`,
    [id, tenantId],
  );
  if (!found) throw new Error(`${table}_tenant_mismatch`);
}

export function insertPrincipal(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    kind: PrincipalRow["kind"];
    subject: string;
    displayName: string;
    audience?: string | null;
    expiresAt?: string | null;
    revokedAt?: string | null;
    createdAt: string;
  },
): PrincipalRow {
  if (!PRINCIPAL_KINDS.has(input.kind)) throw new Error("principal_kind_invalid");
  requireText("tenant_id", input.tenantId);
  requireText("principal_subject", input.subject);
  requireText("principal_display_name", input.displayName);
  const existing = one<PrincipalRow>(
    db,
    `SELECT * FROM principals WHERE tenant_id = ? AND kind = ? AND subject = ?`,
    [input.tenantId, input.kind, input.subject],
  );
  if (existing) {
    const same =
      existing.display_name === input.displayName &&
      existing.audience === (input.audience ?? null) &&
      existing.expires_at === (input.expiresAt ?? null) &&
      existing.revoked_at === (input.revokedAt ?? null);
    if (!same) throw new Error("principal_identity_conflict");
    return existing;
  }
  // Read-then-insert has no BEGIN IMMEDIATE, so a concurrent caller can commit
  // the same deterministic principal between the SELECT above and this INSERT.
  // `ON CONFLICT DO NOTHING` makes the race idempotent (the primary key and the
  // (tenant_id, kind, subject) unique index both hold) instead of throwing a
  // constraint error the caller would otherwise swallow.
  db.raw
    .prepare(
      `INSERT INTO principals
       (id, tenant_id, kind, subject, display_name, audience, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      input.id,
      input.tenantId,
      input.kind,
      input.subject,
      input.displayName,
      input.audience ?? null,
      input.expiresAt ?? null,
      input.revokedAt ?? null,
      input.createdAt,
    );
  // Re-read by id; fall back to the identity index when a raced writer used a
  // different id for the same (tenant_id, kind, subject).
  return (
    one<PrincipalRow>(db, `SELECT * FROM principals WHERE id = ?`, [input.id]) ??
    one<PrincipalRow>(
      db,
      `SELECT * FROM principals WHERE tenant_id = ? AND kind = ? AND subject = ?`,
      [input.tenantId, input.kind, input.subject],
    )
  )!;
}

export function getPrincipalBySubject(
  db: AppDb,
  tenantId: string,
  kind: PrincipalRow["kind"],
  subject: string,
): PrincipalRow | undefined {
  return one(
    db,
    `SELECT * FROM principals WHERE tenant_id = ? AND kind = ? AND subject = ?`,
    [tenantId, kind, subject],
  );
}

export function getPrincipal(
  db: AppDb,
  tenantId: string,
  id: string,
): PrincipalRow | undefined {
  return one(
    db,
    `SELECT * FROM principals WHERE tenant_id = ? AND id = ?`,
    [tenantId, id],
  );
}

export function insertArtifactManifest(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    kind: string;
    schemaVersion: number;
    sha256: string;
    mediaType: string;
    sizeBytes: number;
    storageRef: string;
    content?: string | null;
    producerPrincipalId?: string | null;
    createdAt: string;
  },
): { row: ArtifactManifestRow; inserted: boolean } {
  if (!SHA256.test(input.sha256)) throw new Error("artifact_sha256_invalid");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error("artifact_size_invalid");
  }
  requireText("tenant_id", input.tenantId);
  requireText("artifact_kind", input.kind);
  requireText("artifact_media_type", input.mediaType);
  requireText("artifact_storage_ref", input.storageRef);
  if (input.content !== undefined && input.content !== null) {
    if (digest(input.content) !== input.sha256) throw new Error("artifact_content_hash_mismatch");
    if (Buffer.byteLength(input.content, "utf8") !== input.sizeBytes) {
      throw new Error("artifact_content_size_mismatch");
    }
  }
  if (input.producerPrincipalId) {
    requireTenantRecord(db, "principals", input.producerPrincipalId, input.tenantId);
  }
  const existing = one<ArtifactManifestRow>(
    db,
    `SELECT * FROM artifact_manifests
     WHERE tenant_id = ? AND kind = ? AND sha256 = ?`,
    [input.tenantId, input.kind, input.sha256],
  );
  if (existing) {
    const same =
      existing.schema_version === input.schemaVersion &&
      existing.media_type === input.mediaType &&
      existing.size_bytes === input.sizeBytes &&
      existing.storage_ref === input.storageRef &&
      existing.content_text === (input.content ?? null) &&
      existing.producer_principal_id === (input.producerPrincipalId ?? null);
    if (!same) throw new Error("artifact_hash_metadata_conflict");
    return { row: existing, inserted: false };
  }
  db.raw
    .prepare(
      `INSERT INTO artifact_manifests
       (id, tenant_id, kind, schema_version, sha256, media_type, size_bytes, storage_ref,
        content_text, producer_principal_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.kind,
      input.schemaVersion,
      input.sha256,
      input.mediaType,
      input.sizeBytes,
      input.storageRef,
      input.content ?? null,
      input.producerPrincipalId ?? null,
      input.createdAt,
    );
  return {
    row: one<ArtifactManifestRow>(db, `SELECT * FROM artifact_manifests WHERE id = ?`, [input.id])!,
    inserted: true,
  };
}

export function listArtifactManifests(
  db: AppDb,
  tenantId: string,
  kind?: string,
): ArtifactManifestRow[] {
  return many(
    db,
    `SELECT * FROM artifact_manifests
     WHERE tenant_id = ? ${kind ? "AND kind = ?" : ""}
     ORDER BY created_at, id`,
    kind ? [tenantId, kind] : [tenantId],
  );
}

export function insertEvidenceRecord(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    subjectType: string;
    subjectId: string;
    artifactId: string;
    inputArtifactId?: string | null;
    producerPrincipalId?: string | null;
    tool: string;
    command?: string | null;
    toolVersion?: string | null;
    commitSha?: string | null;
    verdict: EvidenceRecordRow["verdict"];
    createdAt: string;
  },
): EvidenceRecordRow {
  if (!EVIDENCE_VERDICTS.has(input.verdict)) throw new Error("evidence_verdict_invalid");
  requireTenantRecord(db, "artifact_manifests", input.artifactId, input.tenantId);
  if (input.inputArtifactId) {
    requireTenantRecord(db, "artifact_manifests", input.inputArtifactId, input.tenantId);
  }
  if (input.producerPrincipalId) {
    requireTenantRecord(db, "principals", input.producerPrincipalId, input.tenantId);
  }
  const existing = one<EvidenceRecordRow>(
    db,
    `SELECT * FROM evidence_records WHERE id = ?`,
    [input.id],
  );
  if (existing) {
    const same =
      existing.tenant_id === input.tenantId &&
      existing.subject_type === input.subjectType &&
      existing.subject_id === input.subjectId &&
      existing.artifact_id === input.artifactId &&
      existing.input_artifact_id === (input.inputArtifactId ?? null) &&
      existing.producer_principal_id === (input.producerPrincipalId ?? null) &&
      existing.tool === input.tool &&
      existing.command === (input.command ?? null) &&
      existing.tool_version === (input.toolVersion ?? null) &&
      existing.commit_sha === (input.commitSha ?? null) &&
      existing.verdict === input.verdict;
    if (!same) throw new Error("evidence_record_id_conflict");
    return existing;
  }
  db.raw
    .prepare(
      `INSERT INTO evidence_records
       (id, tenant_id, subject_type, subject_id, artifact_id, input_artifact_id,
        producer_principal_id, tool, command, tool_version, commit_sha, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.subjectType,
      input.subjectId,
      input.artifactId,
      input.inputArtifactId ?? null,
      input.producerPrincipalId ?? null,
      input.tool,
      input.command ?? null,
      input.toolVersion ?? null,
      input.commitSha ?? null,
      input.verdict,
      input.createdAt,
    );
  return one<EvidenceRecordRow>(db, `SELECT * FROM evidence_records WHERE id = ?`, [input.id])!;
}

export function listEvidenceRecords(
  db: AppDb,
  tenantId: string,
  subjectType: string,
  subjectId: string,
): EvidenceRecordRow[] {
  return many(
    db,
    `SELECT * FROM evidence_records
     WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
     ORDER BY created_at, id`,
    [tenantId, subjectType, subjectId],
  );
}

export function insertReviewDecision(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    subjectType: string;
    subjectId: string;
    candidateArtifactId: string;
    reviewerPrincipalId: string;
    decision: ReviewDecisionRow["decision"];
    rationale: string;
    waiverExpiresAt?: string | null;
    supersedesId?: string | null;
    createdAt: string;
  },
): ReviewDecisionRow {
  if (!REVIEW_DECISIONS.has(input.decision)) throw new Error("review_decision_invalid");
  if (input.decision === "waive" && !input.waiverExpiresAt) {
    throw new Error("review_waiver_expiry_required");
  }
  if (
    input.decision === "waive" &&
    (!Number.isFinite(Date.parse(input.waiverExpiresAt!)) ||
      Date.parse(input.waiverExpiresAt!) <= Date.parse(input.createdAt))
  ) {
    throw new Error("review_waiver_expiry_invalid");
  }
  requireText("review_rationale", input.rationale);
  requireTenantRecord(db, "artifact_manifests", input.candidateArtifactId, input.tenantId);
  requireTenantRecord(db, "principals", input.reviewerPrincipalId, input.tenantId);
  const previous = one<ReviewDecisionRow>(
    db,
    `SELECT * FROM review_decisions
     WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
       AND candidate_artifact_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [input.tenantId, input.subjectType, input.subjectId, input.candidateArtifactId],
  );
  if (previous?.id !== (input.supersedesId ?? undefined)) {
    throw new Error("review_supersedes_latest_required");
  }
  db.raw
    .prepare(
      `INSERT INTO review_decisions
       (id, tenant_id, subject_type, subject_id, candidate_artifact_id,
        reviewer_principal_id, decision, rationale, waiver_expires_at, supersedes_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.subjectType,
      input.subjectId,
      input.candidateArtifactId,
      input.reviewerPrincipalId,
      input.decision,
      input.rationale,
      input.waiverExpiresAt ?? null,
      input.supersedesId ?? null,
      input.createdAt,
    );
  return one<ReviewDecisionRow>(db, `SELECT * FROM review_decisions WHERE id = ?`, [input.id])!;
}

export function getLatestCandidateArtifactForSubject(
  db: AppDb,
  tenantId: string,
  subjectType: string,
  subjectId: string,
): ArtifactManifestRow | undefined {
  return one(
    db,
    `SELECT a.* FROM evidence_records e
     JOIN artifact_manifests a ON a.id = e.input_artifact_id
     WHERE e.tenant_id = ? AND e.subject_type = ? AND e.subject_id = ?
       AND a.tenant_id = e.tenant_id AND a.kind = 'candidate-edit'
     ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
    [tenantId, subjectType, subjectId],
  );
}

export function listReviewDecisions(
  db: AppDb,
  tenantId: string,
  subjectType: string,
  subjectId: string,
): ReviewDecisionRow[] {
  return many(
    db,
    `SELECT * FROM review_decisions
     WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
     ORDER BY created_at, id`,
    [tenantId, subjectType, subjectId],
  );
}

function eventHash(input: {
  tenantId: string;
  sequence: number;
  schemaVersion: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  actorPrincipalId: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  payloadSha256: string;
  previousHash: string | null;
  createdAt: string;
}) {
  return digest(JSON.stringify(input));
}

export function appendDomainEvent(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    schemaVersion: number;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    actorPrincipalId: string;
    correlationId: string;
    causationId?: string | null;
    idempotencyKey: string;
    payload: unknown;
    createdAt: string;
  },
): { row: DomainEventRow; inserted: boolean } {
  requireTenantRecord(db, "principals", input.actorPrincipalId, input.tenantId);
  const payloadJson = JSON.stringify(input.payload);
  const payloadSha256 = digest(payloadJson);
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<DomainEventRow>(
      db,
      `SELECT * FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?`,
      [input.tenantId, input.idempotencyKey],
    );
    if (existing) {
      const same =
        existing.event_type === input.eventType &&
        existing.aggregate_type === input.aggregateType &&
        existing.aggregate_id === input.aggregateId &&
        existing.actor_principal_id === input.actorPrincipalId &&
        existing.payload_sha256 === payloadSha256;
      if (!same) throw new Error("domain_event_idempotency_conflict");
      if (ownsTransaction) db.raw.exec("COMMIT");
      return { row: existing, inserted: false };
    }
    const previous = one<{ event_sequence: number; event_hash: string }>(
      db,
      `SELECT event_sequence, event_hash FROM domain_events
       WHERE tenant_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      [input.tenantId],
    );
    const sequence = (previous?.event_sequence ?? 0) + 1;
    const previousHash = previous?.event_hash ?? null;
    const causationId = input.causationId ?? null;
    const hash = eventHash({
      tenantId: input.tenantId,
      sequence,
      schemaVersion: input.schemaVersion,
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      causationId,
      idempotencyKey: input.idempotencyKey,
      payloadSha256,
      previousHash,
      createdAt: input.createdAt,
    });
    db.raw
      .prepare(
        `INSERT INTO domain_events
         (id, tenant_id, event_sequence, schema_version, event_type, aggregate_type,
          aggregate_id, actor_principal_id, correlation_id, causation_id, idempotency_key,
          payload_json, payload_sha256, prev_hash, event_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tenantId,
        sequence,
        input.schemaVersion,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        input.actorPrincipalId,
        input.correlationId,
        causationId,
        input.idempotencyKey,
        payloadJson,
        payloadSha256,
        previousHash,
        hash,
        input.createdAt,
      );
    const row = one<DomainEventRow>(db, `SELECT * FROM domain_events WHERE id = ?`, [input.id])!;
    if (ownsTransaction) db.raw.exec("COMMIT");
    return { row, inserted: true };
  } catch (error) {
    if (ownsTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function listDomainEvents(
  db: AppDb,
  tenantId: string,
  aggregateType?: string,
  aggregateId?: string,
): DomainEventRow[] {
  if ((aggregateType && !aggregateId) || (!aggregateType && aggregateId)) {
    throw new Error("aggregate_filter_incomplete");
  }
  return many(
    db,
    `SELECT * FROM domain_events
     WHERE tenant_id = ? ${aggregateType ? "AND aggregate_type = ? AND aggregate_id = ?" : ""}
     ORDER BY event_sequence`,
    aggregateType ? [tenantId, aggregateType, aggregateId!] : [tenantId],
  );
}

export function verifyDomainEventIntegrity(
  db: AppDb,
  tenantId: string,
): { ok: boolean; checked: number; error?: string } {
  const rows = listDomainEvents(db, tenantId);
  let previousHash: string | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.event_sequence !== index + 1 || row.prev_hash !== previousHash) {
      return { ok: false, checked: index, error: `domain_event_sequence:${row.id}` };
    }
    const payloadSha256 = digest(row.payload_json);
    const expected = eventHash({
      tenantId: row.tenant_id,
      sequence: row.event_sequence,
      schemaVersion: row.schema_version,
      eventType: row.event_type,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      actorPrincipalId: row.actor_principal_id,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      idempotencyKey: row.idempotency_key,
      payloadSha256,
      previousHash,
      createdAt: row.created_at,
    });
    if (row.payload_sha256 !== payloadSha256 || row.event_hash !== expected) {
      return { ok: false, checked: index, error: `domain_event_hash:${row.id}` };
    }
    previousHash = row.event_hash;
  }
  return { ok: true, checked: rows.length };
}

/**
 * Verify one domain event and its immediate chain links in bounded time.
 *
 * The worker's periodic audit still verifies the complete tenant chain. Replay
 * paths use this bounded check so one old tenant cannot make a single dispatch
 * hold the global mutation lease while rehashing its entire history.
 */
export function verifyDomainEventRecordIntegrity(
  db: AppDb,
  tenantId: string,
  eventId: string,
): { ok: boolean; checked: number; error?: string } {
  const row = one<DomainEventRow>(
    db,
    "SELECT * FROM domain_events WHERE tenant_id = ? AND id = ?",
    [tenantId, eventId],
  );
  if (!row) return { ok: false, checked: 0, error: `domain_event_missing:${eventId}` };
  const previous = row.event_sequence > 1
    ? one<DomainEventRow>(
        db,
        "SELECT * FROM domain_events WHERE tenant_id = ? AND event_sequence = ?",
        [tenantId, row.event_sequence - 1],
      )
    : undefined;
  if (row.event_sequence > 1 && !previous) {
    return { ok: false, checked: 0, error: `domain_event_predecessor_missing:${row.id}` };
  }
  const previousHash = previous?.event_hash ?? null;
  if (row.prev_hash !== previousHash) {
    return { ok: false, checked: 0, error: `domain_event_sequence:${row.id}` };
  }
  const payloadSha256 = digest(row.payload_json);
  const expected = eventHash({
    tenantId: row.tenant_id,
    sequence: row.event_sequence,
    schemaVersion: row.schema_version,
    eventType: row.event_type,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    actorPrincipalId: row.actor_principal_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
    payloadSha256,
    previousHash,
    createdAt: row.created_at,
  });
  if (row.payload_sha256 !== payloadSha256 || row.event_hash !== expected) {
    return { ok: false, checked: 0, error: `domain_event_hash:${row.id}` };
  }
  const next = one<DomainEventRow>(
    db,
    "SELECT * FROM domain_events WHERE tenant_id = ? AND event_sequence = ?",
    [tenantId, row.event_sequence + 1],
  );
  if (next && next.prev_hash !== row.event_hash) {
    return { ok: false, checked: 1, error: `domain_event_successor:${row.id}` };
  }
  return { ok: true, checked: 1 };
}
