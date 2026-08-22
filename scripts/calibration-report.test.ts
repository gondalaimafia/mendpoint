import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addLearningDatasetMember,
  admitLearningRecord,
  createDb,
  createLearningDatasetVersion,
  grantLearningConsent,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertReviewDecision,
  insertTenant,
  sealLearningDatasetVersion,
  type AppDb,
} from "@mendpoint/db";
import { buildCrossRunCalibration } from "./calibration-report.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-01T12:00:00.000Z";
const later = "2026-08-01T13:00:00.000Z";
const observed = "2026-07-31T12:00:00.000Z";
const cutoff = "2026-08-01T00:00:00.000Z";
const RESIDENCY = "us-east";
const APPROVED_PURPOSE = "transformer-adaptive-repair";
const REJECTED_PURPOSE = "transformer-adaptive-rejected-outcomes";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function setup(tenantId: string): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-calibration-"));
  dirs.push(dir);
  const db = createDb(join(dir, "calibration.sqlite"));
  dbs.push(db);
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
  return db;
}

function outcomeJson(
  prefix: string,
  confidence: number,
  decision: "accepted" | "rejected",
): string {
  const base = {
    schemaVersion: 1,
    failingCommandId: `cmd-${prefix}`,
    overallRisk: "low",
    confidence,
    changedPaths: [`src/${prefix}.ts`],
    edits: [
      {
        path: `src/${prefix}.ts`,
        semanticCategory: "behavior",
        risk: "low",
        rationale: `Adapt ${prefix}`,
      },
    ],
    verificationSummary: "vitest passed",
    verificationCommandId: `verify-${prefix}`,
    observedAt: observed,
  };
  if (decision === "rejected") {
    return JSON.stringify({
      ...base,
      decision: "rejected",
      rejectionRationale: `Rejected ${prefix}`,
    });
  }
  return JSON.stringify(base);
}

