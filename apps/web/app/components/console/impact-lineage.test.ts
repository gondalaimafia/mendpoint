import { describe, expect, it } from "vitest";
import { REQUIRED_EVIDENCE_SECTIONS } from "../../consumer/prs/[id]/evidence.js";
import { buildImpactLineage } from "./impact-lineage.js";

const path = {
  nodes: ["stripe.charges", "src/pay.ts"],
  hops: 1,
  terminal: "anchor" as const,
  truncated: false,
  coverage: "complete" as const,
};

function finding(consumerId: string, id = "f1") {
  return {
    id,
    consumerId,
    filePath: "src/pay.ts",
    lineStart: 12,
    symbol: "charge",
    graphPath: path,
  };
}

function packageBody(verification = "unit + post-edit passed"): string {
  return [
    "### Structured Fettler draft package",
    ...REQUIRED_EVIDENCE_SECTIONS.flatMap((section) => [
      `#### ${section}`,
      section === "Verification results" ? verification : `${section} evidence`,
    ]),
  ].join("\n\n");
}

describe("buildImpactLineage", () => {
  it("keeps a failed change fetch as unknown, not no-impact", () => {
    const lineage = buildImpactLineage({
      change: null,
      consumerId: "con1",
      prBody: "",
    });
    expect(lineage.standing).toBe("unknown");
    expect(lineage.reason).toBe("change_detail_unavailable");
    expect(lineage.findings).toEqual([]);
    expect(lineage.verification.recorded).toBe(false);
  });

  it("does not treat another consumer's finding as this PR's lineage", () => {
    const lineage = buildImpactLineage({
      change: {
        findings: [finding("con-other")],
        impactCoverage: {
          impact: "impact",
          coverageBasis: "analyzed",
          reason: null,
          findingCount: 1,
          prCount: 1,
        },
      },
      consumerId: "con1",
      prBody: "",
    });
    expect(lineage.findings).toEqual([]);
    expect(lineage.standing).toBe("unknown");
    expect(lineage.reason).toBe("coverage_not_recorded");
  });

  it("does not inherit another consumer's change-level impact as this PR's standing", () => {
    const lineage = buildImpactLineage({
      change: {
        findings: [finding("con-other")],
        impactCoverage: {
          impact: "impact",
          coverageBasis: "analyzed",
          reason: null,
          findingCount: 1,
          prCount: 2,
        },
      },
      consumerId: "con1",
      prBody: "",
      prCoverageBasis: "analyzed",
    });
    expect(lineage.standing).toBe("no_impact");
    expect(lineage.findings).toEqual([]);
  });

  it("projects a computed provider path and recorded verification", () => {
    const lineage = buildImpactLineage({
      change: {
        findings: [finding("con1")],
        impactCoverage: {
          impact: "impact",
          coverageBasis: "analyzed",
          reason: null,
          findingCount: 1,
          prCount: 1,
        },
      },
      consumerId: "con1",
      prBody: packageBody(),
    });
    expect(lineage.standing).toBe("impact");
    expect(lineage.findings).toEqual([
      {
        id: "f1",
        file: "src/pay.ts:12",
        symbol: "charge",
        pathKind: "chain",
        pathText: "stripe.charges → src/pay.ts",
      },
    ]);
    expect(lineage.verification).toEqual({
      recorded: true,
      excerpt: "unit + post-edit passed",
    });
  });

  it("labels a missing graphPath as not computed, not as a direct path", () => {
    const lineage = buildImpactLineage({
      change: {
        findings: [{ ...finding("con1"), graphPath: null }],
      },
      consumerId: "con1",
      prBody: "",
    });
    expect(lineage.findings[0]).toMatchObject({
      pathKind: "not_computed",
      pathText: "not computed",
    });
    expect(lineage.standing).toBe("impact");
  });

  it("keeps empty findings under this PR's partial coverage as unknown", () => {
    const lineage = buildImpactLineage({
      change: {
        findings: [],
        impactCoverage: {
          impact: "unknown_impact",
          coverageBasis: "partial",
          reason: "partial_or_unknown_coverage",
          findingCount: 0,
          prCount: 1,
        },
      },
      consumerId: "con1",
      prBody: "",
      prCoverageBasis: "partial",
    });
    expect(lineage.standing).toBe("unknown");
    expect(lineage.reason).toBe("partial_or_unknown_coverage");
    expect(lineage.verification.recorded).toBe(false);
  });
});
