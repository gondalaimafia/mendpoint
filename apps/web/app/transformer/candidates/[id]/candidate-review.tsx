"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  adaptiveReviewActionEnabled,
  candidateStatusLabel,
  formatCandidateBytes,
  reviewReadiness,
  type AdaptiveCandidateDetail,
  type AdaptiveDeliveryView,
  type AdaptiveReviewRisk,
  type AdaptiveReviewResponse,
  type AdaptiveSemanticCategory,
  type AdaptiveSemanticReview,
} from "../../candidate-model";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type Notice = Readonly<{ tone: "error" | "success" | "neutral"; text: string }>;

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? response.statusText);
  return body;
}

function statusTone(status: AdaptiveCandidateDetail["status"]): string {
  if (status === "approved" || status === "promoted") return "success";
  return status === "review_pending" ? "active" : "";
}

function evidencePresentation(candidate: AdaptiveCandidateDetail): Readonly<{
  label: string;
  tone: string;
  description: string;
}> {
  if (candidate.evidenceStatus === "verified") {
    return {
      label: "Seal verified",
      tone: "success",
      description: "The retained evidence matches its recorded digest.",
    };
  }
  if (candidate.evidenceStatus === "retention_cleaned") {
    return {
      label: "Retention complete",
      tone: "",
      description: "The exact file content was intentionally removed after this review closed.",
    };
  }
  return {
    label: "Seal verification failed",
    tone: "danger",
    description: "The retained evidence could not be verified against its recorded digest.",
  };
}

function reviewErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    adaptive_candidate_expired: "This candidate expired before it could be reviewed.",
    adaptive_candidate_preview_incomplete: "Approval is blocked because the complete proposed change is unavailable.",
    adaptive_candidate_review_evidence_incomplete: "Approval is blocked because the complete explanation and verification evidence is unavailable.",
    human_review_required: "A direct human reviewer session is required for this decision.",
    adaptive_candidate_seal_digest_mismatch: "The sealed candidate no longer matches its recorded digest.",
    adaptive_candidate_record_binding_mismatch: "The candidate does not match its recorded repository evidence.",
  };
  return known[message] ?? message;
}

function semanticCategoryLabel(category: AdaptiveSemanticCategory): string {
  const labels: Record<AdaptiveSemanticCategory, string> = {
    behavior: "Product behavior",
    tests: "Tests",
    configuration: "Configuration",
    dependencies: "Dependencies",
    security: "Security",
    documentation: "Documentation",
    other: "Other changes",
  };
  return labels[category];
}

function riskTone(risk: AdaptiveReviewRisk): string {
  if (risk === "low") return "success";
  return risk === "high" ? "danger" : "active";
}

function fileModeLabel(mode: "100644" | "100755" | null): string {
  if (mode === null) return "Not present";
  return mode === "100755" ? "Executable" : "Regular file";
}

