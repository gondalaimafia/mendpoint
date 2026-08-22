import type { LearningCorpusExample } from "@mendpoint/db";

// ---------------------------------------------------------------------------
// Cross-run confidence calibration report.
//
// Calibration asks a distribution-level question: when the model says it is 80%
// confident, does roughly 80% of that cohort get accepted? It CANNOT be answered
// per event and it is NOT an outcome attribution -- it is a property of the whole
// (confidence, decision) distribution across many runs. This module computes it
// as a pure function over the (confidence, human-decision) pairs that the legacy
// learning path already stores on BOTH arms:
//
//   - Approved arm: admitApprovedOutcomeLearningRecord persists the approved
//     outcome with `confidence` and an "accepted" decision
//     (apps/worker/src/transformer-learning-producer.ts).
//   - Rejected arm: admitRejectedOutcomeLearningRecord persists the same
//     change-spec labeled `decision: "rejected"`, same confidence field
//     (apps/worker/src/transformer-learning-rejected.ts).
//
// It lives in @mendpoint/pipeline (alongside the other learning/post-training
// read paths: learning-operations, post-trained-*) because the pipeline package
// already depends on @mendpoint/db, so the corpus-example adapter below is a
// type-only import that is erased at runtime. The core math takes plain
// observations and has no runtime dependency at all.
//
// HONESTY, enforced in the types below rather than in prose:
//   - The outcome variable is the HUMAN REVIEWER'S accept/reject decision, NOT
//     correctness. Both arms passed the same deterministic verification (sealing
//     forces the stored verification to passed), so this calibrates confidence
//     against reviewer taste, never against ground-truth correctness. That fact
//     is carried in a fixed `outcomeSemantics` field so any renderer must show it.
//   - The confidence is the model's own self-score with no independent
//     assessment; carried in a fixed `confidenceSource` field for the same reason.
//   - A bucket with too few observations is reported as `insufficient_data` -- a
//     variant that literally has no rate field -- so small-N can never be read as
//     a rate. Empty input yields an explicit `no_data` report, never zeros that
//     would read as "perfectly calibrated".
//
// It emits NO `calibration` learning attribution and touches no producer code.
// It is report-only.
// ---------------------------------------------------------------------------

/** The human reviewer's decision on a candidate. */
export type CalibrationDecision = "accepted" | "rejected";

/**
 * One (confidence, decision) pair. `confidence` is the model's self-reported
 * whole-number percentage 0..100 (Transformer review self-score; see
 * packages/transformer/src/adaptive-candidate.ts). The two arms are merged into a
 * single stream of these, because calibration is a property of the full
 * accept-and-reject distribution, not of either arm alone.
 */
export type CalibrationObservation = Readonly<{
  confidence: number;
  decision: CalibrationDecision;
}>;

/**
 * Bucket edges in percent. Ten uniform-width deciles: [0,10), [10,20), ...,
 * [80,90), [90,100]. Rationale for the design:
 *   - Uniform width makes the reliability curve directly readable -- each bucket
 *     is the same slice of the confidence axis, so observed-vs-expected can be
 *     compared bucket to bucket without reweighting.
 *   - Decile resolution is the conventional granularity for a reliability diagram:
 *     fine enough to see a miscalibration trend, coarse enough that a real corpus
 *     puts a usable number of observations in a populated bucket.
 * The final bucket [90,100] is closed on both ends so a perfect 100 self-score
 * lands somewhere; every other bucket is half-open [lo, hi).
 */
export const CALIBRATION_BUCKET_EDGES: readonly number[] = Object.freeze([
  0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100,
]);

/**
 * Minimum observations for a bucket to report a rate. Below this floor the bucket
 * is `insufficient_data`, never a rate. Rationale: an acceptance rate is a
 * binomial proportion, and its standard error is sqrt(p(1-p)/n). At n=20 the
 * worst-case (p=0.5) standard error is ~0.11, so a reported rate is at least
 * distinguishable from noise; below ~20 a single flipped decision moves the rate
 * by more than 5 points and the "rate" is dominated by sampling noise rather than
 * signal. 20 is a deliberately conservative, round floor, not a derived optimum;
 * a caller can override it (see CalibrationReportOptions) but the default refuses
 * to dress up a handful of reviews as a calibration curve.
 */
