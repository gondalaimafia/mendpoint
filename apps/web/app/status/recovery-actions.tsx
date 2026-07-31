"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function RecoveryActions({
  jobId,
  status,
}: {
  jobId: string;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "retry" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/jobs/${jobId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: action === "retry" ? "Operator requested recovery" : "Operator cancelled work",
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? response.statusText);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const canRetry =
    status === "dead_letter" || status === "failed" || status === "cancelled";
  const canCancel = status === "pending";
  if (!canRetry && !canCancel) return null;

  return (
    <div>
      {canRetry && (
        <button className="btn" type="button" disabled={busy} onClick={() => act("retry")}>
          {busy ? "Working" : "Retry now"}
        </button>
      )}
      {canCancel && (
        <button className="btn" type="button" disabled={busy} onClick={() => act("cancel")}>
          {busy ? "Working" : "Cancel"}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
