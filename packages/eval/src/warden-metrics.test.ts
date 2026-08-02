import { describe, expect, it } from "vitest";
import { calculateWardenMetrics, type WardenMetricsInput } from "./warden-metrics.js";

function input(): WardenMetricsInput {
  return {
    version: "2026-08-02.v1",
    cohort: { id: "pilot-a", revision: "a".repeat(40), digest: `sha256:${"b".repeat(64)}` },
    observations: [
      {
        taskId: "change-a",
        detectionAt: "2026-08-02T10:00:00.000Z",
        firstDraftPrAt: "2026-08-02T10:30:00.000Z",
        impact: { truePositive: 8, falsePositive: 2, falseNegative: 2 },
        generatedBytes: 1_000,
        reviewerEditedBytes: 100,
        accepted: true,
        regressionDetected: false,
        manualBaselineMinutes: 180,
        actualMinutes: 60,
        incidentPrevention: { confirmed: true, evidenceRefs: ["customer://incident/a"] },
        evidenceRefs: ["run://change-a"],
      },
      {
        taskId: "change-b",
        detectionAt: "2026-08-02T11:00:00.000Z",
        firstDraftPrAt: null,
        impact: { truePositive: 2, falsePositive: 0, falseNegative: 0 },
        generatedBytes: 500,
        reviewerEditedBytes: 50,
        accepted: true,
        regressionDetected: true,
        manualBaselineMinutes: 60,
        actualMinutes: 90,
        incidentPrevention: { confirmed: false, evidenceRefs: [] },
        evidenceRefs: ["run://change-b"],
      },
    ],
  };
}

describe("Warden metrics", () => {
  it("calculates exact cohort scoped definitions without inventing unmeasured values", () => {
    expect(calculateWardenMetrics(input())).toMatchObject({
      taskCount: 2,
      detectionToFirstPrMinutes: { measured: 1, median: 30 },
      verifiedImpactPrecision: 10 / 12,
      verifiedImpactRecall: 10 / 12,
      reviewerEditDelta: 0.1,
      acceptedRegressionRate: 0.5,
      hoursSaved: 2,
      confirmedPreventedIncidents: 1,
    });
  });

  it("returns null when a denominator has no measured evidence", () => {
    const base = input();
    const value: WardenMetricsInput = { ...base, observations: [{
      ...base.observations[0]!,
      impact: { truePositive: 0, falsePositive: 0, falseNegative: 0 },
      generatedBytes: 0,
      reviewerEditedBytes: 0,
      accepted: false,
    }] };
    expect(calculateWardenMetrics(value)).toMatchObject({
      verifiedImpactPrecision: null,
      verifiedImpactRecall: null,
      reviewerEditDelta: null,
      acceptedRegressionRate: null,
    });
  });

  it("fails closed for duplicate tasks, impossible time, unattributed edits, and unconfirmed incident claims", () => {
    const base = input();
    const duplicate: WardenMetricsInput = {
      ...base,
      observations: [...base.observations, base.observations[0]!],
    };
    expect(() => calculateWardenMetrics(duplicate)).toThrow("warden_metric_task_duplicate");

    const time: WardenMetricsInput = {
      ...base,
      observations: [{ ...base.observations[0]!, firstDraftPrAt: "2026-08-02T09:59:00.000Z" }],
    };
    expect(() => calculateWardenMetrics(time)).toThrow("warden_metric_pr_before_detection");

    const edits: WardenMetricsInput = {
      ...base,
      observations: [{ ...base.observations[0]!, generatedBytes: 0 }],
    };
    expect(() => calculateWardenMetrics(edits)).toThrow("warden_metric_reviewer_delta_unattributable");

    const incident: WardenMetricsInput = {
      ...base,
      observations: [{ ...base.observations[0]!, incidentPrevention: { confirmed: true, evidenceRefs: [] } }],
    };
    expect(() => calculateWardenMetrics(incident)).toThrow("warden_metric_incident_confirmation_required");
  });
});
