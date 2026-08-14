import React from "react";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  DiffView,
  ExternalLinkIcon,
  StatusPill,
  WandSparklesIcon,
} from "../ds/index.js";
import Link from "next/link";
import type { PrDetailData } from "./fixtures.js";

/**
 * `/prs/[id]` — one PR in review, driven by live data (`PrDetailData`) fetched
 * in the page. Back link, a title row with the `StatusPill` and an outline
 * "Open on GitHub", then (when the linked change is breaking) an amber alert
 * naming it. The body is a two-column grid: stacked `DiffView`s parsed from the
 * PR's unified patch on the left, checks and provenance cards on the right. The
 * single indigo primary action ("Approve & merge") lives in the console topbar,
 * wired by `ConsoleShell`.
 */
export function PrDetailView({ pr }: { pr: PrDetailData }) {
  return (
    <div className="ds-view">
      <Link className="ds-link-ghost ds-detail__back" href="/prs">
        <ArrowLeftIcon size={14} />
        All pull requests
      </Link>

      <header className="ds-detail__header">
        <div>
          <div className="ds-detail__eyebrow">
            <span className="ds-detail__repo">{pr.repo}</span>
            <StatusPill status={pr.status} />
          </div>
          <h1 className="ds-view__title">
            {pr.title}{" "}
            {pr.number != null && (
              <span className="ds-detail__num">#{pr.number}</span>
            )}
          </h1>
        </div>
        <div className="ds-detail__actions">
          {pr.githubUrl ? (
            <a
              href={pr.githubUrl}
              target="_blank"
              rel="noreferrer"
              className="ds-btn ds-btn--outline"
            >
              <ExternalLinkIcon size={15} />
              Open on GitHub
            </a>
          ) : (
            <button type="button" className="ds-btn ds-btn--outline" disabled>
              <ExternalLinkIcon size={15} />
              Open on GitHub
            </button>
          )}
        </div>
      </header>

      {pr.alert && (
        <div className="ds-alert" role="note">
          <AlertTriangleIcon size={16} className="ds-alert__icon" />
          <div>
            <strong className="ds-alert__title">{pr.alert.title}</strong>
            {pr.alert.body}
          </div>
        </div>
      )}

      <div className="ds-detail__body">
        <div className="ds-detail__diffs">
          {pr.diffs.length === 0 && (
            <p className="ds-diff__note">No unified patch is recorded for this PR.</p>
          )}
          {pr.diffs.map((diff, i) => (
            <DiffView
              key={`${diff.path}-${i}`}
              path={diff.path}
              hunks={diff.hunks}
              additions={diff.additions}
              deletions={diff.deletions}
            />
          ))}
        </div>
        <aside className="ds-detail__aside">
          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">CHECKS</div>
            <ul className="ds-check-list">
              {pr.checks.length === 0 && (
                <li className="ds-check-row">
                  No checks recorded
                  <span className="ds-check-row__state">—</span>
                </li>
              )}
              {pr.checks.map((check) => (
                <li key={check.name} className="ds-check-row">
                  <CheckCircleIcon size={14} className="ds-check-row__icon" />
                  {check.name}
                  <span className="ds-check-row__state">{check.state}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">AUTHORED BY</div>
            <div className="ds-author">
              <WandSparklesIcon size={16} className="ds-author__icon" />
              <span>Regauge</span>
            </div>
            <p className="ds-author__note">
              Draft by default. Merging is always a human action.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
