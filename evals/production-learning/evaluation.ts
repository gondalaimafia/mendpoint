export type EvaluationArm =
  | "production_baseline"
  | "deterministic_recipe"
  | "configured_model_router"
  | "advisory_verifier"
  | "oracle";

export interface CaseArmResult {
  schemaVersion: "mendpoint.case-arm-result.v1";
  caseId: string;
  product: "fettler" | "regauge";
  cohort: "common" | "edge";
  datasetSplit: "development" | "holdout";
  arm: EvaluationArm;
  snapshotDigest: string;
  budgetDigest: string;
  predictionArtifactDigest: string;
  predictionSealedAt: string;
  answerKeyOpenedAt: string | null;
  answerKeyAccessReceiptDigest: string | null;
  gradedAt: string;
  expectedOutcomeIncludedInInput: boolean;
  answerKeyIncludedInInput: boolean;
  metrics: {
    success: boolean;
    correctAbstention: boolean;
    falseRepairOrMigration: boolean;
    falseNoImpact: boolean;
    deterministicVerificationPass: boolean;
    rollbackPass: boolean;
    tenantIsolationPass: boolean;
    replayIdempotencyPass: boolean;
    severeRegression: boolean;
    latencyMs: number;
    costUsd: number;
  };
}

export interface AggregateMetrics {
  caseCount: number;
  runCount: number;
  byArm: Record<EvaluationArm, {
    runs: number;
    successRate: number | null;
    correctAbstentionRate: number | null;
    falseRepairOrMigrationRate: number | null;
    falseNoImpactRate: number | null;
    deterministicVerificationPassRate: number | null;
    rollbackPassRate: number | null;
    tenantIsolationPassRate: number | null;
    replayIdempotencyPassRate: number | null;
    severeRegressionRate: number | null;
    totalCostUsd: number;
    meanLatencyMs: number | null;
  }>;
}