export const MIN_BUCKET_OBSERVATIONS = 20 as const;

/**
 * The outcome variable is the human reviewer's decision, NOT correctness. Fixed,
 * literal-typed so a renderer cannot drop or soften it.
 */
export const CALIBRATION_OUTCOME_SEMANTICS = "reviewer_decision" as const;

/** The confidence is the model's own self-score, with no independent assessment. */
export const CALIBRATION_CONFIDENCE_SOURCE = "model_self_reported" as const;

export type CalibrationHonesty = Readonly<{
  outcomeSemantics: typeof CALIBRATION_OUTCOME_SEMANTICS;
  /** Human-readable expansion of {@link CALIBRATION_OUTCOME_SEMANTICS}. */
  outcomeSemanticsDetail: string;
  confidenceSource: typeof CALIBRATION_CONFIDENCE_SOURCE;
  /** Human-readable expansion of {@link CALIBRATION_CONFIDENCE_SOURCE}. */
  confidenceSourceDetail: string;
}>;

const HONESTY: CalibrationHonesty = Object.freeze({
  outcomeSemantics: CALIBRATION_OUTCOME_SEMANTICS,
  outcomeSemanticsDetail:
    "Outcome is the human reviewer's accept/reject decision, not correctness. " +
    "Both arms passed the same deterministic verification, so this measures " +
    "confidence against reviewer taste, not against ground truth.",
  confidenceSource: CALIBRATION_CONFIDENCE_SOURCE,
  confidenceSourceDetail:
    "Confidence is the model's own self-reported score (0..100); no independent " +
    "assessment of the change was made.",
});

export type CalibrationBucketRange = Readonly<{
  /** Inclusive lower bound, percent. */
  lowerInclusive: number;
  /** Upper bound, percent. */
  upperBound: number;
  /** Whether {@link upperBound} is inclusive (true only for the final bucket). */
  upperInclusive: boolean;
}>;

/**
 * One confidence bucket. A discriminated union: the `insufficient_data` variant
 * deliberately carries NO rate fields, so a renderer physically cannot read an
 * acceptance rate off a bucket that did not clear the floor.
 */
export type CalibrationBucket =
  | Readonly<{
      status: "insufficient_data";
      range: CalibrationBucketRange;
      count: number;
      acceptedCount: number;
    }>
  | Readonly<{
      status: "ok";
      range: CalibrationBucketRange;
      count: number;
      acceptedCount: number;
      /** acceptedCount / count, 0..1. */
      observedAcceptanceRate: number;
      /** Mean self-confidence in the bucket as a probability, 0..1. */
      expectedAcceptanceRate: number;
      /** observedAcceptanceRate - expectedAcceptanceRate (signed). */
      calibrationGap: number;
      /** Mean self-confidence in the bucket, percent. */
      meanConfidence: number;
    }>;

export type CalibrationSummary = Readonly<{
  totalObservations: number;
  acceptedObservations: number;
  /** acceptedObservations / totalObservations, 0..1. */
  overallObservedAcceptanceRate: number;
  /** Mean self-confidence across all observations, percent. */
  overallMeanConfidence: number;
  /**
   * Brier score over ALL observations: mean of (confidence/100 - outcome)^2 with
   * outcome 1 for accepted, 0 for rejected. Per-event and bucket-free, so the
   * floor does not apply. Lower is better; 0 is perfect.
   */
  brierScore: number;
  /**
   * Expected calibration error computed ONLY over buckets that clear the floor:
   * the observation-weighted mean of |observed - expected| across `ok` buckets.
   * Below-floor observations are excluded (and counted in observationsBelowFloor)
   * rather than folded in with an unreportable rate.
   */
  expectedCalibrationError: number;
  /** Observations that fell into below-floor buckets and are excluded from ECE. */
  observationsBelowFloor: number;
  /** Number of buckets that cleared the floor. */
  reportableBuckets: number;
}>;