export function AdaptiveSemanticReviewPanel({
  review,
}: {
  review: AdaptiveSemanticReview;
}) {
  return (
    <section className="transformer-semantic-review" aria-labelledby="semantic-review-title">
      <div className="section-head">
        <div>
          <p className="eyebrow">Review by purpose</p>
          <h2 id="semantic-review-title">Why each change is proposed</h2>
        </div>
        <div className="transformer-review-summary" aria-label="Overall review assessment">
          <span className={`state-pill ${riskTone(review.overallRisk)}`}>
            {review.overallRisk} risk
          </span>
          <strong>{review.confidence}% confidence</strong>
        </div>
      </div>

      <section className="surface transformer-verification-summary" aria-labelledby="verification-title">
        <div>
          <p className="eyebrow">Final verification</p>
          <h3 id="verification-title">Objective check passed</h3>
        </div>
        <p>{review.verification.summary}</p>
        <dl className="kv transformer-review-kv">
          <dt>Command</dt><dd><code>{review.verification.commandId}</code></dd>
          <dt>Output digest</dt><dd><code>{review.verification.outputDigest}</code></dd>
        </dl>
      </section>

      {review.groups.map((group, groupIndex) => (
        <section
          className="transformer-semantic-group"
          key={`${group.category}-${groupIndex}`}
          aria-labelledby={`semantic-group-${group.category}-${groupIndex}`}
        >
          <div className="transformer-semantic-group-heading">
            <p className="eyebrow">Semantic category</p>
            <h3 id={`semantic-group-${group.category}-${groupIndex}`}>
              {semanticCategoryLabel(group.category)}
            </h3>
            <span>{group.edits.length} {group.edits.length === 1 ? "change" : "changes"}</span>
          </div>

          {group.edits.map((edit, editIndex) => (
            <article className="surface transformer-review-edit" key={edit.path}>
              <header>
                <div>
                  <span className="state-pill active">
                    {edit.changeType === "add" ? "New file" : "Modified file"}
                  </span>
                  <h4>{edit.path}</h4>
                </div>
                <div className="transformer-review-edit-assessment">
                  <span className={`state-pill ${riskTone(edit.risk)}`}>{edit.risk} risk</span>
                  <strong>{edit.confidence}% confidence</strong>
                </div>
              </header>

              <div className="transformer-edit-rationale">
                <strong>Why this edit is needed</strong>
                <p>{edit.rationale}</p>
              </div>

              <div className="transformer-before-after">
                <section aria-labelledby={`before-${groupIndex}-${editIndex}`}>
                  <header>
                    <strong id={`before-${groupIndex}-${editIndex}`}>Before</strong>
                    <span>{fileModeLabel(edit.beforeMode)}</span>
                    <span>{formatCandidateBytes(edit.bytes.before)}</span>
                  </header>
                  <code className="transformer-content-digest">{edit.beforeDigest}</code>
                  {edit.beforeContent === null ? (
                    <p className="transformer-new-file-state">This file did not exist in the approved recipe output.</p>
                  ) : (
                    <pre tabIndex={0} aria-label={`Content before the change to ${edit.path}`}>
                      <code>{edit.beforeContent}</code>
                    </pre>
                  )}
                </section>

                <section aria-labelledby={`after-${groupIndex}-${editIndex}`}>
                  <header>
                    <strong id={`after-${groupIndex}-${editIndex}`}>After</strong>
                    <span>{fileModeLabel(edit.afterMode)}</span>
                    <span>{formatCandidateBytes(edit.bytes.after)}</span>
                  </header>
                  <code className="transformer-content-digest">{edit.afterDigest}</code>
                  <pre tabIndex={0} aria-label={`Content after the change to ${edit.path}`}>
                    <code>{edit.afterContent}</code>
                  </pre>
                </section>
              </div>
            </article>
          ))}
        </section>
      ))}
    </section>
  );
}

