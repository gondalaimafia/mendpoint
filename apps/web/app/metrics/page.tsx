import Link from "next/link";
import { apiGet } from "../../lib/api";

export const dynamic = "force-dynamic";

type Metrics = {
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  prsOpen: number;
  prsLowConfidence: number;
  mergeRate: number | null;
  closeWithoutMergeRate: number | null;
  medianTimeToMergeHours: number | null;
  realGithubPrs: number;
  mockOrLocalPrs: number;
  auditEvents: number;
  consumers?: number;
  monitoredApis?: number;
  changes?: number;
  suppressedPatterns?: number;
  notificationOnlyEvents?: number;
  coverage?: number | null;
  recent: Array<{
    id: string;
    title: string;
    status: string;
    risk: string;
    githubPrUrl: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  computedAt: string;
};

function pct(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export default async function MetricsPage() {
  let m: Metrics | null = null;
  let error: string | null = null;
  try {
    m = await apiGet<Metrics>("/metrics/design-partner");
  } catch (e) {
    try {
      m = await apiGet<Metrics>("/metrics");
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : String(e2);
    }
  }

  return (
    <div>
      <h1>Product metrics</h1>
      <p className="lead">
        Design-partner instrumentation: PR funnel, merge rate, coverage, suppressions,
        notification-only events, time-to-merge.
      </p>
      <p className="command-actions" aria-label="Related views">
        <Link className="btn" href="/metrics/dashboard">
          Self-serve dashboard
        </Link>
      </p>
      {error && (
        <div className="card">
          <p className="muted">API unavailable: {error}</p>
        </div>
      )}
      {m && (
        <>
          <div className="grid">
            {m.consumers != null && (
              <div className="card">
                <h3>Consumers</h3>
                <p style={{ fontSize: "1.75rem", margin: 0 }}>{m.consumers}</p>
                <p className="muted small">monitored APIs: {m.monitoredApis ?? 0}</p>
              </div>
            )}
            {m.changes != null && (
              <div className="card">
                <h3>Changes</h3>
                <p style={{ fontSize: "1.75rem", margin: 0 }}>{m.changes}</p>
                <p className="muted small">suppressed: {m.suppressedPatterns ?? 0}</p>
              </div>
            )}
            {m.notificationOnlyEvents != null && (
              <div className="card">
                <h3>Notify-only</h3>
                <p style={{ fontSize: "1.75rem", margin: 0 }}>{m.notificationOnlyEvents}</p>
              </div>
            )}
            <div className="card">
              <h3>PRs opened</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>{m.prsOpened}</p>
              <p className="muted">
                open {m.prsOpen} · merged {m.prsMerged} · closed {m.prsClosed} · low-conf{" "}
                {m.prsLowConfidence}
              </p>
            </div>
            <div className="card">
              <h3>Merge rate</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>{pct(m.mergeRate)}</p>
              <p className="muted">merged / (merged + closed)</p>
            </div>
            <div className="card">
              <h3>Close w/o merge</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>{pct(m.closeWithoutMergeRate)}</p>
              <p className="muted">proxy for false-positive / rejected PRs</p>
            </div>
            <div className="card">
              <h3>Median TTM</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {m.medianTimeToMergeHours === null
                  ? "—"
                  : `${m.medianTimeToMergeHours.toFixed(1)}h`}
              </p>
              <p className="muted">hours open → merged</p>
            </div>
            <div className="card">
              <h3>Real GitHub PRs</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>{m.realGithubPrs}</p>
              <p className="muted">mock/local {m.mockOrLocalPrs} · audits {m.auditEvents}</p>
            </div>
          </div>
          <h2>Recent PRs</h2>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Risk</th>
                <th>Title</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {m.recent.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className={`badge ${p.status}`}>{p.status}</span>
                  </td>
                  <td>
                    <span className={`badge ${p.risk}`}>{p.risk}</span>
                  </td>
                  <td>{p.title}</td>
                  <td>
                    {p.githubPrUrl ? (
                      <a href={p.githubPrUrl} target="_blank" rel="noreferrer">
                        GitHub ↗
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
              {!m.recent.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No PRs yet — run <code>npm run phase-a</code> or <code>npm run demo</code>.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="muted">Computed {m.computedAt}</p>
        </>
      )}
    </div>
  );
}
