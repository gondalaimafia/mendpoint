"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { PullRequestCard, SectionLabel } from "../ds/index.js";
import {
  PR_TABS,
  filterPullRequests,
  type PrTab,
  type PullRequest,
} from "./fixtures.js";

/**
 * `/prs` — Transformer's pull-request list, driven by the live `/prs` feed. A
 * tab control (All / Needs review / Failing / Merged) filters the list
 * client-side; each tab's count is derived from the real list. Every row is a
 * DS2 `PullRequestCard` staggered on mount and routes to the detail by PR id.
 * No indigo CTA lives here — the console frame owns the single one.
 */
export function PrsView({
  prs,
  unavailable = false,
}: {
  prs: PullRequest[];
  unavailable?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState<PrTab>("all");
  const visible = filterPullRequests(prs, tab);

  // `unavailable` means the `/prs` feed failed to load. An empty list (prs.length
  // === 0) is a known-empty result; a failed fetch is unknown. We must not render
  // "No pull requests staged yet." or zero-count tabs for a failure, because that
  // certifies a rejected fetch as an authoritative "none are staged".
  if (unavailable) {
    return (
      <div className="ds-view">
        <header className="ds-view__header ds-view__header--stack">
          <SectionLabel tone="muted">REGAUGE</SectionLabel>
          <h1 className="ds-view__title">Pull requests unavailable</h1>
        </header>
        <div className="ds-pr-list">
          <p className="ds-pr-card__repo" style={{ padding: "1rem" }}>
            The pull request feed did not load. This is not a claim that none are
            staged: retry, or confirm the API is reachable.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-view">
      <header className="ds-view__header ds-view__header--stack">
        <SectionLabel tone="muted">REGAUGE</SectionLabel>
        <h1 className="ds-view__title">Pull requests</h1>
      </header>

      <div className="ds-tabs" role="tablist" aria-label="Pull request status">
        {PR_TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`ds-tab ${active ? "ds-tab--active" : ""}`.trim()}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              <span className="ds-tab__count">
                {filterPullRequests(prs, t.id).length}
              </span>
            </button>
          );
        })}
      </div>

      <div className="ds-pr-list">
        {visible.length === 0 && (
          <p className="ds-pr-card__repo" style={{ padding: "1rem" }}>
            {prs.length === 0
              ? "No pull requests staged yet."
              : "No pull requests in this view."}
          </p>
        )}
        {visible.map((pr, i) => (
          <div
            key={pr.id}
            className="fade-up"
            style={{ "--i": i } as React.CSSProperties}
          >
            <PullRequestCard
              repo={pr.repo}
              title={pr.title}
              number={pr.number ?? undefined}
              status={pr.status}
              agent="transformer"
              additions={pr.additions}
              deletions={pr.deletions}
              files={pr.files}
              checks={pr.checks}
              time={pr.time}
              onClick={() => router.push(`/prs/${pr.id}`)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