/**
 * The calibration report. A discriminated union so empty input is an explicit
 * `no_data` report rather than a zero-filled `ok` report that would read as
 * "perfectly calibrated". Both variants carry the honesty fields so every
 * renderer surfaces them.
 */
export type CalibrationReport =
  | Readonly<{
      status: "no_data";
      honesty: CalibrationHonesty;
      minBucketObservations: number;
      bucketEdges: readonly number[];
    }>
  | Readonly<{
      status: "ok";
      honesty: CalibrationHonesty;
      minBucketObservations: number;
      bucketEdges: readonly number[];
      buckets: readonly CalibrationBucket[];
      summary: CalibrationSummary;
    }>;

export type CalibrationReportOptions = Readonly<{
  /**
   * Override the small-N floor. Defaults to {@link MIN_BUCKET_OBSERVATIONS}. A
   * value of 1 makes every non-empty bucket reportable (used by the
   * delete-the-check test to prove the floor is load-bearing).
   */
  minBucketObservations?: number;
}>;

/** Round to `digits` decimal places without carrying float noise into the JSON. */
function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Bucket index for a confidence. Confidence is guaranteed 0..100 by the producers;
 * the clamp keeps a stray value inside the decile array rather than throwing, and
 * folds a perfect 100 into the final [90,100] bucket.
 */
function bucketIndexFor(confidence: number): number {
  const raw = Math.floor(confidence / 10);
  const lastIndex = CALIBRATION_BUCKET_EDGES.length - 2; // number of buckets - 1
  return Math.min(lastIndex, Math.max(0, raw));
}

function rangeFor(index: number): CalibrationBucketRange {
  const lastIndex = CALIBRATION_BUCKET_EDGES.length - 2;
  return Object.freeze({
    lowerInclusive: CALIBRATION_BUCKET_EDGES[index],
    upperBound: CALIBRATION_BUCKET_EDGES[index + 1],
    upperInclusive: index === lastIndex,
  });
}

/**
 * Compute the cross-run calibration report from merged (confidence, decision)
 * observations of BOTH arms. Pure: no I/O, no clock, no mutation of the input.
 */
export function computeCalibrationReport(
  observations: readonly CalibrationObservation[],
  options: CalibrationReportOptions = {},
): CalibrationReport {
  const floor = options.minBucketObservations ?? MIN_BUCKET_OBSERVATIONS;

  if (observations.length === 0) {
    return Object.freeze({
      status: "no_data",
      honesty: HONESTY,
      minBucketObservations: floor,
      bucketEdges: CALIBRATION_BUCKET_EDGES,
    });
  }

  const bucketCount = CALIBRATION_BUCKET_EDGES.length - 1;
  const counts = new Array<number>(bucketCount).fill(0);
  const accepted = new Array<number>(bucketCount).fill(0);
  const confidenceSum = new Array<number>(bucketCount).fill(0);

  let totalAccepted = 0;
  let confidenceSumAll = 0;
  let brierSum = 0;

  for (const observation of observations) {
    const index = bucketIndexFor(observation.confidence);
    const isAccepted = observation.decision === "accepted";
    counts[index] += 1;
    confidenceSum[index] += observation.confidence;
    confidenceSumAll += observation.confidence;
    const outcome = isAccepted ? 1 : 0;
    if (isAccepted) {
      accepted[index] += 1;
      totalAccepted += 1;
    }
    const probability = observation.confidence / 100;
    brierSum += (probability - outcome) ** 2;
  }

  let observationsBelowFloor = 0;
  let reportableBuckets = 0;
  let eceWeightedSum = 0;
  let eceObservations = 0;

  const buckets: CalibrationBucket[] = counts.map((count, index) => {
    const range = rangeFor(index);
    if (count < floor) {
      observationsBelowFloor += count;
      return Object.freeze({
        status: "insufficient_data" as const,
        range,
        count,
        acceptedCount: accepted[index],
      });
    }
    const observedAcceptanceRate = accepted[index] / count;
    const meanConfidence = confidenceSum[index] / count;
    const expectedAcceptanceRate = meanConfidence / 100;
    reportableBuckets += 1;
    eceWeightedSum += Math.abs(observedAcceptanceRate - expectedAcceptanceRate) * count;
    eceObservations += count;
    return Object.freeze({
      status: "ok" as const,
      range,
      count,
      acceptedCount: accepted[index],
      observedAcceptanceRate: round(observedAcceptanceRate, 4),
      expectedAcceptanceRate: round(expectedAcceptanceRate, 4),
      calibrationGap: round(observedAcceptanceRate - expectedAcceptanceRate, 4),
      meanConfidence: round(meanConfidence, 2),
    });
  });

  const total = observations.length;
  const summary: CalibrationSummary = Object.freeze({
    totalObservations: total,
    acceptedObservations: totalAccepted,
    overallObservedAcceptanceRate: round(totalAccepted / total, 4),
    overallMeanConfidence: round(confidenceSumAll / total, 2),
    brierScore: round(brierSum / total, 4),
    expectedCalibrationError:
      eceObservations === 0 ? 0 : round(eceWeightedSum / eceObservations, 4),
    observationsBelowFloor,
    reportableBuckets,
  });

  return Object.freeze({
    status: "ok",
    honesty: HONESTY,
    minBucketObservations: floor,
    bucketEdges: CALIBRATION_BUCKET_EDGES,
    buckets: Object.freeze(buckets),
    summary,
  });
}

