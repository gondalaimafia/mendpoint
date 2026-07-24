import { apiGet } from "../../lib/api";
import { AgentForm } from "./agent-form";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  goal: string;
  repoPath: string;
  status: string;
  ok: boolean;
  steps: number;
  filesChanged: string[];
  reportMd: string | null;
  createdAt: string;
};

type Consumer = { id: string; name: string };

export default async function AgentPage() {
  let runs: Run[] = [];
  let consumers: Consumer[] = [];
  let error: string | null = null;
  try {
    runs = await apiGet<Run[]>("/agent/runs");
    consumers = await apiGet<Consumer[]>("/consumers");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="page">
      <div className="page-header">
        <h1>Warden</h1>
        <p className="muted">
          Mendpoint&apos;s API debug agent — Devin-style tool loop for wrong paths, field renames,
          auth headers, pagination. Explores the repo, edits code, re-runs your verify command.
          Never auto-merges.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
        </div>
      )}

      <AgentForm consumers={consumers} />

      <section className="card">
        <h2>Recent runs</h2>
        {!runs.length && <p className="muted">No agent runs yet.</p>}
        <table className="table">
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
                  <span className={`badge ${r.ok ? "high" : "breaking"}`}>{r.status}</span>
                </td>
                <td>{r.steps}</td>
                <td>{r.filesChanged?.length ?? 0}</td>
                <td className="small">{r.goal.slice(0, 80)}</td>
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
    </main>
  );
}
