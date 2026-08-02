export const CONFIDENCE_CALIBRATION_VERSION = "2026-08-02.v1" as const;

export type ConfidencePhase =
  | "detection"
  | "path"
  | "edit"
  | "verification"
  | "pull_request"
  | "campaign";

export type ConfidencePhasePolicy = Readonly<{
  phase: ConfidencePhase;
  abstainBelow: number;
  maxExpectedCalibrationError: number;
  maxBrierScore: number;
  minSelectiveAccuracy: number;
  minCoverage: number;
}>;

export type ConfidenceCalibrationSample = Readonly<{
  id: string;
  phase: ConfidencePhase;
  confidence: number;
  correct: boolean;
  abstained: boolean;
  cohortId: string;
  corpusRevision: string;
  snapshotId: string;
  exactCommit: string;
  evidenceRefs: readonly string[];
}>;

export type ConfidenceCalibrationContract = Readonly<{
  version: typeof CONFIDENCE_CALIBRATION_VERSION;
  tenantId: string;
  repositorySnapshot: Readonly<{ id: string; exactCommit: string }>;
  cohort: Readonly<{
    id: string;
    revision: string;
    digest: string;
    split: "held_out" | "training" | "validation";
    createdAt: string;
    trainingCohortIds: readonly string[];
  }>;
  binEdges: readonly number[];
  phases: readonly ConfidencePhasePolicy[];
  samples: readonly ConfidenceCalibrationSample[];
  evidenceRefs: readonly string[];
}>;

export type CalibrationBin = Readonly<{
  lower: number;
  upper: number;
  samples: number;
  meanConfidence: number | null;
  observedAccuracy: number | null;
}>;

export type ConfidencePhaseReport = Readonly<{
  phase: ConfidencePhase;
  samples: number;
  answered: number;
  abstained: number;
  coverage: number;
  selectiveAccuracy: number;
  expectedCalibrationError: number;
  brierScore: number;
  bins: readonly CalibrationBin[];
  accepted: boolean;
  failures: readonly string[];
}>;

export type ConfidenceCalibrationReport = Readonly<{
  version: typeof CONFIDENCE_CALIBRATION_VERSION;
  tenantId: string;
  repositorySnapshot: Readonly<{ id: string; exactCommit: string }>;
  cohort: Readonly<{ id: string; revision: string; digest: string }>;
  evaluatedAt: string;
  phases: readonly ConfidencePhaseReport[];
  accepted: boolean;
  evidenceRefs: readonly string[];
}>;

const PHASES: readonly ConfidencePhase[] = [
  "detection",
  "path",
  "edit",
  "verification",
  "pull_request",
  "campaign",
];
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function fail(message: string): never {
  throw new Error(message);
}

function required(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(message);
  return value.trim();
}

function probability(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(message);
  }
  return value;
}

function references(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(message);
  const result = value.map((entry) => required(entry, message));
  if (new Set(result).size !== result.length) fail(message);
  return result.sort();
}

function parseDate(value: unknown, message: string): number {
  const timestamp = Date.parse(required(value, message));
  if (!Number.isFinite(timestamp)) fail(message);
  return timestamp;
}

function validateBins(edges: readonly number[]): void {
  if (!Array.isArray(edges) || edges.length < 2 || edges[0] !== 0 || edges.at(-1) !== 1) {
    fail("confidence_bins_invalid");
  }
  for (let index = 0; index < edges.length; index++) {
    probability(edges[index], "confidence_bins_invalid");
    if (index > 0 && edges[index]! <= edges[index - 1]!) fail("confidence_bins_invalid");
  }
}

