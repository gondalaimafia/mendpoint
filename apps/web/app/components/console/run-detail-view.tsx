import React from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  DiffView,
  ExternalLinkIcon,
  StatusPill,
  Terminal,
  type TerminalLine,
} from "../ds/index.js";
import { RunControls } from "./run-controls.js";
import type { RunDetailData } from "./fixtures.js";

/**
 * `/runs/[id]` — one run, assembled from REAL data by the page. Left column: the
 * plan (when the run produced one), the execution log in the DS `Terminal`, and
 * code changes (DiffView on the resulting PR patch, else the changed-file list).
 * Right column: verification results, resulting PR(s) with link + status, the
 * pause/retry controls (wired to the existing queue endpoints), and the handoff
 * to the existing review surface. Every panel shows an honest empty state when
 * the datum does not exist for this run type — never a fabricated plan or log.
 */
function logToLines(log: string): TerminalLine[] {
  return log.split("\n").map((text) => {
    if (text.startsWith("## ") || text.startsWith("### ")) return { type: "warn", text };
    if (/\b(fail|error)\b/i.test(text)) return { type: "err", text };
    if (/\b(ok|pass|done|approve)\b/i.test(text)) return { type: "ok", text };
    return { type: "out", text };
  });
}

export function RunDetailView({ data }: { data: RunDetailData }) {
  const { run } = data;
  return (
    <div className="ds-view">
      <Link className="ds-link-ghost ds-detail__back" href="/runs">
        <ArrowLeftIcon size={14} />
        All runs
      </Link>

      <header className="ds-detail__header">
        <div>
          <div className="ds-detail__eyebrow">
            <span className="ds-detail__repo">{run.target ?? run.id}</span>
            <StatusPill
              status={run.status}
              label={run.statusLabel}
              pulse={run.status === "pending"}
            />
            <span className="ds-run-card__type">{run.type}</span>
          </div>
          <h1 className="ds-view__title">{run.goal ?? "Run"}</h1>
        </div>
        <div className="ds-detail__actions">
          {data.reviewHref ? (
            <Link href={data.reviewHref} className="ds-btn ds-btn--outline">
              Open review
            </Link>
          ) : (
            <button type="button" className="ds-btn ds-btn--outline" disabled>
              Open review
            </button>
          )}
        </div>
      </header>

      <div className="ds-detail__body">
        <div className="ds-detail__diffs">
          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">PLAN</div>
            {data.plan ? (
              <ul className="ds-run-plan">
                {data.plan.steps.map((step, i) => (
                  <li key={i} className="ds-run-plan__step">
                    <span className="ds-run-plan__state">{step.status}</span>
                    <span>{step.title}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ds-author__note">
                No plan was recorded for this run type.
              </p>
            )}
          </div>

          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">EXECUTION LOG</div>
            {data.log ? (
              <Terminal lines={logToLines(data.log)} />
            ) : (
              <p className="ds-author__note">
                No execution log was recorded for this run.
              </p>
            )}
          </div>

          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">CODE CHANGES</div>
            {data.diffs.length > 0 ? (
              <div className="ds-detail__diffs">
                {data.diffs.map((diff, i) => (
                  <DiffView
                    key={`${diff.path}-${i}`}
                    path={diff.path}
                    hunks={diff.hunks}
                    additions={diff.additions}
                    deletions={diff.deletions}
                  />
                ))}
              </div>
            ) : data.changedPaths.length > 0 ? (
              <>
                <ul className="ds-run-files">
                  {data.changedPaths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                <p className="ds-author__note">
                  The full diff opens in the review surface.
                </p>
              </>
            ) : (
              <p className="ds-author__note">
                No file changes are recorded for this run.
              </p>
            )}
          </div>
        </div>

        <aside className="ds-detail__aside">
          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">VERIFICATION</div>
            <ul className="ds-check-list">
              {data.verification.length === 0 && (
                <li className="ds-check-row">
                  Not run
                  <span className="ds-check-row__state">—</span>
                </li>
              )}
              {data.verification.map((check) => (
                <li key={check.name} className="ds-check-row">
                  <CheckCircleIcon size={14} className="ds-check-row__icon" />
                  {check.name}
                  <span className="ds-check-row__state">{check.state}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">PULL REQUESTS</div>
            <ul className="ds-check-list">
              {data.prs.length === 0 && (
                <li className="ds-check-row">
                  None opened yet
                  <span className="ds-check-row__state">—</span>
                </li>
              )}
              {data.prs.map((pr, i) => (
                <li key={i} className="ds-check-row">
                  {pr.url ? (
                    <a href={pr.url} target="_blank" rel="noreferrer" className="ds-link-ghost">
                      <ExternalLinkIcon size={13} />
                      {pr.number != null ? `#${pr.number}` : "pull request"}
                    </a>
                  ) : (
                    <span>{pr.number != null ? `#${pr.number}` : "pull request"}</span>
                  )}
                  <span className="ds-check-row__state">{pr.status}</span>
                </li>
              ))}
            </ul>
          </div>

          <RunControls
            runId={run.id}
            canCancel={run.canCancel}
            cancelReason={run.cancelReason}
            canRetry={run.canRetry}
            retryReason={run.retryReason}
          />
        </aside>
      </div>
    </div>
  );
}
