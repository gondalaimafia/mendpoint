"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function FeedbackButtons({ prId }: { prId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);

  async function send(outcome: "merged" | "closed" | "modified") {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/prs/${prId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMsg(`Recorded: ${outcome}`);
      setConfirmingClose(false);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="btn-row">
        <button className="primary" disabled={busy} onClick={() => send("merged")}>
          Mark merged
        </button>
        <button disabled={busy} onClick={() => setConfirmingClose(true)}>
          Close and teach
        </button>
        <button disabled={busy} onClick={() => send("modified")}>
          Request changes
        </button>
      </div>
      {confirmingClose && (
        <div className="confirmation-panel" role="alertdialog" aria-labelledby="close-learning-title">
          <strong id="close-learning-title">Teach Mendpoint to suppress this pattern?</strong>
          <p>Closing records durable feedback so similar changes are not proposed again.</p>
          <div className="btn-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void send("closed")}>
              Confirm close
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmingClose(false)}>
              Keep open
            </button>
          </div>
        </div>
      )}
      {msg && <p className="muted" role="status" aria-live="polite">{msg}</p>}
    </div>
  );
}
