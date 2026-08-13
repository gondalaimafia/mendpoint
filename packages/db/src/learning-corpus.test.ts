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
  revokeLearningConsent,
  sealLearningDatasetVersion,
} from "./learning.js";
import {
  LEARNING_CORPUS_SCHEMA_VERSION,
  buildLearningCorpus,
  formatLearningCorpusStats,
  serializeLearningCorpusJsonl,
} from "./learning-corpus.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-01T12:00:00.000Z";
const later = "2026-08-01T13:00:00.000Z";
const observed = "2026-07-31T12:00:00.000Z";
const cutoff = "2026-08-01T00:00:00.000Z";
const PURPOSE = "migration-adapter";
const RESIDENCY = "us-east";

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
    CREATE TRIGGER IF NOT EXISTS learning_records_append_only_update
    BEFORE UPDATE ON learning_records BEGIN
      SELECT RAISE(ABORT, 'learning_records_append_only');
    END;
    CREATE TRIGGER IF NOT EXISTS learning_dataset_versions_sealed_update
    BEFORE UPDATE ON learning_dataset_versions WHEN OLD.status = 'sealed' BEGIN
      SELECT RAISE(ABORT, 'learning_dataset_versions_sealed');
    END;
  `);
}

function setup(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-corpus-"));
  dirs.push(dir);
  const db = createDb(join(dir, "corpus.sqlite"));
  dbs.push(db);
  installLearningTables(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: at });
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

function outcomeJson(prefix: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    failingCommandId: `cmd-${prefix}`,
    overallRisk: "low",
    confidence: 82,
    changedPaths: [`src/${prefix}.ts`],
    edits: [
      {
        path: `src/${prefix}.ts`,
        semanticCategory: "behavior",
        risk: "low",
        rationale: `Adapt ${prefix} to the new signature`,
      },
    ],
    verificationSummary: "vitest passed",
    verificationCommandId: `verify-${prefix}`,
    observedAt: observed,
  });
}

function afterContentJson(prefix: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    failingCommandId: `cmd-${prefix}`,
    overallRisk: "low",
    confidence: 82,
    changedPaths: [`src/${prefix}.ts`],
    edits: [
      {
        path: `src/${prefix}.ts`,
        semanticCategory: "behavior",
        risk: "low",
        rationale: `Adapt ${prefix} to the new signature`,
      },
    ],
    verificationSummary: "vitest passed",
    verificationCommandId: `verify-${prefix}`,
    observedAt: observed,
    afterContent: [
      {
        path: `src/${prefix}.ts`,
        changeType: "modify",
        beforeContent: "export const x = 0;\n",
        afterContent: "export const x = 1;\n",
      },
    ],
  });
}

function rejectedJson(prefix: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    failingCommandId: `cmd-${prefix}`,
    overallRisk: "medium",
    confidence: 40,
    changedPaths: [`src/${prefix}.ts`],
    edits: [
      {
        path: `src/${prefix}.ts`,
        semanticCategory: "behavior",
        risk: "medium",
        rationale: `Proposed change for ${prefix}`,
      },
    ],
    verificationSummary: "vitest passed",
    verificationCommandId: `verify-${prefix}`,
    observedAt: observed,
    decision: "rejected",
    rejectionRationale: `Rejected ${prefix}: the fix hides the real defect.`,
  });
}

/**
 * Build the redaction/verification/contamination/review evidence bundle for one
 * outcome. `redactedContent` is stored as the redacted artifact body (null to
 * simulate a record with no retrievable redacted content).
 */
function evidenceBundle(
  db: AppDb,
  tenantId: string,
  prefix: string,
  redactedContent: string | null,
) {
  const rawSource = `raw-${prefix}`;
  const source = insertArtifactManifest(db, {
    id: `${prefix}-source`,
    tenantId,
    kind: "source",
    schemaVersion: 1,
    sha256: sha(rawSource),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(rawSource),
    storageRef: `test://${prefix}-source`,
    content: rawSource,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  const redacted = insertArtifactManifest(db, {
    id: `${prefix}-redacted`,
    tenantId,
    kind: "candidate-edit",
    schemaVersion: 1,
    // A valid content hash is required; when we deliberately omit stored content
    // (redactedContent === null) we hash a placeholder so the row is still valid.
    sha256: sha(redactedContent ?? `no-content-${prefix}`),
    mediaType: "application/json",
    sizeBytes:
      redactedContent === null ? 0 : Buffer.byteLength(redactedContent),
    storageRef: `test://${prefix}-redacted`,
    content: redactedContent ?? null,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  const verificationArt = insertArtifactManifest(db, {
    id: `${prefix}-verart`,
    tenantId,
    kind: "verification-result",
    schemaVersion: 1,
    sha256: sha(`verification-${prefix}`),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(`verification-${prefix}`),
    storageRef: `test://${prefix}-verart`,
    content: `verification-${prefix}`,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  const contaminationArt = insertArtifactManifest(db, {
    id: `${prefix}-conart`,
    tenantId,
    kind: "contamination-result",
    schemaVersion: 1,
    sha256: sha(`contamination-${prefix}`),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(`contamination-${prefix}`),
    storageRef: `test://${prefix}-conart`,
    content: `contamination-${prefix}`,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
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
    artifactId: verificationArt.id,
    inputArtifactId: redacted.id,
    producerPrincipalId: `service-${tenantId}`,
    tool: "vitest",
    verdict: "passed",
    createdAt: at,
  });
  insertEvidenceRecord(db, {
    id: `${prefix}-contamination-evidence`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    artifactId: contaminationArt.id,
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
    purpose: PURPOSE,
    residencyRegion: RESIDENCY,
    authorizedByPrincipalId: `human-${tenantId}`,
    effectiveAt: at,
    expiresAt: "2026-09-01T00:00:00.000Z",
    reason: "Authorized adapter improvement",
    idempotencyKey: `grant-${tenantId}`,
    createdAt: at,
  });
}

function admit(db: AppDb, prefix: string, redactedContent: string | null) {
  const bundle = evidenceBundle(db, "tenant-a", prefix, redactedContent);
  return admitLearningRecord(db, {
    id: `record-${prefix}`,
    tenantId: "tenant-a",
    consentId: "consent-tenant-a",
    sourceObjectType: "transformer_adaptive_candidate",
    sourceObjectId: `pr-${prefix}`,
    ...bundle,
    observedAt: observed,
    admittedByPrincipalId: "service-tenant-a",
    idempotencyKey: `admit-${prefix}`,
    createdAt: later,
  });
}

function dataset(db: AppDb, id = "dataset-a") {
  return createLearningDatasetVersion(db, {
    id,
    tenantId: "tenant-a",
    purpose: PURPOSE,
    residencyRegion: RESIDENCY,
    version: 1,
    temporalCutoffAt: cutoff,
    createdByPrincipalId: "service-tenant-a",
    idempotencyKey: `create-${id}`,
    createdAt: later,
  });
}

function member(db: AppDb, versionId: string, recordId: string) {
  return addLearningDatasetMember(db, {
    tenantId: "tenant-a",
    datasetVersionId: versionId,
    learningRecordId: recordId,
    idempotencyKey: `member-${recordId}`,
    createdAt: later,
  });
}

function seal(db: AppDb, versionId: string) {
  return sealLearningDatasetVersion(db, {
    tenantId: "tenant-a",
    datasetVersionId: versionId,
    sealedByPrincipalId: "human-tenant-a",
    sealedAt: later,
  });
}

describe("learning corpus export", () => {
  it("exports sealed, consented, approved outcomes as labeled JSONL", () => {
    const db = setup();
    grant(db);
    const a = admit(db, "alpha", outcomeJson("alpha"));
    const b = admit(db, "bravo", outcomeJson("bravo"));
    const version = dataset(db);
    member(db, version.id, a.id);
    member(db, version.id, b.id);
    const sealed = seal(db, version.id);

    const result = buildLearningCorpus({
      db,
      tenantId: "tenant-a",
      purpose: PURPOSE,
      at: later,
    });

    expect(result.reason).toBe("ok");
    expect(result.examples).toHaveLength(2);
    expect(result.stats.exported).toBe(2);
    expect(result.stats.excluded).toBe(0);
    expect(result.stats.sealedMembers).toBe(2);
    expect(result.stats.eligibleMembers).toBe(2);
    expect(result.stats.byDecision).toEqual({ accepted: 2 });
    expect(result.stats.bySemanticCategory).toEqual({ behavior: 2 });

    const example = result.examples.find((e) => e.provenance.learningRecordId === a.id)!;
    expect(example.schemaVersion).toBe(LEARNING_CORPUS_SCHEMA_VERSION);
    expect(example.input).toEqual({
      task: PURPOSE,
      failingCommandId: "cmd-alpha",
      changedPaths: ["src/alpha.ts"],
      targetPaths: ["src/alpha.ts"],
    });
    expect(example.output.edits).toEqual([
      {
        path: "src/alpha.ts",
        semanticCategory: "behavior",
        risk: "low",
        rationale: "Adapt alpha to the new signature",
      },
    ]);
    expect(example.output.verificationSummary).toBe("vitest passed");
    expect(example.labels).toEqual({
      family: null,
      provider: null,
      framework: null,
      semanticCategories: ["behavior"],
      overallRisk: "low",
      confidence: 82,
      verificationPassed: true,
      decision: "accepted",
    });
    expect(example.provenance.datasetVersionId).toBe(version.id);
    expect(example.provenance.datasetSha256).toBe(sealed.dataset_sha256);
    expect(example.provenance.residencyRegion).toBe(RESIDENCY);

    const jsonl = serializeLearningCorpusJsonl(result.examples);
    const lines = jsonl.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
    // Idempotent: a second build over the same state emits identical bytes.
    const again = buildLearningCorpus({ db, tenantId: "tenant-a", purpose: PURPOSE, at: later });
    expect(serializeLearningCorpusJsonl(again.examples)).toBe(jsonl);
    expect(formatLearningCorpusStats(result.stats)).toContain("exported examples: 2");
  });

  it("emits the real classification labels an outcome doc carries; legacy docs stay null", () => {
    const db = setup();
    grant(db);
    const labeledJson = JSON.stringify({
      schemaVersion: 1,
      failingCommandId: "cmd-labeled",
      overallRisk: "low",
      confidence: 82,
      changedPaths: ["src/labeled.ts"],
      edits: [
        {
          path: "src/labeled.ts",
          semanticCategory: "behavior",
          risk: "low",
          rationale: "Adapt labeled to the new signature",
        },
      ],
      verificationSummary: "vitest passed",
      verificationCommandId: "verify-labeled",
      observedAt: observed,
      family: "sdk",
      provider: "aws-sdk-js",
    });
    const labeled = admit(db, "labeled", labeledJson);
    const legacy = admit(db, "legacy", outcomeJson("legacy"));
    const version = dataset(db);
    member(db, version.id, labeled.id);
    member(db, version.id, legacy.id);
    seal(db, version.id);

    const result = buildLearningCorpus({ db, tenantId: "tenant-a", purpose: PURPOSE, at: later });
    const labeledExample = result.examples.find(
      (e) => e.provenance.learningRecordId === labeled.id,
    )!;
    expect(labeledExample.labels.family).toBe("sdk");
    expect(labeledExample.labels.provider).toBe("aws-sdk-js");
    expect(labeledExample.labels.framework).toBeNull();

    // A pre-labeling (legacy) outcome doc keeps null labels: byte-identical corpus.
    const legacyExample = result.examples.find(
      (e) => e.provenance.learningRecordId === legacy.id,
    )!;
    expect(legacyExample.labels.family).toBeNull();
    expect(legacyExample.labels.provider).toBeNull();
    expect(legacyExample.labels.framework).toBeNull();
  });

  it("EXCLUDES members with missing, unparseable, or unexpected-schema content (fail closed)", () => {
    const db = setup();
    grant(db);
    const good = admit(db, "good", outcomeJson("good"));
    const missing = admit(db, "missing", null);
    const garbage = admit(db, "garbage", "not-json-at-all");
    const wrong = admit(db, "wrong", JSON.stringify({ schemaVersion: 99, edits: [] }));
    const version = dataset(db);
    for (const record of [good, missing, garbage, wrong]) member(db, version.id, record.id);
    seal(db, version.id);

    const result = buildLearningCorpus({
      db,
      tenantId: "tenant-a",
      purpose: PURPOSE,
      at: later,
    });

    expect(result.stats.sealedMembers).toBe(4);
    expect(result.stats.eligibleMembers).toBe(4);
    expect(result.stats.exported).toBe(1);
    expect(result.stats.excluded).toBe(3);
    expect(result.stats.excludedByReason).toEqual({
      ineligible_membership: 0,
      missing_redacted_content: 1,
      unparseable_content: 1,
      unexpected_schema: 1,
    });
    expect(result.examples[0].provenance.learningRecordId).toBe(good.id);
    // No excluded record's redacted body leaked into the corpus.
    expect(serializeLearningCorpusJsonl(result.examples)).not.toContain("not-json-at-all");
  });

  it("EXCLUDES everything once consent is revoked (no active consent, nothing exported)", () => {
    const db = setup();
    grant(db);
    const record = admit(db, "revoke", outcomeJson("revoke"));
    const version = dataset(db);
    member(db, version.id, record.id);
    seal(db, version.id);
    // Sanity: exported while consented.
    expect(buildLearningCorpus({ db, tenantId: "tenant-a", purpose: PURPOSE, at: later }).stats.exported).toBe(1);

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

    const result = buildLearningCorpus({
      db,
      tenantId: "tenant-a",
      purpose: PURPOSE,
      at: later,
    });
    expect(result.reason).toBe("no_active_consent");
    expect(result.examples).toEqual([]);
    expect(result.stats.exported).toBe(0);
  });

  it("counts sealed-but-deleted members as excluded for lost eligibility", () => {
    const db = setup();
    grant(db);
    const keep = admit(db, "keep", outcomeJson("keep"));
    const drop = admit(db, "drop", outcomeJson("drop"));
    const version = dataset(db);
    member(db, version.id, keep.id);
    member(db, version.id, drop.id);
    seal(db, version.id);

    deleteLearningRecord(db, {
      id: "delete-drop",
      tenantId: "tenant-a",
      learningRecordId: drop.id,
      reason: "Customer deletion request",
      requestedByPrincipalId: "human-tenant-a",
      idempotencyKey: "delete-drop",
      createdAt: later,
    });

    const result = buildLearningCorpus({
      db,
      tenantId: "tenant-a",
      purpose: PURPOSE,
      at: later,
    });
    expect(result.stats.sealedMembers).toBe(2);
    expect(result.stats.eligibleMembers).toBe(1);
    expect(result.stats.exported).toBe(1);
    expect(result.stats.excludedByReason.ineligible_membership).toBe(1);
    expect(result.examples[0].provenance.learningRecordId).toBe(keep.id);
  });

  it("does not export a draft (unsealed) dataset", () => {
    const db = setup();
    grant(db);
    const record = admit(db, "draft", outcomeJson("draft"));
    const version = dataset(db);
    member(db, version.id, record.id);
    // Not sealed.

    const latest = buildLearningCorpus({
      db,
      tenantId: "tenant-a",
      purpose: PURPOSE,
      at: later,
    });
    expect(latest.reason).toBe("no_sealed_dataset");
    expect(latest.examples).toEqual([]);

    const explicit = buildLearningCorpus({
      db,
      tenantId: "tenant-a",
      purpose: PURPOSE,
      at: later,
      datasetVersionId: version.id,
    });
    expect(explicit.reason).toBe("dataset_not_found_or_unsealed");
    expect(explicit.examples).toEqual([]);
  });

  it("emits after-content on the output when the redacted doc carries it (opt-in content)", () => {
    const db = setup();
    grant(db);
    const base = admit(db, "base", outcomeJson("base"));
    const content = admit(db, "content", afterContentJson("content"));
    const version = dataset(db);
    member(db, version.id, base.id);
    member(db, version.id, content.id);
    seal(db, version.id);

    const result = buildLearningCorpus({ db, tenantId: "tenant-a", purpose: PURPOSE, at: later });
    expect(result.stats.exported).toBe(2);
    expect(result.stats.byDecision).toEqual({ accepted: 2 });

    const contentExample = result.examples.find(
      (e) => e.provenance.learningRecordId === content.id,
    )!;
    expect(contentExample.output.afterContent).toEqual([
      {
        path: "src/content.ts",
        changeType: "modify",
        beforeContent: "export const x = 0;\n",
        afterContent: "export const x = 1;\n",
      },
    ]);
    expect(contentExample.labels.decision).toBe("accepted");
    expect(contentExample.labels.verificationPassed).toBe(true);

    // The base example is byte-identical to today: no after-content / rejection keys.
    const baseExample = result.examples.find((e) => e.provenance.learningRecordId === base.id)!;
    expect("afterContent" in baseExample.output).toBe(false);
    expect("rejectionRationale" in baseExample.output).toBe(false);
    expect(baseExample.labels).toEqual({
      family: null,
      provider: null,
      framework: null,
      semanticCategories: ["behavior"],
      overallRisk: "low",
      confidence: 82,
      verificationPassed: true,
      decision: "accepted",
    });
  });

  it("emits negatives labeled decision=rejected with the rejection rationale (opt-in negatives)", () => {
    const db = setup();
    grant(db);
    const good = admit(db, "good", outcomeJson("good"));
    const bad = admit(db, "bad", rejectedJson("bad"));
    const version = dataset(db);
    member(db, version.id, good.id);
    member(db, version.id, bad.id);
    seal(db, version.id);

    const result = buildLearningCorpus({ db, tenantId: "tenant-a", purpose: PURPOSE, at: later });
    expect(result.stats.exported).toBe(2);
    expect(result.stats.byDecision).toEqual({ accepted: 1, rejected: 1 });

    const negative = result.examples.find((e) => e.provenance.learningRecordId === bad.id)!;
    expect(negative.labels.decision).toBe("rejected");
    expect(negative.output.rejectionRationale).toBe("Rejected bad: the fix hides the real defect.");
    // The negative's change-spec is still exported so a preference pair can be built.
    expect(negative.input.changedPaths).toEqual(["src/bad.ts"]);
    expect("afterContent" in negative.output).toBe(false);
  });

  it("keeps the base (accepted-only) corpus byte-identical when no opt-in docs are present", () => {
    const db = setup();
    grant(db);
    const record = admit(db, "identical", outcomeJson("identical"));
    const version = dataset(db);
    member(db, version.id, record.id);
    seal(db, version.id);

    const jsonl = serializeLearningCorpusJsonl(
      buildLearningCorpus({ db, tenantId: "tenant-a", purpose: PURPOSE, at: later }).examples,
    );
    expect(jsonl).not.toContain("afterContent");
    expect(jsonl).not.toContain("rejectionRationale");
    expect(jsonl).toContain('"decision":"accepted"');
    expect(jsonl).toContain('"verificationPassed":true');
  });

  it("never exports another tenant's data for the same purpose", () => {
    const db = setup();
    grant(db, "tenant-a");
    const record = admit(db, "scoped", outcomeJson("scoped"));
    const version = dataset(db);
    member(db, version.id, record.id);
    seal(db, version.id);

    // tenant-b has no consent and no sealed data of its own.
    const result = buildLearningCorpus({
      db,
      tenantId: "tenant-b",
      purpose: PURPOSE,
      at: later,
    });
    expect(result.reason).toBe("no_active_consent");
    expect(result.examples).toEqual([]);
  });
});