function validatePolicy(policy: ConfidencePhasePolicy): void {
  probability(policy.abstainBelow, "confidence_threshold_unacceptable");
  probability(policy.maxExpectedCalibrationError, "confidence_threshold_unacceptable");
  probability(policy.maxBrierScore, "confidence_threshold_unacceptable");
  probability(policy.minSelectiveAccuracy, "confidence_threshold_unacceptable");
  probability(policy.minCoverage, "confidence_threshold_unacceptable");
  if (
    policy.abstainBelow < 0.5 ||
    policy.maxExpectedCalibrationError > 0.25 ||
    policy.maxBrierScore > 0.25 ||
    policy.minSelectiveAccuracy < 0.7 ||
    policy.minCoverage < 0.1
  ) fail("confidence_threshold_unacceptable");
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calibrationBins(
  samples: readonly ConfidenceCalibrationSample[],
  edges: readonly number[],
): CalibrationBin[] {
  return edges.slice(0, -1).map((lower, index) => {
    const upper = edges[index + 1]!;
    const entries = samples.filter((sample) =>
      sample.confidence >= lower && (upper === 1 ? sample.confidence <= upper : sample.confidence < upper),
    );
    return Object.freeze({
      lower,
      upper,
      samples: entries.length,
      meanConfidence: entries.length ? mean(entries.map((sample) => sample.confidence)) : null,
      observedAccuracy: entries.length ? mean(entries.map((sample) => sample.correct ? 1 : 0)) : null,
    });
  });
}

export function evaluateConfidenceCalibration(
  contract: ConfidenceCalibrationContract,
  options: Readonly<{
    expectedCorpusRevision: string;
    evaluatedAt: string;
    maxCohortAgeMs?: number;
  }>,
): ConfidenceCalibrationReport {
  if (contract.version !== CONFIDENCE_CALIBRATION_VERSION) fail("confidence_contract_version_unsupported");
  const tenantId = required(contract.tenantId, "confidence_tenant_required");
  const snapshotId = required(contract.repositorySnapshot?.id, "confidence_snapshot_required");
  const exactCommit = required(contract.repositorySnapshot?.exactCommit, "confidence_commit_required");
  if (!REVISION.test(exactCommit)) fail("confidence_commit_invalid");
  const cohortId = required(contract.cohort?.id, "confidence_cohort_required");
  if (contract.cohort?.split !== "held_out") fail("confidence_cohort_not_held_out");
  const revision = required(contract.cohort.revision, "confidence_corpus_revision_required");
  if (!REVISION.test(revision)) fail("confidence_corpus_revision_invalid");
  if (revision !== required(options.expectedCorpusRevision, "confidence_expected_revision_required")) {
    fail("confidence_corpus_revision_mismatch");
  }
  if (!DIGEST.test(required(contract.cohort.digest, "confidence_corpus_digest_required"))) {
    fail("confidence_corpus_digest_invalid");
  }
  if (contract.cohort.trainingCohortIds.includes(cohortId)) fail("confidence_cohort_leakage");
  const evaluatedAt = parseDate(options.evaluatedAt, "confidence_evaluated_at_invalid");
  const createdAt = parseDate(contract.cohort.createdAt, "confidence_cohort_created_at_invalid");
  const maxAge = options.maxCohortAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(maxAge) || maxAge <= 0) fail("confidence_max_age_invalid");
  if (createdAt > evaluatedAt || evaluatedAt - createdAt > maxAge) fail("confidence_cohort_stale");
  validateBins(contract.binEdges);
  const evidenceRefs = references(contract.evidenceRefs, "confidence_evidence_required");

  if (!Array.isArray(contract.phases) || contract.phases.length !== PHASES.length) {
    fail("confidence_phase_policy_incomplete");
  }
  const policyByPhase = new Map<ConfidencePhase, ConfidencePhasePolicy>();
  for (const policy of contract.phases) {
    if (!PHASES.includes(policy.phase) || policyByPhase.has(policy.phase)) {
      fail("confidence_phase_policy_incomplete");
    }
    validatePolicy(policy);
    policyByPhase.set(policy.phase, policy);
  }
  if (PHASES.some((phase) => !policyByPhase.has(phase))) fail("confidence_phase_policy_incomplete");
  if (!Array.isArray(contract.samples) || contract.samples.length === 0) fail("confidence_samples_required");

  const sampleIds = new Set<string>();
  for (const sample of contract.samples) {
    const id = required(sample.id, "confidence_sample_id_required");
    if (sampleIds.has(id)) fail("confidence_sample_duplicate");
    sampleIds.add(id);
    if (!PHASES.includes(sample.phase)) fail("confidence_sample_phase_invalid");
    probability(sample.confidence, "confidence_sample_probability_invalid");
    if (typeof sample.correct !== "boolean") fail("confidence_sample_label_required");
    if (typeof sample.abstained !== "boolean") fail("confidence_sample_abstention_required");
    if (sample.cohortId !== cohortId) fail("confidence_sample_cohort_mismatch");
    if (sample.corpusRevision !== revision) fail("confidence_sample_revision_mismatch");
    if (sample.snapshotId !== snapshotId) fail("confidence_sample_snapshot_mismatch");
    if (sample.exactCommit !== exactCommit) fail("confidence_sample_commit_mismatch");
    references(sample.evidenceRefs, "confidence_sample_evidence_required");
    const policy = policyByPhase.get(sample.phase)!;
    if ((sample.confidence < policy.abstainBelow) !== sample.abstained) {
      fail("confidence_abstention_policy_violation");
    }
  }

  const phaseReports = PHASES.map((phase): ConfidencePhaseReport => {
    const policy = policyByPhase.get(phase)!;
    const samples = contract.samples.filter((sample) => sample.phase === phase);
    if (!samples.length) fail("confidence_phase_samples_required");
    const answered = samples.filter((sample) => !sample.abstained);
    const bins = calibrationBins(samples, contract.binEdges);
    const expectedCalibrationError = bins.reduce((sum, bin) => {
      if (bin.samples === 0) return sum;
      return sum + (bin.samples / samples.length) * Math.abs(bin.meanConfidence! - bin.observedAccuracy!);
    }, 0);
    const brierScore = mean(samples.map((sample) => (sample.confidence - (sample.correct ? 1 : 0)) ** 2));
    const coverage = answered.length / samples.length;
    const selectiveAccuracy = answered.length
      ? answered.filter((sample) => sample.correct).length / answered.length
      : 0;
    const failures: string[] = [];
    if (expectedCalibrationError > policy.maxExpectedCalibrationError) failures.push("expected_calibration_error");
    if (brierScore > policy.maxBrierScore) failures.push("brier_score");
    if (selectiveAccuracy < policy.minSelectiveAccuracy) failures.push("selective_accuracy");
    if (coverage < policy.minCoverage) failures.push("coverage");
    return Object.freeze({
      phase,
      samples: samples.length,
      answered: answered.length,
      abstained: samples.length - answered.length,
      coverage,
      selectiveAccuracy,
      expectedCalibrationError,
      brierScore,
      bins: Object.freeze(bins),
      accepted: failures.length === 0,
      failures: Object.freeze(failures),
    });
  });

  return Object.freeze({
    version: CONFIDENCE_CALIBRATION_VERSION,
    tenantId,
    repositorySnapshot: Object.freeze({ id: snapshotId, exactCommit }),
    cohort: Object.freeze({ id: cohortId, revision, digest: contract.cohort.digest }),
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    phases: Object.freeze(phaseReports),
    accepted: phaseReports.every((phase) => phase.accepted),
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}
