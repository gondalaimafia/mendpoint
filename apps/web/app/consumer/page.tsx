import Link from "next/link";
import { apiGet, type Consumer, type MigrationPr } from "../../lib/api";
import { DetectButton } from "./detect-button";

export const dynamic = "force-dynamic";

type ConsumerRow = Consumer & {
  monitored?: Array<{ id: string; provider_id: string; detection_source: string }>;
};

export default async function ConsumerPage() {
  let consumers: ConsumerRow[] = [];
  let prs: MigrationPr[] = [];
  let suppressed: Array<{ pattern: string; reason: string | null }> = [];
  let error: string | null = null;
  try {
    [consumers, prs, suppressed] = await Promise.all([
      apiGet<ConsumerRow[]>("/consumers"),
      apiGet<MigrationPr[]>("/prs"),
      apiGet<Array<{ pattern: string; reason: string | null }>>("/learning/suppressed").catch(
        () => [],
      ),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const pending = prs.filter((p) => p.status === "open" || p.status === "low_confidence" || p.status === "draft");

  return (
    <div>
      <h1>Consumer console</h1>
      <p className="lead">
        Connected repos, auto-detected APIs, suppressed patterns from closed PRs, and pending
        migrations.
      </p>
      {error && (
        <div className="card">
          <p className="muted">API unavailable: {error}</p>
        </div>
      )}

      <h2>Repositories</h2>
      <div className="grid">
        {consumers.map((c) => (
          <div className="card" key={c.id}>
            <h3>{c.name}</h3>
            <p className="muted">
              <code>
                {c.githubOwner}/{c.githubRepo}
              </code>
            </p>
            <p className="muted">
              Monitored: {c.monitored?.length ?? 0}
              {c.monitored?.some((m) => m.detection_source === "auto_detect")
                ? " (incl. auto-detect)"
                : ""}
            </p>
            <DetectButton consumerId={c.id} />
          </div>
        ))}
      </div>

      {suppressed.length > 0 && (
        <>
          <h2>Learning — suppressed patterns</h2>
          <p className="muted">Closed PRs teach the agent not to re-propose these symbols.</p>
          <ul>
            {suppressed.slice(0, 20).map((s, i) => (
              <li key={i}>
                <code>{s.pattern}</code>
                {s.reason ? <span className="muted"> — {s.reason}</span> : null}
              </li>
            ))}
          </ul>
        </>
      )}


      <h2>Pending PRs</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Risk</th>
            <th>Title</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {pending.map((p) => (
            <tr key={p.id}>
              <td>
                <span className={`badge ${p.status}`}>{p.status}</span>
              </td>
              <td>
                <span className={`badge ${p.risk}`}>{p.risk}</span>
              </td>
              <td>{p.title}</td>
              <td>
                <Link href={`/consumer/prs/${p.id}`}>Review</Link>
                {p.githubPrUrl ? (
                  <>
                    {" · "}
                    <a href={p.githubPrUrl} target="_blank" rel="noreferrer">
                      GitHub ↗
                    </a>
                  </>
                ) : null}
              </td>

            </tr>
          ))}
          {!pending.length && (
            <tr>
              <td colSpan={4} className="muted">
                No pending PRs — run <code>npm run demo</code> after seed.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
