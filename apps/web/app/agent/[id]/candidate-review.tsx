"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function CandidateReview({ runId }: { runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [humanIdentity, setHumanIdentity] = useState<boolean | null>(null);
  const [rationale, setRationale] = useState("");

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

  async function decide(decision: "approve" | "reject" | "regenerate") {
    if (humanIdentity !== true) return;
    const normalizedRationale = rationale.trim();
    if (!normalizedRationale) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/agent/runs/${runId}/candidate/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, rationale: normalizedRationale }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? response.statusText);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return <CandidateReviewDecisionPanel
    runId={runId}
    humanIdentity={humanIdentity}
    busy={busy}
    error={error}
    onDecision={(decision) => void decide(decision)}
    rationale={rationale}
    onRationaleChange={setRationale}
  />;
}

export function CandidateReviewDecisionPanel({
  runId,
  humanIdentity,
  busy,
  error,
  onDecision,
  rationale = "",
  onRationaleChange = () => {},
}: {
  runId: string;
  humanIdentity: boolean | null;
  busy: boolean;
  error: string | null;
  onDecision: (decision: "approve" | "reject" | "regenerate") => void;
  rationale?: string;
  onRationaleChange?: (value: string) => void;
}) {
  if (humanIdentity === null) {
    return <p className="muted small" role="status">Checking company identity</p>;
  }
  if (!humanIdentity) {
    return (
      <p className="muted small" role="status">
        Company identity is required for this decision. Preview access is read only.{" "}
        <Link href={`/access?next=${encodeURIComponent(`/agent/${runId}`)}`}>
          Sign in with company identity
        </Link>
      </p>
    );
  }
  const decisionDisabled = busy || !rationale.trim();
  return (
    <div className="stack">
      <label htmlFor="warden-review-rationale">Review rationale</label>
      <textarea
        id="warden-review-rationale"
        className="input"
        rows={4}
        maxLength={2_000}
        required
        value={rationale}
        onChange={(event) => onRationaleChange(event.target.value)}
        placeholder="Explain why this repair should proceed, be rejected, or be regenerated"
      />
      <p className="muted small">Required for every decision. {rationale.length} of 2000 characters.</p>
      <div className="row gap">
      <button className="btn primary" disabled={decisionDisabled} onClick={() => onDecision("approve")}>
        Approve candidate
      </button>
      <button className="btn" disabled={decisionDisabled} onClick={() => onDecision("regenerate")}>
        Request regeneration
      </button>
      <button className="btn" disabled={decisionDisabled} onClick={() => onDecision("reject")}>
        Reject and delete
      </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
