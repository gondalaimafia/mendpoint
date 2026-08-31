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
import { CoverageBadge } from "./coverage.js";

function deliveryLabel(status: NonNullable<PullRequest["candidateEvidence"]>["deliveryStatus"]): string {
  if (status === "delivery_pending") return "Delivery pending";
  if (status === "delivery_failed") return "Delivery needs attention";
  return "Draft delivered";
}

function CandidateEvidence({ pr }: { pr: PullRequest }) {
  const evidence = pr.candidateEvidence;
  if (!evidence) return null;
  const change = evidence.providerChange;
  return (
    <div className="ds-pr-card__evidence">
      <p><strong>Fettler verified candidate</strong> · {deliveryLabel(evidence.deliveryStatus)}</p>
      <dl>
        <div><dt>Repository</dt><dd><code>{evidence.repositoryId}</code></dd></div>
        <div><dt>Snapshot</dt><dd><code>{evidence.snapshotId}</code></dd></div>
        <div><dt>Base revision</dt><dd><code>{evidence.expectedBaseRevision}</code></dd></div>
        {change && <>
          <div><dt>Provider change</dt><dd>{change.providerSlug} · <code>{change.changeId}</code></dd></div>
          <div><dt>Provider versions</dt><dd>{change.fromVersionLabel} to {change.toVersionLabel}</dd></div>
          <div><dt>What changed</dt><dd>{change.whatChanged}</dd></div>
          <div><dt>Change Graph</dt><dd>{change.graphVersionId ? <code>{change.graphVersionId}</code> : "No graph version was recorded"}</dd></div>
          <div><dt>Graph context</dt><dd>{change.graphContextArtifactId ? <code>{change.graphContextArtifactId}</code> : "No graph context artifact was recorded"}</dd></div>
          <div><dt>Impact evidence</dt><dd><code>{change.impactEvidenceDigest}</code></dd></div>
          <div><dt>Why this code is affected</dt><dd>{change.whyAffected}</dd></div>
        </>}
        <div><dt>Proposed migration</dt><dd>{evidence.proposedMigration.summary}</dd></div>
        {evidence.proposedMigration.edits.map((edit, index) => <div key={`${edit.path}:${index}`}>
          <dt>Proposed edit</dt>
          <dd><code>{edit.path}</code>: {edit.explanation}{edit.risk ? ` Risk: ${edit.risk}.` : ""}</dd>
        </div>)}
        <div><dt>Verification</dt><dd>{evidence.verification.summary}</dd></div>
        <div><dt>Verification commands</dt><dd>{evidence.verification.commands.map((command, index) => <code key={`${command.outputSha256}:${index}`}>{command.command}</code>)}</dd></div>
      </dl>
      {change ? <div className="ds-pr-card__known-unknown">
        <div><strong>What we know</strong><ul>{change.knownFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>
        <div><strong>What we do not know</strong><ul>{change.unknowns.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>
      </div> : <p>Provider change evidence was not included in this historical seal.</p>}
      {pr.githubUrl && <p>
        <a href={pr.githubUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
          Open the reviewable draft in GitHub
        </a>
      </p>}
    </div>
  );
}

/**
 * `/prs` is Fettler's pull request list, driven by the live `/prs` feed. A
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
          <SectionLabel tone="muted">FETTLER</SectionLabel>
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
        <SectionLabel tone="muted">FETTLER</SectionLabel>
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
              agent="warden"
              additions={pr.additions}
              deletions={pr.deletions}
              files={pr.files}
              checks={pr.checks}
              time={pr.time}
              onClick={pr.candidateEvidence ? undefined : () => router.push(`/prs/${pr.id}`)}
            >
              {pr.coverage && <CoverageBadge summary={pr.coverage} />}
              <CandidateEvidence pr={pr} />
            </PullRequestCard>
          </div>
        ))}
      </div>
    </div>
  );
}
