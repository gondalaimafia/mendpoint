"use client";

import { useRouter } from "next/navigation";
import React, { useRef, useState } from "react";
import { waitForJob } from "../../lib/job-poll";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

type WardenRequestInput = Readonly<{
  customerMode: boolean;
  providerSlug: string;
  consumerId: string;
  goal: string;
  allowedPaths: string;
  errorLog: string;
}>;

export function buildWardenRequest(input: WardenRequestInput): Readonly<{
  endpoint: "/fettler/pilot" | "/agent/runs";
  body: Record<string, unknown>;
}> {
  if (input.customerMode) {
    return {
      endpoint: "/fettler/pilot",
      body: {
        providerSlug: input.providerSlug,
        consumerId: input.consumerId,
      },
    };
  }
  return {
    endpoint: "/agent/runs",
    body: {
      goal: input.goal,
      consumerId: input.consumerId,
      allowedChangedPaths: input.allowedPaths
        .split(/[\n,]/)
        .map((path) => path.trim())
        .filter(Boolean),
      errorLog: input.errorLog || undefined,
      maxSteps: 20,
      async: true,
    },
  };
}

export function AgentForm({
  consumers,
  customerMode,
}: {
  consumers: Array<{
    id: string;
    name: string;
    providers: Array<{ slug: string; name: string }>;
  }>;
  customerMode: boolean;
}) {
  const router = useRouter();
  const [consumerId, setConsumerId] = useState(consumers[0]?.id ?? "");
  const [providerSlug, setProviderSlug] = useState(consumers[0]?.providers[0]?.slug ?? "");
  const approvedProviders = consumers.find((consumer) => consumer.id === consumerId)?.providers ?? [];
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
      const request = buildWardenRequest({
        customerMode,
        providerSlug,
        consumerId,
        goal,
        allowedPaths,
        errorLog,
      });
      const payload = JSON.stringify(request.body);
      const requestIdentity = `${request.endpoint}\n${payload}`;
      if (!idempotency.current || idempotency.current.payload !== requestIdentity) {
        idempotency.current = { payload: requestIdentity, key: crypto.randomUUID() };
      }
      const apiBase = customerMode ? "/api" : API_URL;
      const res = await fetch(`${apiBase}${request.endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotency.current.key,
        },
        body: payload,
      });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok) {
        const requestId = res.headers.get("x-request-id");
        throw new Error(
          requestId
            ? `Fettler could not start this request. Reference ${requestId}`
            : "Fettler could not start this request. Check system status and try again.",
        );
      }
      idempotency.current = null;
      if (res.status === 202 || data.status === "queued") {
        setOut(
          customerMode
            ? `QUEUED · job ${String(data.jobId)}\nFettler will derive the bounded migration scope from approved evidence`
            : `QUEUED · session ${String(data.sessionId)} · job ${String(data.jobId)}\nThe recovery worker will process this job`,
        );
        const job = await waitForJob(API_URL, String(data.jobId));
        setOut((current) =>
          job
            ? `${current ?? ""}\nCompleted with status: ${job.status}`
            : `${current ?? ""}\nStill running. Status remains available on the recovery page.`,
        );
        router.refresh();
      } else {
        setOut(
          `${data.ok ? "OK" : "NEEDS HUMAN"} · ${String(data.steps)} steps · files: ${Array.isArray(data.filesChanged) ? data.filesChanged.join(", ") || "none" : "none"}\n\n${String(data.reportMarkdown ?? "")}`,
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
      <h2>{customerMode ? "New bounded pilot" : "New Fettler run"}</h2>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        {customerMode && (
          <>
            <p className="muted small">
              Fettler derives repository scope, verification, model policy, budget, and delivery authority from approved tenant evidence.
            </p>
            <label>
              Approved provider
              <select
                className="input"
                value={providerSlug}
                onChange={(event) => setProviderSlug(event.target.value)}
                required
              >
                {approvedProviders.map((provider) => (
                  <option key={provider.slug} value={provider.slug}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          {customerMode ? "Connected repository" : "Consumer"}
          <select
            className="input"
            value={consumerId}
            onChange={(event) => {
              const nextConsumerId = event.target.value;
              const nextConsumer = consumers.find((consumer) => consumer.id === nextConsumerId);
              setConsumerId(nextConsumerId);
              setProviderSlug(nextConsumer?.providers[0]?.slug ?? "");
            }}
          >
            {consumers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {!customerMode && (
          <>
            <label>
              Goal
              <textarea
                className="input"
                rows={3}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
            <label>
              Files Fettler may change
              <textarea
                className="input"
                rows={2}
                value={allowedPaths}
                onChange={(event) => setAllowedPaths(event.target.value)}
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
                onChange={(event) => setErrorLog(event.target.value)}
              />
            </label>
          </>
        )}
        <button
          type="submit"
          className="btn primary"
          disabled={
            busy ||
            !consumerId ||
            (customerMode ? !providerSlug : !allowedPaths.trim())
          }
        >
          {busy
            ? "Fettler running…"
            : customerMode
              ? "Start bounded pilot"
              : "Run Fettler"}
        </button>
        {err && <p className="error" role="alert">{err}</p>}
        {out && <pre className="code-block" role="status" aria-live="polite">{out}</pre>}
      </form>
    </section>
  );
}
