import type { ChangeImpactCoverage } from "../../../lib/api";
import type { CoverageSummary } from "./pr-map.js";

/**
 * Map the change-detail `impactCoverage` channel onto the console coverage
 * card. The `/changes` page already fetches `/changes/:id` (which returns this
 * channel) but previously discarded it, so empty findings rendered as
 * "0 repos · 0 calls" with no standing — the FET-017 collapse of unknown into
 * verified no-impact.
 *
 * This mapper does not invent `analyzed`. A missing channel, an unrecognized
 * impact value, or a raw-retrieval no-impact result must not read as
 * graph-authoritative clean. The PR-level `coverageSummary` stays on
 * `MigrationPr.coverage`; this is the change-level aggregate from
 * `summarizeChangeImpactCoverage`.
 */
export function changeImpactCoverageSummary(
  coverage?: ChangeImpactCoverage | null,
): CoverageSummary {
  if (!coverage) {
    return {
      state: "unknown",
      tone: "neutral",
      badge: "coverage unknown",
      headline: "Coverage not recorded",
      detail:
        "This change has no impact-coverage channel, so an empty findings list is not evidence of no impact. Treat it as unverified.",
      files: null,
      gaps: [],
    };
  }

  if (coverage.impact === "impact") {
    const findings = `${coverage.findingCount} finding${coverage.findingCount === 1 ? "" : "s"} across ${coverage.prCount} staged PR${coverage.prCount === 1 ? "" : "s"}`;

    // Findings alone do not certify a complete list. A raw-retrieval stamp means
    // Fettler ran without a tenant graph, so the result is not graph-authoritative
    // — this dominates the coverage basis, exactly as the no_impact branch treats
    // raw retrieval (FET-018). Checked first so an analyzed-basis raw-retrieval run
    // never reads as emerald covered.
    if (coverage.fallback === "raw_retrieval") {
      return {
        state: "no_known_impact",
        tone: "amber",
        badge: "raw retrieval",
        headline: "Impact found — not graph-authoritative",
        detail: `${findings}, but analysis ran without a tenant graph (bounded raw retrieval). This is not a graph-authoritative result; the finding list may be incomplete.`,
        files: null,
        gaps: [],
      };
    }

    // Coverage-aware, mirroring pr-map.ts coverageSummary: only a fully-analyzed
    // basis yields the emerald `covered` state (a complete set of impacted sites).
    // Partial / not-analyzed / absent bases stay amber-or-neutral so a complete
    // finding list is distinguishable from one that may have missed impact in code
    // Fettler could not see. This is the FET-017 discipline: never dress a partial
    // result as verified.
    switch (coverage.coverageBasis) {
      case "analyzed":
        return {
          state: "covered",
          tone: "emerald",
          badge: "impact found",
          headline: "Impact findings recorded",
          detail: `${findings}, analyzed with full coverage, so this is the complete set of impacted sites. Empty-findings wording does not apply.`,
          files: null,
          gaps: [],
        };
      case "partial":
        return {
          state: "no_known_impact",
          tone: "amber",
          badge: "partial coverage",
          headline: "Impact found — partial coverage",
          detail: `${findings}, but some code in scope was not analyzed, so the finding list may be incomplete: there may be more impact Fettler could not see.`,
          files: null,
          gaps: [],
        };
      case "not_analyzed":
        return {
          state: "no_basis",
          tone: "amber",
          badge: "not analyzed",
          headline: "Impact found — no analysis basis",
          detail: `${findings}, but no analysis ran against real code for the staged PRs, so the finding list cannot be confirmed complete.`,
          files: null,
          gaps: [],
        };
      default:
        // No PR recorded a coverage basis: findings exist, but whether the list is
        // complete is unverified. Neutral unknown, never emerald covered.
        return {
          state: "unknown",
          tone: "neutral",
          badge: "coverage unknown",
          headline: "Impact found — coverage not recorded",
          detail: `${findings}, but no staged PR recorded a coverage basis, so whether the finding list is complete is unverified.`,
          files: null,
          gaps: [],
        };
    }
  }

  if (coverage.impact === "no_impact" && coverage.fallback === "raw_retrieval") {
    return {
      state: "no_known_impact",
      tone: "amber",
      badge: "raw retrieval",
      headline: "No impact — not graph-authoritative",
      detail:
        "Fettler analyzed without a tenant graph. This is not a graph-authoritative no-impact result; do not treat it as verified clean.",
      files: null,
      gaps: [],
    };
  }

  if (coverage.impact === "no_impact") {
    return {
      state: "clean",
      tone: "emerald",
      badge: "no impact",
      headline: "No impact — verified",
      detail:
        "Fettler analyzed the in-scope code with full coverage and found nothing affected. This is complete evidence of no impact, not merely an empty result.",
      files: null,
      gaps: [],
    };
  }

  if (coverage.impact === "unknown_impact") {
    if (
      coverage.coverageBasis === "partial" ||
      coverage.reason === "partial_or_unknown_coverage"
    ) {
      return {
        state: "no_known_impact",
        tone: "amber",
        badge: "partial coverage",
        headline: "No known impact — partial coverage",
        detail:
          "Some code in scope was not analyzed, so this is no known impact rather than verified clean: there may be impact in code Fettler could not see.",
        files: null,
        gaps: [],
      };
    }
    if (
      coverage.coverageBasis === "not_analyzed" ||
      coverage.reason === "analysis_did_not_run"
    ) {
      return {
        state: "no_basis",
        tone: "amber",
        badge: "not analyzed",
        headline: "Not analyzed — no basis",
        detail:
          "No analysis ran against real code, so an empty findings list is not evidence of no impact. This is not a clean result.",
        files: null,
        gaps: [],
      };
    }
    return {
      state: "unknown",
      tone: "neutral",
      badge: "coverage unknown",
      headline: "Coverage not recorded",
      detail:
        coverage.reason === "pipeline_not_recorded"
          ? "No staged PR has been recorded for this change, so there is no analysis coverage to read. An empty findings list is not evidence of no impact."
          : "Staged PRs exist but none recorded a coverage basis. Treat the empty findings list as unverified, not clean.",
      files: null,
      gaps: [],
    };
  }

  return {
    state: "unknown",
    tone: "neutral",
    badge: "coverage unknown",
    headline: "Coverage not recognized",
    detail:
      "The change report returned an impact value this console does not recognize. Treat it as unverified rather than assuming no impact.",
    files: null,
    gaps: [],
  };
}
