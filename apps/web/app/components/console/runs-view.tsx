"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { SectionLabel, StatusPill } from "../ds/index.js";
import { ScanTrigger } from "../../consumer/scan-trigger.js";
import { RUN_TABS, filterRuns, type RunSummary, type RunTab } from "./fixtures.js";

/**
 * `/runs` — the tenant's agent runs, driven by the live `/self-serve/runs` feed.
 * A tab control filters by lifecycle status client-side; each row is a run
 * (scan or Warden) with its DS `StatusPill`, target, timing, and trigger, and
 * routes to the detail. "Start" reuses the existing `ScanTrigger` (the shipped
 * self-serve start control). No indigo CTA lives here — the run controls are
 * neutral, and start is the reused trigger.
 */
export function RunsView({ runs }: { runs: RunSummary[] }) {
  const router = useRouter();
  const [tab, setTab] = React.useState<RunTab>("all");
  const visible = filterRuns(runs, tab);

  return (
    <div className="ds-view">
      <header className="ds-view__header ds-view__header--stack">
        <SectionLabel tone="muted">RUNS</SectionLabel>
        <h1 className="ds-view__title">Runs</h1>
      </header>

      <div className="ds-panel ds-panel--pad">
        <div className="section-label section-label--muted">START A RUN</div>
        <div className="ds-run-start">
          <ScanTrigger />
          <p className="ds-author__note">
            Scans your monitored providers for breaking changes and queues the
            impact run. Every change still goes through human review before any
            pull request is merged.
          </p>
        </div>
      </div>

      <div className="ds-tabs" role="tablist" aria-label="Run status">
        {RUN_TABS.map((t) => {
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
              <span className="ds-tab__count">{filterRuns(runs, t.id).length}</span>
            </button>
          );
        })}
      </div>

      <div className="ds-run-list">
        {visible.length === 0 && (
          <p className="ds-run-empty">
            {runs.length === 0
              ? "No runs yet. Start a scan to queue your first run."
              : "No runs in this view."}
          </p>
        )}
        {visible.map((run, i) => (
          <button
            key={run.id}
            type="button"
            className="ds-run-card fade-up"
            style={{ "--i": i } as React.CSSProperties}
            onClick={() => router.push(`/runs/${run.id}`)}
          >
            <div className="ds-run-card__head">
              <span className="ds-run-card__target">{run.target ?? run.id}</span>
              <span className="ds-run-card__type">{run.type}</span>
              <span className="ds-run-card__status">
                <StatusPill
                  status={run.status}
                  label={run.statusLabel}
                  pulse={run.status === "pending"}
                />
              </span>
            </div>
            {run.goal && <p className="ds-run-card__goal">{run.goal}</p>}
            <div className="ds-run-card__meta">
              <span>{run.timeLabel}</span>
              {run.durationLabel && <span>ran {run.durationLabel}</span>}
              <span>by {run.triggeredBy ?? "not recorded"}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
