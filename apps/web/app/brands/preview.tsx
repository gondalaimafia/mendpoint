"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function BrandPreview({ packId, cta }: { packId: string; cta: string }) {
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/brands/${packId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setPreview({ title: data.title, body: data.body });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ marginTop: "0.75rem" }}>
      <button type="button" className="btn" onClick={run} disabled={busy}>
        {busy ? "…" : cta + " (preview PR)"}
      </button>
      {preview && (
        <pre className="code-block">
          {preview.title}
          {"\n\n"}
          {preview.body}
        </pre>
      )}
    </div>
  );
}
