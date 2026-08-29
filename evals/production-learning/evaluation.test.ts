import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  EVALUATION_ARMS,
  EVALUATION_PRODUCTION_REVISION,
  EVALUATION_REPOSITORY_COMMIT,
  SHA,
  evaluationGradeAuthorityEnvelope,
  evaluationMetrics,
  evaluationProductionAuthorityEnvelope,
  installTestAuthorityTrustRoots,
} from "./authority-fixtures.test-support.js";
import {
  aggregateCaseArmResults,
  validateCaseArmCohort,
  verifyEvaluationGradeAuthority,
  type CaseArmResult,
  type EvaluationArm,
  type EvaluationRegistry,
} from "./evaluation.js";
import type { LearningCase, ProductionExecutionReceipt, RepositoryProvenance } from "./schema.js";
import { verifyProductionLearningAuthority } from "./preflight.js";

const RUN_BUDGET = { maximumUsd: 1, maximumLatencyMs: 60_000, maximumAttempts: 1 };
const BUDGET = createHash("sha256").update(JSON.stringify(RUN_BUDGET)).digest("hex");
const REPOSITORY_COMMIT = EVALUATION_REPOSITORY_COMMIT;
const PRODUCTION_REVISION = EVALUATION_PRODUCTION_REVISION;
const ARMS: EvaluationArm[] = [...EVALUATION_ARMS];
installTestAuthorityTrustRoots();
process.env.MENDPOINT_PRODUCTION_REVISION = PRODUCTION_REVISION;

function cohort(): CaseArmResult[] {
  return ARMS.map((arm) => {
    const productionEnvelope = evaluationProductionAuthorityEnvelope(arm);
    const gradeEnvelope = evaluationGradeAuthorityEnvelope(arm);
    const row: CaseArmResult = {
    schemaVersion: "mendpoint.case-arm-result.v1",
    caseId: "REG-E001",
    product: "regauge",
    cohort: "edge",
    datasetSplit: "holdout",
    arm,
    tenantId: "benchmark-tenant-a",
    repositoryProvenanceId: "repo-example",
    repositoryCommit: REPOSITORY_COMMIT,
    productionRevision: PRODUCTION_REVISION,
    snapshotDigest: SHA,
    fixtureManifestId: "fixture-reg-e001-manifest-v1",
    fixtureManifestDigest: "1".repeat(64),
    graphVersion: "graph-v1",
    policyVersion: "policy-v1",
    model: { provider: "configured", modelId: `model-${arm}`, requestId: `request-${arm}` },
    routerVersion: "router-v1",
    recipeVersion: arm === "deterministic_recipe" ? "recipe-v1" : null,
    consentEvidenceRef: "consent://benchmark-tenant-a/evaluation/v1",
    authorizationRef: "authorization://benchmark-tenant-a/REG-E001/v1",
    executionDigest: productionEnvelope.payload.executionDigest,
    sandboxReceiptDigest: "8".repeat(64),
    trustedProductionReceiptAuthorityDigest: "0".repeat(64),
    budgetDigest: BUDGET,
    predictionArtifactDigest: gradeEnvelope.payload.predictionArtifactDigest,
    predictionSealedAt: "2026-08-28T23:00:00.000Z",
    answerKeyOpenedAt: "2026-08-28T23:01:00.000Z",
    answerKeyAccessReceiptDigest: "d".repeat(64),
    gradedAt: "2026-08-28T23:02:00.000Z",
    gradingAuthorityDigest: "0".repeat(64),
    expectedOutcomeIncludedInInput: false,
    answerKeyIncludedInInput: false,
    metrics: evaluationMetrics(arm),
    };
    row.trustedProductionReceiptAuthorityDigest = productionAuthority(row).authorityEnvelopeDigest;
    row.gradingAuthorityDigest = verifyEvaluationGradeAuthority(gradeEnvelope).authorityEnvelopeDigest;
    return row;
  });
}

function productionAuthority(row: CaseArmResult) {
  process.env.MENDPOINT_PRODUCTION_REVISION = row.productionRevision;
  return verifyProductionLearningAuthority(evaluationProductionAuthorityEnvelope(row.arm));
}

