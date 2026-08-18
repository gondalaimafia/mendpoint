import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import {
  governedLearningAdmissionIds,
  type LearningSignalClass,
  type LearningVerificationProducer,
} from "@mendpoint/pipeline";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
  type GovernedLearningOutcomeFacts,
} from "./governed-learning-producer.js";

// These tests pin the corpus-integrity fix: the sole production producer used to
// assert `verdict: "passed"` and `contaminationFree: true` as literals, so the
// "insufficient" classification branch (learning-event.ts) was unreachable and the
// contamination gate (learning-operations.ts) could never fire. The verdict is now
// derived from the recorded authority's signal class, and contamination-freedom is
// a caller attestation the gate enforces.

const TENANT = "tenant-verdict";
const HUMAN = "human-verdict";
const RESIDENCY = "us-east";
const AT = "2026-08-01T00:00:00.000Z";
const OBSERVED = "2026-08-01T10:00:00.000Z";
const NOW = "2026-08-01T12:00:00.000Z";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-verdict-"));
  dirs.push(dir);
  const db = createDb(join(dir, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: TENANT, slug: TENANT, name: TENANT, createdAt: AT });
  insertPrincipal(db, {
    id: HUMAN,
    tenantId: TENANT,
    kind: "human",
    subject: "reviewer",
    displayName: "Reviewer",
    createdAt: AT,
  });
  grantLearningConsent(db, {
    id: "consent-governed",
    tenantId: TENANT,
    consentVersion: 1,
    purpose: GOVERNED_LEARNING_PURPOSE,
    residencyRegion: RESIDENCY,
    authorizedByPrincipalId: HUMAN,
    effectiveAt: AT,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized governed learning",
    idempotencyKey: "grant-governed",
    createdAt: AT,
  });
  return db;
}

function facts(
  db: AppDb,
  runId: string,
  overrides: Readonly<{
    signalClass?: LearningSignalClass;
    producedBy?: LearningVerificationProducer;
    contaminationFree?: boolean;
  }> = {},
): GovernedLearningOutcomeFacts {
  const signalClass = overrides.signalClass ?? "hard";
  return {
    db,
    tenantId: TENANT,
    consentId: "consent-governed",
    residencyRegion: RESIDENCY,
    product: "fettler",
    sourceObjectType: "fettler_agent_run",
    sourceObjectId: runId,
    repositoryId: "warden-repo-verdict",
    taskType: "api_remediation",
    capability: "remediation_generation",
    specialization: {
      provider: null,
      framework: null,
      language: null,
      runtime: null,
      migrationFamily: "api_remediation",
      riskClass: "medium",
    },
    execution: { modelId: null, adapterId: null, routerDecisionId: `warden_route_${runId}`, fallback: false },
    predictionSummary: "Apply the reviewed Warden repair.",
    outcome: { status: "corrected", summary: "The repair passed objective verification.", attribution: "model_behavior" },
    reviewerDecision: "accepted",
    correctionSubstantive: true,
    contaminationFree: overrides.contaminationFree ?? true,
    confidence: 0.9,
    verificationAuthority: {
      signalClass,
      producedBy: overrides.producedBy ?? (signalClass === "hard" ? "sandbox_command" : "model_verifier"),
      producerModelId: signalClass === "hard" ? null : "muse-spark-1.2",
    },
    economics: { inputTokens: 100, outputTokens: 20, latencyMs: 500, costUsd: 0.01 },
    sourceClass: "design_partner_verified",
    provenanceQualifiers: signalClass === "hard"
      ? ["deterministically_verified", "reviewer_accepted"]
      : ["reviewer_accepted"],
    mayLeaveTenantBoundary: false,
    revision: "b".repeat(40),
    snapshotDigest: `sha256:${"c".repeat(64)}`,
    scenarioId: null,
    syntheticFamilyId: null,
    reviewerPrincipalId: HUMAN,
    reviewRationale: "Approved in Warden review.",
    observedAt: OBSERVED,
    now: NOW,
  };
}

/** Read back the stored governed lesson document for an admitted event. */
function storedLesson(db: AppDb, eventId: string): {
  verdict: string;
  evidenceStrength: string;
  destinations: ReadonlyArray<{ destination: string; rationale: string }>;
  eligibleForModelTraining: boolean;
} {
  const ids = governedLearningAdmissionIds(TENANT, eventId);
  const row = db.raw
    .prepare("SELECT content_text FROM artifact_manifests WHERE id = ? AND tenant_id = ?")
    .get(ids.redactedArtifactId, TENANT) as { content_text: string | null } | undefined;
  if (!row?.content_text) throw new Error("lesson document not found");
  const doc = JSON.parse(row.content_text) as {
    event: { verification: { verdict: string } };
    lesson: {
      evidenceStrength: string;
      destinations: ReadonlyArray<{ destination: string; rationale: string }>;
      eligibleForModelTraining: boolean;
    };
  };
  return {
    verdict: doc.event.verification.verdict,
    evidenceStrength: doc.lesson.evidenceStrength,
    destinations: doc.lesson.destinations,
    eligibleForModelTraining: doc.lesson.eligibleForModelTraining,
  };
}

describe("governed producer derives the verification verdict from the recorded authority", () => {
  it("a soft model_verifier authority cannot produce a passed verdict; the lesson reads insufficient", () => {
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-soft", { signalClass: "soft" }));
    expect(result.admitted).toBe(true);

    // The soft authority yields `inconclusive`, never `passed`, so the previously
    // unreachable "insufficient" classification branch now fires.
    const lesson = storedLesson(db, result.eventId!);
    expect(lesson.verdict).toBe("inconclusive");
    expect(lesson.verdict).not.toBe("passed");
    expect(lesson.evidenceStrength).toBe("insufficient");
    expect(lesson.destinations).toEqual([
      { destination: "no_action", rationale: "verification_not_authoritative" },
    ]);
    expect(lesson.eligibleForModelTraining).toBe(false);
  });

  it("a genuinely hard, contamination-checked outcome still admits and stays on the weight path", () => {
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-hard", { signalClass: "hard" }));
    expect(result.admitted).toBe(true);

    const lesson = storedLesson(db, result.eventId!);
    expect(lesson.verdict).toBe("passed");
    expect(lesson.evidenceStrength).toBe("high");
    expect(lesson.eligibleForModelTraining).toBe(true);
  });

  it("an outcome whose contamination status is not attested is rejected by the admission gate", () => {
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-uncontaminated", { contaminationFree: false }));
    // The gate (learning-operations.ts) throws learning_admission_authority_invalid
    // for any contaminationFree !== true; the best-effort producer surfaces it as a
    // non-admission rather than admitting a record the check never cleared.
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain("learning_admission_authority_invalid");

    // Nothing was persisted for the rejected outcome.
    const rows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM learning_records WHERE tenant_id = ?")
      .get(TENANT) as { n: number };
    expect(rows.n).toBe(0);
  });
});