/**
 * Adapt exported corpus examples (either arm) into calibration observations. A
 * type-only import of {@link LearningCorpusExample}, so no runtime dependency is
 * added. The corpus already carries the reviewer decision and the model's
 * self-confidence on `labels`, so the two arms merge by simple concatenation.
 */
export function observationsFromCorpusExamples(
  examples: readonly LearningCorpusExample[],
): CalibrationObservation[] {
  return examples.map((example) =>
    Object.freeze({
      confidence: example.labels.confidence,
      decision: example.labels.decision,
    }),
  );
}

/** Format a percent (0..1 rate) for the readable table. */
function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/** A small, human-readable table of the report. JSON stays the machine format. */
export function formatCalibrationReport(report: CalibrationReport): string {
  const header = [
    `outcome semantics: ${report.honesty.outcomeSemantics} (${report.honesty.outcomeSemanticsDetail})`,
    `confidence source: ${report.honesty.confidenceSource} (${report.honesty.confidenceSourceDetail})`,
    `min bucket observations (floor): ${report.minBucketObservations}`,
  ];

  if (report.status === "no_data") {
    return [...header, "", "no data: no observations on either arm"].join("\n");
  }

  const rows = report.buckets.map((bucket) => {
    const label = `[${bucket.range.lowerInclusive},${bucket.range.upperBound}${
      bucket.range.upperInclusive ? "]" : ")"
    }`.padEnd(9);
    if (bucket.status === "insufficient_data") {
      return `${label} n=${String(bucket.count).padStart(5)}  insufficient_data`;
    }
    const observed = pct(bucket.observedAcceptanceRate).padStart(7);
    const expected = pct(bucket.expectedAcceptanceRate).padStart(7);
    const gap = `${bucket.calibrationGap >= 0 ? "+" : ""}${pct(bucket.calibrationGap)}`.padStart(8);
    return `${label} n=${String(bucket.count).padStart(5)}  observed=${observed}  expected=${expected}  gap=${gap}`;
  });

  const summary = [
    "",
    `observations:      ${report.summary.totalObservations} (accepted ${report.summary.acceptedObservations})`,
    `overall accepted:  ${pct(report.summary.overallObservedAcceptanceRate)}`,
    `overall confidence: ${report.summary.overallMeanConfidence.toFixed(2)}%`,
    `brier score:       ${report.summary.brierScore.toFixed(4)} (lower is better)`,
    `expected calibration error (reportable buckets only): ${report.summary.expectedCalibrationError.toFixed(4)}`,
    `reportable buckets: ${report.summary.reportableBuckets}`,
    `observations below floor (excluded from ECE): ${report.summary.observationsBelowFloor}`,
  ];

  return [...header, "", "bucket    count     observed / expected / gap", ...rows, ...summary].join("\n");
}
