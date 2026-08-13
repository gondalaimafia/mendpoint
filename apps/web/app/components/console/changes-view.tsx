import React from "react";
import Link from "next/link";
import { ArrowRightIcon, Badge, SectionLabel, type BadgeTone } from "../ds/index.js";
import type { ChangesData, Severity } from "./fixtures.js";

/**
 * `/changes` — Warden's breaking-change overview. Presentational server
 * component driven by live data (`ChangesData`) fetched in the page: eyebrow +
 * version title, a four-stat grid, then the spec-diff table. Amber is confined
 * to the breaking-changes stat and the "N BREAKING" header badge (Step-7: amber
 * only on breaking). The per-row severity badges map breaking -> danger, safe ->
 * emerald; deprecated is neutral rather than amber so amber stays exclusive to
 * breaking. When the API has no change to show, an honest empty state renders.
 */
const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  breaking: "danger",
  deprecated: "neutral",
  safe: "emerald",
};

export function ChangesView({ data }: { data: ChangesData | null }) {
  if (!data || data.changes.length === 0) {
    return (
      <div className="ds-view">
        <header className="ds-view__header ds-view__header--stack">
          <SectionLabel tone="warden">WARDEN</SectionLabel>
          <h1 className="ds-view__title">{data?.target ?? "No breaking changes"}</h1>
        </header>
        <section className="ds-panel">
          <div className="ds-panel__head">
            <span className="ds-panel__title">Spec diff</span>
          </div>
          <p className="ds-spec-row__note" style={{ padding: "1rem" }}>
            No structural change is staged yet. Warden populates this view once a
            provider spec is analyzed.
          </p>
        </section>
      </div>
    );
  }

  const breakingCount = data.changes.filter(
    (c) => c.severity === "breaking",
  ).length;

  return (
    <div className="ds-view">
      <header className="ds-view__header ds-view__header--stack">
        <SectionLabel tone="warden">WARDEN</SectionLabel>
        <h1 className="ds-view__title">{data.target}</h1>
      </header>

      <div className="ds-stat-grid">
        {data.stats.map((stat, i) => (
          <div
            key={stat.label}
            className="ds-stat fade-up"
            style={{ "--i": i } as React.CSSProperties}
          >
            <div className="ds-stat__label">{stat.label}</div>
            <div className={`ds-stat__figure ds-stat__figure--${stat.tone}`}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <section className="ds-panel">
        <div className="ds-panel__head">
          <span className="ds-panel__title">Spec diff</span>
          <Badge tone="warn">{breakingCount} BREAKING</Badge>
          <Link className="ds-link-ghost" href="/prs">
            View staged PRs
            <ArrowRightIcon size={14} />
          </Link>
        </div>
        <ul className="ds-spec-list">
          {data.changes.map((change, i) => (
            <li
              key={`${change.endpoint}-${i}`}
              className="ds-spec-row fade-up"
              style={{ "--i": i } as React.CSSProperties}
            >
              <Badge tone={SEVERITY_TONE[change.severity]}>
                {change.severity.toUpperCase()}
              </Badge>
              <span className="ds-spec-row__endpoint">{change.endpoint}</span>
              <span className="ds-spec-row__note">{change.note}</span>
              <span className="ds-spec-row__meta">
                {change.repos} repos · {change.calls} calls
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
