"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function BrandPreview({ packId, cta }: { packId: string; cta: string }) {
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/brands/${packId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Preview failed with status ${res.status}`);
      setPreview({ title: data.title, body: data.body });
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ marginTop: "0.75rem" }}>
      <button type="button" className="btn" onClick={run} disabled={busy}>
        {busy ? "Preparing preview" : cta + " preview"}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      {preview && (
        <pre className="code-block" role="status" aria-live="polite">
          {preview.title}
          {"\n\n"}
          {preview.body}
        </pre>
      )}
    </div>
  );
}
