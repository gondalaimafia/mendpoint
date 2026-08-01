import Link from "next/link";
import { apiGet, type ApiChange, type MigrationPr, type Provider } from "../../lib/api";
import { PublishForm } from "./publish-form";

export const dynamic = "force-dynamic";

export default async function ProviderPage() {
  let providers: Provider[] = [];
  let changes: ApiChange[] = [];
  let prs: MigrationPr[] = [];
  let catalog: Array<{ slug: string; name: string }> = [];
  let error: string | null = null;
  try {
    [providers, changes, prs, catalog] = await Promise.all([
      apiGet<Provider[]>("/providers"),
      apiGet<ApiChange[]>("/changes"),
      apiGet<MigrationPr[]>("/prs"),
      apiGet<Array<{ slug: string; name: string }>>("/catalog").catch(() => []),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const prsByChange = new Map<string, { total: number; merged: number }>();
  for (const pr of prs) {
    const summary = prsByChange.get(pr.changeId) ?? { total: 0, merged: 0 };
    summary.total += 1;
    if (pr.status === "merged") summary.merged += 1;
    prsByChange.set(pr.changeId, summary);
  }

  return (
    <div>
      <h1>Provider console</h1>
      <p className="lead">
        Publish OpenAPI versions, run the impact pipeline, and track migration adoption.
      </p>
      {error && (
        <div className="card" style={{ borderColor: "rgba(248,113,113,0.4)" }}>
          <p className="muted">
            API unavailable ({error}). Start with <code>npm run db:seed</code> then{" "}
            <code>npm run dev:api</code>.
          </p>
        </div>
      )}

      <h2>Publish change</h2>
      <PublishForm
        providers={
          providers.length
            ? providers.map((p) => ({ slug: p.slug, name: p.name }))
            : catalog.map((c) => ({ slug: c.slug, name: c.name }))
        }
      />

      <h2>Providers</h2>

      <div className="grid">
        {providers.map((p) => (
          <div className="card" key={p.id}>
            <h3>{p.name}</h3>
            <p className="muted">
              <code>{p.slug}</code>
            </p>
          </div>
        ))}
        {!providers.length && !error && <p className="muted">No providers yet.</p>}
      </div>

      <h2>Recent changes</h2>
      <p className="muted small">
        Set severity (required / recommended / optional) on change detail. Enterprise can use{" "}
        <code>notificationsOnly</code> publish. Export audit at <code>/audit/export</code>.
      </p>
      <table>
        <caption className="sr-only">Recent API changes and migration pull request progress</caption>
        <thead>
          <tr>
            <th>Risk</th>
            <th>Summary</th>
            <th>PRs</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {changes.map((ch) => {
            const related = prsByChange.get(ch.id) ?? { total: 0, merged: 0 };
            return (
              <tr key={ch.id}>
                <td>
                  <span className={`badge ${ch.risk}`}>{ch.risk}</span>
                </td>
                <td>{ch.summary}</td>
                <td className="muted">
                  {related.merged}/{related.total} merged
                </td>
                <td>
                  <Link href={`/provider/changes/${ch.id}`}>Open</Link>
                </td>
              </tr>
            );
          })}
          {!changes.length && (
            <tr>
              <td colSpan={4} className="muted">
                No changes yet — run <code>npm run demo</code>.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
