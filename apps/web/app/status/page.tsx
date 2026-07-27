import { apiGet } from "../../lib/api";
import Link from "next/link";

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

export default async function StatusPage() {
  let s: Status | null = null;
  let error: string | null = null;
  try {
    s = await apiGet<Status>("/status");
  } catch (e) {
    try {
      s = await apiGet<Status>("/health");
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : String(e2);
    }
  }

  const ok = s && (s.status === "ok" || (s as { ok?: boolean }).ok);

  return (
    <div>
      <h1>System status</h1>
      <p className="lead">
        Production GA health for Mendpoint / Warden. Public probes:{" "}
        <code>/status</code> · <code>/ready</code> · <code>/live</code>
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
                  `${s.release?.product ?? "Warden"} ${s.release?.version ?? ""}`}
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
              <h3>GA features</h3>
              <ul className="small">
                {s.ga.gaFeatures.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
              <h3>Experimental (not GA)</h3>
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
      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/trust">Trust model</Link> · <Link href="/platform">Platform</Link>
      </p>
    </div>
  );
}
