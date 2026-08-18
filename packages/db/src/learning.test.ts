import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertReviewDecision,
  insertTenant,
  type AppDb,
} from "./index.js";
import {
  addLearningDatasetMember,
  admitLearningRecord,
  createLearningDatasetVersion,
  deleteLearningRecord,
  grantLearningConsent,
  listEligibleLearningDatasetMembers,
  listLearningRecordLineage,
  revokeLearningConsent,
  sealLearningDatasetVersion,
} from "./learning.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-01T12:00:00.000Z";
const later = "2026-08-01T13:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function installLearningTables(db: AppDb): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS learning_consents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      consent_version INTEGER NOT NULL CHECK (consent_version > 0),
      action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
      purpose TEXT NOT NULL,
      residency_region TEXT NOT NULL,
      authorized_by_principal_id TEXT NOT NULL REFERENCES principals(id),
      supersedes_consent_id TEXT REFERENCES learning_consents(id),
      effective_at TEXT NOT NULL,
      expires_at TEXT,
      reason TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, purpose, residency_region, consent_version),
      UNIQUE (tenant_id, idempotency_key),
      CHECK (
        (action = 'granted') OR
        (action = 'revoked' AND supersedes_consent_id IS NOT NULL AND expires_at IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS learning_consents_policy_idx
      ON learning_consents(tenant_id, purpose, residency_region, consent_version);

    CREATE TABLE IF NOT EXISTS learning_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      consent_id TEXT NOT NULL REFERENCES learning_consents(id),
      purpose TEXT NOT NULL,
      residency_region TEXT NOT NULL,
      source_object_type TEXT NOT NULL,
      source_object_id TEXT NOT NULL,
      source_artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
      redacted_artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
      redaction_evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
      verification_evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
      accepted_review_id TEXT NOT NULL REFERENCES review_decisions(id),
      contamination_evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      provenance_sha256 TEXT NOT NULL CHECK (length(provenance_sha256) = 64),
      observed_at TEXT NOT NULL,
      admitted_by_principal_id TEXT NOT NULL REFERENCES principals(id),
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS learning_records_consent_idx
      ON learning_records(tenant_id, consent_id, observed_at);
    CREATE INDEX IF NOT EXISTS learning_records_content_idx
      ON learning_records(tenant_id, content_sha256);

    CREATE TABLE IF NOT EXISTS learning_dataset_versions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      purpose TEXT NOT NULL,
      residency_region TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      temporal_cutoff_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'sealed')),
      dataset_sha256 TEXT CHECK (dataset_sha256 IS NULL OR length(dataset_sha256) = 64),
      created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
      sealed_by_principal_id TEXT REFERENCES principals(id),
      sealed_at TEXT,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, purpose, residency_region, version),
      UNIQUE (tenant_id, idempotency_key),
      CHECK (
        (status = 'draft' AND dataset_sha256 IS NULL AND sealed_at IS NULL AND sealed_by_principal_id IS NULL) OR
        (status = 'sealed' AND dataset_sha256 IS NOT NULL AND sealed_at IS NOT NULL AND sealed_by_principal_id IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS learning_dataset_members (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      dataset_version_id TEXT NOT NULL REFERENCES learning_dataset_versions(id),
      learning_record_id TEXT NOT NULL REFERENCES learning_records(id),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, idempotency_key),
      UNIQUE (tenant_id, dataset_version_id, learning_record_id),
      UNIQUE (tenant_id, dataset_version_id, content_sha256)
    );

    CREATE TABLE IF NOT EXISTS learning_deletion_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      learning_record_id TEXT NOT NULL REFERENCES learning_records(id),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      action TEXT NOT NULL CHECK (action = 'deleted'),
      reason TEXT NOT NULL,
      requested_by_principal_id TEXT NOT NULL REFERENCES principals(id),
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, idempotency_key),
      UNIQUE (tenant_id, learning_record_id, action)
    );

    CREATE TRIGGER IF NOT EXISTS learning_consents_append_only_update
    BEFORE UPDATE ON learning_consents BEGIN
      SELECT RAISE(ABORT, 'learning_consents_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_consents_append_only_delete
    BEFORE DELETE ON learning_consents BEGIN
      SELECT RAISE(ABORT, 'learning_consents_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_records_append_only_update
    BEFORE UPDATE ON learning_records BEGIN
      SELECT RAISE(ABORT, 'learning_records_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_records_append_only_delete
    BEFORE DELETE ON learning_records BEGIN
      SELECT RAISE(ABORT, 'learning_records_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_dataset_members_append_only_update
    BEFORE UPDATE ON learning_dataset_members BEGIN
      SELECT RAISE(ABORT, 'learning_dataset_members_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_dataset_members_append_only_delete
    BEFORE DELETE ON learning_dataset_members BEGIN
      SELECT RAISE(ABORT, 'learning_dataset_members_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_deletion_events_append_only_update
    BEFORE UPDATE ON learning_deletion_events BEGIN
      SELECT RAISE(ABORT, 'learning_deletion_events_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_deletion_events_append_only_delete
    BEFORE DELETE ON learning_deletion_events BEGIN
      SELECT RAISE(ABORT, 'learning_deletion_events_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_dataset_versions_sealed_update
    BEFORE UPDATE ON learning_dataset_versions WHEN OLD.status = 'sealed' BEGIN
      SELECT RAISE(ABORT, 'learning_dataset_versions_sealed');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_dataset_versions_sealed_delete
    BEFORE DELETE ON learning_dataset_versions WHEN OLD.status = 'sealed' BEGIN
      SELECT RAISE(ABORT, 'learning_dataset_versions_sealed');
    END;
  `);
}

function setup(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-learning-"));
  dirs.push(dir);
  const db = createDb(join(dir, "learning.sqlite"));
  dbs.push(db);
  installLearningTables(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, {
      id: tenantId,
      slug: tenantId,
      name: tenantId,
      createdAt: at,
    });
    insertPrincipal(db, {
      id: `human-${tenantId}`,
      tenantId,
      kind: "human",
      subject: `user-${tenantId}`,
      displayName: `Reviewer ${tenantId}`,
      createdAt: at,
    });
    insertPrincipal(db, {
      id: `service-${tenantId}`,
      tenantId,
      kind: "service",
      subject: `worker-${tenantId}`,
      displayName: `Worker ${tenantId}`,
      createdAt: at,
    });
  }
  return db;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(
  db: AppDb,
  tenantId: string,
  id: string,
  kind: string,
  content: string,
) {
  return insertArtifactManifest(db, {
    id,
    tenantId,
    kind,
    schemaVersion: 1,
    sha256: sha(content),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
    storageRef: `test://${id}`,
    content,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
}

function evidenceBundle(
  db: AppDb,
  tenantId: string,
  prefix: string,
  opts: { verificationVerdict?: "passed" | "failed" } = {},
) {
  const source = artifact(db, tenantId, `${prefix}-source`, "source", `raw-${prefix}`);
  const redacted = artifact(
    db,
    tenantId,
    `${prefix}-redacted`,
    "candidate-edit",
    `redacted-${prefix}`,
  );
  const verification = artifact(
    db,
    tenantId,
    `${prefix}-verification-artifact`,
    "verification-result",
    `verification-${prefix}`,
  );
  const contamination = artifact(
    db,
    tenantId,
    `${prefix}-contamination-artifact`,
    "contamination-result",
    `contamination-${prefix}`,
  );
  insertEvidenceRecord(db, {
    id: `${prefix}-redaction-evidence`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    artifactId: redacted.id,
    inputArtifactId: source.id,
    producerPrincipalId: `service-${tenantId}`,
    tool: "learning-redaction",
    verdict: "passed",
    createdAt: at,
  });
  insertEvidenceRecord(db, {
    id: `${prefix}-verification-evidence`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    artifactId: verification.id,
    inputArtifactId: redacted.id,
    producerPrincipalId: `service-${tenantId}`,
    tool: "vitest",
    verdict: opts.verificationVerdict ?? "passed",
    createdAt: at,
  });
  insertEvidenceRecord(db, {
    id: `${prefix}-contamination-evidence`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    artifactId: contamination.id,
    inputArtifactId: redacted.id,
    producerPrincipalId: `service-${tenantId}`,
    tool: "learning-contamination",
    verdict: "passed",
    createdAt: at,
  });
  insertReviewDecision(db, {
    id: `${prefix}-review`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    candidateArtifactId: redacted.id,
    reviewerPrincipalId: `human-${tenantId}`,
    decision: "approve",
    rationale: "Redacted output is accepted",
    createdAt: at,
  });
  return {
    sourceArtifactId: source.id,
    redactedArtifactId: redacted.id,
    redactionEvidenceId: `${prefix}-redaction-evidence`,
    verificationEvidenceId: `${prefix}-verification-evidence`,
    contaminationEvidenceId: `${prefix}-contamination-evidence`,
    acceptedReviewId: `${prefix}-review`,
  };
}

function grant(db: AppDb, tenantId = "tenant-a") {
  return grantLearningConsent(db, {
    id: `consent-${tenantId}`,
    tenantId,
    consentVersion: 1,
    purpose: "migration-adapter",
    residencyRegion: "us-east",
    authorizedByPrincipalId: `human-${tenantId}`,
    effectiveAt: at,
    expiresAt: "2026-09-01T00:00:00.000Z",
    reason: "Authorized adapter improvement",
    idempotencyKey: `grant-${tenantId}`,
    createdAt: at,
  });
}

function admit(
  db: AppDb,
  prefix: string,
  bundle: ReturnType<typeof evidenceBundle>,
  observedAt = "2026-07-31T12:00:00.000Z",
) {
  return admitLearningRecord(db, {
    id: `record-${prefix}`,
    tenantId: "tenant-a",
    consentId: "consent-tenant-a",
    sourceObjectType: "migration_pr",
    sourceObjectId: `pr-${prefix}`,
    ...bundle,
    observedAt,
    admittedByPrincipalId: "service-tenant-a",
    idempotencyKey: `admit-${prefix}`,
    createdAt: later,
  });
}

function dataset(
  db: AppDb,
  id = "dataset-a",
  cutoff = "2026-08-01T00:00:00.000Z",
) {
  return createLearningDatasetVersion(db, {
    id,
    tenantId: "tenant-a",
    purpose: "migration-adapter",
    residencyRegion: "us-east",
    version: 1,
    temporalCutoffAt: cutoff,
    createdByPrincipalId: "service-tenant-a",
    idempotencyKey: `create-${id}`,
    createdAt: later,
  });
}

describe("governed learning admission and deletion", () => {
  it("binds opt-in consent to tenant, purpose, residency, and idempotency", () => {
    const db = setup();
    const first = grant(db);
    expect(grant(db)).toEqual(first);
    expect(() =>
      grantLearningConsent(db, {
        id: "conflicting-consent",
        tenantId: "tenant-a",
        consentVersion: 1,
        purpose: "different-purpose",
        residencyRegion: "us-east",
        authorizedByPrincipalId: "human-tenant-a",
        effectiveAt: at,
        reason: "Conflict",
        idempotencyKey: "grant-tenant-a",
        createdAt: at,
      }),
    ).toThrow("learning_consent_idempotency_conflict");
    const bundle = evidenceBundle(db, "tenant-a", "tenant-bound");
    expect(() =>
      admitLearningRecord(db, {
        id: "cross-tenant-record",
        tenantId: "tenant-b",
        consentId: first.id,
        sourceObjectType: "migration_pr",
        sourceObjectId: "pr-1",
        ...bundle,
        observedAt: at,
        admittedByPrincipalId: "service-tenant-b",
        idempotencyKey: "cross-tenant",
        createdAt: later,
      }),
    ).toThrow("learning_consent_tenant_mismatch");
  });

  it("rejects admission after consent revocation", () => {
    const db = setup();
    grant(db);
    revokeLearningConsent(db, {
      id: "consent-revoked",
      tenantId: "tenant-a",
      consentId: "consent-tenant-a",
      consentVersion: 2,
      authorizedByPrincipalId: "human-tenant-a",
      reason: "Customer withdrew consent",
      idempotencyKey: "revoke-a",
      createdAt: later,
    });
    const bundle = evidenceBundle(db, "tenant-a", "revoked");
    expect(() => admit(db, "revoked", bundle)).toThrow("learning_consent_revoked");
  });

  it("requires redaction, accepted review, passed verification, and contamination evidence", () => {
    const db = setup();
    grant(db);
    const missing = evidenceBundle(db, "tenant-a", "missing");
    expect(() =>
      admit(db, "missing", {
        ...missing,
        contaminationEvidenceId: "does-not-exist",
      }),
    ).toThrow("learning_evidence_tenant_mismatch");
    const failed = evidenceBundle(db, "tenant-a", "failed", {
      verificationVerdict: "failed",
    });
    expect(() => admit(db, "failed", failed)).toThrow("learning_evidence_not_passed");
  });

  it("blocks temporal leakage, purpose or residency mismatch, and duplicate content", () => {
    const db = setup();
    grant(db);
    const bundle = evidenceBundle(db, "tenant-a", "cutoff");
    const record = admit(db, "cutoff", bundle, "2026-08-01T00:00:00.000Z");
    const version = dataset(db);
    expect(() =>
      addLearningDatasetMember(db, {
        tenantId: "tenant-a",
        datasetVersionId: version.id,
        learningRecordId: record.id,
        idempotencyKey: "member-cutoff",
        createdAt: later,
      }),
    ).toThrow("learning_dataset_temporal_leakage");

    const earlier = admit(
      db,
      "earlier",
      evidenceBundle(db, "tenant-a", "earlier"),
    );
    addLearningDatasetMember(db, {
      tenantId: "tenant-a",
      datasetVersionId: version.id,
      learningRecordId: earlier.id,
      idempotencyKey: "member-earlier",
      createdAt: later,
    });
    expect(() =>
      addLearningDatasetMember(db, {
        tenantId: "tenant-a",
        datasetVersionId: version.id,
        learningRecordId: earlier.id,
        idempotencyKey: "member-earlier-again",
        createdAt: later,
      }),
    ).toThrow("learning_member_duplicate_content");

    const wrongRegion = createLearningDatasetVersion(db, {
      id: "dataset-wrong-region",
      tenantId: "tenant-a",
      purpose: "migration-adapter",
      residencyRegion: "eu-west",
      version: 1,
      temporalCutoffAt: "2026-08-01T00:00:00.000Z",
      createdByPrincipalId: "service-tenant-a",
      idempotencyKey: "create-wrong-region",
      createdAt: later,
    });
    expect(() =>
      addLearningDatasetMember(db, {
        tenantId: "tenant-a",
        datasetVersionId: wrongRegion.id,
        learningRecordId: earlier.id,
        idempotencyKey: "member-wrong-region",
        createdAt: later,
      }),
    ).toThrow("learning_dataset_policy_mismatch");
  });

  it("seals immutable datasets and excludes deleted members", () => {
    const db = setup();
    grant(db);
    const record = admit(
      db,
      "delete",
      evidenceBundle(db, "tenant-a", "delete"),
    );
    const version = dataset(db);
    addLearningDatasetMember(db, {
      tenantId: "tenant-a",
      datasetVersionId: version.id,
      learningRecordId: record.id,
      idempotencyKey: "member-delete",
      createdAt: later,
    });
    const sealed = sealLearningDatasetVersion(db, {
      tenantId: "tenant-a",
      datasetVersionId: version.id,
      sealedByPrincipalId: "human-tenant-a",
      sealedAt: later,
    });
    expect(sealed.status).toBe("sealed");
    expect(sealed.dataset_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      listEligibleLearningDatasetMembers(db, {
        tenantId: "tenant-a",
        datasetVersionId: version.id,
        at: later,
      }),
    ).toHaveLength(1);
    const deleted = deleteLearningRecord(db, {
      id: "delete-event",
      tenantId: "tenant-a",
      learningRecordId: record.id,
      reason: "Customer deletion request",
      requestedByPrincipalId: "human-tenant-a",
      idempotencyKey: "delete-record",
      createdAt: later,
    });
    expect(
      deleteLearningRecord(db, {
        id: "delete-event-replay",
        tenantId: "tenant-a",
        learningRecordId: record.id,
        reason: "Customer deletion request",
        requestedByPrincipalId: "human-tenant-a",
        idempotencyKey: "delete-record",
        createdAt: later,
      }),
    ).toEqual(deleted);
    expect(
      listEligibleLearningDatasetMembers(db, {
        tenantId: "tenant-a",
        datasetVersionId: version.id,
        at: later,
      }),
    ).toEqual([]);
    expect(() =>
      db.raw.prepare("UPDATE learning_records SET source_object_id = 'changed'").run(),
    ).toThrow("learning_records_append_only");
    expect(() =>
      db.raw.prepare("UPDATE learning_dataset_versions SET purpose = 'changed'").run(),
    ).toThrow("learning_dataset_versions_sealed");
    expect(() => db.raw.prepare("DELETE FROM learning_consents").run()).toThrow(
      "learning_consents_append_only",
    );
  });

  it("walks reverse lineage from a learning record to the datasets that consumed it", () => {
    const db = setup();
    grant(db);
    const record = admit(db, "lineage", evidenceBundle(db, "tenant-a", "lineage"));
    const version = dataset(db, "dataset-lineage");
    addLearningDatasetMember(db, {
      tenantId: "tenant-a",
      datasetVersionId: version.id,
      learningRecordId: record.id,
      idempotencyKey: "member-lineage",
      createdAt: later,
    });

    const lineage = listLearningRecordLineage(db, {
      tenantId: "tenant-a",
      learningRecordId: record.id,
    });
    expect(lineage.record.id).toBe(record.id);
    expect(lineage.datasets.map((d) => d.id)).toEqual([version.id]);
    expect(lineage.deleted).toBe(false);

    // Fail-closed across tenants: the same record id is invisible to another tenant.
    expect(() =>
      listLearningRecordLineage(db, { tenantId: "tenant-b", learningRecordId: record.id }),
    ).toThrow("learning_record_tenant_mismatch");

    // After a deletion request the lineage still resolves but is flagged deleted.
    deleteLearningRecord(db, {
      id: "lineage-delete-event",
      tenantId: "tenant-a",
      learningRecordId: record.id,
      reason: "Customer deletion request",
      requestedByPrincipalId: "human-tenant-a",
      idempotencyKey: "lineage-delete",
      createdAt: later,
    });
    expect(
      listLearningRecordLineage(db, { tenantId: "tenant-a", learningRecordId: record.id }).deleted,
    ).toBe(true);
  });

  it("does not allow sealing when revocation makes a member ineligible", () => {
    const db = setup();
    grant(db);
    const record = admit(
      db,
      "revoke-before-seal",
      evidenceBundle(db, "tenant-a", "revoke-before-seal"),
    );
    const version = dataset(db);
    addLearningDatasetMember(db, {
      tenantId: "tenant-a",
      datasetVersionId: version.id,
      learningRecordId: record.id,
      idempotencyKey: "member-revoke-before-seal",
      createdAt: later,
    });
    revokeLearningConsent(db, {
      id: "revoke-before-seal",
      tenantId: "tenant-a",
      consentId: "consent-tenant-a",
      consentVersion: 2,
      authorizedByPrincipalId: "human-tenant-a",
      reason: "Withdrawn",
      idempotencyKey: "revoke-before-seal",
      createdAt: later,
    });
    expect(() =>
      sealLearningDatasetVersion(db, {
        tenantId: "tenant-a",
        datasetVersionId: version.id,
        sealedByPrincipalId: "human-tenant-a",
        sealedAt: later,
      }),
    ).toThrow("learning_dataset_member_ineligible");
  });
});
