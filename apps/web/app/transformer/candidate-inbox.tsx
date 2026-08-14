"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  candidateLifecycle,
  mergeAdaptiveCandidateHistory,
  pendingAdaptiveCandidates,
  type AdaptiveCandidateInboxPage,
  type AdaptiveCandidateSummary,
} from "./candidate-model";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const HISTORY_PAGE_SIZE = 25;

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? response.statusText);
  return body;
}

export function AdaptiveCandidateInbox() {
  const [attention, setAttention] = useState<AdaptiveCandidateSummary[]>([]);
  const [history, setHistory] = useState<AdaptiveCandidateSummary[]>([]);
  const [nextHistoryCursor, setNextHistoryCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${API_URL}/regauge/adaptive-candidates?historyLimit=${HISTORY_PAGE_SIZE}`,
        {
        cache: "no-store",
        signal,
        },
      );
      const body = await responseJson<AdaptiveCandidateInboxPage>(response);
      setAttention([...body.attention]);
      setHistory([...body.history]);
      setNextHistoryCursor(body.nextHistoryCursor);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  const pendingCount = pendingAdaptiveCandidates(attention).length;

  async function loadMoreHistory(): Promise<void> {
    if (!nextHistoryCursor || loadingHistory) return;
    setLoadingHistory(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        historyLimit: String(HISTORY_PAGE_SIZE),
        historyCursor: nextHistoryCursor,
      });
      const response = await fetch(`${API_URL}/regauge/adaptive-candidates?${query}`, {
        cache: "no-store",
      });
      const body = await responseJson<AdaptiveCandidateInboxPage>(response);
      setAttention([...body.attention]);
      setHistory((current) => mergeAdaptiveCandidateHistory(current, body.history));
      setNextHistoryCursor(body.nextHistoryCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingHistory(false);
    }
  }

  function candidateList(
    records: readonly AdaptiveCandidateSummary[],
    label: string,
  ) {
    return (
      <ol className="transformer-candidate-list" aria-label={label}>
        {records.map((candidate) => {
          const lifecycle = candidateLifecycle(candidate);
          return (
            <li key={candidate.id}>
              <div className="transformer-candidate-main">
                <div className="transformer-candidate-title">
                  <code>{candidate.repositoryId}</code>
                  <span className={`state-pill ${lifecycle.tone === "neutral" ? "" : lifecycle.tone}`}>
                    {lifecycle.label}
                  </span>
                </div>
                <strong>{candidate.unitId}</strong>
                <span className="muted small">
                  {candidate.changedFileCount} {candidate.changedFileCount === 1 ? "file" : "files"}.
                  {candidate.status === "review_pending"
                    ? ` Review before ${new Date(candidate.expiresAt).toLocaleString()}.`
                    : candidate.reviewedAt
                      ? ` Decision recorded ${new Date(candidate.reviewedAt).toLocaleString()}.`
                      : " Lifecycle evidence retained."}
                </span>
                <span className="muted small">
                  Generation {candidate.generation}.
                  {candidate.supersedesCandidateId ? ` Regenerated from ${candidate.supersedesCandidateId}.` : ""}
                  {candidate.supersededByCandidateId ? ` Replaced by ${candidate.supersededByCandidateId}.` : ""}
                </span>
                {candidate.regeneration && (
                  <span className="muted small">
                    {candidate.regeneration.externalProcessingAuthorizationRequired
                      ? candidate.regeneration.authorizationMessage
                      : `Regeneration ${candidate.regeneration.status}.`}
                    {` Reviewer ${candidate.regeneration.reviewerPrincipalId}.`}
                  </span>
                )}
                {candidate.delivery?.errorCode && (
                  <span className="muted small">Delivery error: {candidate.delivery.errorCode}</span>
                )}
              </div>
              <div className="transformer-candidate-links">
                <Link
                  className={`btn ${candidate.status === "review_pending" ? "primary" : ""}`}
                  href={`/transformer/candidates/${encodeURIComponent(candidate.id)}`}
                  prefetch={false}
                  aria-label={`${lifecycle.action} for ${candidate.repositoryId}`}
                >
                  {lifecycle.action}
                </Link>
                {candidate.delivery?.draftPrUrl && (
                  <a
                    className="btn"
                    href={candidate.delivery.draftPrUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open delivered draft pull request for ${candidate.repositoryId}`}
                  >
                    Open draft pull request
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    );
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <section
      className="surface transformer-candidate-inbox"
      aria-labelledby="adaptive-inbox-title"
      aria-busy={loading}
    >
      <div className="section-head">
        <div>
          <p className="eyebrow">Human review inbox</p>
          <h2 id="adaptive-inbox-title">Adaptive candidates</h2>
          <p className="muted small">
            Review the exact proposed files before any draft pull request is created.
          </p>
        </div>
        <div className="transformer-inbox-actions">
          <span className={`state-pill ${attention.length ? "active" : ""}`}>
            {loading ? "Checking" : `${pendingCount} pending`}
          </span>
          <button className="btn" type="button" disabled={loading} onClick={() => void load()}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="transformer-review-problem" role="alert">
          <strong>Candidate inbox unavailable</strong>
          <p>{error}</p>
        </div>
      )}

      {!error && !loading && attention.length === 0 && (
        <div className="empty-state compact" role="status">
          <p>No adaptive candidates need attention.</p>
        </div>
      )}

      {attention.length > 0 && candidateList(
        attention,
        "Adaptive candidates needing attention",
      )}

      <div className="section-head transformer-history-heading">
        <div>
          <p className="eyebrow">Review history</p>
          <h3>Decisions and delivery evidence</h3>
        </div>
        <div className="transformer-inbox-actions">
          <span className="state-pill">{history.length} loaded</span>
          {nextHistoryCursor && (
            <button
              className="btn"
              type="button"
              disabled={loading || loadingHistory}
              onClick={() => void loadMoreHistory()}
            >
              {loadingHistory ? "Loading history" : "Load more history"}
            </button>
          )}
        </div>
      </div>
      {!loading && history.length === 0 ? (
        <div className="empty-state compact" role="status">
          <p>No completed adaptive reviews yet.</p>
        </div>
      ) : candidateList(history, "Adaptive candidate review history")}
    </section>
  );
}
