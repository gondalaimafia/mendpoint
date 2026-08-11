import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutcomeMetricsView, type OutcomeMetrics } from "./outcome-metrics-view";

function baseMetrics(overrides: Partial<OutcomeMetrics> = {}): OutcomeMetrics {
  return {
    tenantId: "tenant-a",
    window: { since: null, until: null },
    totalRuns: 5,
    candidateProducingRuns: 4,
    acceptedCandidates: 2,
    acceptedCandidateRate: { value: 0.5, numerator: 2, denominator: 4, basis: "measured" },
    escapedRegressionRate: {
      value: null,
      basis: "unavailable",
      reason: "No post-delivery regression or revert signal is recorded yet.",
      nearestProxy: {
        name: "reviewRejectionRate",
        value: 0.25,
        numerator: 1,
        denominator: 4,
        basis: "proxy",
        note: "Caught pre-delivery, not escaped.",
      },
    },
    humanInterventionRate: { value: 0.8, numerator: 4, denominator: 5, basis: "measured" },
    costPerAcceptedPr: {
      value: 0.05,
      currency: "USD",
      acceptedCount: 2,
      measuredAcceptedCount: 1,
      totalMeasuredCostUsd: 0.05,
      basis: "measured",
      note: "Averaged over the 1 of 2 accepted candidates with measured cost.",
    },
    timeToCandidate: {
      p50Ms: 20000,
      p95Ms: 29000,
      sampleSize: 2,
      excludedReviewedRuns: 2,
      basis: "measured",
      note: "created_at to candidate-ready.",
    },
    externalBaseline: {
      disclaimer: "External reference points are declared by their sources.",
      headToHeadMeasured: false,
      references: [
        {
          id: "devin-swebench-2024",
          source: "Cognition Labs",
          system: "Devin",
          benchmark: "SWE-bench (random 25% subset)",
          metric: "End-to-end issue resolution rate",
          value: 0.1386,
          unit: "rate",
          asOf: "2024-03-12",
          evidenceQuality: "vendor_reported_unaudited",
          comparability: "low",
          sourceUrl: "https://www.cognition.ai/blog/introducing-devin",
          note: "External anchor only.",
        },
      ],
    },
    computedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("OutcomeMetricsView", () => {
  it("labels the escaped-regression metric as not measurable and shows the proxy", () => {
    const html = renderToStaticMarkup(<OutcomeMetricsView m={baseMetrics()} />);
    expect(html).toContain("not measurable yet");
    expect(html).toContain("reviewRejectionRate");
    expect(html).toContain("proxy");
  });

  it("labels the external baseline as an external reference, not our measurement", () => {
    const html = renderToStaticMarkup(<OutcomeMetricsView m={baseMetrics()} />);
    expect(html).toContain("Devin");
    expect(html).toContain("external reference, not our measurement");
    expect(html).toContain("vendor_reported_unaudited");
  });

  it("shows honest no-data language instead of zero-filling", () => {
    const html = renderToStaticMarkup(
      <OutcomeMetricsView
        m={baseMetrics({
          acceptedCandidateRate: {
            value: null,
            numerator: 0,
            denominator: 0,
            basis: "measured",
            reason: "no candidate-producing runs in window",
          },
          costPerAcceptedPr: {
            value: null,
            currency: "USD",
            acceptedCount: 0,
            measuredAcceptedCount: 0,
            totalMeasuredCostUsd: null,
            basis: "measured",
            reason: "no accepted candidates in window",
          },
        })}
      />,
    );
    expect(html).toContain("no data yet");
    expect(html).toContain("no candidate-producing runs in window");
  });
});