function productionReceipt(row: CaseArmResult): ProductionExecutionReceipt {
  return {
    schemaVersion: "mendpoint.production-learning-receipt.v1",
    caseId: row.caseId,
    product: row.product,
    productionRevision: row.productionRevision,
    tenantId: row.tenantId,
    repositoryId: row.repositoryProvenanceId,
    repositoryCommit: row.repositoryCommit,
    snapshotDigest: row.snapshotDigest,
    fixtureManifestDigest: row.fixtureManifestDigest,
    graphVersion: row.graphVersion,
    policyVersion: row.policyVersion,
    model: row.model,
    routerVersion: row.routerVersion,
    recipeVersion: row.recipeVersion,
    consent: { decision: "granted", purpose: "evaluation", evidenceRef: row.consentEvidenceRef },
    authorizationRef: row.authorizationRef,
    sandbox: { kind: "dedicated_benchmark", receiptDigest: row.sandboxReceiptDigest, defaultDenyEgress: true },
    executionDigest: row.executionDigest,
    budget: RUN_BUDGET,
    delivery: { mode: "draft_pr_only", mergeAllowed: false, deploymentAllowed: false, openDraftCountForCase: 0 },
    advisoryVerifier: { name: "deepseek", advisoryOnly: true, maySelectCandidate: false, mayMutateExecution: false, mayDeliver: false, mayMerge: false, mayDeploy: false },
    evidence: { diagnosis: "verified", repairOrMigration: "verified", verification: "verified", rollback: "verified", production: "unknown" },
  };
}

function registry(): EvaluationRegistry {
  const learningCase: LearningCase = {
    schemaVersion: "mendpoint.learning-case.v1",
    id: "REG-E001",
    product: "regauge",
    cohort: "edge",
    datasetSplit: "holdout",
    title: "Registry-bound evaluation case",
    importance: { statement: "Official evidence supports this case.", frequencyClaim: "not_claimed", sourceIds: ["source-1"] },
    sources: [{ id: "source-1", kind: "official_documentation", title: "Official evidence", publisher: "Upstream", url: "https://example.com/evidence", retrievedAt: "2026-08-28T23:00:00.000Z" }],
    repository: {
      provenanceId: "repo-example",
      languages: ["TypeScript"],
      frameworks: ["Node.js"],
      binding: { mode: "native", originalResearchCandidate: "repo-example", rationale: "The repository directly exercises the case." },
    },
    pattern: { family: "runtime-upgrade", seededFailure: "A deterministic failure is seeded.", expectedImpactGraph: ["runtime", "test"], evidenceState: "verified" },
    expected: { diagnosis: "Diagnose the seeded failure.", repairOrMigration: "Apply the bounded migration.", oracleIds: ["oracle-reg-e001"], productionAcceptance: ["The oracle passes."] },
    fixture: { manifestId: "fixture-reg-e001-manifest-v1", mutationId: "mutation-reg-e001-v1", allowedEditPaths: ["src/**"], rollbackId: "rollback-reg-e001-v1", cleanupId: "cleanup-reg-e001-v1" },
    security: { tenantRisk: "bounded", risks: ["untrusted_repository_content"], requiresDedicatedBenchmarkTenant: true },
    planning: { requirementIds: ["REQ-EVAL-001"] },
  };
  const repository: RepositoryProvenance = {
    schemaVersion: "mendpoint.repository-provenance.v1",
    id: "repo-example",
    repositoryUrl: "https://github.com/example/example",
    immutableCommit: REPOSITORY_COMMIT,
    license: { spdxId: "MIT", sourceUrl: "https://github.com/example/example/blob/main/LICENSE", textSha256: "4".repeat(64), decision: "approved", decidedAt: "2026-08-28T23:00:00.000Z", intendedUses: ["evaluation", "governed_learning"] },
    languages: ["TypeScript"], frameworks: ["Node.js"], dependencyLockfiles: ["package-lock.json"], provenanceRetrievedAt: "2026-08-28T23:00:00.000Z", dataClassification: "public_source_code",
    contentScreening: { secrets: "not_detected", personalData: "not_detected", generatedCredentials: "not_detected", customerData: "not_present" },
  };
  return {
    cases: [learningCase],
    repositories: [repository],
    trustedProductionRuns: cohort().map((row) => ({
      authority: productionAuthority(row),
      receipt: productionReceipt(row),
    })),
    trustedEvaluationGrades: ARMS.map((arm) => verifyEvaluationGradeAuthority(evaluationGradeAuthorityEnvelope(arm))),
  };
}

