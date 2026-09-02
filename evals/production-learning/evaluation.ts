import { createHash } from "node:crypto";
import {
  revalidateSignedAuthorityContext,
  signedAuthorityEnvelopeDigest,
  verifySignedAuthorityEnvelope,
  type SignedAuthorityEnvelope,
  type VerifiedAuthorityContext,
} from "./authority.js";
import { modeledCaseInputDigest } from "./sealing.js";
import { validateExecutionReceipt } from "./schema.js";
import type { LearningCase, ProductionExecutionReceipt, RepositoryProvenance } from "./schema.js";
import { requireVerifiedProductionLearningAuthority, type VerifiedProductionLearningAuthority } from "./preflight.js";

export type EvaluationArm =
  | "production_baseline"
  | "deterministic_recipe"
  | "configured_model_router"
  | "advisory_verifier"
  | "oracle";

export interface EvaluationMetrics {
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
}

export interface CaseArmResult {
  schemaVersion: "mendpoint.case-arm-result.v1";
  caseId: string;
  product: "fettler" | "regauge";
  cohort: "common" | "edge";
  datasetSplit: "development" | "holdout";
  arm: EvaluationArm;
  tenantId: string;
  repositoryProvenanceId: string;
  repositoryCommit: string;
  productionRevision: string;
  snapshotDigest: string;
  fixtureManifestId: string;
  fixtureManifestDigest: string;
  graphVersion: string;
  policyVersion: string;
  model: { provider: string; modelId: string; requestId: string };
  routerVersion: string;
  recipeVersion: string | null;
  consentEvidenceRef: string;
  authorizationRef: string;
  executionDigest: string;
  sandboxReceiptDigest: string;
  trustedProductionReceiptAuthorityDigest: string;
  budgetDigest: string;
  predictionArtifactDigest: string;
  predictionSealedAt: string;
  answerKeyOpenedAt: string | null;
  answerKeyAccessReceiptDigest: string | null;
  gradedAt: string;
  gradingAuthorityDigest: string;
  // sha256 over the canonical serialization of the exact input artifact the arm
  // received, or null when no executor retained one.
  //
  // This replaces the pair of `expectedOutcomeIncludedInInput` /
  // `answerKeyIncludedInInput` booleans. Those were set by the same producer
  // whose leakage they were supposed to rule out, were bound to no content, and
  // were absent from the signed grading payload, so an arm that had actually
  // received the answer key satisfied the anti-leak check by reporting `false`.
  // A two-valued flag also could not express the state this program is really
  // in: no executor exists, so for every case the honest answer is "not yet
  // determined" rather than "no leak". The digest carries all three states —
  // matching the recomputed staged digest, not matching it, and absent — and
  // the validator decides from content rather than from the claim.
  modeledInputArtifactDigest: string | null;
  metrics: EvaluationMetrics;
}

export interface EvaluationGradeAuthorityPayload {
  schemaVersion: "mendpoint.evaluation-grade-authority.v1";
  productionRevision: string;
  caseId: string;
  arm: EvaluationArm;
  tenantId: string;
  repositoryProvenanceId: string;
  repositoryCommit: string;
  snapshotDigest: string;
  fixtureManifestDigest: string;
  executionDigest: string;
  productionReceiptAuthorityDigest: string;
  predictionArtifactDigest: string;
  predictionSealedAt: string;
  answerKeyOpenedAt: string;
  answerKeyAccessReceiptDigest: string;
  gradedAt: string;
  metricsDigest: string;
  // Inside the signed payload, so the Ed25519 signature covers the value the
  // anti-leak determination is made from. The booleans it replaces sat outside
  // this payload entirely, which meant the signature said nothing about whether
  // the arm had seen the answer key.
  modeledInputArtifactDigest: string | null;
}

const VERIFIED_EVALUATION_GRADE_AUTHORITY: unique symbol = Symbol("verified-evaluation-grade-authority");
const verifiedEvaluationGradeAuthorities = new WeakSet<object>();
const evaluationGradeAuthorityContexts = new WeakMap<object, VerifiedAuthorityContext>();
export type VerifiedEvaluationGradeAuthority = Readonly<EvaluationGradeAuthorityPayload> & {
  readonly authorityEnvelopeDigest: string;
  readonly [VERIFIED_EVALUATION_GRADE_AUTHORITY]: true;
};

