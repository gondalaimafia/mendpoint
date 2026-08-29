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
    expect(missing.state).not.toBe("clean");
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
    expect(summary.state).not.toBe("clean");
    expect(summary.detail).toContain("not a graph-authoritative");
  });

  it("records impact findings as covered, not as an empty-findings standing", () => {
    const summary = changeImpactCoverageSummary({
      impact: "impact",
      coverageBasis: "analyzed",
      reason: null,
      findingCount: 2,
      prCount: 1,
    });
    expect(summary.state).toBe("covered");
    expect(summary.detail).toContain("2 findings");
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
