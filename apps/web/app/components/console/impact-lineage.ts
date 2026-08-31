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

/**
 * What the change record says about THIS consumer, before any coverage channel
 * is folded in. Kept separate from `standing` because the coverage card needs
 * the raw observation: `standing` already mixes in coverage basis, and reusing
 * it there would re-import the very conflation this file exists to avoid.
 *
 * `"unknown"` is a real third state — the change body was unreadable, or it
 * carried no findings list at all — and must never collapse into `"none"`.
 */
export type ObservedConsumerImpact = "impact" | "none" | "unknown";

export type ImpactLineageView = Readonly<{
  standing: "impact" | "no_impact" | "unknown";
  reason: string;
  /** Raw per-consumer observation; the reconciliation input for `coverageSummary`. */
  observed: ObservedConsumerImpact;
  findings: readonly ImpactLineageFindingView[];
  verification: Readonly<{ recorded: boolean; excerpt: string | null }>;
  /**
   * As-of qualifier for the findings list. `impact_findings` carries no
   * timestamp column, and the pipeline seeds its `findingKeys` set from every
   * row already recorded for the change, so re-analysis only ever ADDS — a
   * finding that no longer applies is never retired. The list is therefore the
   * union across analysis runs for this change, not the output of one run
   * against the revision in the patch rendered beside it (`patch_unified` is
   * not refreshed by `updateMigrationPrDelivery` either). `changeRecordedAt` is
   * the change's own `createdAt`, the only timestamp the record actually
   * carries. Retiring stale findings needs a schema change and is deliberately
   * not attempted here; this field exists so the card's claim is qualified
   * rather than absolute.
   */
  asOf: Readonly<{ changeRecordedAt: string | null }>;
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
  /** Optional at runtime only: the API always sends it, so absence means "not read". */
  findings?: readonly ChangeImpactFinding[];
  impactCoverage?: ChangeImpactCoverage;
  createdAt?: string;
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
  const asOf = { changeRecordedAt: input.change?.createdAt ?? null } as const;
  if (!input.change) {
    return {
      standing: "unknown",
      reason: "change_detail_unavailable",
      observed: "unknown",
      findings: [],
      verification,
      asOf,
    };
  }
  // An ABSENT `findings` key is not an empty findings list. `changeDetailBody`
  // always sends the key, so its absence means we are not looking at the body
  // we think we are; reporting "analyzed and nothing found" there would turn a
  // missing field into a verified negative.
  const recorded = input.change.findings;
  if (recorded === undefined) {
    return {
      standing: "unknown",
      reason: "findings_not_recorded",
      observed: "unknown",
      findings: [],
      verification,
      asOf,
    };
  }
  const findings = recorded
    .filter((finding) => finding.consumerId === input.consumerId)
    .map(pathView);
  const observed: ObservedConsumerImpact = findings.length > 0 ? "impact" : "none";
  if (findings.length > 0) {
    return { standing: "impact", reason: "findings_present", observed, findings, verification, asOf };
  }
  if (input.prCoverageBasis === "analyzed") {
    return { standing: "no_impact", reason: "analyzed_empty", observed, findings, verification, asOf };
  }
  if (input.prCoverageBasis === "partial" || input.prCoverageBasis === "not_analyzed") {
    return {
      standing: "unknown",
      reason: input.prCoverageBasis === "partial" ? "partial_or_unknown_coverage" : "analysis_did_not_run",
      observed,
      findings,
      verification,
      asOf,
    };
  }
  const coverage = input.change.impactCoverage;
  if (coverage?.impact === "no_impact" && coverage.coverageBasis === "analyzed") {
    return { standing: "no_impact", reason: "analyzed_empty", observed, findings, verification, asOf };
  }
  return {
    standing: "unknown",
    reason: coverage?.reason ?? "coverage_not_recorded",
    observed,
    findings,
    verification,
    asOf,
  };
}
