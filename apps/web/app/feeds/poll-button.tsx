"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function PollButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function poll() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/feeds/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localOnly: true, runPipeline: true }),
      });
      const data = (await res.json()) as {
        results?: Array<{ slug: string; status: string }>;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      const summary = (data.results ?? []).map((r) => `${r.slug}:${r.status}`).join(", ");
      setMsg(summary || "done");
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="poll-actions">
      <button type="button" className="btn" onClick={poll} disabled={busy}>
        {busy ? "Polling…" : "Poll local feeds"}
      </button>
      {msg && <span className="muted small">{msg}</span>}
    </div>
  );
}
