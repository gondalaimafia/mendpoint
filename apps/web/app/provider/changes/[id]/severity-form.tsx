"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function SeverityForm({
  changeId,
  initial,
}: {
  changeId: string;
  initial?: string;
}) {
  const router = useRouter();
  const [severity, setSeverity] = useState(initial ?? "recommended");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/changes/${changeId}/severity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ severity }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMsg(`Severity set to ${severity}`);
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <h3>Provider severity</h3>
      <p className="muted small">
        Required = must migrate · Recommended = default · Optional = adoption / notify-friendly
      </p>
      <div className="plan-picker">
        <select
          className="input"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          style={{ maxWidth: 200 }}
        >
          <option value="required">required</option>
          <option value="recommended">recommended</option>
          <option value="optional">optional</option>
        </select>
        <button type="button" className="btn primary" onClick={save} disabled={busy}>
          {busy ? "…" : "Save"}
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </div>
  );
}
