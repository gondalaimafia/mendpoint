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
 * `/prs` — Transformer's pull-request list. A tab control (All / Needs review /
 * Failing / Merged, counts in a mono chip) filters the list client-side; each
 * row is a DS2 `PullRequestCard` staggered on mount and routes to the detail on
 * click. No indigo CTA lives here — the console frame owns the single one.
 */
export function PrsView({ prs }: { prs: PullRequest[] }) {
  const router = useRouter();
  const [tab, setTab] = React.useState<PrTab>("all");
  const visible = filterPullRequests(prs, tab);

  return (
    <div className="ds-view">
      <header className="ds-view__header ds-view__header--stack">
        <SectionLabel tone="muted">TRANSFORMER</SectionLabel>
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
              <span className="ds-tab__count">{t.count}</span>
            </button>
          );
        })}
      </div>

      <div className="ds-pr-list">
        {visible.map((pr, i) => (
          <div
            key={pr.number}
            className="fade-up"
            style={{ "--i": i } as React.CSSProperties}
          >
            <PullRequestCard
              repo={pr.repo}
              title={pr.title}
              number={pr.number}
              status={pr.status}
              agent="transformer"
              additions={pr.additions}
              deletions={pr.deletions}
              files={pr.files}
              checks={pr.checks}
              time={pr.time}
              onClick={() => router.push(`/prs/${pr.number}`)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
