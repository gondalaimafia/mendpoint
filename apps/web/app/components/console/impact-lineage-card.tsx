import React from "react";
import type { ImpactLineageView } from "./impact-lineage.js";

function standingCopy(lineage: ImpactLineageView): { headline: string; detail: string } {
  if (lineage.standing === "impact") {
    return {
      headline: "Provider → code path",
      detail: "Each finding is the path from the provider change to the affected symbol.",
    };
  }
  if (lineage.standing === "no_impact") {
    return {
      headline: "No impact — verified",
      detail: "This consumer was analyzed and no affected symbols were recorded.",
    };
  }
  if (lineage.reason === "change_detail_unavailable") {
    return {
      headline: "Impact lineage unavailable",
      detail: "The change record could not be loaded. That is not a no-impact result.",
    };
  }
  return {
    headline: "Impact lineage unknown",
    detail: "No verified no-impact result is recorded for this consumer.",
  };
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
