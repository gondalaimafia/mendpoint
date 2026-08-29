import { describe, expect, it } from "vitest";
import { aggregateCaseArmResults, validateCaseArmCohort, type CaseArmResult, type EvaluationArm } from "./evaluation.js";

const SHA = "a".repeat(64);
const BUDGET = "b".repeat(64);
const ARMS: EvaluationArm[] = ["production_baseline", "deterministic_recipe", "configured_model_router", "advisory_verifier", "oracle"];

function cohort(): CaseArmResult[] {
  return ARMS.map((arm) => ({
    schemaVersion: "mendpoint.case-arm-result.v1",
    caseId: "REG-E001",
    product: "regauge",
    cohort: "edge",
    datasetSplit: "holdout",
    arm,
    snapshotDigest: SHA,
    budgetDigest: BUDGET,
    predictionArtifactDigest: "c".repeat(64),
    predictionSealedAt: "2026-08-28T23:00:00.000Z",
    answerKeyOpenedAt: "2026-08-28T23:01:00.000Z",
    answerKeyAccessReceiptDigest: "d".repeat(64),
    gradedAt: "2026-08-28T23:02:00.000Z",
    expectedOutcomeIncludedInInput: false,
    answerKeyIncludedInInput: false,
    metrics: {
      success: arm === "oracle",
      correctAbstention: false,
      falseRepairOrMigration: false,
      falseNoImpact: false,
      deterministicVerificationPass: arm === "oracle",
      rollbackPass: true,
      tenantIsolationPass: true,
      replayIdempotencyPass: true,
      severeRegression: false,
      latencyMs: arm === "oracle" ? 10 : 100,
      costUsd: arm === "oracle" ? 0 : 0.1,
    },
  }));
}

describe("case arm evaluation", () => {
  it("requires all five arms under an identical snapshot and budget", () => {
    expect(validateCaseArmCohort(cohort())).toEqual([]);
    const rows = cohort().slice(0, -1);
    rows[0]!.snapshotDigest = "d".repeat(64);
    expect(validateCaseArmCohort(rows)).toEqual(expect.arrayContaining([
      "REG-E001 missing evaluation arm: oracle",
      "REG-E001 arms must use an identical snapshot",
    ]));
  });

  it("rejects desired outcome or answer key leakage into a modeled arm", () => {
    const rows = cohort();
    rows[2]!.expectedOutcomeIncludedInInput = true;
    rows[2]!.answerKeyIncludedInInput = true;
    expect(validateCaseArmCohort(rows)).toEqual(expect.arrayContaining([
      "REG-E001/configured_model_router modeled input must not include expected outcome",
      "REG-E001/configured_model_router modeled input must not include answer key",
      "REG-E001/configured_model_router holdout answer key must remain sealed from the input",
    ]));
  });

  it("rejects answer key access before a prediction is sealed", () => {
    const rows = cohort();
    rows[0]!.answerKeyOpenedAt = "2026-08-28T22:59:00.000Z";
    expect(validateCaseArmCohort(rows)).toContain(
      "REG-E001/production_baseline answer key must open after prediction sealing",
    );
  });

  it("rejects malformed chronology and grading without an access receipt", () => {
    const rows = cohort();
    rows[0]!.predictionSealedAt = "not-a-time";
    rows[0]!.answerKeyAccessReceiptDigest = null;
    expect(validateCaseArmCohort(rows)).toEqual(expect.arrayContaining([
      "REG-E001/production_baseline predictionSealedAt must be a canonical UTC timestamp",
      "REG-E001/production_baseline graded result requires an answer-key access receipt digest",
    ]));
  });

  it("reports all requested rates without inventing confidence intervals", () => {
    const report = aggregateCaseArmResults(cohort());
    expect(report.caseCount).toBe(1);
    expect(report.runCount).toBe(5);
    expect(report.byArm.oracle.successRate).toBe(1);
    expect(report.byArm.configured_model_router.falseNoImpactRate).toBe(0);
    expect(report.byArm.oracle.meanLatencyMs).toBe(10);
  });
});
