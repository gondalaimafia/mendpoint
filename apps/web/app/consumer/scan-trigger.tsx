"use client";

import { useRouter } from "next/navigation";
import React, { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type ScanResult = {
  jobId: string;
  providerSlug: string;
  status: string;
  replayed?: boolean;
};

export function ScanTrigger() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/self-serve/scan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(json));
      setResult(json as ScanResult);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={busy} onClick={run}>
        {busy ? "Scanning…" : "Scan for impact"}
      </button>
      {result && (
        <p className="muted">
          Queued scan <code>{result.jobId}</code> for <code>{result.providerSlug}</code> — status{" "}
          <span className={`badge ${result.status}`}>{result.status}</span>
        </p>
      )}
      {error && <p className="muted">{error}</p>}
    </div>
  );
}
