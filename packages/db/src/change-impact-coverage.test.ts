import { describe, expect, it } from "vitest";
import { summarizeChangeImpactCoverage } from "./change-impact-coverage.js";

describe("summarizeChangeImpactCoverage", () => {
  it("is impact when findings exist", () => {
    expect(
      summarizeChangeImpactCoverage({
        findingCount: 2,
        prs: [{ coverage: { basis: "analyzed" } }],
      }),
    ).toMatchObject({ impact: "impact", findingCount: 2, coverageBasis: "analyzed" });
  });

  it("is unknown when no PRs have been recorded", () => {
    expect(summarizeChangeImpactCoverage({ findingCount: 0, prs: [] })).toEqual({
      impact: "unknown_impact",
      coverageBasis: null,
      reason: "pipeline_not_recorded",
      findingCount: 0,
      prCount: 0,
    });
  });

  it("is unknown when PRs predate coverage tracking", () => {
    expect(
      summarizeChangeImpactCoverage({ findingCount: 0, prs: [{ coverage: null }, {}] }),
    ).toMatchObject({
      impact: "unknown_impact",
      reason: "coverage_not_recorded",
    });
  });

  it("is verified no-impact only when every PR was analyzed with empty findings", () => {
    expect(
      summarizeChangeImpactCoverage({
        findingCount: 0,
        prs: [{ coverage: { basis: "analyzed" } }, { coverage: { basis: "analyzed" } }],
      }),
    ).toEqual({
      impact: "no_impact",
      coverageBasis: "analyzed",
      reason: null,
      findingCount: 0,
      prCount: 2,
    });
  });

  it("is unknown when any PR has only partial coverage and findings are empty", () => {
    expect(
      summarizeChangeImpactCoverage({
        findingCount: 0,
        prs: [
          { coverage: { basis: "analyzed" } },
          { coverage: { basis: "partial" } },
        ],
      }),
    ).toMatchObject({
      impact: "unknown_impact",
      coverageBasis: "partial",
      reason: "partial_or_unknown_coverage",
    });
  });
});
