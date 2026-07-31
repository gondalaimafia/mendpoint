import { apiGet } from "../../lib/api";
import { RepairForm } from "./repair-form";

export const dynamic = "force-dynamic";

type Session = {
  id: string;
  consumerId: string | null;
  status: string;
  attempts: number;
  editsCount: number;
  ok: boolean;
  reportMd: string | null;
  createdAt: string;
  finishedAt: string | null;
};

type Consumer = {
  id: string;
  name: string;
  githubOwner: string;
  githubRepo: string;
};

export default async function RepairPage() {
  let sessions: Session[] = [];
  let consumers: Consumer[] = [];
  let error: string | null = null;
  try {
    sessions = await apiGet<Session[]>("/repair/sessions");
    consumers = await apiGet<Consumer[]>("/consumers");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="page">
      <div className="page-header">
        <h1>Agentic repair</h1>
        <p className="muted">
          Detect, diagnose, repair, and verify with bounded attempts. Every unverified mutation is
          rolled back. Verified work remains in the tenant checkout for review and is never merged
          automatically.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
          <p className="muted">Start API with <code>npm run dev:api</code></p>
        </div>
      )}

      <RepairForm consumers={consumers} />

      <section className="card">
        <h2>Recent sessions</h2>
        {!sessions.length && <p className="muted">No repair sessions yet.</p>}
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Edits</th>
              <th>Consumer</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td className="mono small">{new Date(s.createdAt).toLocaleString()}</td>
                <td>
                  <span className={`badge ${s.ok ? "high" : "breaking"}`}>
                    {s.status}
                  </span>
                </td>
                <td>{s.attempts}</td>
                <td>{s.editsCount}</td>
                <td className="mono small truncate">{s.consumerId ?? "unassigned"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions[0]?.reportMd && (
          <pre className="code-block" style={{ marginTop: "1rem" }}>
            {sessions[0].reportMd}
          </pre>
        )}
      </section>
    </main>
  );
}
