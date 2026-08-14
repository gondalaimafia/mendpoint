import { apiGet } from "../../lib/api";
import Link from "next/link";
import { RecoveryActions } from "./recovery-actions";

export const dynamic = "force-dynamic";

type Status = {
  status: string;
  release?: { version: string; channel: string; product: string; banner: string };
  uptimeSec?: number;
  checks?: Array<{ name: string; ok: boolean; detail?: string }>;
  ga?: {
    version: string;
    channel: string;
    gaFeatures: string[];
    experimental: string[];
  };
};

type RecoverySummary = {
  pending: number;
  retryScheduled: number;
  running: number;
  deadLetter: number;
  cancelled: number;
  done: number;
  recovered: number;
  simulated: number;
  oldestPendingAgeMs: number | null;
};

type RecoveryJob = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  error: string | null;
  availableAt: string | null;
  createdAt: string;
};

export default async function StatusPage() {
  let s: Status | null = null;
  let recovery: RecoverySummary | null = null;
  let jobs: RecoveryJob[] = [];
  let error: string | null = null;
  const [statusResult, recoveryResult, jobsResult] = await Promise.allSettled([
    apiGet<Status>("/status"),
    apiGet<RecoverySummary>("/recovery/summary"),
    apiGet<RecoveryJob[]>("/jobs"),
  ]);
  if (statusResult.status === "fulfilled") {
    s = statusResult.value;
  } else {
    try {
      s = await apiGet<Status>("/health");
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : String(e2);
    }
  }
  if (recoveryResult.status === "fulfilled") {
    recovery = recoveryResult.value;
  } else {
    error = [error, `Recovery summary unavailable: ${String(recoveryResult.reason)}`]
      .filter(Boolean)
      .join(". ");
  }
  if (jobsResult.status === "fulfilled") {
    jobs = jobsResult.value;
  } else {
    error = [error, `Recovery jobs unavailable: ${String(jobsResult.reason)}`]
      .filter(Boolean)
      .join(". ");
  }

  const ok = s && (s.status === "ok" || (s as { ok?: boolean }).ok);

  return (
    <div>
      <h1>System status</h1>
      <p className="lead">
        Design partner health for Mendpoint and Gauge. Process liveness and
        recovery state are reported separately so failed work stays visible
        without taking the console offline.
      </p>
      {error && (
        <div className="card">
          <p className="muted">API unreachable: {error}</p>
          <p className="small muted">Start API with npm run dev:api</p>
        </div>
      )}
      {s && (
        <>
          <div className="grid">
            <div className="card">
              <h3>Status</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {ok ? "Operational" : s.status ?? "Unknown"}
              </p>
              <p className="muted small">
                {s.release?.banner ??
                  `${s.release?.product ?? "Gauge"} ${s.release?.version ?? ""}`}
              </p>
            </div>
            <div className="card">
              <h3>Channel</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {(s.ga?.channel ?? s.release?.channel ?? "—").toUpperCase()}
              </p>
              <p className="muted small">v{s.ga?.version ?? s.release?.version}</p>
            </div>
            <div className="card">
              <h3>Uptime</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {s.uptimeSec != null ? `${s.uptimeSec}s` : "—"}
              </p>
            </div>
          </div>
          {s.checks && (
            <div className="card" style={{ marginTop: "1rem" }}>
              <h3>Checks</h3>
              <ul>
                {s.checks.map((c) => (
                  <li key={c.name}>
                    {c.ok ? "✓" : "✗"} <strong>{c.name}</strong>{" "}
                    <span className="muted small">{c.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {s.ga && (
            <div className="card" style={{ marginTop: "1rem" }}>
              <h3>Available capabilities</h3>
              <ul className="small">
                {s.ga.gaFeatures.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              <h3>Design partner capabilities</h3>
              <ul className="small muted">
                {s.ga.experimental.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {recovery && (
        <section id="recovery" className="card" style={{ marginTop: "1rem" }}>
          <h2>Self healing recovery</h2>
          <p className="muted">
            Automated repair is bounded and verified. Failed work stays visible until it is
            recovered, cancelled, or reviewed by a person. Verified changes remain in the tenant
            checkout and are never merged automatically.
          </p>
          <div className="grid">
            <div>
              <strong>{recovery.running}</strong>
              <div className="muted small">Running</div>
            </div>
            <div>
              <strong>{recovery.pending}</strong>
              <div className="muted small">Waiting or retrying</div>
            </div>
            <div>
              <strong>{recovery.deadLetter}</strong>
              <div className="muted small">Needs review</div>
            </div>
            <div>
              <strong>{recovery.recovered}</strong>
              <div className="muted small">Verified recoveries</div>
            </div>
          </div>
          <p className="muted small">
            Completed jobs: {recovery.done}. Simulations: {recovery.simulated}.
          </p>
          {recovery.oldestPendingAgeMs != null && (
            <p className="muted small">
              Oldest waiting work: {Math.round(recovery.oldestPendingAgeMs / 1000)} seconds
            </p>
          )}
        </section>
      )}
      {jobs.length > 0 && (
        <section id="work" className="card" style={{ marginTop: "1rem" }}>
          <h2>Recent recovery work</h2>
          <table className="table">
            <caption className="sr-only">Recent self healing recovery work</caption>
            <thead>
              <tr>
                <th>Created</th>
                <th>Type</th>
                <th>Status</th>
                <th>Attempt</th>
                <th>Recovery</th>
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 20).map((job) => (
                <tr key={job.id}>
                  <td className="mono small">{new Date(job.createdAt).toLocaleString()}</td>
                  <td className="mono small">{job.type}</td>
                  <td>
                    <span className={`badge ${job.status === "done" ? "high" : "breaking"}`}>
                      {job.status.replaceAll("_", " ")}
                    </span>
                    {job.errorCode && <div className="muted small">{job.errorCode}</div>}
                  </td>
                  <td>
                    {job.attempts}/{job.maxAttempts}
                  </td>
                  <td>
                    <RecoveryActions jobId={job.id} status={job.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/trust">Trust model</Link> · <Link href="/platform">Platform</Link>
      </p>
    </div>
  );
}