export interface EvaluationRegistry {
  cases: readonly LearningCase[];
  repositories: readonly RepositoryProvenance[];
  trustedProductionRuns: readonly {
    authority: VerifiedProductionLearningAuthority;
    receipt: ProductionExecutionReceipt;
  }[];
  trustedEvaluationGrades: readonly VerifiedEvaluationGradeAuthority[];
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
const GIT_SHA = /^[0-9a-f]{40}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BOOLEAN_METRICS = [
  "success",
  "correctAbstention",
  "falseRepairOrMigration",
  "falseNoImpact",
  "deterministicVerificationPass",
  "rollbackPass",
  "tenantIsolationPass",
  "replayIdempotencyPass",
  "severeRegression",
] as const;

export function evaluationMetricsDigest(metrics: EvaluationMetrics): string {
  const canonicalMetrics = {
    success: metrics.success,
    correctAbstention: metrics.correctAbstention,
    falseRepairOrMigration: metrics.falseRepairOrMigration,
    falseNoImpact: metrics.falseNoImpact,
    deterministicVerificationPass: metrics.deterministicVerificationPass,
    rollbackPass: metrics.rollbackPass,
    tenantIsolationPass: metrics.tenantIsolationPass,
    replayIdempotencyPass: metrics.replayIdempotencyPass,
    severeRegression: metrics.severeRegression,
    latencyMs: metrics.latencyMs,
    costUsd: metrics.costUsd,
  };
  return createHash("sha256").update(JSON.stringify(canonicalMetrics)).digest("hex");
}

export function verifyEvaluationGradeAuthority(
  envelope: SignedAuthorityEnvelope<EvaluationGradeAuthorityPayload>,
): VerifiedEvaluationGradeAuthority {
  const verifiedEnvelope = verifySignedAuthorityEnvelope(envelope, "evaluation_grading");
  const payload = verifiedEnvelope.payload;
  const errors: string[] = [];
  if (payload.schemaVersion !== "mendpoint.evaluation-grade-authority.v1") errors.push("grading authority schema is invalid");
  if (!ARMS.includes(payload.arm)) errors.push("grading authority arm is invalid");
  if (!GIT_SHA.test(payload.productionRevision) || !GIT_SHA.test(payload.repositoryCommit)) {
    errors.push("grading authority revisions must be git shas");
  }
  for (const [field, value] of [
    ["snapshotDigest", payload.snapshotDigest],
    ["fixtureManifestDigest", payload.fixtureManifestDigest],
    ["executionDigest", payload.executionDigest],
    ["productionReceiptAuthorityDigest", payload.productionReceiptAuthorityDigest],
    ["predictionArtifactDigest", payload.predictionArtifactDigest],
    ["answerKeyAccessReceiptDigest", payload.answerKeyAccessReceiptDigest],
    ["metricsDigest", payload.metricsDigest],
  ] as const) if (!SHA256.test(value)) errors.push(`grading authority ${field} must be sha256`);
  if (payload.modeledInputArtifactDigest !== null && !SHA256.test(payload.modeledInputArtifactDigest)) {
    errors.push("grading authority modeledInputArtifactDigest must be sha256 or null");
  }
  if (payload.arm === "oracle" && payload.modeledInputArtifactDigest !== null) {
    errors.push("grading authority for the oracle arm must not carry a modeled input artifact digest");
  }
  for (const [field, value] of [
    ["caseId", payload.caseId],
    ["tenantId", payload.tenantId],
    ["repositoryProvenanceId", payload.repositoryProvenanceId],
  ] as const) nonEmpty(value, `grading authority ${field}`, errors);
  const sealedAt = Date.parse(payload.predictionSealedAt);
  const openedAt = Date.parse(payload.answerKeyOpenedAt);
  const gradedAt = Date.parse(payload.gradedAt);
  if (![payload.predictionSealedAt, payload.answerKeyOpenedAt, payload.gradedAt].every((value) => UTC_TIMESTAMP.test(value))) {
    errors.push("grading authority chronology must use canonical UTC timestamps");
  }
  if (![sealedAt, openedAt, gradedAt].every(Number.isFinite) || openedAt <= sealedAt || gradedAt <= openedAt) {
    errors.push("grading authority chronology is invalid");
  }
  if (errors.length > 0) throw new Error(`evaluation_grade_authority_invalid:${errors.join("|")}`);
  const token = Object.freeze({
    ...payload,
    authorityEnvelopeDigest: signedAuthorityEnvelopeDigest(envelope),
    [VERIFIED_EVALUATION_GRADE_AUTHORITY]: true,
  }) as VerifiedEvaluationGradeAuthority;
  verifiedEvaluationGradeAuthorities.add(token);
  evaluationGradeAuthorityContexts.set(token, verifiedEnvelope.context);
  return token;
}

export function requireVerifiedEvaluationGradeAuthority(
  authority: VerifiedEvaluationGradeAuthority,
): VerifiedEvaluationGradeAuthority {
  if (!verifiedEvaluationGradeAuthorities.has(authority)) throw new Error("evaluation_grade_authority_not_verified");
  const context = evaluationGradeAuthorityContexts.get(authority);
  if (context === undefined) throw new Error("evaluation_grade_authority_context_missing");
  revalidateSignedAuthorityContext(context);
  return authority;
}

function nonEmpty(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
}

export function validateCaseArmCohort(results: readonly CaseArmResult[], registry: EvaluationRegistry): string[] {
  const errors: string[] = [];
  const byCase = new Map<string, CaseArmResult[]>();
  const casesById = new Map(registry.cases.map((item) => [item.id, item]));
  const repositoriesById = new Map(registry.repositories.map((item) => [item.id, item]));
  const trustedRuns = new Map<string, { authority: VerifiedProductionLearningAuthority; receipt: ProductionExecutionReceipt }>();
  for (const run of registry.trustedProductionRuns) {
    try {
      const authority = requireVerifiedProductionLearningAuthority(run.authority);
      trustedRuns.set(authority.authorityEnvelopeDigest, { authority, receipt: run.receipt });
    } catch {
      errors.push("evaluation registry contains an unverified production authority");
    }
  }
  const trustedGrades = new Map<string, VerifiedEvaluationGradeAuthority>();
  for (const candidate of registry.trustedEvaluationGrades) {
    try {
      const grade = requireVerifiedEvaluationGradeAuthority(candidate);
      trustedGrades.set(grade.authorityEnvelopeDigest, grade);
    } catch {
      errors.push("evaluation registry contains an unverified grading authority");
    }
  }
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
    const prefix = `${result.caseId}/${result.arm}`;
    for (const [path, value] of [
      ["tenantId", result.tenantId],
      ["repositoryProvenanceId", result.repositoryProvenanceId],
      ["fixtureManifestId", result.fixtureManifestId],
      ["graphVersion", result.graphVersion],
      ["policyVersion", result.policyVersion],
      ["model.provider", result.model?.provider],
      ["model.modelId", result.model?.modelId],
      ["model.requestId", result.model?.requestId],
      ["routerVersion", result.routerVersion],
      ["consentEvidenceRef", result.consentEvidenceRef],
      ["authorizationRef", result.authorizationRef],
    ] as const) nonEmpty(value, `${prefix} ${path}`, errors);
    if (result.recipeVersion !== null) nonEmpty(result.recipeVersion, `${prefix} recipeVersion`, errors);
    if (!GIT_SHA.test(result.repositoryCommit)) errors.push(`${prefix} repositoryCommit must be a git sha`);
    if (!GIT_SHA.test(result.productionRevision)) errors.push(`${prefix} productionRevision must be a git sha`);
    if (!SHA256.test(result.snapshotDigest)) errors.push(`${prefix} snapshotDigest must be sha256`);
    if (!SHA256.test(result.fixtureManifestDigest)) errors.push(`${prefix} fixtureManifestDigest must be sha256`);
    if (!SHA256.test(result.executionDigest)) errors.push(`${prefix} executionDigest must be sha256`);
    if (!SHA256.test(result.sandboxReceiptDigest)) errors.push(`${prefix} sandboxReceiptDigest must be sha256`);
    if (!SHA256.test(result.trustedProductionReceiptAuthorityDigest)) errors.push(`${prefix} trustedProductionReceiptAuthorityDigest must be sha256`);
    const trustedRun = trustedRuns.get(result.trustedProductionReceiptAuthorityDigest);
    if (trustedRun === undefined) {
      if (SHA256.test(result.trustedProductionReceiptAuthorityDigest)) {
        errors.push(`${prefix} trustedProductionReceiptAuthorityDigest is not present in the trusted authority registry`);
      }
    } else {
      const { receipt: trustedReceipt, authority } = trustedRun;
      const receiptErrors = validateExecutionReceipt(trustedReceipt);
      if (receiptErrors.length > 0) errors.push(`${prefix} trusted production receipt is invalid: ${receiptErrors.join("|")}`);
      const receiptBindings: Array<[string, unknown, unknown]> = [
        ["caseId", result.caseId, trustedReceipt.caseId],
        ["product", result.product, trustedReceipt.product],
        ["tenantId", result.tenantId, trustedReceipt.tenantId],
        ["repositoryProvenanceId", result.repositoryProvenanceId, trustedReceipt.repositoryId],
        ["repositoryCommit", result.repositoryCommit, trustedReceipt.repositoryCommit],
        ["productionRevision", result.productionRevision, trustedReceipt.productionRevision],
        ["snapshotDigest", result.snapshotDigest, trustedReceipt.snapshotDigest],
        ["fixtureManifestDigest", result.fixtureManifestDigest, trustedReceipt.fixtureManifestDigest],
        ["graphVersion", result.graphVersion, trustedReceipt.graphVersion],
        ["policyVersion", result.policyVersion, trustedReceipt.policyVersion],
        ["model.provider", result.model?.provider, trustedReceipt.model.provider],
        ["model.modelId", result.model?.modelId, trustedReceipt.model.modelId],
        ["model.requestId", result.model?.requestId, trustedReceipt.model.requestId],
        ["routerVersion", result.routerVersion, trustedReceipt.routerVersion],
        ["recipeVersion", result.recipeVersion, trustedReceipt.recipeVersion],
        ["consentEvidenceRef", result.consentEvidenceRef, trustedReceipt.consent.evidenceRef],
        ["authorizationRef", result.authorizationRef, trustedReceipt.authorizationRef],
        ["sandboxReceiptDigest", result.sandboxReceiptDigest, trustedReceipt.sandbox.receiptDigest],
        ["executionDigest", result.executionDigest, trustedReceipt.executionDigest],
        ["budgetDigest", result.budgetDigest, createHash("sha256").update(JSON.stringify(trustedReceipt.budget)).digest("hex")],
      ];
      for (const [field, actual, expected] of receiptBindings) {
        if (actual !== expected) errors.push(`${prefix} ${field} does not match the trusted production receipt`);
      }
      const authorityBindings: Array<[string, unknown, unknown]> = [
        ["caseId", trustedReceipt.caseId, authority.caseId],
        ["product", trustedReceipt.product, authority.product],
        ["productionRevision", trustedReceipt.productionRevision, authority.productionRevision],
        ["tenantId", trustedReceipt.tenantId, authority.tenantId],
        ["repositoryId", trustedReceipt.repositoryId, authority.repositoryId],
        ["repositoryCommit", trustedReceipt.repositoryCommit, authority.repositoryCommit],
        ["snapshotDigest", trustedReceipt.snapshotDigest, authority.snapshotDigest],
        ["fixtureManifestDigest", trustedReceipt.fixtureManifestDigest, authority.fixtureManifestDigest],
        ["graphVersion", trustedReceipt.graphVersion, authority.graphVersion],
        ["policyVersion", trustedReceipt.policyVersion, authority.policyVersion],
        ["model.provider", trustedReceipt.model.provider, authority.modelProvider],
        ["model.modelId", trustedReceipt.model.modelId, authority.modelId],
        ["routerVersion", trustedReceipt.routerVersion, authority.routerVersion],
        ["recipeVersion", trustedReceipt.recipeVersion, authority.recipeVersion],
        ["consentEvidenceRef", trustedReceipt.consent.evidenceRef, authority.consentEvidenceRef],
        ["authorizationRef", trustedReceipt.authorizationRef, authority.authorizationRef],
        ["sandboxReceiptDigest", trustedReceipt.sandbox.receiptDigest, authority.sandboxReceiptDigest],
        ["executionDigest", trustedReceipt.executionDigest, authority.executionDigest],
      ];
      for (const [field, actual, expected] of authorityBindings) {
        if (actual !== expected) errors.push(`${prefix} production receipt ${field} does not match verified authority`);
      }
    }
    if (!SHA256.test(result.budgetDigest)) errors.push(`${result.caseId}/${result.arm} budgetDigest must be sha256`);
    if (!SHA256.test(result.predictionArtifactDigest)) errors.push(`${result.caseId}/${result.arm} predictionArtifactDigest must be sha256`);
    if (result.modeledInputArtifactDigest !== null && !SHA256.test(result.modeledInputArtifactDigest)) {
      errors.push(`${result.caseId}/${result.arm} modeledInputArtifactDigest must be sha256 or null`);
    }
    // The oracle arm is entitled to the answer key, so no leak-free input digest
    // applies to it and presenting one would be a false claim about which
    // artifact it consumed.
    if (result.arm === "oracle" && result.modeledInputArtifactDigest !== null) {
      errors.push(`${result.caseId}/${result.arm} oracle arm must not present a modeled input artifact digest`);
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
    if (!SHA256.test(result.gradingAuthorityDigest)) {
      errors.push(`${prefix} gradingAuthorityDigest must be sha256`);
    }
    const trustedGrade = trustedGrades.get(result.gradingAuthorityDigest);
    if (trustedGrade === undefined) {
      if (SHA256.test(result.gradingAuthorityDigest)) {
        errors.push(`${prefix} gradingAuthorityDigest is not present in the trusted grading registry`);
      }
    } else {
      const gradeBindings: Array<[string, unknown, unknown]> = [
        ["caseId", result.caseId, trustedGrade.caseId],
        ["arm", result.arm, trustedGrade.arm],
        ["tenantId", result.tenantId, trustedGrade.tenantId],
        ["repositoryProvenanceId", result.repositoryProvenanceId, trustedGrade.repositoryProvenanceId],
        ["repositoryCommit", result.repositoryCommit, trustedGrade.repositoryCommit],
        ["productionRevision", result.productionRevision, trustedGrade.productionRevision],
        ["snapshotDigest", result.snapshotDigest, trustedGrade.snapshotDigest],
        ["fixtureManifestDigest", result.fixtureManifestDigest, trustedGrade.fixtureManifestDigest],
        ["executionDigest", result.executionDigest, trustedGrade.executionDigest],
        ["trustedProductionReceiptAuthorityDigest", result.trustedProductionReceiptAuthorityDigest, trustedGrade.productionReceiptAuthorityDigest],
        ["predictionArtifactDigest", result.predictionArtifactDigest, trustedGrade.predictionArtifactDigest],
        ["predictionSealedAt", result.predictionSealedAt, trustedGrade.predictionSealedAt],
        ["answerKeyOpenedAt", result.answerKeyOpenedAt, trustedGrade.answerKeyOpenedAt],
        ["answerKeyAccessReceiptDigest", result.answerKeyAccessReceiptDigest, trustedGrade.answerKeyAccessReceiptDigest],
        ["gradedAt", result.gradedAt, trustedGrade.gradedAt],
        ["metricsDigest", evaluationMetricsDigest(result.metrics), trustedGrade.metricsDigest],
        ["modeledInputArtifactDigest", result.modeledInputArtifactDigest, trustedGrade.modeledInputArtifactDigest],
      ];
      for (const [field, actual, expected] of gradeBindings) {
        if (actual !== expected) errors.push(`${prefix} ${field} does not match the trusted grading authority`);
      }
    }
    for (const metric of BOOLEAN_METRICS) {
      if (typeof result.metrics[metric] !== "boolean") errors.push(`${prefix} metrics.${metric} must be boolean`);
    }
    for (const [name, value] of [["latencyMs", result.metrics.latencyMs], ["costUsd", result.metrics.costUsd]] as const) {
      if (!Number.isFinite(value) || value < 0) errors.push(`${result.caseId}/${result.arm} ${name} must be non-negative`);
    }

    const learningCase = casesById.get(result.caseId);
    if (learningCase === undefined) {
      errors.push(`${prefix} caseId is not present in the case registry`);
    } else {
      if (result.product !== learningCase.product || result.cohort !== learningCase.cohort || result.datasetSplit !== learningCase.datasetSplit) {
        errors.push(`${prefix} metadata does not match the case registry`);
      }
      if (result.repositoryProvenanceId !== learningCase.repository.provenanceId) {
        errors.push(`${prefix} repositoryProvenanceId does not match the case registry`);
      }
      if (result.fixtureManifestId !== learningCase.fixture.manifestId) {
        errors.push(`${prefix} fixtureManifestId does not match the case registry`);
      }
      // Content-derived answer-key exposure determination for the modeled arms.
      // The validator recomputes the digest of the only leak-free input the arm
      // was allowed to receive and compares it to the digest of the artifact the
      // arm actually received. A mismatch means the arm consumed something other
      // than the staged input, so absence of the answer key cannot be concluded;
      // a null digest means no input artifact was retained, which is the
      // undetermined third state and also fails closed. Neither outcome can be
      // talked out of by the producer, because neither reads a producer-set
      // claim about leakage.
      if (result.arm !== "oracle") {
        if (result.modeledInputArtifactDigest === null) {
          errors.push(
            `${prefix} modeled input artifact digest is not retained, so answer-key exposure cannot be determined`,
          );
        } else if (result.modeledInputArtifactDigest !== modeledCaseInputDigest(learningCase, result.arm)) {
          errors.push(
            `${prefix} modeled input artifact does not match the sealed leak-free staged input for this case and arm`,
          );
        }
      }
    }
    const repository = repositoriesById.get(result.repositoryProvenanceId);
    if (repository === undefined) {
      errors.push(`${prefix} repositoryProvenanceId is not present in the provenance registry`);
    } else if (result.repositoryCommit !== repository.immutableCommit) {
      errors.push(`${prefix} repositoryCommit does not match the provenance registry`);
    }
  }

  for (const learningCase of registry.cases) {
    const caseId = learningCase.id;
    const rows = byCase.get(caseId) ?? [];
    const arms = new Set(rows.map((row) => row.arm));
    for (const arm of ARMS) if (!arms.has(arm)) errors.push(`${caseId} missing evaluation arm: ${arm}`);
    for (const arm of ARMS) {
      if (rows.filter((row) => row.arm === arm).length > 1) errors.push(`${caseId} duplicate evaluation arm: ${arm}`);
    }
    if (rows.length === 0) continue;
    const snapshots = new Set(rows.map((row) => row.snapshotDigest));
    if (snapshots.size !== 1) errors.push(`${caseId} arms must use an identical snapshot`);
    const budgets = new Set(rows.map((row) => row.budgetDigest));
    if (budgets.size !== 1) errors.push(`${caseId} arms must use an identical budget`);
    for (const [name, values] of [
      ["tenant", rows.map((row) => row.tenantId)],
      ["repository provenance", rows.map((row) => row.repositoryProvenanceId)],
      ["repository commit", rows.map((row) => row.repositoryCommit)],
      ["production revision", rows.map((row) => row.productionRevision)],
      ["fixture manifest", rows.map((row) => row.fixtureManifestId)],
      ["fixture manifest digest", rows.map((row) => row.fixtureManifestDigest)],
      ["graph version", rows.map((row) => row.graphVersion)],
      ["policy version", rows.map((row) => row.policyVersion)],
      ["consent evidence", rows.map((row) => row.consentEvidenceRef)],
      ["authorization", rows.map((row) => row.authorizationRef)],
    ] as const) {
      if (new Set(values).size !== 1) errors.push(`${caseId} arms must use an identical ${name}`);
    }
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

export function aggregateCaseArmResults(results: readonly CaseArmResult[], registry: EvaluationRegistry): AggregateMetrics {
  const errors = validateCaseArmCohort(results, registry);
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
