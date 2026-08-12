"use client";

import React from "react";
import { GitPullRequestIcon } from "./icons.js";
import { StatusPill, type Status } from "./status-pill.js";
import { Badge } from "./badge.js";

/**
 * A staged migration PR — the app's primary list object. Title, repo, a
 * `StatusPill`, and a mono meta row (+adds / -dels / files / checks / time).
 * The lead icon is tinted by the authoring agent (warden->cyan,
 * transformer->indigo). Pass `onClick` to make the row a lift-on-hover target.
 */
export function PullRequestCard({
  repo,
  title,
  number,
  status = "open",
  agent = "transformer",
  additions = 0,
  deletions = 0,
  files = 0,
  checks,
  time,
  onClick,
  children,
}: {
  repo: string;
  title: string;
  number?: number | string;
  status?: Status;
  agent?: "warden" | "transformer";
  additions?: number;
  deletions?: number;
  files?: number;
  checks?: "passing" | "failing" | "running";
  time?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const interactive = Boolean(onClick);
  return (
    <div
      className={`ds-pr-card ${interactive ? "ds-pr-card--interactive lift" : ""}`.trim()}
      onClick={onClick}
    >
      <div className="ds-pr-card__head">
        <GitPullRequestIcon
          size={16}
          className={`ds-pr-card__icon--${agent}`}
        />
        <span className="ds-pr-card__repo">{repo}</span>
        <span className="ds-pr-card__status">
          <StatusPill status={status} />
        </span>
      </div>
      <div className="ds-pr-card__titlerow">
        <h3 className="ds-pr-card__title">{title}</h3>
        {number != null && <span className="ds-pr-card__num">#{number}</span>}
      </div>
      {children}
      <div className="ds-pr-card__meta">
        <span>
          <span className="add">+{additions}</span>{" "}
          <span className="del">&minus;{deletions}</span>
        </span>
        <span>{files} files</span>
        {checks && (
          <Badge tone={checks === "failing" ? "danger" : "neutral"}>
            {checks}
          </Badge>
        )}
        {time && <span className="ds-pr-card__time">{time}</span>}
      </div>
    </div>
  );
}
