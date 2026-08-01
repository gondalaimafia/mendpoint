import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";

const SHA256 = /^[a-f0-9]{64}$/;

export type LearningConsentRow = {
  id: string;
  tenant_id: string;
  consent_version: number;
  action: "granted" | "revoked";
  purpose: string;
  residency_region: string;
  authorized_by_principal_id: string;
  supersedes_consent_id: string | null;
  effective_at: string;
  expires_at: string | null;
  reason: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
};

export type LearningRecordRow = {
  id: string;
  tenant_id: string;
  consent_id: string;
  purpose: string;
  residency_region: string;
  source_object_type: string;
  source_object_id: string;
  source_artifact_id: string;
  redacted_artifact_id: string;
  redaction_evidence_id: string;
  verification_evidence_id: string;
  accepted_review_id: string;
  contamination_evidence_id: string;
  content_sha256: string;
  provenance_sha256: string;
  observed_at: string;
  admitted_by_principal_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
};

export type LearningDatasetVersionRow = {
  id: string;
  tenant_id: string;
  purpose: string;
  residency_region: string;
  version: number;
  temporal_cutoff_at: string;
  status: "draft" | "sealed";
  dataset_sha256: string | null;
  created_by_principal_id: string;
  sealed_by_principal_id: string | null;
  sealed_at: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
};

export type LearningDatasetMemberRow = {
  id: string;
  tenant_id: string;
  dataset_version_id: string;
  learning_record_id: string;
  content_sha256: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
};

export type LearningDeletionEventRow = {
  id: string;
  tenant_id: string;
  learning_record_id: string;
  content_sha256: string;
  action: "deleted";
  reason: string;
  requested_by_principal_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  created_at: string;
};

type PrincipalRow = {
  id: string;
  tenant_id: string;
  kind: string;
  expires_at: string | null;
  revoked_at: string | null;
};

type ArtifactRow = {
  id: string;
  tenant_id: string;
  sha256: string;
};

type EvidenceRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  artifact_id: string;
  input_artifact_id: string | null;
  tool: string;
  verdict: string;
  created_at: string;
};

type ReviewRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  candidate_artifact_id: string;
  decision: string;
  created_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name}_required`);
}

function time(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return parsed;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: Record<string, unknown>): string {
  return digest(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    ),
  );
}

function requirePrincipal(
  db: AppDb,
  tenantId: string,
  principalId: string,
  at: string,
  humanOnly = false,
): PrincipalRow {
  const principal = one<PrincipalRow>(
    db,
    `SELECT id, tenant_id, kind, expires_at, revoked_at
     FROM principals WHERE id = ? AND tenant_id = ?`,
    [principalId, tenantId],
  );
  if (!principal) throw new Error("learning_principal_tenant_mismatch");
  if (humanOnly && principal.kind !== "human") {
    throw new Error("learning_human_principal_required");
  }
  const atMs = time(at, "learning_principal_time");
  if (principal.revoked_at && time(principal.revoked_at, "learning_principal_revoked_at") <= atMs) {
    throw new Error("learning_principal_revoked");
  }
  if (principal.expires_at && time(principal.expires_at, "learning_principal_expires_at") <= atMs) {
    throw new Error("learning_principal_expired");
  }
  return principal;
}

function idempotent<T extends { request_fingerprint: string }>(
  db: AppDb,
  table: string,
  tenantId: string,
  idempotencyKey: string,
  requestFingerprint: string,
  conflictCode: string,
): T | undefined {
  const existing = one<T>(
    db,
    `SELECT * FROM ${table} WHERE tenant_id = ? AND idempotency_key = ?`,
    [tenantId, idempotencyKey],
  );
  if (existing && existing.request_fingerprint !== requestFingerprint) {
    throw new Error(conflictCode);
  }
  return existing;
}

function requireArtifact(db: AppDb, tenantId: string, artifactId: string): ArtifactRow {
  const artifact = one<ArtifactRow>(
    db,
    `SELECT id, tenant_id, sha256 FROM artifact_manifests
     WHERE id = ? AND tenant_id = ?`,
    [artifactId, tenantId],
  );
  if (!artifact) throw new Error("learning_artifact_tenant_mismatch");
  if (!SHA256.test(artifact.sha256)) throw new Error("learning_artifact_hash_invalid");
  return artifact;
}

function requireEvidence(
  db: AppDb,
  tenantId: string,
  evidenceId: string,
  expectedInputArtifactId: string,
  expectedTool?: string,
): EvidenceRow {
  const evidence = one<EvidenceRow>(
    db,
    `SELECT * FROM evidence_records WHERE id = ? AND tenant_id = ?`,
    [evidenceId, tenantId],
  );
  if (!evidence) throw new Error("learning_evidence_tenant_mismatch");
  if (evidence.verdict !== "passed") throw new Error("learning_evidence_not_passed");
  if (evidence.input_artifact_id !== expectedInputArtifactId) {
    throw new Error("learning_evidence_input_mismatch");
  }
  if (expectedTool && evidence.tool !== expectedTool) {
    throw new Error("learning_evidence_tool_mismatch");
  }
  return evidence;
}

function requireAcceptedReview(
  db: AppDb,
  tenantId: string,
  reviewId: string,
  candidateArtifactId: string,
): ReviewRow {
  const review = one<ReviewRow>(
    db,
    `SELECT * FROM review_decisions WHERE id = ? AND tenant_id = ?`,
    [reviewId, tenantId],
  );
  if (!review) throw new Error("learning_review_tenant_mismatch");
  if (review.decision !== "approve") throw new Error("learning_review_not_accepted");
  if (review.candidate_artifact_id !== candidateArtifactId) {
    throw new Error("learning_review_candidate_mismatch");
  }
  const latest = one<ReviewRow>(
    db,
    `SELECT * FROM review_decisions
     WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [tenantId, review.subject_type, review.subject_id],
  );
  if (latest?.id !== review.id) throw new Error("learning_review_not_latest");
  return review;
}

