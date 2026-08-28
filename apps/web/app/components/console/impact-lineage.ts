/**
 * FET-016 view-model for the live Fettler review surfaces (`/prs/[id]` and
 * `/consumer/prs/[id]`).
 *
 * GET /changes/:id already returns findings + graphPath + impactCoverage.
 * The page fetched that body and used it only for a breaking-change alert.
 * This mapper keeps three states distinct: material impact, verified no
 * impact, and unknown. A missing change body is unknown, never no-impact.
 */
import { graphPathDisplay, type GraphPath } from "@mendpoint/shared";
import type { ChangeImpactCoverage } from "../../../lib/api.js";
import { parsePrEvidence } from "../../consumer/prs/[id]/evidence.js";

export type ImpactLineageFindingView = Readonly<{
  id: string;
  file: string;
  symbol: string;
  pathKind: "direct" | "chain" | "not_computed";
  pathText: string;
}>;

export type ImpactLineageView = Readonly<{
  standing: "impact" | "no_impact" | "unknown";
  reason: string;
  findings: readonly ImpactLineageFindingView[];
  verification: Readonly<{ recorded: boolean; excerpt: string | null }>;
}>;

export type ChangeImpactFinding = Readonly<{
  id: string;
  consumerId: string;
  filePath: string;
  lineStart: number;
  symbol: string;
  graphPath: GraphPath | null;
}>;

export type ChangeImpactBody = Readonly<{
  findings?: readonly ChangeImpactFinding[];
  impactCoverage?: ChangeImpactCoverage;
}>;

function pathView(finding: ChangeImpactFinding): ImpactLineageFindingView {
  const file = `${finding.filePath}:${finding.lineStart}`;
  if (!finding.graphPath) {
    return {
      id: finding.id,
      file,
      symbol: finding.symbol,
      pathKind: "not_computed",
      pathText: "not computed",
    };
  }
  const display = graphPathDisplay(finding.graphPath);
  if (display.kind === "direct") {
    return {
      id: finding.id,
      file,
      symbol: finding.symbol,
      pathKind: "direct",
      pathText: display.node,
    };
  }
  const suffix =
    display.bound === "cycle"
      ? " (truncated at an import cycle)"
      : display.bound === "no_anchor"
        ? " (incomplete: no provider anchor reached)"
        : display.bound === "max_hops"
          ? ` (truncated at the ${display.hops}-hop limit)`
          : "";
  return {
    id: finding.id,
    file,
    symbol: finding.symbol,
    pathKind: "chain",
    pathText: `${display.nodes.join(" → ")}${suffix}`,
  };
}

function verificationFromBody(prBody: string): ImpactLineageView["verification"] {
  const section = parsePrEvidence(prBody).sections.find((item) => item.title === "Verification results");
  const excerpt = section?.content.trim() ?? "";
  if (!excerpt) return { recorded: false, excerpt: null };
  return { recorded: true, excerpt };
}

export function buildImpactLineage(input: {
  change: ChangeImpactBody | null;
  consumerId: string;
  prBody: string;
  /** This PR's coverage basis. Change-level impact can belong to another consumer. */
  prCoverageBasis?: "analyzed" | "partial" | "not_analyzed" | null;
}): ImpactLineageView {
  const verification = verificationFromBody(input.prBody);
  if (!input.change) {
    return {
      standing: "unknown",
      reason: "change_detail_unavailable",
      findings: [],
      verification,
    };
  }
  const findings = (input.change.findings ?? [])
    .filter((finding) => finding.consumerId === input.consumerId)
    .map(pathView);
  if (findings.length > 0) {
    return { standing: "impact", reason: "findings_present", findings, verification };
  }
  if (input.prCoverageBasis === "analyzed") {
    return { standing: "no_impact", reason: "analyzed_empty", findings, verification };
  }
  if (input.prCoverageBasis === "partial" || input.prCoverageBasis === "not_analyzed") {
    return {
      standing: "unknown",
      reason: input.prCoverageBasis === "partial" ? "partial_or_unknown_coverage" : "analysis_did_not_run",
      findings,
      verification,
    };
  }
  const coverage = input.change.impactCoverage;
  if (coverage?.impact === "no_impact" && coverage.coverageBasis === "analyzed") {
    return { standing: "no_impact", reason: "analyzed_empty", findings, verification };
  }
  return {
    standing: "unknown",
    reason: coverage?.reason ?? "coverage_not_recorded",
    findings,
    verification,
  };
}