export function AdaptiveCandidateReview({ candidateId }: { candidateId: string }) {
  const [candidate, setCandidate] = useState<AdaptiveCandidateDetail | null>(null);
  const [delivery, setDelivery] = useState<AdaptiveDeliveryView | null>(null);
  const [rationale, setRationale] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyDecision, setBusyDecision] = useState<"approve" | "reject" | "regenerate" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [humanIdentity, setHumanIdentity] = useState<boolean | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(
        `${API_URL}/transformer/adaptive-candidates/${encodeURIComponent(candidateId)}`,
        { cache: "no-store", signal },
      );
      const loaded = await responseJson<AdaptiveCandidateDetail>(response);
      setCandidate(loaded);
      setDelivery(loaded.delivery ?? null);
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") return;
      setLoadError(reviewErrorMessage(caught));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [candidateId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    let active = true;
    void fetch("/api/session", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : null)
      .then((body: { subject?: { kind?: string } } | null) => {
        if (active) setHumanIdentity(body?.subject?.kind === "human_oidc");
      })
      .catch(() => {
        if (active) setHumanIdentity(false);
      });
    return () => { active = false; };
  }, []);

  const readiness = useMemo(
    () => candidate ? reviewReadiness(candidate) : null,
    [candidate],
  );
  const normalizedRationale = rationale.trim();

  async function decide(decision: "approve" | "reject" | "regenerate"): Promise<void> {
    if (humanIdentity !== true) {
      setNotice({
        tone: "error",
        text: "Company identity is required to approve, reject, or regenerate this candidate.",
      });
      return;
    }
    if (!candidate || !normalizedRationale) {
      setNotice({ tone: "error", text: "Explain your decision before submitting it." });
      return;
    }
    if (decision === "approve" && !readiness?.canApprove) return;
    if (decision === "reject" && !readiness?.canReject) return;
    if (decision === "regenerate" && !readiness?.canRegenerate) return;

    setBusyDecision(decision);
    setNotice(null);
    try {
      const response = await fetch(
        `${API_URL}/transformer/adaptive-candidates/${encodeURIComponent(candidate.id)}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, rationale: normalizedRationale }),
        },
      );
      const reviewed = await responseJson<AdaptiveReviewResponse>(response);
      if (
        decision === "approve" &&
        (response.status !== 202 || reviewed.delivery?.status !== "delivery_pending")
      ) {
        throw new Error("Approval was not accepted for draft delivery.");
      }
      setCandidate((current) => current ? {
        ...current,
        status: reviewed.status,
        reviewDecision: reviewed.reviewDecision,
        reviewerPrincipalId: reviewed.reviewerPrincipalId,
        reviewedAt: reviewed.reviewedAt,
        reviewRationale: normalizedRationale,
        regeneration: reviewed.regeneration,
      } : current);
      setDelivery(reviewed.delivery ?? null);
      setNotice({
        tone: "success",
        text: reviewed.delivery?.status === "delivery_pending"
          ? "Approval recorded. Draft pull request delivery is pending."
          : reviewed.regeneration
            ? reviewed.regeneration.authorizationMessage ?? reviewed.statement
            : reviewed.statement,
      });
    } catch (caught) {
      setNotice({ tone: "error", text: reviewErrorMessage(caught) });
    } finally {
      setBusyDecision(null);
    }
  }

  if (loading) {
    return (
      <div className="workspace-page transformer-workspace" aria-busy="true" aria-live="polite">
        <p className="eyebrow">Adaptive candidate review</p>
        <h1>Loading sealed candidate</h1>
        <div className="surface transformer-review-loading">
          <div className="skeleton skeleton-copy" />
          <div className="skeleton skeleton-title" />
          <span className="sr-only">Loading candidate files</span>
        </div>
      </div>
    );
  }

  if (loadError || !candidate) {
    return (
      <div className="workspace-page transformer-workspace">
        <p><Link href="/transformer">Back to Transformer</Link></p>
        <section className="surface transformer-review-problem" role="alert">
          <p className="eyebrow">Candidate unavailable</p>
          <h1>The review could not be opened</h1>
          <p>{loadError ?? "The candidate was not returned by the service."}</p>
          <div className="btn-row">
            <button className="btn primary" type="button" onClick={() => void load()}>Retry</button>
            <Link className="btn" href="/status">System status</Link>
          </div>
        </section>
      </div>
    );
  }

  const pending = candidate.status === "review_pending";
  const evidence = evidencePresentation(candidate);
  const previewBlocksReview = pending || candidate.status === "approved";

  return (
    <div className="workspace-page transformer-workspace transformer-review-page">
      <header className="command-header transformer-review-header">
        <div>
          <p className="muted small"><Link href="/transformer">Back to Transformer</Link></p>
          <p className="eyebrow">Adaptive candidate review</p>
          <h1>Inspect every proposed file</h1>
          <p className="lead">
            This change diverges from the approved recipe. Approval creates a queued draft pull request only after the reviewed bytes are reverified.
          </p>
        </div>
        <div className="transformer-review-status" role="status">
          <span className={`state-pill ${statusTone(candidate.status)}`}>
            {candidateStatusLabel(candidate.status)}
          </span>
          <strong>{candidate.changedPaths.length} {candidate.changedPaths.length === 1 ? "file" : "files"}</strong>
          <span>{formatCandidateBytes(candidate.totalBytes)}</span>
        </div>
      </header>

      {notice && (
        <p
          className={`transformer-notice ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {notice.text}
        </p>
      )}

      <section className="surface transformer-review-evidence" aria-labelledby="candidate-evidence-title">
        <div className="section-head">
          <div>
            <p className="eyebrow">Bound evidence</p>
            <h2 id="candidate-evidence-title">Repository and snapshot</h2>
          </div>
          <span className={`state-pill ${evidence.tone}`}>
            {evidence.label}
          </span>
        </div>
        <dl className="kv transformer-review-kv">
          <dt>Repository</dt><dd><code>{candidate.repositoryId}</code></dd>
          <dt>Snapshot</dt><dd><code>{candidate.snapshotId}</code></dd>
          <dt>Base branch</dt><dd><code>{candidate.baseBranch}</code></dd>
          <dt>Expected base</dt><dd><code>{candidate.expectedBaseRevision}</code></dd>
          <dt>Campaign</dt><dd><code>{candidate.campaignId}</code></dd>
          <dt>Unit</dt><dd><code>{candidate.unitId}</code></dd>
          <dt>Attempt</dt><dd><code>{candidate.attemptId}</code></dd>
          <dt>Generation</dt><dd>{candidate.generation}</dd>
          <dt>Candidate digest</dt><dd><code>{candidate.candidateDigest}</code></dd>
          <dt>Diverged from</dt><dd><code>{candidate.divergedFromDigest}</code></dd>
          <dt>Failed verification</dt><dd><code>{candidate.failingCommandId ?? "Not recorded"}</code></dd>
          <dt>Review expires</dt><dd>{new Date(candidate.expiresAt).toLocaleString()}</dd>
        </dl>
        <p className="muted small">{evidence.description}</p>
        {candidate.evidenceStatus === "corrupt" && candidate.evidenceErrorCode && (
          <p className="muted small"><code>{candidate.evidenceErrorCode}</code></p>
        )}
      </section>

      {(candidate.supersedesCandidateId || candidate.supersededByCandidateId || candidate.regeneration) && (
        <section className="surface transformer-review-evidence" aria-labelledby="candidate-lineage-title">
          <div className="section-head">
            <div>
              <p className="eyebrow">Immutable lineage</p>
              <h2 id="candidate-lineage-title">Candidate history</h2>
            </div>
            {candidate.regeneration && (
              <span className="state-pill active">
                {candidate.regeneration.externalProcessingAuthorizationRequired
                  ? "authorization required"
                  : candidate.regeneration.status}
              </span>
            )}
          </div>
          <dl className="kv transformer-review-kv">
            {candidate.supersedesCandidateId && (
              <><dt>Previous candidate</dt><dd><Link href={`/transformer/candidates/${candidate.supersedesCandidateId}`}><code>{candidate.supersedesCandidateId}</code></Link></dd></>
            )}
            {candidate.supersededByCandidateId && (
              <><dt>Replacement candidate</dt><dd><Link href={`/transformer/candidates/${candidate.supersededByCandidateId}`}><code>{candidate.supersededByCandidateId}</code></Link></dd></>
            )}
            {candidate.regeneration && (
              <>
                <dt>Request</dt><dd><code>{candidate.regeneration.id}</code></dd>
                <dt>Reviewer</dt><dd><code>{candidate.regeneration.reviewerPrincipalId}</code></dd>
                <dt>Requested</dt><dd>{new Date(candidate.regeneration.requestedAt).toLocaleString()}</dd>
                <dt>Rationale digest</dt><dd><code>{candidate.regeneration.rationaleDigest}</code></dd>
              </>
            )}
          </dl>
          {candidate.regeneration?.authorizationMessage && (
            <p className="transformer-notice" role="status">
              {candidate.regeneration.authorizationMessage}
            </p>
          )}
          {candidate.reviewRationale && <p>{candidate.reviewRationale}</p>}
        </section>
      )}

      {!candidate.previewComplete && (
        <section
          className={previewBlocksReview || candidate.evidenceStatus === "corrupt"
            ? "transformer-review-problem"
            : "surface transformer-review-retention"}
          role={previewBlocksReview || candidate.evidenceStatus === "corrupt" ? "alert" : "status"}
          aria-labelledby="preview-incomplete-title"
        >
          <strong id="preview-incomplete-title">
            {candidate.evidenceStatus === "retention_cleaned"
              ? "Exact content removed by retention"
              : candidate.evidenceStatus === "corrupt"
                ? "Retained evidence unavailable"
                : "Full preview exceeds the display limit"}
          </strong>
          <p>
            {previewBlocksReview
              ? "Approval is disabled because not every proposed file can be displayed and verified."
              : candidate.evidenceStatus === "retention_cleaned"
                ? "The decision metadata remains available, while the closed candidate content has been removed."
                : candidate.evidenceStatus === "corrupt"
                  ? "The delivery record remains available, but the retained content failed verification."
                  : "The seal is verified and delivery evidence remains available, but the full content is too large for this page."}
          </p>
          {candidate.omittedPaths.length > 0 && (
            <p>Unavailable files: {candidate.omittedPaths.join(", ")}</p>
          )}
        </section>
      )}

      {!candidate.reviewEvidenceComplete && (
        <section className="transformer-review-problem" role="alert" aria-labelledby="review-evidence-incomplete-title">
          <strong id="review-evidence-incomplete-title">Complete review evidence is unavailable</strong>
          <p>
            Approval is disabled because the explanation, exact before and after content, or final verification evidence is incomplete.
          </p>
        </section>
      )}

      {candidate.semanticReview ? (
        <AdaptiveSemanticReviewPanel review={candidate.semanticReview} />
      ) : (
        <section className="surface empty-state compact" aria-label="Review evidence unavailable">
          <p>No complete semantic review evidence is available.</p>
        </section>
      )}

      <section className="surface transformer-decision-panel" aria-labelledby="review-decision-title">
        <div>
          <p className="eyebrow">Direct human decision</p>
          <h2 id="review-decision-title">Record your rationale</h2>
          <p className="muted">
            Approval queues draft pull request delivery. It does not merge or deploy the change.
          </p>
        </div>

        {pending && readiness && readiness.blockers.length > 0 && (
          <ul className="transformer-review-blockers" role="alert">
            {readiness.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
          </ul>
        )}

        {pending ? (
          <div className="transformer-decision-form">
            {humanIdentity === false && (
              <p className="transformer-review-problem" role="status">
                Company identity is required for this decision. Preview access is read only.{" "}
                <Link href={`/access?next=${encodeURIComponent(`/transformer/candidates/${candidate.id}`)}`}>
                  Sign in with company identity
                </Link>
              </p>
            )}
            {humanIdentity === null && (
              <p className="muted small" role="status">Checking company identity</p>
            )}
            <label htmlFor="adaptive-review-rationale">Review rationale</label>
            <textarea
              id="adaptive-review-rationale"
              className="input"
              rows={5}
              maxLength={2_000}
              required
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              aria-describedby="adaptive-review-rationale-help"
              disabled={busyDecision !== null}
              placeholder="Explain why this exact change should or should not proceed to a draft pull request"
            />
            <div className="transformer-rationale-meta" id="adaptive-review-rationale-help">
              <span>Required for approval, rejection, and regeneration</span>
              <span>{rationale.length} of 2000</span>
            </div>
            <div className="btn-row" aria-busy={busyDecision !== null}>
              <button
                className="btn primary"
                type="button"
                disabled={!adaptiveReviewActionEnabled({
                  decision: "approve",
                  humanIdentity,
                  busy: busyDecision !== null,
                  rationale: normalizedRationale,
                  readiness,
                })}
                onClick={() => void decide("approve")}
              >
                {busyDecision === "approve" ? "Recording approval" : "Approve for draft delivery"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={!adaptiveReviewActionEnabled({
                  decision: "regenerate",
                  humanIdentity,
                  busy: busyDecision !== null,
                  rationale: normalizedRationale,
                  readiness,
                })}
                onClick={() => void decide("regenerate")}
              >
                {busyDecision === "regenerate" ? "Requesting regeneration" : "Request regeneration"}
              </button>
              <button
                className="btn danger-button"
                type="button"
                disabled={!adaptiveReviewActionEnabled({
                  decision: "reject",
                  humanIdentity,
                  busy: busyDecision !== null,
                  rationale: normalizedRationale,
                  readiness,
                })}
                onClick={() => void decide("reject")}
              >
                {busyDecision === "reject" ? "Recording rejection" : "Reject candidate"}
              </button>
            </div>
          </div>
        ) : (
          <div className="transformer-decision-record" role="status">
            <strong>Decision recorded: {candidateStatusLabel(candidate.status)}</strong>
            {candidate.reviewerPrincipalId && <span>Reviewer: {candidate.reviewerPrincipalId}</span>}
            {candidate.reviewRationale && <span>Rationale: {candidate.reviewRationale}</span>}
          </div>
        )}

        {delivery && (
          <div className="transformer-delivery-status" role="status">
            <div>
              <span className={`state-pill ${delivery.status === "delivered" ? "success" : delivery.status === "delivery_failed" ? "danger" : "active"}`}>
                {candidateStatusLabel(delivery.status)}
              </span>
              <strong>
                {delivery.status === "delivery_pending"
                  ? "Draft delivery queued"
                  : delivery.status === "delivered"
                    ? "Draft delivered"
                    : "Draft delivery failed"}
              </strong>
              {delivery.errorCode && <span>Failure code: <code>{delivery.errorCode}</code></span>}
            </div>
            <code>Job {delivery.jobId}</code>
            {delivery.draftPrUrl && (
              <a className="btn" href={delivery.draftPrUrl} target="_blank" rel="noreferrer">
                Open draft pull request
              </a>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
