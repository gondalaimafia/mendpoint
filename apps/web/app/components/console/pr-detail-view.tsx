"use client";

import React from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  Badge,
  CheckCircleIcon,
  DiffView,
  ExternalLinkIcon,
  GitMergeIcon,
  StatusPill,
  WandSparklesIcon,
  type DiffHunk,
} from "../ds/index.js";
import { PR_DETAIL_CHECKS, type PullRequest } from "./fixtures.js";
import { approveAndMerge } from "./interactions.js";

const CLIENT_HUNKS: DiffHunk[] = [
  {
    header: "@@ -14,7 +14,7 @@",
    lines: [
      { type: "ctx", line: 14, text: "  const pay = new Payments(process.env.KEY);" },
      { type: "del", line: 15, text: "  await pay.charge(order.total, 'usd');" },
      { type: "add", line: 15, text: "  await pay.charges.create({ amount: order.total });" },
      { type: "ctx", line: 16, text: "  return { ok: true };" },
    ],
  },
];

const SESSION_HUNKS: DiffHunk[] = [
  {
    header: "@@ -62,4 +62,4 @@",
    lines: [
      { type: "del", line: 62, text: "  const c = await pay.charge(total, currency);" },
      { type: "add", line: 62, text: "  const c = await pay.charges.create({ amount: total, currency });" },
    ],
  },
];

/**
 * `/prs/[id]` — one PR in review. Back link, a title row with the `StatusPill`,
 * an outline "Open on GitHub" and the single indigo "Approve & merge" CTA, then
 * an amber alert naming the breaking change. The body is a two-column grid:
 * stacked `DiffView`s on the left, checks and provenance cards on the right.
 * Approve & merge fires the success toast.
 */
export function PrDetailView({ pr }: { pr: PullRequest }) {
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
            {pr.title} <span className="ds-detail__num">#{pr.number}</span>
          </h1>
        </div>
        <div className="ds-detail__actions">
          <button type="button" className="ds-btn ds-btn--outline">
            <ExternalLinkIcon size={15} />
            Open on GitHub
          </button>
          <button
            type="button"
            className="ds-btn ds-btn--primary indigo-glow"
            onClick={() => approveAndMerge(pr.number)}
          >
            <GitMergeIcon size={15} />
            Approve &amp; merge
          </button>
        </div>
      </header>

      <div className="ds-alert" role="note">
        <AlertTriangleIcon size={16} className="ds-alert__icon" />
        <div>
          <strong className="ds-alert__title">
            Breaking change · POST /v1/charges
          </strong>
          charge() was removed in v3.0.0. Transformer rewrote 6 call sites and
          left inline notes where behavior changed.
        </div>
      </div>

      <div className="ds-detail__body">
        <div className="ds-detail__diffs">
          <DiffView path="src/api/client.ts" hunks={CLIENT_HUNKS} additions={12} deletions={9} />
          <DiffView path="src/checkout/session.ts" hunks={SESSION_HUNKS} additions={4} deletions={4} />
        </div>
        <aside className="ds-detail__aside">
          <div className="ds-panel ds-panel--pad">
            <div className="section-label section-label--muted">CHECKS</div>
            <ul className="ds-check-list">
              {PR_DETAIL_CHECKS.map((check) => (
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
              <span>Transformer</span>
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
