"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

export function AgentForm({
  consumers,
}: {
  consumers: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [consumerId, setConsumerId] = useState(consumers[0]?.id ?? "");
  const [goal, setGoal] = useState(
    "Fix API 404: path typo chargess. Rename amount_cents to amount for charges API.",
  );
  const [errorLog, setErrorLog] = useState(
    "HTTP 404 /v1/chargess\nerror: amount_cents is not allowed",
  );
  const [asyncMode, setAsyncMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    setOut(null);
    try {
      const body: Record<string, unknown> = {
        goal,
        consumerId,
        errorLog: errorLog || undefined,
        maxSteps: 20,
        async: asyncMode || undefined,
      };
      const res = await fetch(`${API_URL}/agent/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      if (res.status === 202 || data.status === "queued") {
        setOut(
          `QUEUED · session ${data.sessionId} · job ${data.jobId}\nDrain with worker process-jobs or POST /jobs/process-one`,
        );
      } else {
        setOut(
          `${data.ok ? "OK" : "NEEDS HUMAN"} · ${data.steps} steps · files: ${(data.filesChanged ?? []).join(", ") || "—"}\n\n${data.reportMarkdown ?? ""}`,
        );
      }
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>New Warden run</h2>
      <div className="stack">
        <label>
          Consumer
          <select
            className="input"
            value={consumerId}
            onChange={(e) => setConsumerId(e.target.value)}
          >
            {consumers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Goal
          <textarea
            className="input"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <label>
          Error log (optional seed)
          <textarea
            className="input"
            rows={2}
            value={errorLog}
            onChange={(e) => setErrorLog(e.target.value)}
          />
        </label>
        <label className="row" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={asyncMode}
            onChange={(e) => setAsyncMode(e.target.checked)}
          />
          Queue async (worker job)
        </label>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !consumerId}
          onClick={run}
        >
          {busy ? "Warden running…" : "Run Warden"}
        </button>
        {err && <p className="error">{err}</p>}
        {out && <pre className="code-block">{out}</pre>}
      </div>
    </section>
  );
}
