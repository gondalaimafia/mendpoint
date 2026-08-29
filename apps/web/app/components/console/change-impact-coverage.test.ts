import { describe, expect, it } from "vitest";
import type { ChangeImpactCoverage } from "../../../lib/api";
import { changeImpactCoverageSummary } from "./change-impact-coverage";

const base = {
  findingCount: 0,
  prCount: 1,
} as const;

describe("changeImpactCoverageSummary", () => {
  it("treats a missing channel as unknown, never clean", () => {
    const missing = changeImpactCoverageSummary(undefined);
    expect(missing.state).toBe("unknown");
    expect(missing.tone).toBe("neutral");
    expect(missing.detail).toContain("not evidence of no impact");
    expect(changeImpactCoverageSummary(null).state).toBe("unknown");
  });

  it("keeps verified no-impact distinct from partial and not-analyzed", () => {
    const clean = changeImpactCoverageSummary({
      ...base,
      impact: "no_impact",
      coverageBasis: "analyzed",
      reason: null,
    });
    expect(clean.state).toBe("clean");
    expect(clean.headline).toContain("verified");

    const partial = changeImpactCoverageSummary({
      ...base,
      impact: "unknown_impact",
      coverageBasis: "partial",
      reason: "partial_or_unknown_coverage",
    });
    expect(partial.state).toBe("no_known_impact");
    expect(partial.tone).toBe("amber");
    expect(partial.detail).toContain("no known impact");

    const none = changeImpactCoverageSummary({
      ...base,
      impact: "unknown_impact",
      coverageBasis: "not_analyzed",
      reason: "analysis_did_not_run",
    });
    expect(none.state).toBe("no_basis");
    expect(none.detail).toContain("not a clean result");
  });

  it("does not treat raw-retrieval no-impact as graph-authoritative clean", () => {
    const raw: ChangeImpactCoverage = {
      ...base,
      impact: "no_impact",
      coverageBasis: "analyzed",
      reason: null,
      fallback: "raw_retrieval",
    };
    const summary = changeImpactCoverageSummary(raw);
    expect(summary.state).toBe("no_known_impact");
    expect(summary.detail).toContain("not a graph-authoritative");
  });

  it("records fully-analyzed impact findings as emerald covered", () => {
    const summary = changeImpactCoverageSummary({
      impact: "impact",
      coverageBasis: "analyzed",
      reason: null,
      findingCount: 2,
      prCount: 1,
    });
    expect(summary.state).toBe("covered");
    expect(summary.tone).toBe("emerald");
    expect(summary.detail).toContain("2 findings");
    expect(summary.detail).toContain("complete set of impacted sites");
  });

  // The FET-017 blocker: the impact branch must carry the coverage basis, not
  // stamp every finding list as emerald covered. A partial / not-analyzed /
  // absent-basis / raw-retrieval finding list is distinguishable from a
  // fully-analyzed one, consistent with pr-map.ts coverageSummary.
  it("does not dress partial-coverage impact findings as verified covered", () => {
    const summary = changeImpactCoverageSummary({
      impact: "impact",
      coverageBasis: "partial",
      reason: null,
      findingCount: 3,
      prCount: 2,
    });
    expect(summary.state).toBe("no_known_impact");
    expect(summary.tone).toBe("amber");
    expect(summary.state).not.toBe("covered");
    expect(summary.detail).toContain("may be incomplete");
    expect(summary.detail).toContain("3 findings");
  });

  it("does not dress not-analyzed impact findings as verified covered", () => {
    const summary = changeImpactCoverageSummary({
      impact: "impact",
      coverageBasis: "not_analyzed",
      reason: null,
      findingCount: 1,
      prCount: 1,
    });
    expect(summary.state).toBe("no_basis");
    expect(summary.tone).toBe("amber");
    expect(summary.detail).toContain("no analysis ran against real code");
  });

  it("treats impact findings with no recorded basis as unknown, never covered", () => {
    const summary = changeImpactCoverageSummary({
      impact: "impact",
      coverageBasis: null,
      reason: null,
      findingCount: 2,
      prCount: 1,
    });
    expect(summary.state).toBe("unknown");
    expect(summary.tone).toBe("neutral");
    expect(summary.detail).toContain("no staged PR recorded a coverage basis");
  });

  it("treats raw-retrieval impact findings as amber, not graph-authoritative covered", () => {
    const summary = changeImpactCoverageSummary({
      impact: "impact",
      coverageBasis: "analyzed",
      reason: null,
      findingCount: 4,
      prCount: 2,
      fallback: "raw_retrieval",
    });
    // Raw retrieval dominates an otherwise-analyzed basis: no tenant graph means
    // the finding list is not graph-authoritative.
    expect(summary.state).toBe("no_known_impact");
    expect(summary.tone).toBe("amber");
    expect(summary.state).not.toBe("covered");
    expect(summary.detail).toContain("without a tenant graph");
  });

  it("keeps pipeline-not-recorded and unrecognized impact as unknown", () => {
    const none = changeImpactCoverageSummary({
      impact: "unknown_impact",
      coverageBasis: null,
      reason: "pipeline_not_recorded",
      findingCount: 0,
      prCount: 0,
    });
    expect(none.state).toBe("unknown");
    expect(none.detail).toContain("No staged PR");

    const bogus = changeImpactCoverageSummary({
      impact: "maybe" as ChangeImpactCoverage["impact"],
      coverageBasis: null,
      reason: null,
      findingCount: 0,
      prCount: 0,
    });
    expect(bogus.state).toBe("unknown");
    expect(bogus.headline).toContain("not recognized");
  });
});
