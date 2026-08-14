import { apiGet, type Consumer, type Provider } from "../../lib/api";
import Link from "next/link";
import { AgentForm } from "./agent-form";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  goal: string;
  status: string;
  ok: boolean;
  steps: number;
  filesChanged: string[];
  reportMd: string | null;
  createdAt: string;
};

type AgentConsumer = Consumer & {
  monitored: Array<{ provider_id: string }>;
};

export default async function AgentPage() {
  let runs: Run[] = [];
  let consumers: AgentConsumer[] = [];
  let providers: Provider[] = [];
  let error: string | null = null;
  const customerMode = process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer";
  const [runsResult, consumersResult, providersResult] = await Promise.allSettled([
    apiGet<Run[]>("/agent/runs"),
    apiGet<AgentConsumer[]>("/consumers"),
    customerMode ? apiGet<Provider[]>("/providers") : Promise.resolve([]),
  ]);
  if (runsResult.status === "fulfilled") runs = runsResult.value;
  if (consumersResult.status === "fulfilled") consumers = consumersResult.value;
  if (providersResult.status === "fulfilled") providers = providersResult.value;
  error = [
    runsResult.status === "rejected" ? "Gauge runs are temporarily unavailable" : null,
    consumersResult.status === "rejected" ? "Connected repositories are temporarily unavailable" : null,
    providersResult.status === "rejected" ? "Approved providers are temporarily unavailable" : null,
  ].filter(Boolean).join(". ") || null;
  const successfulStatus = (status: string) =>
    ["ok", "no_action", "candidate_ready", "candidate_approved"].includes(status);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Gauge</h1>
        <p className="muted">
          Mendpoint&apos;s API repair agent for wrong paths, field renames, auth headers, and
          pagination. Gauge works on a private candidate, reruns approved checks, and always
          requires review.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      )}

      <AgentForm
        consumers={consumers.map(({ id, name, monitored }) => ({
          id,
          name,
          providers: monitored.flatMap((entry) => {
            const provider = providers.find((candidate) => candidate.id === entry.provider_id);
            return provider ? [{ slug: provider.slug, name: provider.name }] : [];
          }),
        }))}
        customerMode={customerMode}
      />

      <section className="card">
        <h2>Recent runs</h2>
        {!runs.length && <p className="muted">No agent runs yet.</p>}
        <table className="table">
          <caption className="sr-only">Recent Gauge runs</caption>
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Steps</th>
              <th>Files</th>
              <th>Goal</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="mono small">{new Date(r.createdAt).toLocaleString()}</td>
                <td>
                  <span className={`badge ${successfulStatus(r.status) ? "high" : "breaking"}`}>
                    {r.status}
                  </span>
                </td>
                <td>{r.steps}</td>
                <td>{r.filesChanged?.length ?? 0}</td>
                <td className="small">
                  {r.status.startsWith("candidate_") ? (
                    <Link href={`/agent/${r.id}`}>{r.goal.slice(0, 80)}</Link>
                  ) : r.goal.slice(0, 80)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs[0]?.reportMd && (
          <pre className="code-block" style={{ marginTop: "1rem" }}>
            {runs[0].reportMd}
          </pre>
        )}
      </section>
    </div>
  );
}
