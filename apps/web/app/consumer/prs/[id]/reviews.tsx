"use client";

import { useEffect, useState } from "react";
import type { MigrationPrReview } from "../../../../lib/api";

type Decision = MigrationPrReview["decision"];

const ACTIONS: Array<{ decision: Decision; label: string }> = [
  { decision: "approve", label: "Approve" },
  { decision: "request_changes", label: "Request changes" },
  { decision: "regenerate", label: "Regenerate" },
  { decision: "reject", label: "Reject" },
];

export function ReviewPanel({
  prId,
  initialReviews,
  evidenceReady,
  disabledReason,
}: {
  prId: string;
  initialReviews: MigrationPrReview[];
  evidenceReady: boolean;
  disabledReason?: string;
}) {
  const [reviews, setReviews] = useState(initialReviews);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState<Decision | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [humanIdentity, setHumanIdentity] = useState<boolean | null>(null);

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

  async function submit(decision: Decision) {
    setBusy(decision);
    setMessage(null);
    try {
      const response = await fetch(`/api/prs/${encodeURIComponent(prId)}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, rationale }),
      });
      const body = await response.json().catch(() => null) as MigrationPrReview | { error?: string } | null;
      if (!response.ok) {
        throw new Error(body && "error" in body && body.error ? body.error : "Review was not recorded");
      }
      setReviews((current) => [...current, body as MigrationPrReview]);
      setRationale("");
      setMessage("Review recorded with your operator identity");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card stack" aria-busy={Boolean(busy)}>
      <div>
        <h2>Human review</h2>
        <p className="muted small">
          Every decision is bound to this exact candidate and your signed operator session.
        </p>
      </div>
      <label>
        Rationale
        <textarea
          className="input"
          rows={4}
          maxLength={2000}
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="State the evidence, risk, or required change"
        />
      </label>
      <div className="btn-row">
        {ACTIONS.map((action) => {
          const approvalBlocked = action.decision === "approve" && !evidenceReady;
          return (
          <button
            key={action.decision}
            className={action.decision === "approve" ? "primary" : undefined}
            type="button"
            disabled={
              Boolean(busy) ||
              humanIdentity !== true ||
              Boolean(disabledReason) ||
              approvalBlocked ||
              rationale.trim().length < 3
            }
            onClick={() => void submit(action.decision)}
          >
            {busy === action.decision ? "Recording" : action.label}
          </button>
          );
        })}
      </div>
      {!evidenceReady && (
        <p className="muted small">
          Approval requires a complete evidence package. Request regeneration if evidence is missing.
        </p>
      )}
      {humanIdentity === false && (
        <p className="muted small">
          Human decisions require company identity. Use company identity on the access page to replace preview access.
        </p>
      )}
      {disabledReason && <p className="muted small">{disabledReason}</p>}
      {message && <p className="muted small" role="status" aria-live="polite">{message}</p>}
      <div>
        <h3>Decision history</h3>
        {reviews.length === 0 ? (
          <p className="muted small">No human decisions have been recorded for this candidate.</p>
        ) : (
          <ol>
            {reviews.map((review) => (
              <li key={review.id}>
                <strong>{review.decision.replaceAll("_", " ")}</strong>
                {` by ${review.reviewer.displayName}: ${review.rationale}`}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
