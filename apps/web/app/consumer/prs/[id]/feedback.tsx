"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function FeedbackButtons({ prId }: { prId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

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
        <button disabled={busy} onClick={() => send("closed")}>
          Mark closed
        </button>
        <button disabled={busy} onClick={() => send("modified")}>
          Request changes
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
