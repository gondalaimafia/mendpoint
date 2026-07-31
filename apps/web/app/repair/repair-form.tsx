"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { waitForJob } from "../../lib/job-poll";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function RepairForm({
  consumers,
}: {
  consumers: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [consumerId, setConsumerId] = useState(consumers[0]?.id ?? "");
  const [from, setFrom] = useState("amount_cents");
  const [to, setTo] = useState("amount");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const renameMap: Record<string, string> = {};
      if (from && to) renameMap[from] = to;
      const res = await fetch(`${API_URL}/repair/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consumerId: consumerId || undefined,
          renameMap,
          dryRun,
          maxAttempts: 3,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (res.status === 202 || data.status === "queued") {
        setResult(
          `QUEUED · session ${data.sessionId} · job ${data.jobId}\n\nMendpoint will repair in a bounded worker, verify the result, and roll back every unverified mutation.`,
        );
        const job = await waitForJob(API_URL, data.jobId);
        setResult((current) =>
          job
            ? `${current ?? ""}\n\nCompleted with status: ${job.status}`
            : `${current ?? ""}\n\nStill running. Status remains available on the recovery page.`,
        );
        router.refresh();
        return;
      }
      setResult(
        `${data.ok ? "OK" : "NEEDS HUMAN"} · session ${data.sessionId} · ${data.editsCount} edits · ${data.attempts} attempts\n\n${data.reportMarkdown ?? ""}`,
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Run repair</h2>
      <div className="stack">
        <label>
          Consumer
          <select
            className="input"
            value={consumerId}
            onChange={(e) => setConsumerId(e.target.value)}
          >
            <option value="">— select —</option>
            {consumers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="plan-picker">
          <label>
            Rename from
            <input className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            to
            <input className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <label className="muted small">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />{" "}
          Dry run (plan only, no writes)
        </label>
        <button
          type="button"
          className="btn primary"
          onClick={run}
          disabled={busy || !consumerId}
        >
          {busy ? "Queueing…" : "Start verified repair"}
        </button>
        {error && <p className="error">{error}</p>}
        {result && <pre className="code-block">{result}</pre>}
      </div>
    </section>
  );
}
