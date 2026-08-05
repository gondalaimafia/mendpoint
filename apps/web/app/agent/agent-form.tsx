"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { waitForJob } from "../../lib/job-poll";

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
  const [allowedPaths, setAllowedPaths] = useState("client.js");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const idempotency = useRef<{ payload: string; key: string } | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    setOut(null);
    try {
      const body: Record<string, unknown> = {
        goal,
        consumerId,
        allowedChangedPaths: allowedPaths
          .split(/[\n,]/)
          .map((path) => path.trim())
          .filter(Boolean),
        errorLog: errorLog || undefined,
        maxSteps: 20,
        async: true,
      };
      const payload = JSON.stringify(body);
      if (!idempotency.current || idempotency.current.payload !== payload) {
        idempotency.current = { payload, key: crypto.randomUUID() };
      }
      const res = await fetch(`${API_URL}/agent/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotency.current.key,
        },
        body: payload,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      idempotency.current = null;
      if (res.status === 202 || data.status === "queued") {
        setOut(
          `QUEUED · session ${data.sessionId} · job ${data.jobId}\nThe recovery worker will process this job`,
        );
        const job = await waitForJob(API_URL, data.jobId);
        setOut((current) =>
          job
            ? `${current ?? ""}\nCompleted with status: ${job.status}`
            : `${current ?? ""}\nStill running. Status remains available on the recovery page.`,
        );
        router.refresh();
      } else {
        setOut(
          `${data.ok ? "OK" : "NEEDS HUMAN"} · ${data.steps} steps · files: ${(data.filesChanged ?? []).join(", ") || "—"}\n\n${data.reportMarkdown ?? ""}`,
        );
      }
      if (res.status !== 202 && data.status !== "queued") router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-busy={busy}>
      <h2>New Warden run</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
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
          Files Warden may change
          <textarea
            className="input"
            rows={2}
            value={allowedPaths}
            onChange={(e) => setAllowedPaths(e.target.value)}
            placeholder="src/payments.ts"
            required
          />
          <span className="muted">Enter one repository file path per line.</span>
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
        <button
          type="submit"
          className="btn primary"
          disabled={busy || !consumerId || !allowedPaths.trim()}
        >
          {busy ? "Warden running…" : "Run Warden"}
        </button>
        {err && <p className="error" role="alert">{err}</p>}
        {out && <pre className="code-block" role="status" aria-live="polite">{out}</pre>}
      </form>
    </section>
  );
}
