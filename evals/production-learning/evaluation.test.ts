import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  EVALUATION_ARMS,
  EVALUATION_LEARNING_CASE,
  EVALUATION_PRODUCTION_REVISION,
  EVALUATION_REPOSITORY_COMMIT,
  SHA,
  evaluationModeledInputDigest,
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
    modeledInputArtifactDigest: evaluationModeledInputDigest(arm),
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
  const learningCase: LearningCase = EVALUATION_LEARNING_CASE;
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
    // The arm presents an input artifact that is not the staged leak-free input
    // for this case and arm. The validator recomputes the staged digest itself,
    // so the mismatch is decided from content; the producer cannot clear it by
    // reporting that it did not leak.
    const rows = cohort();
    rows[2]!.modeledInputArtifactDigest = "c".repeat(64);
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001/configured_model_router modeled input artifact does not match the sealed leak-free staged input for this case and arm",
    ]));
  });

  it("rejects a modeled arm whose input artifact digest is the real answer-key-bearing case", () => {
    // The concrete leak this guard exists for: the arm was handed the full
    // learning case, answer key and expected impact graph included, rather than
    // the staged projection. Digesting that artifact the same way the honest
    // producer would still fails, because its content is not the staged input.
    const rows = cohort();
    const leakedInputDigest = createHash("sha256")
      .update(JSON.stringify(EVALUATION_LEARNING_CASE))
      .digest("hex");
    rows[2]!.modeledInputArtifactDigest = leakedInputDigest;
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001/configured_model_router modeled input artifact does not match the sealed leak-free staged input for this case and arm",
    ]));
  });

  it("fails closed when no modeled input artifact was retained", () => {
    // The undetermined third state. No executor exists yet, so this is the
    // state every real row would be in today. It must not read as "no leak".
    const rows = cohort();
    rows[1]!.modeledInputArtifactDigest = null;
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001/deterministic_recipe modeled input artifact digest is not retained, so answer-key exposure cannot be determined",
    ]));
  });

  it("rejects an oracle arm that presents a modeled input artifact digest", () => {
    const rows = cohort();
    rows[4]!.modeledInputArtifactDigest = "c".repeat(64);
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001/oracle oracle arm must not present a modeled input artifact digest",
    ]));
  });

  it("requires all five arms to run under an identical budget", () => {
    // The headline property of the five-arm design: an arm that was given a
    // larger budget than its peers is not comparable to them, so a cohort whose
    // budgets disagree is not a valid comparison regardless of its metrics.
    const rows = cohort();
    expect(validateCaseArmCohort(rows, registry())).toEqual([]);
    rows[2]!.budgetDigest = createHash("sha256")
      .update(JSON.stringify({ ...RUN_BUDGET, maximumUsd: RUN_BUDGET.maximumUsd * 10 }))
      .digest("hex");
    expect(validateCaseArmCohort(rows, registry())).toEqual(expect.arrayContaining([
      "REG-E001 arms must use an identical budget",
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

  it("stops trusting issued production and grading capabilities after their key epochs advance", () => {
    const rows = cohort();
    const trusted = registry();
    process.env.MENDPOINT_PRODUCTION_LEARNING_MINIMUM_ISSUED_AT = "2026-01-02T00:00:00.000Z";
    expect(validateCaseArmCohort(rows, trusted)).toContain(
      "evaluation registry contains an unverified production authority",
    );
    installTestAuthorityTrustRoots();
    process.env.MENDPOINT_PRODUCTION_REVISION = PRODUCTION_REVISION;
    process.env.MENDPOINT_EVALUATION_GRADING_MINIMUM_ISSUED_AT = "2026-01-02T00:00:00.000Z";
    expect(validateCaseArmCohort(rows, trusted)).toContain(
      "evaluation registry contains an unverified grading authority",
    );
    installTestAuthorityTrustRoots();
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
