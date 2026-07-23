import { apiGet, apiPost } from "../../lib/api";
import { PollButton } from "./poll-button";

type Feed = {
  slug: string;
  name: string;
  openapiUrl: string;
  changelogUrl?: string;
  source: string;
};

type Poll = {
  id: string;
  providerSlug: string;
  openapiUrl: string;
  contentHash: string | null;
  versionLabel: string | null;
  status: string;
  error: string | null;
  polledAt: string;
};

export default async function FeedsPage() {
  let catalog: Feed[] = [];
  let recentPolls: Poll[] = [];
  let error: string | null = null;
  try {
    const data = await apiGet<{ catalog: Feed[]; recentPolls: Poll[] }>("/feeds");
    catalog = data.catalog;
    recentPolls = data.recentPolls;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="page">
      <div className="page-header">
        <h1>Continuous feeds</h1>
        <p className="muted">
          Mendpoint continuous feeds — poll vendor OpenAPI URLs, store versions when content
          changes, run the migration pipeline.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">API offline: {error}</p>
          <p className="muted">Start with <code>npm run dev:api</code></p>
        </div>
      )}

      <section className="card">
        <div className="row-between">
          <h2>Catalog feeds</h2>
          <PollButton />
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Source</th>
              <th>OpenAPI URL</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((f) => (
              <tr key={f.slug}>
                <td>
                  <strong>{f.slug}</strong>
                  <div className="muted">{f.name}</div>
                </td>
                <td>{f.source}</td>
                <td className="mono truncate">{f.openapiUrl}</td>
              </tr>
            ))}
            {!catalog.length && (
              <tr>
                <td colSpan={3} className="muted">
                  No feeds configured
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Recent polls</h2>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Version</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {recentPolls.map((p) => (
              <tr key={p.id}>
                <td className="mono">{new Date(p.polledAt).toLocaleString()}</td>
                <td>{p.providerSlug}</td>
                <td>
                  <span className={`badge badge-${p.status}`}>{p.status}</span>
                  {p.error && <div className="muted small">{p.error}</div>}
                </td>
                <td>{p.versionLabel ?? "—"}</td>
                <td className="mono">{p.contentHash?.slice(0, 8) ?? "—"}</td>
              </tr>
            ))}
            {!recentPolls.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No polls yet — run Poll now or <code>npm run worker -- poll-once --local</code>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}