/** Seed one governed learning record whose redacted body is `redactedContent`. */
function admitRecord(
  db: AppDb,
  tenantId: string,
  consentId: string,
  prefix: string,
  redactedContent: string,
): string {
  const source = insertArtifactManifest(db, {
    id: `${prefix}-source`,
    tenantId,
    kind: "source",
    schemaVersion: 1,
    sha256: sha(`raw-${prefix}`),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(`raw-${prefix}`),
    storageRef: `test://${prefix}-source`,
    content: `raw-${prefix}`,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  const redacted = insertArtifactManifest(db, {
    id: `${prefix}-redacted`,
    tenantId,
    kind: "candidate-edit",
    schemaVersion: 1,
    sha256: sha(redactedContent),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(redactedContent),
    storageRef: `test://${prefix}-redacted`,
    content: redactedContent,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  const verart = insertArtifactManifest(db, {
    id: `${prefix}-verart`,
    tenantId,
    kind: "verification-result",
    schemaVersion: 1,
    sha256: sha(`ver-${prefix}`),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(`ver-${prefix}`),
    storageRef: `test://${prefix}-verart`,
    content: `ver-${prefix}`,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  const conart = insertArtifactManifest(db, {
    id: `${prefix}-conart`,
    tenantId,
    kind: "contamination-result",
    schemaVersion: 1,
    sha256: sha(`con-${prefix}`),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(`con-${prefix}`),
    storageRef: `test://${prefix}-conart`,
    content: `con-${prefix}`,
    producerPrincipalId: `service-${tenantId}`,
    createdAt: at,
  }).row;
  insertEvidenceRecord(db, {
    id: `${prefix}-redev`,
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
    id: `${prefix}-verev`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    artifactId: verart.id,
    inputArtifactId: redacted.id,
    producerPrincipalId: `service-${tenantId}`,
    tool: "vitest",
    verdict: "passed",
    createdAt: at,
  });
  insertEvidenceRecord(db, {
    id: `${prefix}-conev`,
    tenantId,
    subjectType: "learning_candidate",
    subjectId: prefix,
    artifactId: conart.id,
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
    rationale: "Redacted output admitted to corpus",
    createdAt: at,
  });
  const record = admitLearningRecord(db, {
    id: `record-${prefix}`,
    tenantId,
    consentId,
    sourceObjectType: "transformer_adaptive_candidate",
    sourceObjectId: `pr-${prefix}`,
    sourceArtifactId: source.id,
    redactedArtifactId: redacted.id,
    redactionEvidenceId: `${prefix}-redev`,
    verificationEvidenceId: `${prefix}-verev`,
    contaminationEvidenceId: `${prefix}-conev`,
    acceptedReviewId: `${prefix}-review`,
    observedAt: observed,
    admittedByPrincipalId: `service-${tenantId}`,
    idempotencyKey: `admit-${prefix}`,
    createdAt: later,
  });
  return record.id;
}

/** Seed a full sealed arm (consent + records + sealed dataset) for one purpose. */
function seedArm(
  db: AppDb,
  tenantId: string,
  purpose: string,
  specs: readonly Readonly<{
    prefix: string;
    confidence: number;
    decision: "accepted" | "rejected";
  }>[],
): void {
  const consentId = `consent-${purpose}`;
  grantLearningConsent(db, {
    id: consentId,
    tenantId,
    consentVersion: 1,
    purpose,
    residencyRegion: RESIDENCY,
    authorizedByPrincipalId: `human-${tenantId}`,
    effectiveAt: at,
    expiresAt: "2026-09-01T00:00:00.000Z",
    reason: "Authorized learning",
    idempotencyKey: `grant-${purpose}`,
    createdAt: at,
  });
  const datasetId = `dataset-${purpose}`;
  createLearningDatasetVersion(db, {
    id: datasetId,
    tenantId,
    purpose,
    residencyRegion: RESIDENCY,
    version: 1,
    temporalCutoffAt: cutoff,
    createdByPrincipalId: `service-${tenantId}`,
    idempotencyKey: `create-${datasetId}`,
    createdAt: later,
  });
  for (const spec of specs) {
    const recordId = admitRecord(
      db,
      tenantId,
      consentId,
      spec.prefix,
      outcomeJson(spec.prefix, spec.confidence, spec.decision),
    );
    addLearningDatasetMember(db, {
      tenantId,
      datasetVersionId: datasetId,
      learningRecordId: recordId,
      idempotencyKey: `member-${spec.prefix}`,
      createdAt: later,
    });
  }
  sealLearningDatasetVersion(db, {
    tenantId,
    datasetVersionId: datasetId,
    sealedByPrincipalId: `human-${tenantId}`,
    sealedAt: later,
  });
}

describe("buildCrossRunCalibration", () => {
  it("merges both arms into one calibration report, tenant-scoped", () => {
    const tenantId = "tenant-a";
    const db = setup(tenantId);
    seedArm(db, tenantId, APPROVED_PURPOSE, [
      { prefix: "alpha", confidence: 90, decision: "accepted" },
      { prefix: "bravo", confidence: 95, decision: "accepted" },
    ]);
    seedArm(db, tenantId, REJECTED_PURPOSE, [
      { prefix: "charlie", confidence: 40, decision: "rejected" },
    ]);

    // Floor of 1 so the small seeded buckets are reportable.
    const result = buildCrossRunCalibration({
      db,
      tenantId,
      at: later,
      minBucketObservations: 1,
    });

    expect(result.arms).toEqual([
      { purpose: APPROVED_PURPOSE, reason: "ok", observations: 2 },
      { purpose: REJECTED_PURPOSE, reason: "ok", observations: 1 },
    ]);
    expect(result.report.status).toBe("ok");
    if (result.report.status !== "ok") throw new Error("unreachable");
    expect(result.report.summary.totalObservations).toBe(3);
    expect(result.report.summary.acceptedObservations).toBe(2);

    const top = result.report.buckets[9]; // [90,100]
    expect(top.count).toBe(2);
    expect(top.acceptedCount).toBe(2);
    if (top.status !== "ok") throw new Error("expected ok bucket");
    expect(top.observedAcceptanceRate).toBe(1);

    const rejected = result.report.buckets[4]; // [40,50)
    expect(rejected.count).toBe(1);
    expect(rejected.acceptedCount).toBe(0);
  });

  it("returns a no_data report for a tenant with no consented data", () => {
    const db = setup("tenant-a");
    const result = buildCrossRunCalibration({
      db,
      tenantId: "tenant-unknown",
      at: later,
    });
    expect(result.report.status).toBe("no_data");
    // Both arms report why they were empty (no consent), so the emptiness is legible.
    expect(result.arms.map((arm) => arm.reason)).toEqual([
      "no_active_consent",
      "no_active_consent",
    ]);
    expect(result.report.honesty.outcomeSemantics).toBe("reviewer_decision");
  });

  it("does not leak one tenant's data into another tenant's report", () => {
    const db = setup("tenant-a");
    insertTenant(db, { id: "tenant-b", slug: "tenant-b", name: "tenant-b", createdAt: at });
    insertPrincipal(db, {
      id: "human-tenant-b",
      tenantId: "tenant-b",
      kind: "human",
      subject: "user-tenant-b",
      displayName: "Reviewer b",
      createdAt: at,
    });
    insertPrincipal(db, {
      id: "service-tenant-b",
      tenantId: "tenant-b",
      kind: "service",
      subject: "worker-tenant-b",
      displayName: "Worker b",
      createdAt: at,
    });
    seedArm(db, "tenant-a", APPROVED_PURPOSE, [
      { prefix: "alpha", confidence: 90, decision: "accepted" },
    ]);

    const result = buildCrossRunCalibration({
      db,
      tenantId: "tenant-b",
      at: later,
      minBucketObservations: 1,
    });
    expect(result.report.status).toBe("no_data");
  });
});
