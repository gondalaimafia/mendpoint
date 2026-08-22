import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitLearningRecord,
  computeRetrievalContextGaps,
  createDb,
  grantLearningConsent,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertReviewDecision,
  insertTenant,
  recordRetrievalContextGap,
  type AppDb,
  type RetrievalContextGapInput,
} from "./index.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const AT = "2026-08-14T20:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-retrieval-gap-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: AT });
    insertPrincipal(db, {
      id: `human-${tenantId}`, tenantId, kind: "human",
      subject: `reviewer-${tenantId}`, displayName: `Reviewer ${tenantId}`, createdAt: AT,
    });
    grantLearningConsent(db, {
      id: `consent-${tenantId}`, tenantId, consentVersion: 1, purpose: "fettler-api-engineering",
      residencyRegion: "us-central", authorizedByPrincipalId: `human-${tenantId}`,
      effectiveAt: "2026-08-14T18:00:00.000Z", reason: "Govern verified outcomes.",
      idempotencyKey: `consent-${tenantId}`, createdAt: AT,
    });
  }
  return db;
}

/**
 * Seed one real `learning_records` row so the `retrieval_context_gaps` foreign key
 * is satisfied — the projection points at a genuinely admitted lesson, exactly as
 * production does. Returns the learning_record_id to key the gap on.
 */
function seedLearningRecord(db: AppDb, tenantId: string, prefix: string): string {
  const artifact = (id: string, kind: string, content: string) =>
    insertArtifactManifest(db, {
      id, tenantId, kind, schemaVersion: 1, sha256: sha(content), mediaType: "application/json",
      sizeBytes: Buffer.byteLength(content), storageRef: `test://${id}`, content,
      producerPrincipalId: `human-${tenantId}`, createdAt: AT,
    }).row;
  const source = artifact(`${prefix}-source`, "learning-source", `source-${prefix}`);
  const redacted = artifact(`${prefix}-redacted`, "learning-redacted", `redacted-${prefix}`);
  const verification = artifact(`${prefix}-verification`, "verification", `verification-${prefix}`);
  const contamination = artifact(`${prefix}-contamination`, "contamination", `contamination-${prefix}`);
  const evidence = (id: string, artifactId: string, inputArtifactId: string, tool: string) =>
    insertEvidenceRecord(db, {
      id, tenantId, subjectType: "fettler_outcome", subjectId: prefix, artifactId, inputArtifactId,
      producerPrincipalId: `human-${tenantId}`, tool, toolVersion: "1", verdict: "passed", createdAt: AT,
    });
  evidence(`${prefix}-redaction-evidence`, redacted.id, source.id, "learning-redaction");
  evidence(`${prefix}-verification-evidence`, verification.id, redacted.id, "learning-verification");
  evidence(`${prefix}-contamination-evidence`, contamination.id, redacted.id, "learning-contamination");
  insertReviewDecision(db, {
    id: `${prefix}-review`, tenantId, subjectType: "fettler_outcome", subjectId: prefix,
    candidateArtifactId: redacted.id, reviewerPrincipalId: `human-${tenantId}`,
    decision: "approve", rationale: "Admit the redacted verified outcome.", createdAt: AT,
  });
  const record = admitLearningRecord(db, {
    id: `record-${prefix}`, tenantId, consentId: `consent-${tenantId}`,
    sourceObjectType: "fettler_agent_run", sourceObjectId: `run-${prefix}`,
    sourceArtifactId: source.id, redactedArtifactId: redacted.id,
    redactionEvidenceId: `${prefix}-redaction-evidence`,
    verificationEvidenceId: `${prefix}-verification-evidence`,
    acceptedReviewId: `${prefix}-review`, contaminationEvidenceId: `${prefix}-contamination-evidence`,
    observedAt: AT, admittedByPrincipalId: `human-${tenantId}`, idempotencyKey: `admit-${prefix}`, createdAt: AT,
  });
  return record.id;
}

function gap(
  db: AppDb,
  tenantId: string,
  prefix: string,
  overrides: Partial<RetrievalContextGapInput> = {},
): void {
  const learningRecordId = seedLearningRecord(db, tenantId, prefix);
  recordRetrievalContextGap(db, {
    learningRecordId,
    tenantId,
    eventId: `event-${prefix}`,
    eventDigest: sha(`digest-${prefix}`),
    product: "fettler",
    capability: "remediation_generation",
    taskType: "api_remediation",
    migrationFamily: "response-field-replacement",
    repositoryId: "repository-a",
    observedAt: overrides.observedAt ?? AT,
    createdAt: AT,
    ...overrides,
  });
}

