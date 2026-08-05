"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function CandidateReview({ runId }: { runId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/agent/runs/${runId}/candidate/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
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

  return (
    <div className="row gap">
      <button className="btn primary" disabled={busy} onClick={() => void decide("approve")}>
        Approve candidate
      </button>
      <button className="btn" disabled={busy} onClick={() => void decide("reject")}>
        Reject and delete
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
