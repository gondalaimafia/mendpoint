export const WARDEN_METRICS_VERSION = "2026-08-02.v1" as const;

export type WardenMetricObservation = Readonly<{
  taskId: string;
  detectionAt: string;
  firstDraftPrAt: string | null;
  impact: Readonly<{ truePositive: number; falsePositive: number; falseNegative: number }>;
  generatedBytes: number;
  reviewerEditedBytes: number;
  accepted: boolean;
  regressionDetected: boolean;
  manualBaselineMinutes: number;
  actualMinutes: number;
  incidentPrevention: Readonly<{
    confirmed: boolean;
    evidenceRefs: readonly string[];
  }>;
  evidenceRefs: readonly string[];
}>;

export type WardenMetricsInput = Readonly<{
  version: typeof WARDEN_METRICS_VERSION;
  cohort: Readonly<{ id: string; revision: string; digest: string }>;
  observations: readonly WardenMetricObservation[];
}>;

export type WardenMetricsReport = Readonly<{
  version: typeof WARDEN_METRICS_VERSION;
  cohortId: string;
  cohortRevision: string;
  cohortDigest: string;
  taskCount: number;
  detectionToFirstPrMinutes: Readonly<{ measured: number; median: number | null }>;
  verifiedImpactPrecision: number | null;
  verifiedImpactRecall: number | null;
  reviewerEditDelta: number | null;
  acceptedRegressionRate: number | null;
  hoursSaved: number;
  confirmedPreventedIncidents: number;
  evidenceRefs: readonly string[];
}>;

const ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function fail(code: string): never {
  throw new Error(code);
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("warden_metric_time_invalid");
  return parsed;
}

function nonnegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
}

function nonnegative(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0) fail(code);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function calculateWardenMetrics(input: WardenMetricsInput): WardenMetricsReport {
  if (input.version !== WARDEN_METRICS_VERSION) fail("warden_metric_version_invalid");
  if (!ID.test(input.cohort.id)) fail("warden_metric_cohort_id_invalid");
  if (!REVISION.test(input.cohort.revision)) fail("warden_metric_revision_invalid");
  if (!DIGEST.test(input.cohort.digest)) fail("warden_metric_digest_invalid");
  if (!Array.isArray(input.observations) || input.observations.length === 0) fail("warden_metric_observations_required");

  const taskIds = new Set<string>();
  const evidenceRefs = new Set<string>();
  const detectionMinutes: number[] = [];
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let generatedBytes = 0;
  let reviewerEditedBytes = 0;
  let accepted = 0;
  let acceptedRegressions = 0;
  let minutesSaved = 0;
  let preventedIncidents = 0;

  for (const observation of input.observations) {
    if (!ID.test(observation.taskId)) fail("warden_metric_task_id_invalid");
    if (taskIds.has(observation.taskId)) fail("warden_metric_task_duplicate");
    taskIds.add(observation.taskId);
    const detectedAt = timestamp(observation.detectionAt);
    if (observation.firstDraftPrAt !== null) {
      const openedAt = timestamp(observation.firstDraftPrAt);
      if (openedAt < detectedAt) fail("warden_metric_pr_before_detection");
      detectionMinutes.push((openedAt - detectedAt) / 60_000);
    }
    for (const count of [
      observation.impact.truePositive,
      observation.impact.falsePositive,
      observation.impact.falseNegative,
    ]) {
      nonnegativeInteger(count, "warden_metric_impact_count_invalid");
    }
    nonnegativeInteger(observation.generatedBytes, "warden_metric_generated_bytes_invalid");
    nonnegativeInteger(observation.reviewerEditedBytes, "warden_metric_reviewer_bytes_invalid");
    if (observation.reviewerEditedBytes > 0 && observation.generatedBytes === 0) {
      fail("warden_metric_reviewer_delta_unattributable");
    }
    nonnegative(observation.manualBaselineMinutes, "warden_metric_manual_baseline_invalid");
    nonnegative(observation.actualMinutes, "warden_metric_actual_minutes_invalid");
    if (!Array.isArray(observation.evidenceRefs) || observation.evidenceRefs.length === 0 ||
      observation.evidenceRefs.some((reference: string) => !reference.trim())) fail("warden_metric_evidence_required");
    if (observation.incidentPrevention.confirmed &&
      (!Array.isArray(observation.incidentPrevention.evidenceRefs) ||
        observation.incidentPrevention.evidenceRefs.length === 0 ||
        observation.incidentPrevention.evidenceRefs.some((reference: string) => !reference.trim()))) {
      fail("warden_metric_incident_confirmation_required");
    }
    truePositive += observation.impact.truePositive;
    falsePositive += observation.impact.falsePositive;
    falseNegative += observation.impact.falseNegative;
    generatedBytes += observation.generatedBytes;
    reviewerEditedBytes += observation.reviewerEditedBytes;
    if (observation.accepted) {
      accepted += 1;
      if (observation.regressionDetected) acceptedRegressions += 1;
    }
    minutesSaved += Math.max(0, observation.manualBaselineMinutes - observation.actualMinutes);
    if (observation.incidentPrevention.confirmed) preventedIncidents += 1;
    for (const reference of [...observation.evidenceRefs, ...observation.incidentPrevention.evidenceRefs]) {
      evidenceRefs.add(reference);
    }
  }

  return Object.freeze({
    version: WARDEN_METRICS_VERSION,
    cohortId: input.cohort.id,
    cohortRevision: input.cohort.revision,
    cohortDigest: input.cohort.digest,
    taskCount: taskIds.size,
    detectionToFirstPrMinutes: Object.freeze({ measured: detectionMinutes.length, median: median(detectionMinutes) }),
    verifiedImpactPrecision: ratio(truePositive, truePositive + falsePositive),
    verifiedImpactRecall: ratio(truePositive, truePositive + falseNegative),
    reviewerEditDelta: ratio(reviewerEditedBytes, generatedBytes),
    acceptedRegressionRate: ratio(acceptedRegressions, accepted),
    hoursSaved: minutesSaved / 60,
    confirmedPreventedIncidents: preventedIncidents,
    evidenceRefs: Object.freeze([...evidenceRefs].sort()),
  });
}