describe("retrieval context-gap sink", () => {
  it("aggregates recorded gaps into a tenant-scoped summary", () => {
    const db = fixture();
    gap(db, "tenant-a", "a1", { capability: "remediation_generation", migrationFamily: "response-field-replacement" });
    gap(db, "tenant-a", "a2", { capability: "remediation_generation", migrationFamily: "endpoint-removal" });
    gap(db, "tenant-a", "a3", { capability: "context_compilation", migrationFamily: "response-field-replacement", product: "regauge" });

    const summary = computeRetrievalContextGaps(db, { tenantId: "tenant-a" });
    expect(summary.totalGaps).toBe(3);
    // Descending by count, ties broken by ascending key.
    expect(summary.byCapability).toEqual([
      { key: "remediation_generation", gaps: 2 },
      { key: "context_compilation", gaps: 1 },
    ]);
    expect(summary.byMigrationFamily).toEqual([
      { key: "response-field-replacement", gaps: 2 },
      { key: "endpoint-removal", gaps: 1 },
    ]);
    expect(summary.byProduct).toEqual([
      { key: "fettler", gaps: 2 },
      { key: "regauge", gaps: 1 },
    ]);
    expect(summary.recent).toHaveLength(3);
  });

  it("never reads another tenant's gaps", () => {
    const db = fixture();
    gap(db, "tenant-a", "a1");
    gap(db, "tenant-b", "b1");
    gap(db, "tenant-b", "b2");
    expect(computeRetrievalContextGaps(db, { tenantId: "tenant-a" }).totalGaps).toBe(1);
    expect(computeRetrievalContextGaps(db, { tenantId: "tenant-b" }).totalGaps).toBe(2);
  });

  it("is idempotent per learning record: a replayed write never double counts", () => {
    const db = fixture();
    const learningRecordId = seedLearningRecord(db, "tenant-a", "a1");
    const input: RetrievalContextGapInput = {
      learningRecordId, tenantId: "tenant-a", eventId: "event-a1", eventDigest: sha("digest-a1"),
      product: "fettler", capability: "remediation_generation", taskType: "api_remediation",
      migrationFamily: "response-field-replacement", repositoryId: "repository-a", observedAt: AT, createdAt: AT,
    };
    recordRetrievalContextGap(db, input);
    recordRetrievalContextGap(db, input);
    expect(computeRetrievalContextGaps(db, { tenantId: "tenant-a" }).totalGaps).toBe(1);
  });

  it("windows on observed_at", () => {
    const db = fixture();
    gap(db, "tenant-a", "early", { observedAt: "2026-08-10T00:00:00.000Z" });
    gap(db, "tenant-a", "mid", { observedAt: "2026-08-15T00:00:00.000Z" });
    gap(db, "tenant-a", "late", { observedAt: "2026-08-20T00:00:00.000Z" });
    const windowed = computeRetrievalContextGaps(db, {
      tenantId: "tenant-a",
      since: "2026-08-12T00:00:00.000Z",
      until: "2026-08-18T00:00:00.000Z",
    });
    expect(windowed.totalGaps).toBe(1);
    expect(windowed.recent[0]?.observedAt).toBe("2026-08-15T00:00:00.000Z");
  });

  it("returns an honest empty summary when nothing is absent yet", () => {
    const db = fixture();
    const summary = computeRetrievalContextGaps(db, { tenantId: "tenant-a" });
    expect(summary.totalGaps).toBe(0);
    expect(summary.byCapability).toEqual([]);
    expect(summary.recent).toEqual([]);
  });

  it("rejects malformed input and an inverted window", () => {
    const db = fixture();
    const learningRecordId = seedLearningRecord(db, "tenant-a", "a1");
    expect(() =>
      recordRetrievalContextGap(db, {
        learningRecordId, tenantId: "tenant-a", eventId: "event-a1", eventDigest: sha("d"),
        // @ts-expect-error deliberately invalid product
        product: "not-a-product", capability: "c", taskType: "t", migrationFamily: "m",
        repositoryId: "r", observedAt: AT, createdAt: AT,
      }),
    ).toThrow("retrieval_gap_product_invalid");
    expect(() =>
      computeRetrievalContextGaps(db, {
        tenantId: "tenant-a", since: "2026-08-18T00:00:00.000Z", until: "2026-08-12T00:00:00.000Z",
      }),
    ).toThrow("retrieval_gap_window_invalid");
  });
});