const ARMS: readonly EvaluationArm[] = [
  "production_baseline",
  "deterministic_recipe",
  "configured_model_router",
  "advisory_verifier",
  "oracle",
];
const SHA256 = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function validateCaseArmCohort(results: readonly CaseArmResult[]): string[] {
  const errors: string[] = [];
  const byCase = new Map<string, CaseArmResult[]>();
  for (const result of results) {
    if (result.schemaVersion !== "mendpoint.case-arm-result.v1") {
      errors.push(`${result.caseId}/${result.arm} schemaVersion must be mendpoint.case-arm-result.v1`);
    }
    if (!ARMS.includes(result.arm)) errors.push(`${result.caseId}/${result.arm} evaluation arm is invalid`);
    if (!(result.product === "fettler" || result.product === "regauge")) {
      errors.push(`${result.caseId}/${result.arm} product is invalid`);
    }
    if (!(result.cohort === "common" || result.cohort === "edge")) {
      errors.push(`${result.caseId}/${result.arm} cohort is invalid`);
    }
    if (!(result.datasetSplit === "development" || result.datasetSplit === "holdout")) {
      errors.push(`${result.caseId}/${result.arm} datasetSplit is invalid`);
    }
    const rows = byCase.get(result.caseId) ?? [];
    rows.push(result);
    byCase.set(result.caseId, rows);
    if (!SHA256.test(result.snapshotDigest)) errors.push(`${result.caseId}/${result.arm} snapshotDigest must be sha256`);
    if (!SHA256.test(result.budgetDigest)) errors.push(`${result.caseId}/${result.arm} budgetDigest must be sha256`);
    if (!SHA256.test(result.predictionArtifactDigest)) errors.push(`${result.caseId}/${result.arm} predictionArtifactDigest must be sha256`);
    if (typeof result.expectedOutcomeIncludedInInput !== "boolean") {
      errors.push(`${result.caseId}/${result.arm} expectedOutcomeIncludedInInput must be boolean`);
    }
    if (typeof result.answerKeyIncludedInInput !== "boolean") {
      errors.push(`${result.caseId}/${result.arm} answerKeyIncludedInInput must be boolean`);
    }
    if (result.arm !== "oracle" && result.expectedOutcomeIncludedInInput !== false) {
      errors.push(`${result.caseId}/${result.arm} modeled input must not include expected outcome`);
    }
    if (result.arm !== "oracle" && result.answerKeyIncludedInInput !== false) {
      errors.push(`${result.caseId}/${result.arm} modeled input must not include answer key`);
    }
    const sealedAt = Date.parse(result.predictionSealedAt);
    const openedAt = result.answerKeyOpenedAt === null ? Number.NaN : Date.parse(result.answerKeyOpenedAt);
    const gradedAt = Date.parse(result.gradedAt);
    if (!UTC_TIMESTAMP.test(result.predictionSealedAt) || !Number.isFinite(sealedAt)) {
      errors.push(`${result.caseId}/${result.arm} predictionSealedAt must be a canonical UTC timestamp`);
    }
    if (!UTC_TIMESTAMP.test(result.gradedAt) || !Number.isFinite(gradedAt)) {
      errors.push(`${result.caseId}/${result.arm} gradedAt must be a canonical UTC timestamp`);
    }
    if (result.answerKeyOpenedAt === null || !UTC_TIMESTAMP.test(result.answerKeyOpenedAt) || !Number.isFinite(openedAt)) {
      errors.push(`${result.caseId}/${result.arm} graded result requires a canonical answerKeyOpenedAt`);
    } else {
      if (openedAt <= sealedAt) errors.push(`${result.caseId}/${result.arm} answer key must open after prediction sealing`);
      if (gradedAt <= openedAt) errors.push(`${result.caseId}/${result.arm} grading must occur after answer key access`);
    }
    if (result.answerKeyAccessReceiptDigest === null || !SHA256.test(result.answerKeyAccessReceiptDigest)) {
      errors.push(`${result.caseId}/${result.arm} graded result requires an answer-key access receipt digest`);
    }
    if (result.datasetSplit === "holdout" && result.answerKeyIncludedInInput !== false) {
      errors.push(`${result.caseId}/${result.arm} holdout answer key must remain sealed from the input`);
    }
    for (const [name, value] of [["latencyMs", result.metrics.latencyMs], ["costUsd", result.metrics.costUsd]] as const) {
      if (!Number.isFinite(value) || value < 0) errors.push(`${result.caseId}/${result.arm} ${name} must be non-negative`);
    }
  }

  for (const [caseId, rows] of byCase) {
    const arms = new Set(rows.map((row) => row.arm));
    for (const arm of ARMS) if (!arms.has(arm)) errors.push(`${caseId} missing evaluation arm: ${arm}`);
    for (const arm of ARMS) {
      if (rows.filter((row) => row.arm === arm).length > 1) errors.push(`${caseId} duplicate evaluation arm: ${arm}`);
    }
    const snapshots = new Set(rows.map((row) => row.snapshotDigest));
    if (snapshots.size !== 1) errors.push(`${caseId} arms must use an identical snapshot`);
    const budgets = new Set(rows.map((row) => row.budgetDigest));
    if (budgets.size !== 1) errors.push(`${caseId} arms must use an identical budget`);
    const products = new Set(rows.map((row) => row.product));
    const cohorts = new Set(rows.map((row) => row.cohort));
    const splits = new Set(rows.map((row) => row.datasetSplit));
    if (products.size !== 1 || cohorts.size !== 1 || splits.size !== 1) {
      errors.push(`${caseId} arm metadata must agree`);
    }
  }
  return errors;
}

function rate(values: readonly boolean[]): number | null {
  if (values.length === 0) return null;
  return values.filter(Boolean).length / values.length;
}

export function aggregateCaseArmResults(results: readonly CaseArmResult[]): AggregateMetrics {
  const errors = validateCaseArmCohort(results);
  if (errors.length > 0) throw new Error(`invalid_case_arm_cohort:${errors.join("|")}`);
  const byArm = Object.fromEntries(ARMS.map((arm) => {
    const rows = results.filter((row) => row.arm === arm);
    const metrics = rows.map((row) => row.metrics);
    return [arm, {
      runs: rows.length,
      successRate: rate(metrics.map((value) => value.success)),
      correctAbstentionRate: rate(metrics.map((value) => value.correctAbstention)),
      falseRepairOrMigrationRate: rate(metrics.map((value) => value.falseRepairOrMigration)),
      falseNoImpactRate: rate(metrics.map((value) => value.falseNoImpact)),
      deterministicVerificationPassRate: rate(metrics.map((value) => value.deterministicVerificationPass)),
      rollbackPassRate: rate(metrics.map((value) => value.rollbackPass)),
      tenantIsolationPassRate: rate(metrics.map((value) => value.tenantIsolationPass)),
      replayIdempotencyPassRate: rate(metrics.map((value) => value.replayIdempotencyPass)),
      severeRegressionRate: rate(metrics.map((value) => value.severeRegression)),
      totalCostUsd: metrics.reduce((sum, value) => sum + value.costUsd, 0),
      meanLatencyMs: metrics.length === 0 ? null : metrics.reduce((sum, value) => sum + value.latencyMs, 0) / metrics.length,
    }];
  })) as AggregateMetrics["byArm"];
  return { caseCount: new Set(results.map((row) => row.caseId)).size, runCount: results.length, byArm };
}
