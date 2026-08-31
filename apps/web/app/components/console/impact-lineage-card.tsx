import React from "react";
import type { ImpactLineageView } from "./impact-lineage.js";

/**
 * Why the lineage is unknown, in the customer's terms. `/prs/[id]` renders a
 * CoverageCard beside this one that draws the same distinction, but
 * `/consumer/prs/[id]` has no CoverageCard at all — so without these,
 * "analysis never ran" and "partial coverage" are indistinguishable to the
 * customer, which is the one distinction §11.7 exists to preserve.
 */
const UNKNOWN_COPY: Record<string, { headline: string; detail: string }> = {
  change_detail_unavailable: {
    headline: "Impact lineage unavailable",
    detail: "The change record could not be loaded. That is not a no-impact result.",
  },
  pull_request_unavailable: {
    headline: "Impact lineage unavailable",
    detail:
      "The pull request could not be loaded, so no impact record was read for this consumer. That is not a no-impact result.",
  },
  findings_not_recorded: {
    headline: "Impact lineage unavailable",
    detail:
      "The change record carried no findings list, so nothing was read for this consumer. An absent list is not an empty one.",
  },
  analysis_did_not_run: {
    headline: "Impact lineage unknown — analysis did not run",
    detail:
      "No analysis ran against this consumer's real code, so an empty result carries no information at all. This is not a clean result.",
  },
  partial_or_unknown_coverage: {
    headline: "Impact lineage unknown — partial coverage",
    detail:
      "Only part of this consumer's code was analyzed, so this is no KNOWN impact rather than verified clean: there may be impact in code Fettler could not see.",
  },
  coverage_not_recorded: {
    headline: "Impact lineage unknown — coverage not recorded",
    detail:
      "No impact coverage was recorded for this consumer, so an empty result could mean no impact or code that was never analyzed. Treat it as unverified.",
  },
};

function standingCopy(lineage: ImpactLineageView): { headline: string; detail: string } {
  if (lineage.standing === "impact") {
    return {
      headline: "Provider → code path",
      detail: "Each finding is the path Fettler recorded from the provider change to the affected symbol.",
    };
  }
  if (lineage.standing === "no_impact") {
    return {
      headline: "No impact — verified",
      detail: "This consumer was analyzed and no affected symbols were recorded.",
    };
  }
  return (
    UNKNOWN_COPY[lineage.reason] ?? {
      headline: "Impact lineage unknown",
      detail: "No verified no-impact result is recorded for this consumer.",
    }
  );
}

/** FET-016 lineage card on `/prs/[id]`. Unknown never reads as verified clean. */
export function ImpactLineageCard({ lineage }: { lineage: ImpactLineageView }) {
  const copy = standingCopy(lineage);
  return (
    <div className={`ds-panel ds-panel--pad ds-lineage ds-lineage--${lineage.standing}`}>
      <div className="section-label section-label--muted">IMPACT LINEAGE</div>
      <p className="ds-lineage__headline">{copy.headline}</p>
      <p className="ds-lineage__detail">{copy.detail}</p>
      {lineage.findings.length > 0 && (
        <ul className="ds-lineage__findings">
          {lineage.findings.map((finding) => (
            <li key={finding.id} className="ds-lineage__finding">
              <code className="ds-lineage__file">{finding.file}</code>
              <span className="ds-lineage__symbol">{finding.symbol}</span>
              <span className={`ds-lineage__path ds-lineage__path--${finding.pathKind}`}>
                {finding.pathText}
              </span>
            </li>
          ))}
        </ul>
      )}
      {lineage.standing === "impact" && (
        <p className="ds-lineage__asof">
          Findings accumulate across analysis runs for this change and are not retired when they
          stop applying, so this list can include findings computed against an earlier consumer
          revision than the patch shown here.
          {lineage.asOf.changeRecordedAt ? ` Change recorded ${lineage.asOf.changeRecordedAt}.` : ""}
        </p>
      )}
      <div className="ds-lineage__verification">
        <div className="section-label section-label--muted">VERIFICATION</div>
        {lineage.verification.recorded ? (
          <pre className="ds-lineage__excerpt">{lineage.verification.excerpt}</pre>
        ) : (
          <p className="ds-lineage__detail">
            Verification evidence is not recorded on this PR. That is not a passing result.
          </p>
        )}
      </div>
    </div>
  );
}
