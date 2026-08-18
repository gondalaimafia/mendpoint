import type { VerifierProduct } from "./types.js";
import { canonicalJson, codeUnitCompare, deepFreeze, fail, identifier, sha256 } from "./utils.js";

export type VerifierCalibrationObservation = Readonly<{
  observationId: string;
  product: VerifierProduct;
  taskFamily: string;
  score: number;
  correct: boolean;
}>;
export type VerifierCalibrationReport = Readonly<{
  schemaVersion: "2026-08-17.calibration.v1";
  observationCount: number;
  brierScore: number;
  expectedCalibrationError: number;
  falseConfidenceObservationIds: readonly string[];
  falseNegativeObservationIds: readonly string[];
  buckets: readonly Readonly<{ lower: number; upper: number; count: number; meanScore: number; accuracy: number }>[];
  reportDigest: string;
}>;

export function buildVerifierCalibrationReport(input: readonly VerifierCalibrationObservation[]): VerifierCalibrationReport {
  if (!Array.isArray(input) || !input.length || input.length > 100_000) fail("verifier_calibration_observations_invalid");
  const observations = input.map((item) => {
    const observationId = identifier(item.observationId, "verifier_calibration_id_invalid");
    identifier(item.taskFamily, "verifier_calibration_task_family_invalid");
    if (item.product !== "fettler" && item.product !== "regauge") fail("verifier_calibration_product_invalid");
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1 || typeof item.correct !== "boolean") fail("verifier_calibration_observation_invalid");
    return { ...item, observationId };
  });
  if (new Set(observations.map(({ observationId }) => observationId)).size !== observations.length) fail("verifier_calibration_id_duplicate");
  const brierScore = observations.reduce((total, item) => total + (item.score - Number(item.correct)) ** 2, 0) / observations.length;
  const buckets = Array.from({ length: 10 }, (_unused, index) => {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const values = observations.filter(({ score }) => score >= lower && (index === 9 ? score <= upper : score < upper));
    return {
      lower,
      upper,
      count: values.length,
      meanScore: values.length ? values.reduce((total, item) => total + item.score, 0) / values.length : 0,
      accuracy: values.length ? values.filter(({ correct }) => correct).length / values.length : 0,
    };
  });
  const expectedCalibrationError = buckets.reduce((total, bucket) => total + (bucket.count / observations.length) * Math.abs(bucket.meanScore - bucket.accuracy), 0);
  const falseConfidenceObservationIds = observations.filter(({ score, correct }) => score >= 0.8 && !correct).map(({ observationId }) => observationId).sort(codeUnitCompare);
  const falseNegativeObservationIds = observations.filter(({ score, correct }) => score <= 0.2 && correct).map(({ observationId }) => observationId).sort(codeUnitCompare);
  const base = { schemaVersion: "2026-08-17.calibration.v1" as const, observationCount: observations.length, brierScore, expectedCalibrationError, falseConfidenceObservationIds: Object.freeze(falseConfidenceObservationIds), falseNegativeObservationIds: Object.freeze(falseNegativeObservationIds), buckets: Object.freeze(buckets) };
  return deepFreeze({ ...base, reportDigest: sha256(canonicalJson(base)) });
}