function requireActiveConsent(
  db: AppDb,
  tenantId: string,
  consentId: string,
  at: string,
): LearningConsentRow {
  const consent = one<LearningConsentRow>(
    db,
    `SELECT * FROM learning_consents
     WHERE id = ? AND tenant_id = ? AND action = 'granted'`,
    [consentId, tenantId],
  );
  if (!consent) throw new Error("learning_consent_tenant_mismatch");
  const atMs = time(at, "learning_consent_check_time");
  if (time(consent.effective_at, "learning_consent_effective_at") > atMs) {
    throw new Error("learning_consent_not_effective");
  }
  if (consent.expires_at && time(consent.expires_at, "learning_consent_expires_at") <= atMs) {
    throw new Error("learning_consent_expired");
  }
  const revoked = one<{ id: string }>(
    db,
    `SELECT id FROM learning_consents
     WHERE tenant_id = ? AND action = 'revoked' AND supersedes_consent_id = ?
     LIMIT 1`,
    [tenantId, consent.id],
  );
  if (revoked) throw new Error("learning_consent_revoked");
  return consent;
}

export function grantLearningConsent(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    consentVersion: number;
    purpose: string;
    residencyRegion: string;
    authorizedByPrincipalId: string;
    supersedesConsentId?: string | null;
    effectiveAt: string;
    expiresAt?: string | null;
    reason: string;
    idempotencyKey: string;
    createdAt: string;
  },
): LearningConsentRow {
  requireText("learning_consent_id", input.id);
  requireText("learning_tenant_id", input.tenantId);
  requireText("learning_purpose", input.purpose);
  requireText("learning_residency_region", input.residencyRegion);
  requireText("learning_consent_reason", input.reason);
  requireText("learning_idempotency_key", input.idempotencyKey);
  if (!Number.isInteger(input.consentVersion) || input.consentVersion < 1) {
    throw new Error("learning_consent_version_invalid");
  }
  const effectiveMs = time(input.effectiveAt, "learning_consent_effective_at");
  time(input.createdAt, "learning_consent_created_at");
  if (input.expiresAt && time(input.expiresAt, "learning_consent_expires_at") <= effectiveMs) {
    throw new Error("learning_consent_expiry_invalid");
  }
  requirePrincipal(
    db,
    input.tenantId,
    input.authorizedByPrincipalId,
    input.createdAt,
    true,
  );
  const requestFingerprint = fingerprint({
    action: "granted",
    consentVersion: input.consentVersion,
    purpose: input.purpose,
    residencyRegion: input.residencyRegion,
    authorizedByPrincipalId: input.authorizedByPrincipalId,
    supersedesConsentId: input.supersedesConsentId ?? null,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt ?? null,
    reason: input.reason,
  });
  const replay = idempotent<LearningConsentRow>(
    db,
    "learning_consents",
    input.tenantId,
    input.idempotencyKey,
    requestFingerprint,
    "learning_consent_idempotency_conflict",
  );
  if (replay) return replay;

  const latest = one<LearningConsentRow>(
    db,
    `SELECT * FROM learning_consents
     WHERE tenant_id = ? AND purpose = ? AND residency_region = ?
     ORDER BY consent_version DESC LIMIT 1`,
    [input.tenantId, input.purpose, input.residencyRegion],
  );
  const expectedVersion = (latest?.consent_version ?? 0) + 1;
  if (input.consentVersion !== expectedVersion) {
    throw new Error("learning_consent_version_conflict");
  }
  if (latest?.action === "granted") throw new Error("learning_consent_already_active");
  if ((input.supersedesConsentId ?? null) !== (latest?.id ?? null)) {
    throw new Error("learning_consent_supersedes_conflict");
  }
  db.raw
    .prepare(
      `INSERT INTO learning_consents
       (id, tenant_id, consent_version, action, purpose, residency_region,
        authorized_by_principal_id, supersedes_consent_id, effective_at, expires_at,
        reason, idempotency_key, request_fingerprint, created_at)
       VALUES (?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.consentVersion,
      input.purpose,
      input.residencyRegion,
      input.authorizedByPrincipalId,
      input.supersedesConsentId ?? null,
      input.effectiveAt,
      input.expiresAt ?? null,
      input.reason,
      input.idempotencyKey,
      requestFingerprint,
      input.createdAt,
    );
  return one<LearningConsentRow>(db, `SELECT * FROM learning_consents WHERE id = ?`, [input.id])!;
}

export function revokeLearningConsent(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    consentId: string;
    consentVersion: number;
    authorizedByPrincipalId: string;
    reason: string;
    idempotencyKey: string;
    createdAt: string;
  },
): LearningConsentRow {
  requireText("learning_consent_reason", input.reason);
  requirePrincipal(
    db,
    input.tenantId,
    input.authorizedByPrincipalId,
    input.createdAt,
    true,
  );
  const requestFingerprint = fingerprint({
    action: "revoked",
    consentId: input.consentId,
    consentVersion: input.consentVersion,
    authorizedByPrincipalId: input.authorizedByPrincipalId,
    reason: input.reason,
  });
  const replay = idempotent<LearningConsentRow>(
    db,
    "learning_consents",
    input.tenantId,
    input.idempotencyKey,
    requestFingerprint,
    "learning_consent_idempotency_conflict",
  );
  if (replay) return replay;
  const grant = one<LearningConsentRow>(
    db,
    `SELECT * FROM learning_consents
     WHERE id = ? AND tenant_id = ? AND action = 'granted'`,
    [input.consentId, input.tenantId],
  );
  if (!grant) throw new Error("learning_consent_tenant_mismatch");
  const latest = one<LearningConsentRow>(
    db,
    `SELECT * FROM learning_consents
     WHERE tenant_id = ? AND purpose = ? AND residency_region = ?
     ORDER BY consent_version DESC LIMIT 1`,
    [input.tenantId, grant.purpose, grant.residency_region],
  );
  if (latest?.id !== grant.id) throw new Error("learning_consent_not_current");
  if (input.consentVersion !== grant.consent_version + 1) {
    throw new Error("learning_consent_version_conflict");
  }
  db.raw
    .prepare(
      `INSERT INTO learning_consents
       (id, tenant_id, consent_version, action, purpose, residency_region,
        authorized_by_principal_id, supersedes_consent_id, effective_at, expires_at,
        reason, idempotency_key, request_fingerprint, created_at)
       VALUES (?, ?, ?, 'revoked', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.consentVersion,
      grant.purpose,
      grant.residency_region,
      input.authorizedByPrincipalId,
      grant.id,
      input.createdAt,
      input.reason,
      input.idempotencyKey,
      requestFingerprint,
      input.createdAt,
    );
  return one<LearningConsentRow>(db, `SELECT * FROM learning_consents WHERE id = ?`, [input.id])!;
}

export function admitLearningRecord(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    consentId: string;
    sourceObjectType: string;
    sourceObjectId: string;
    sourceArtifactId: string;
    redactedArtifactId: string;
    redactionEvidenceId: string;
    verificationEvidenceId: string;
    acceptedReviewId: string;
    contaminationEvidenceId: string;
    observedAt: string;
    admittedByPrincipalId: string;
    idempotencyKey: string;
    createdAt: string;
  },
): LearningRecordRow {
  requireText("learning_source_object_type", input.sourceObjectType);
  requireText("learning_source_object_id", input.sourceObjectId);
  time(input.observedAt, "learning_observed_at");
  time(input.createdAt, "learning_record_created_at");
  const requestFingerprint = fingerprint({
    consentId: input.consentId,
    sourceObjectType: input.sourceObjectType,
    sourceObjectId: input.sourceObjectId,
    sourceArtifactId: input.sourceArtifactId,
    redactedArtifactId: input.redactedArtifactId,
    redactionEvidenceId: input.redactionEvidenceId,
    verificationEvidenceId: input.verificationEvidenceId,
    acceptedReviewId: input.acceptedReviewId,
    contaminationEvidenceId: input.contaminationEvidenceId,
    observedAt: input.observedAt,
    admittedByPrincipalId: input.admittedByPrincipalId,
  });
  const replay = idempotent<LearningRecordRow>(
    db,
    "learning_records",
    input.tenantId,
    input.idempotencyKey,
    requestFingerprint,
    "learning_record_idempotency_conflict",
  );
  if (replay) return replay;
  const consent = requireActiveConsent(db, input.tenantId, input.consentId, input.createdAt);
  requirePrincipal(db, input.tenantId, input.admittedByPrincipalId, input.createdAt);
  const source = requireArtifact(db, input.tenantId, input.sourceArtifactId);
  const redacted = requireArtifact(db, input.tenantId, input.redactedArtifactId);
  const redaction = requireEvidence(
    db,
    input.tenantId,
    input.redactionEvidenceId,
    source.id,
    "learning-redaction",
  );
  if (redaction.artifact_id !== redacted.id) {
    throw new Error("learning_redaction_artifact_mismatch");
  }
  requireEvidence(
    db,
    input.tenantId,
    input.verificationEvidenceId,
    redacted.id,
  );
  requireEvidence(
    db,
    input.tenantId,
    input.contaminationEvidenceId,
    redacted.id,
    "learning-contamination",
  );
  requireAcceptedReview(db, input.tenantId, input.acceptedReviewId, redacted.id);
  const provenanceSha256 = fingerprint({
    tenantId: input.tenantId,
    consentId: consent.id,
    sourceObjectType: input.sourceObjectType,
    sourceObjectId: input.sourceObjectId,
    sourceArtifactId: source.id,
    sourceSha256: source.sha256,
    redactedArtifactId: redacted.id,
    contentSha256: redacted.sha256,
    redactionEvidenceId: input.redactionEvidenceId,
    verificationEvidenceId: input.verificationEvidenceId,
    acceptedReviewId: input.acceptedReviewId,
    contaminationEvidenceId: input.contaminationEvidenceId,
    observedAt: input.observedAt,
  });
  db.raw
    .prepare(
      `INSERT INTO learning_records
       (id, tenant_id, consent_id, purpose, residency_region, source_object_type,
        source_object_id, source_artifact_id, redacted_artifact_id,
        redaction_evidence_id, verification_evidence_id, accepted_review_id,
        contamination_evidence_id, content_sha256, provenance_sha256, observed_at,
        admitted_by_principal_id, idempotency_key, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      consent.id,
      consent.purpose,
      consent.residency_region,
      input.sourceObjectType,
      input.sourceObjectId,
      source.id,
      redacted.id,
      input.redactionEvidenceId,
      input.verificationEvidenceId,
      input.acceptedReviewId,
      input.contaminationEvidenceId,
      redacted.sha256,
      provenanceSha256,
      input.observedAt,
      input.admittedByPrincipalId,
      input.idempotencyKey,
      requestFingerprint,
      input.createdAt,
    );
  return one<LearningRecordRow>(db, `SELECT * FROM learning_records WHERE id = ?`, [input.id])!;
}

export function createLearningDatasetVersion(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    purpose: string;
    residencyRegion: string;
    version: number;
    temporalCutoffAt: string;
    createdByPrincipalId: string;
    idempotencyKey: string;
    createdAt: string;
  },
): LearningDatasetVersionRow {
  requireText("learning_dataset_purpose", input.purpose);
  requireText("learning_dataset_residency", input.residencyRegion);
  time(input.temporalCutoffAt, "learning_dataset_cutoff");
  requirePrincipal(db, input.tenantId, input.createdByPrincipalId, input.createdAt);
  const requestFingerprint = fingerprint({
    purpose: input.purpose,
    residencyRegion: input.residencyRegion,
    version: input.version,
    temporalCutoffAt: input.temporalCutoffAt,
    createdByPrincipalId: input.createdByPrincipalId,
  });
  const replay = idempotent<LearningDatasetVersionRow>(
    db,
    "learning_dataset_versions",
    input.tenantId,
    input.idempotencyKey,
    requestFingerprint,
    "learning_dataset_idempotency_conflict",
  );
  if (replay) return replay;
  const latest = one<{ version: number }>(
    db,
    `SELECT version FROM learning_dataset_versions
     WHERE tenant_id = ? AND purpose = ? AND residency_region = ?
     ORDER BY version DESC LIMIT 1`,
    [input.tenantId, input.purpose, input.residencyRegion],
  );
  if (!Number.isInteger(input.version) || input.version !== (latest?.version ?? 0) + 1) {
    throw new Error("learning_dataset_version_conflict");
  }
  db.raw
    .prepare(
      `INSERT INTO learning_dataset_versions
       (id, tenant_id, purpose, residency_region, version, temporal_cutoff_at,
        status, dataset_sha256, created_by_principal_id, sealed_by_principal_id,
        sealed_at, idempotency_key, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      input.purpose,
      input.residencyRegion,
      input.version,
      input.temporalCutoffAt,
      input.createdByPrincipalId,
      input.idempotencyKey,
      requestFingerprint,
      input.createdAt,
    );
  return one<LearningDatasetVersionRow>(
    db,
    `SELECT * FROM learning_dataset_versions WHERE id = ?`,
    [input.id],
  )!;
}

function recordDeleted(db: AppDb, tenantId: string, recordId: string): boolean {
  return Boolean(
    one<{ id: string }>(
      db,
      `SELECT id FROM learning_deletion_events
       WHERE tenant_id = ? AND learning_record_id = ? AND action = 'deleted' LIMIT 1`,
      [tenantId, recordId],
    ),
  );
}

export function addLearningDatasetMember(
  db: AppDb,
  input: {
    tenantId: string;
    datasetVersionId: string;
    learningRecordId: string;
    idempotencyKey: string;
    createdAt: string;
  },
): LearningDatasetMemberRow {
  const requestFingerprint = fingerprint({
    datasetVersionId: input.datasetVersionId,
    learningRecordId: input.learningRecordId,
  });
  const replay = idempotent<LearningDatasetMemberRow>(
    db,
    "learning_dataset_members",
    input.tenantId,
    input.idempotencyKey,
    requestFingerprint,
    "learning_member_idempotency_conflict",
  );
  if (replay) return replay;
  const dataset = one<LearningDatasetVersionRow>(
    db,
    `SELECT * FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?`,
    [input.datasetVersionId, input.tenantId],
  );
  if (!dataset) throw new Error("learning_dataset_tenant_mismatch");
  if (dataset.status !== "draft") throw new Error("learning_dataset_sealed");
  const record = one<LearningRecordRow>(
    db,
    `SELECT * FROM learning_records WHERE id = ? AND tenant_id = ?`,
    [input.learningRecordId, input.tenantId],
  );
  if (!record) throw new Error("learning_record_tenant_mismatch");
  requireActiveConsent(db, input.tenantId, record.consent_id, input.createdAt);
  if (recordDeleted(db, input.tenantId, record.id)) {
    throw new Error("learning_record_deleted");
  }
  if (
    record.purpose !== dataset.purpose ||
    record.residency_region !== dataset.residency_region
  ) {
    throw new Error("learning_dataset_policy_mismatch");
  }
  if (time(record.observed_at, "learning_observed_at") >= time(dataset.temporal_cutoff_at, "learning_dataset_cutoff")) {
    throw new Error("learning_dataset_temporal_leakage");
  }
  const duplicate = one<LearningDatasetMemberRow>(
    db,
    `SELECT * FROM learning_dataset_members
     WHERE tenant_id = ? AND dataset_version_id = ? AND content_sha256 = ?`,
    [input.tenantId, dataset.id, record.content_sha256],
  );
  if (duplicate) throw new Error("learning_member_duplicate_content");
  const id = `member_${digest(
    [input.tenantId, dataset.id, record.content_sha256].join("\u0000"),
  )}`;
  db.raw
    .prepare(
      `INSERT INTO learning_dataset_members
       (id, tenant_id, dataset_version_id, learning_record_id, content_sha256,
        idempotency_key, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.tenantId,
      dataset.id,
      record.id,
      record.content_sha256,
      input.idempotencyKey,
      requestFingerprint,
      input.createdAt,
    );
  return one<LearningDatasetMemberRow>(db, `SELECT * FROM learning_dataset_members WHERE id = ?`, [id])!;
}

function eligibleMembers(
  db: AppDb,
  tenantId: string,
  datasetVersionId: string,
  at: string,
): LearningDatasetMemberRow[] {
  const atMs = time(at, "learning_eligibility_time");
  return many<LearningDatasetMemberRow & { consent_effective_at: string; consent_expires_at: string | null }>(
    db,
    `SELECT m.*, c.effective_at AS consent_effective_at,
            c.expires_at AS consent_expires_at
     FROM learning_dataset_members m
     JOIN learning_records r ON r.id = m.learning_record_id AND r.tenant_id = m.tenant_id
     JOIN learning_consents c ON c.id = r.consent_id AND c.tenant_id = r.tenant_id
     JOIN learning_dataset_versions v
       ON v.id = m.dataset_version_id AND v.tenant_id = m.tenant_id
     WHERE m.tenant_id = ? AND m.dataset_version_id = ?
       AND r.purpose = v.purpose AND r.residency_region = v.residency_region
       AND r.observed_at < v.temporal_cutoff_at
       AND NOT EXISTS (
         SELECT 1 FROM learning_deletion_events d
         WHERE d.tenant_id = m.tenant_id AND d.learning_record_id = r.id
           AND d.action = 'deleted'
       )
       AND NOT EXISTS (
         SELECT 1 FROM learning_consents revoked
         WHERE revoked.tenant_id = c.tenant_id AND revoked.action = 'revoked'
           AND revoked.supersedes_consent_id = c.id
       )
     ORDER BY m.content_sha256, m.id`,
    [tenantId, datasetVersionId],
  ).filter(
    (member) =>
      time(member.consent_effective_at, "learning_consent_effective_at") <= atMs &&
      (!member.consent_expires_at ||
        time(member.consent_expires_at, "learning_consent_expires_at") > atMs),
  );
}

export function listEligibleLearningDatasetMembers(
  db: AppDb,
  input: {
    tenantId: string;
    datasetVersionId: string;
    at: string;
  },
): LearningDatasetMemberRow[] {
  const dataset = one<LearningDatasetVersionRow>(
    db,
    `SELECT * FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?`,
    [input.datasetVersionId, input.tenantId],
  );
  if (!dataset) throw new Error("learning_dataset_tenant_mismatch");
  if (dataset.status !== "sealed") throw new Error("learning_dataset_not_sealed");
  return eligibleMembers(db, input.tenantId, dataset.id, input.at).map((member) => ({
    id: member.id,
    tenant_id: member.tenant_id,
    dataset_version_id: member.dataset_version_id,
    learning_record_id: member.learning_record_id,
    content_sha256: member.content_sha256,
    idempotency_key: member.idempotency_key,
    request_fingerprint: member.request_fingerprint,
    created_at: member.created_at,
  }));
}

export function sealLearningDatasetVersion(
  db: AppDb,
  input: {
    tenantId: string;
    datasetVersionId: string;
    sealedByPrincipalId: string;
    sealedAt: string;
  },
): LearningDatasetVersionRow {
  requirePrincipal(
    db,
    input.tenantId,
    input.sealedByPrincipalId,
    input.sealedAt,
    true,
  );
  const dataset = one<LearningDatasetVersionRow>(
    db,
    `SELECT * FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?`,
    [input.datasetVersionId, input.tenantId],
  );
  if (!dataset) throw new Error("learning_dataset_tenant_mismatch");
  if (dataset.status === "sealed") return dataset;
  const allMembers = many<LearningDatasetMemberRow>(
    db,
    `SELECT * FROM learning_dataset_members
     WHERE tenant_id = ? AND dataset_version_id = ? ORDER BY content_sha256, id`,
    [input.tenantId, dataset.id],
  );
  if (allMembers.length === 0) throw new Error("learning_dataset_empty");
  const eligible = eligibleMembers(db, input.tenantId, dataset.id, input.sealedAt);
  if (eligible.length !== allMembers.length) {
    throw new Error("learning_dataset_member_ineligible");
  }
  const datasetSha256 = digest(
    JSON.stringify(
      allMembers.map((member) => ({
        id: member.id,
        contentSha256: member.content_sha256,
        learningRecordId: member.learning_record_id,
      })),
    ),
  );
  db.raw
    .prepare(
      `UPDATE learning_dataset_versions
       SET status = 'sealed', dataset_sha256 = ?, sealed_by_principal_id = ?, sealed_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'draft'`,
    )
    .run(
      datasetSha256,
      input.sealedByPrincipalId,
      input.sealedAt,
      dataset.id,
      input.tenantId,
    );
  return one<LearningDatasetVersionRow>(
    db,
    `SELECT * FROM learning_dataset_versions WHERE id = ?`,
    [dataset.id],
  )!;
}

export function deleteLearningRecord(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    learningRecordId: string;
    reason: string;
    requestedByPrincipalId: string;
    idempotencyKey: string;
    createdAt: string;
  },
): LearningDeletionEventRow {
  requireText("learning_deletion_reason", input.reason);
  requirePrincipal(
    db,
    input.tenantId,
    input.requestedByPrincipalId,
    input.createdAt,
    true,
  );
  const requestFingerprint = fingerprint({
    learningRecordId: input.learningRecordId,
    reason: input.reason,
    requestedByPrincipalId: input.requestedByPrincipalId,
  });
  const replay = idempotent<LearningDeletionEventRow>(
    db,
    "learning_deletion_events",
    input.tenantId,
    input.idempotencyKey,
    requestFingerprint,
    "learning_deletion_idempotency_conflict",
  );
  if (replay) return replay;
  const record = one<LearningRecordRow>(
    db,
    `SELECT * FROM learning_records WHERE id = ? AND tenant_id = ?`,
    [input.learningRecordId, input.tenantId],
  );
  if (!record) throw new Error("learning_record_tenant_mismatch");
  if (recordDeleted(db, input.tenantId, record.id)) {
    throw new Error("learning_record_already_deleted");
  }
  db.raw
    .prepare(
      `INSERT INTO learning_deletion_events
       (id, tenant_id, learning_record_id, content_sha256, action, reason,
        requested_by_principal_id, idempotency_key, request_fingerprint, created_at)
       VALUES (?, ?, ?, ?, 'deleted', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.tenantId,
      record.id,
      record.content_sha256,
      input.reason,
      input.requestedByPrincipalId,
      input.idempotencyKey,
      requestFingerprint,
      input.createdAt,
    );
  return one<LearningDeletionEventRow>(
    db,
    `SELECT * FROM learning_deletion_events WHERE id = ?`,
    [input.id],
  )!;
}
