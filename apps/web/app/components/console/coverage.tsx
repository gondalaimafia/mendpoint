import React from "react";
import {
  AlertTriangleIcon,
  Badge,
  CheckCircleIcon,
  ShieldAlertIcon,
  type BadgeTone,
} from "../ds/index.js";
import type { CoverageSummary } from "./pr-map.js";

/**
 * Impact-coverage surfaces shared by `/prs` (list badge) and `/prs/[id]`
 * (detail card). They render the §11.7 / §12.4 distinction the DS `Status` pill
 * cannot: a verified-clean result (analyzed, empty findings) versus no-known
 * impact under partial coverage versus no basis at all versus absent coverage.
 * Pure presentational components — no hooks — so both the server-rendered detail
 * view and the client `PrsView` can use them.
 */

const COVERAGE_ICON = {
  clean: CheckCircleIcon,
  covered: CheckCircleIcon,
  no_known_impact: AlertTriangleIcon,
  no_basis: ShieldAlertIcon,
  unknown: ShieldAlertIcon,
} as const;

const COVERAGE_BADGE_TONE: Record<CoverageSummary["tone"], BadgeTone> = {
  emerald: "emerald",
  amber: "warn",
  neutral: "neutral",
};

/** Compact list-card badge naming the coverage state. */
export function CoverageBadge({ summary }: { summary: CoverageSummary }) {
  return (
    <span className="ds-pr-card__coverage">
      <Badge tone={COVERAGE_BADGE_TONE[summary.tone]}>{summary.badge}</Badge>
    </span>
  );
}

/** Detail-panel card: headline, explanation, file counts, and typed gap reasons. */
export function CoverageCard({ summary }: { summary: CoverageSummary }) {
  const Icon = COVERAGE_ICON[summary.state];
  return (
    <div className={`ds-panel ds-panel--pad ds-coverage ds-coverage--${summary.state}`}>
      <div className="section-label section-label--muted">IMPACT COVERAGE</div>
      <div className="ds-coverage__head">
        <Icon size={16} className="ds-coverage__icon" />
        <span className="ds-coverage__headline">{summary.headline}</span>
      </div>
      <p className="ds-coverage__detail">{summary.detail}</p>
      {summary.files && <p className="ds-coverage__files">{summary.files}</p>}
      {summary.gaps.length > 0 && (
        <ul className="ds-coverage__gaps">
          {summary.gaps.map((gap, i) => (
            <li key={`${gap.reason}-${i}`} className="ds-coverage__gap">
              <span className="ds-coverage__gap-reason">{gap.reason}</span>
              {" — "}
              {gap.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
