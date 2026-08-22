import { describe, expect, it } from "vitest";
import {
  CALIBRATION_BUCKET_EDGES,
  MIN_BUCKET_OBSERVATIONS,
  computeCalibrationReport,
  formatCalibrationReport,
  observationsFromCorpusExamples,
  type CalibrationObservation,
} from "./calibration-report.js";

/** Build `count` observations at `confidence`, the first `acceptedCount` accepted. */
function obs(
  confidence: number,
  count: number,
  acceptedCount: number,
): CalibrationObservation[] {
  return Array.from({ length: count }, (_unused, index) => ({
    confidence,
    decision: index < acceptedCount ? ("accepted" as const) : ("rejected" as const),
  }));
}

describe("computeCalibrationReport", () => {
  it("computes per-bucket observed/expected rates and gaps on a known fixture", () => {
    // Floor removed so both small buckets are reportable; math is the subject here.
    const observations = [
      ...obs(90, 4, 3), // [90,100] bucket: observed 3/4, meanConf 90, expected 0.90
      ...obs(0, 2, 0), // [0,10) bucket: observed 0/2, expected 0.00
    ];
    const report = computeCalibrationReport(observations, { minBucketObservations: 1 });
    expect(report.status).toBe("ok");
    if (report.status !== "ok") throw new Error("unreachable");

    const top = report.buckets[9];
    expect(top.range).toEqual({ lowerInclusive: 90, upperBound: 100, upperInclusive: true });
    expect(top.count).toBe(4);
    expect(top.acceptedCount).toBe(3);
    if (top.status !== "ok") throw new Error("expected ok bucket");
    expect(top.observedAcceptanceRate).toBe(0.75);
    expect(top.expectedAcceptanceRate).toBe(0.9);
    expect(top.meanConfidence).toBe(90);
    expect(top.calibrationGap).toBe(-0.15);

    const bottom = report.buckets[0];
    expect(bottom.range).toEqual({ lowerInclusive: 0, upperBound: 10, upperInclusive: false });
    expect(bottom.count).toBe(2);
    if (bottom.status !== "ok") throw new Error("expected ok bucket");
    expect(bottom.observedAcceptanceRate).toBe(0);
    expect(bottom.expectedAcceptanceRate).toBe(0);
    expect(bottom.calibrationGap).toBe(0);

    // Empty middle buckets stay ok with zero counts under a floor of 1.
    expect(report.buckets[5].count).toBe(0);
  });

  it("computes a Brier score and observation-weighted ECE over the fixture", () => {
    const observations = [...obs(90, 4, 3), ...obs(0, 2, 0)];
    const report = computeCalibrationReport(observations, { minBucketObservations: 1 });
    if (report.status !== "ok") throw new Error("unreachable");
    // Brier = [3*(0.9-1)^2 + 1*(0.9-0)^2 + 2*(0-0)^2] / 6 = 0.84/6 = 0.14
    expect(report.summary.brierScore).toBe(0.14);
    // ECE = [|0.75-0.9|*4 + |0-0|*2] / 6 = 0.6/6 = 0.1
    expect(report.summary.expectedCalibrationError).toBe(0.1);
    expect(report.summary.totalObservations).toBe(6);
    expect(report.summary.acceptedObservations).toBe(3);
    expect(report.summary.overallObservedAcceptanceRate).toBe(0.5);
    expect(report.summary.overallMeanConfidence).toBe(60);
  });

  it("folds a perfect 100 self-score into the final [90,100] bucket", () => {
    const report = computeCalibrationReport(obs(100, 3, 3), { minBucketObservations: 1 });
    if (report.status !== "ok") throw new Error("unreachable");
    expect(report.buckets[9].count).toBe(3);
    expect(report.buckets[9].range.upperInclusive).toBe(true);
  });

  it("merges both arms: accepted and rejected observations share the same buckets", () => {
    // One arm approved (accepted), one arm rejected, both at 55% confidence.
    const observations = [...obs(55, 12, 12), ...obs(55, 8, 0)];
    const report = computeCalibrationReport(observations, { minBucketObservations: 1 });
    if (report.status !== "ok") throw new Error("unreachable");
    const bucket = report.buckets[5]; // [50,60)
    expect(bucket.count).toBe(20);
    expect(bucket.acceptedCount).toBe(12);
    if (bucket.status !== "ok") throw new Error("expected ok bucket");
    expect(bucket.observedAcceptanceRate).toBe(0.6);
    expect(bucket.expectedAcceptanceRate).toBe(0.55);
  });

  describe("small-N floor", () => {
    it("reports a below-floor bucket as insufficient_data with no rate fields", () => {
      // 5 observations in [70,80) -- below the default floor of 20.
      const report = computeCalibrationReport(obs(75, 5, 3));
      if (report.status !== "ok") throw new Error("unreachable");
      const bucket = report.buckets[7];
      expect(bucket.status).toBe("insufficient_data");
      expect(bucket.count).toBe(5);
      expect(bucket.acceptedCount).toBe(3);
      // The insufficient_data variant carries no rate to misread.
      expect("observedAcceptanceRate" in bucket).toBe(false);
      expect("expectedAcceptanceRate" in bucket).toBe(false);
      // Below-floor observations are excluded from ECE, counted separately.
      expect(report.summary.observationsBelowFloor).toBe(5);
      expect(report.summary.reportableBuckets).toBe(0);
      expect(report.summary.expectedCalibrationError).toBe(0);
      // Brier is per-event and ignores the floor entirely.
      expect(report.summary.totalObservations).toBe(5);
    });

    it("uses MIN_BUCKET_OBSERVATIONS as the default floor", () => {
      const atFloor = computeCalibrationReport(obs(75, MIN_BUCKET_OBSERVATIONS, 10));
      if (atFloor.status !== "ok") throw new Error("unreachable");
      expect(atFloor.buckets[7].status).toBe("ok");
      const belowFloor = computeCalibrationReport(obs(75, MIN_BUCKET_OBSERVATIONS - 1, 10));
      if (belowFloor.status !== "ok") throw new Error("unreachable");
      expect(belowFloor.buckets[7].status).toBe("insufficient_data");
    });

    // delete-the-check: the floor is the ONLY thing turning a small bucket into
    // insufficient_data. Remove it (floor of 1) and the specific small-N assertion
    // below flips from insufficient_data to ok, proving the guard is load-bearing.
    it("delete-the-check: dropping the floor makes the small-N assertion die", () => {
      const small = obs(75, 5, 3);

      const withFloor = computeCalibrationReport(small);
      if (withFloor.status !== "ok") throw new Error("unreachable");
      // This is the assertion that the floor exists to protect.
      expect(withFloor.buckets[7].status).toBe("insufficient_data");

      const floorRemoved = computeCalibrationReport(small, { minBucketObservations: 1 });
      if (floorRemoved.status !== "ok") throw new Error("unreachable");
      // With the floor gone the same 5-observation bucket now reports a rate, and
      // the insufficient_data assertion above would no longer hold.
      const bucket = floorRemoved.buckets[7];
      expect(bucket.status).toBe("ok");
      if (bucket.status !== "ok") throw new Error("unreachable");
      expect(bucket.observedAcceptanceRate).toBe(0.6);
    });
  });

  describe("no data", () => {
    it("returns an explicit no_data report for empty input, never zeros", () => {
      const report = computeCalibrationReport([]);
      expect(report.status).toBe("no_data");
      // No buckets or summary that could read as perfect calibration.
      expect("buckets" in report).toBe(false);
      expect("summary" in report).toBe(false);
      expect(report.minBucketObservations).toBe(MIN_BUCKET_OBSERVATIONS);
      expect(report.bucketEdges).toEqual(CALIBRATION_BUCKET_EDGES);
    });
  });

  describe("honesty fields", () => {
    it("carries fixed outcome-semantics and confidence-source on every report", () => {
      const ok = computeCalibrationReport(obs(85, 25, 20));
      expect(ok.honesty.outcomeSemantics).toBe("reviewer_decision");
      expect(ok.honesty.confidenceSource).toBe("model_self_reported");
      expect(ok.honesty.outcomeSemanticsDetail).toContain("not correctness");

      const none = computeCalibrationReport([]);
      expect(none.honesty.outcomeSemantics).toBe("reviewer_decision");
      expect(none.honesty.confidenceSource).toBe("model_self_reported");
    });
  });

  describe("observationsFromCorpusExamples", () => {
    it("extracts confidence and decision from corpus example labels", () => {
      // Minimal shape: only the labels fields the adapter reads.
      const examples = [
        { labels: { confidence: 82, decision: "accepted" } },
        { labels: { confidence: 40, decision: "rejected" } },
      ] as unknown as Parameters<typeof observationsFromCorpusExamples>[0];
      const observations = observationsFromCorpusExamples(examples);
      expect(observations).toEqual([
        { confidence: 82, decision: "accepted" },
        { confidence: 40, decision: "rejected" },
      ]);
    });
  });

  describe("formatCalibrationReport", () => {
    it("renders honesty header and a no-data line for empty input", () => {
      const text = formatCalibrationReport(computeCalibrationReport([]));
      expect(text).toContain("outcome semantics: reviewer_decision");
      expect(text).toContain("confidence source: model_self_reported");
      expect(text).toContain("no data");
    });

    it("renders a table with buckets and summary for populated input", () => {
      const text = formatCalibrationReport(computeCalibrationReport(obs(85, 25, 20)));
      expect(text).toContain("[80,90)");
      expect(text).toContain("brier score");
      expect(text).toContain("expected calibration error");
    });
  });
});