describe("case arm evaluation", () => {
  it("rejects an empty or partial cohort against the complete case registry", () => {
    expect(validateCaseArmCohort([], registry())).toEqual(ARMS.map((arm) => `REG-E001 missing evaluation arm: ${arm}`));
    expect(() => aggregateCaseArmResults([], registry())).toThrow("invalid_case_arm_cohort");
  });

  it("requires all five arms under an identical snapshot and budget", () => {
    expect(validateCaseArmCohort(cohort(), registry())).toEqual([]);
    const rows = cohort().slice(0, -1);
    rows[0]!.snapshotDigest = "d".repeat(64);
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001 missing evaluation arm: oracle",
      "REG-E001 arms must use an identical snapshot",
    ]));
  });

  it("rejects desired outcome or answer key leakage into a modeled arm", () => {
    const rows = cohort();
    rows[2]!.expectedOutcomeIncludedInInput = true;
    rows[2]!.answerKeyIncludedInInput = true;
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001/configured_model_router modeled input must not include expected outcome",
      "REG-E001/configured_model_router modeled input must not include answer key",
      "REG-E001/configured_model_router holdout answer key must remain sealed from the input",
    ]));
  });

  it("rejects answer key access before a prediction is sealed", () => {
    const rows = cohort();
    rows[0]!.answerKeyOpenedAt = "2026-08-28T22:59:00.000Z";
    expect(validateCaseArmCohort(rows, registry())).toContain(
      "REG-E001/production_baseline answer key must open after prediction sealing",
    );
  });

  it("rejects malformed chronology and grading without an access receipt", () => {
    const rows = cohort();
    rows[0]!.predictionSealedAt = "not-a-time";
    rows[0]!.answerKeyAccessReceiptDigest = null;
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001/production_baseline predictionSealedAt must be a canonical UTC timestamp",
      "REG-E001/production_baseline graded result requires an answer-key access receipt digest",
    ]));
  });

  it("rejects divergent immutable bindings and case or provenance registry mismatches", () => {
    const rows = cohort();
    rows[1]!.tenantId = "benchmark-tenant-b";
    rows[2]!.repositoryCommit = "9".repeat(40);
    rows[3]!.fixtureManifestId = "fixture-foreign";
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001 arms must use an identical tenant",
      "REG-E001/configured_model_router repositoryCommit does not match the provenance registry",
      "REG-E001/advisory_verifier fixtureManifestId does not match the case registry",
    ]));
  });

  it("rejects a production receipt authority digest outside the trusted registry", () => {
    const rows = cohort();
    rows[0]!.trustedProductionReceiptAuthorityDigest = "8".repeat(64);
    expect(validateCaseArmCohort(rows, registry())).toContain(
      "REG-E001/production_baseline trustedProductionReceiptAuthorityDigest is not present in the trusted authority registry",
    );
  });

  it("requires every boolean metric to be the exact boolean type", () => {
    for (const metric of [
      "success",
      "correctAbstention",
      "falseRepairOrMigration",
      "falseNoImpact",
      "deterministicVerificationPass",
      "rollbackPass",
      "tenantIsolationPass",
      "replayIdempotencyPass",
      "severeRegression",
    ] as const) {
      const rows = cohort();
      (rows[0]!.metrics as unknown as Record<string, unknown>)[metric] = "false";
      expect(validateCaseArmCohort(rows, registry())).toContain(
        `REG-E001/production_baseline metrics.${metric} must be boolean`,
      );
    }
  });

  it("rejects self-attested grading tokens and metrics that differ from the signed grade", () => {
    const rows = cohort();
    rows[0]!.metrics.success = true;
    expect(validateCaseArmCohort(rows, registry())).toContain(
      "REG-E001/production_baseline metricsDigest does not match the trusted grading authority",
    );
    const trusted = registry();
    const forged = { ...trusted.trustedEvaluationGrades[0] } as typeof trusted.trustedEvaluationGrades[number];
    const forgedRegistry = { ...trusted, trustedEvaluationGrades: [forged, ...trusted.trustedEvaluationGrades.slice(1)] };
    expect(validateCaseArmCohort(cohort(), forgedRegistry)).toContain(
      "evaluation registry contains an unverified grading authority",
    );
  });

  it("reports all requested rates without inventing confidence intervals", () => {
    const report = aggregateCaseArmResults(cohort(), registry());
    expect(report.caseCount).toBe(1);
    expect(report.runCount).toBe(5);
    expect(report.byArm.oracle.successRate).toBe(1);
    expect(report.byArm.configured_model_router.falseNoImpactRate).toBe(0);
    expect(report.byArm.oracle.meanLatencyMs).toBe(10);
  });
});
