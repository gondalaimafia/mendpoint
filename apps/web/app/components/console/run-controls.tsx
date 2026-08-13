"use client";

import React from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type ControlAction = "cancel" | "retry";

/**
 * The run detail's pause/cancel + retry controls. Both post to the EXISTING,
 * already-allowlisted queue endpoints (`/jobs/:id/cancel`, `/jobs/:id/retry`)
 * through the web proxy, so the API's tenant scope, guards, and the no-auto-merge
 * model are unchanged — this component adds no new mutation surface. Buttons are
 * disabled with the server's own reason when the run is not eligible; neither is
 * an indigo primary (that stays reserved for the shell's single forward action).
 */
export function RunControls({
  runId,
  canCancel,
  cancelReason,
  canRetry,
  retryReason,
}: {
  runId: string;
  canCancel: boolean;
  cancelReason: string | null;
  canRetry: boolean;
  retryReason: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<ControlAction | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function act(action: ControlAction) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/jobs/${encodeURIComponent(runId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: `console ${action}` }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ds-panel ds-panel--pad">
      <div className="section-label section-label--muted">CONTROLS</div>
      <div className="ds-run-controls">
        <button
          type="button"
          className="ds-btn ds-btn--outline"
          disabled={!canCancel || busy !== null}
          title={cancelReason ?? undefined}
          onClick={() => act("cancel")}
        >
          {busy === "cancel" ? "Cancelling…" : "Pause / cancel"}
        </button>
        <button
          type="button"
          className="ds-btn ds-btn--outline"
          disabled={!canRetry || busy !== null}
          title={retryReason ?? undefined}
          onClick={() => act("retry")}
        >
          {busy === "retry" ? "Retrying…" : "Retry"}
        </button>
      </div>
      {!canCancel && cancelReason && (
        <p className="ds-author__note">Cancel unavailable: {cancelReason}</p>
      )}
      {!canRetry && retryReason && (
        <p className="ds-author__note">Retry unavailable: {retryReason}</p>
      )}
      {error && (
        <p className="ds-author__note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
