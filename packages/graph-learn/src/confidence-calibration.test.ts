import { describe, expect, it } from "vitest";
import {
  evaluateConfidenceCalibration,
  type ConfidenceCalibrationContract,
} from "./confidence-calibration.js";

const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

function fixture(): ConfidenceCalibrationContract {
  const phases = [
    "detection",
    "path",
    "edit",
    "verification",
    "pull_request",
    "campaign",
  ] as const;
  return {
    version: "2026-08-02.v1",
    tenantId: "tenant-a",
    repositorySnapshot: { id: "snapshot-17", exactCommit: revision },
    cohort: {
      id: "graph-confidence-held-out-v1",
      revision,
      digest,
      split: "held_out",
      createdAt: "2026-08-01T00:00:00.000Z",
      trainingCohortIds: ["graph-training-v1"],
    },
    binEdges: [0, 0.5, 0.8, 1],
    phases: phases.map((phase) => ({
      phase,
      abstainBelow: 0.6,
      maxExpectedCalibrationError: 0.25,
      maxBrierScore: 0.25,
      minSelectiveAccuracy: 0.75,
      minCoverage: 0.5,
    })),
    samples: phases.flatMap((phase) => [
      {
        id: `${phase}-correct`,
        phase,
        confidence: 0.9,
        correct: true,
        abstained: false,
        cohortId: "graph-confidence-held-out-v1",
        corpusRevision: revision,
        snapshotId: "snapshot-17",
        exactCommit: revision,
        evidenceRefs: [`evidence://${phase}/correct`],
      },
      {
        id: `${phase}-abstain`,
        phase,
        confidence: 0.4,
        correct: false,
        abstained: true,
        cohortId: "graph-confidence-held-out-v1",
        corpusRevision: revision,
        snapshotId: "snapshot-17",
        exactCommit: revision,
        evidenceRefs: [`evidence://${phase}/abstain`],
      },
    ]),
    evidenceRefs: ["artifact://labels.json", "artifact://runner.json"],
  };
}

describe("phase confidence calibration", () => {
  it("produces reproducible phase metrics and abstention evidence", () => {
    const report = evaluateConfidenceCalibration(fixture(), {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      maxCohortAgeMs: 7 * 24 * 60 * 60 * 1_000,
    });

    expect(report.version).toBe("2026-08-02.v1");
    expect(report.accepted).toBe(true);
    expect(report.phases).toHaveLength(6);
    expect(report.phases.every((phase) => phase.accepted)).toBe(true);
    expect(report.phases[0]).toMatchObject({
      phase: "detection",
      samples: 2,
      answered: 1,
      abstained: 1,
      coverage: 0.5,
      selectiveAccuracy: 1,
    });
    expect(report.phases[0]?.bins).toEqual([
      { lower: 0, upper: 0.5, samples: 1, meanConfidence: 0.4, observedAccuracy: 0 },
      { lower: 0.5, upper: 0.8, samples: 0, meanConfidence: null, observedAccuracy: null },
      { lower: 0.8, upper: 1, samples: 1, meanConfidence: 0.9, observedAccuracy: 1 },
    ]);
    expect(report.evidenceRefs).toEqual(["artifact://labels.json", "artifact://runner.json"]);
  });

  it.each([
    ["training split", (value: any) => { value.cohort.split = "training"; }, /confidence_cohort_not_held_out/],
    ["training leakage", (value: any) => { value.cohort.trainingCohortIds = [value.cohort.id]; }, /confidence_cohort_leakage/],
    ["missing label", (value: any) => { delete value.samples[0].correct; }, /confidence_sample_label_required/],
    ["malformed bins", (value: any) => { value.binEdges = [0, 0.8, 0.5, 1]; }, /confidence_bins_invalid/],
    ["revision mismatch", (value: any) => { value.samples[0].corpusRevision = "c".repeat(40); }, /confidence_sample_revision_mismatch/],
    ["snapshot mismatch", (value: any) => { value.samples[0].snapshotId = "snapshot-other"; }, /confidence_sample_snapshot_mismatch/],
    ["missing evidence", (value: any) => { value.samples[0].evidenceRefs = []; }, /confidence_sample_evidence_required/],
    ["weak threshold", (value: any) => { value.phases[0].maxExpectedCalibrationError = 0.5; }, /confidence_threshold_unacceptable/],
  ])("fails closed for %s", (_name, mutate, expected) => {
    const value: any = fixture();
    mutate(value);
    expect(() => evaluateConfidenceCalibration(value, {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-08-02T00:00:00.000Z",
    })).toThrow(expected);
  });

  it("rejects stale and unexpectedly revised held out cohorts", () => {
    expect(() => evaluateConfidenceCalibration(fixture(), {
      expectedCorpusRevision: "c".repeat(40),
      evaluatedAt: "2026-08-02T00:00:00.000Z",
    })).toThrow("confidence_corpus_revision_mismatch");

    expect(() => evaluateConfidenceCalibration(fixture(), {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-09-02T00:00:00.000Z",
      maxCohortAgeMs: 7 * 24 * 60 * 60 * 1_000,
    })).toThrow("confidence_cohort_stale");
  });
});
