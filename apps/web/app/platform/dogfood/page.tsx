import { apiGet } from "../../../lib/api";

export const dynamic = "force-dynamic";

type Dogfood = {
  totalRuns: number;
  okRuns: number;
  failRuns: number;
  okRate: number;
  recovered: number;
  avgDurationMs: number;
  day90Ready: boolean;
  meetsVolume: boolean;
  meetsOkRate: boolean;
  targetRuns: number;
  targetOkRate: number;
  notes: string[];
  markdown?: string;
  runs?: Array<{ runId: string; ok: boolean; durationMs: number }>;
};

export default async function DogfoodPage() {
  let dog: Dogfood | null = null;
  let error: string | null = null;
  try {
    dog = await apiGet<Dogfood>("/platform/dogfood");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Dogfood</h1>
      <p className="lead">
        Volume ≥{dog?.targetRuns ?? 30}, ok rate ≥
        {((dog?.targetOkRate ?? 0.5) * 100).toFixed(0)}%.
      </p>
      {error && <div className="card muted">API: {error}</div>}
      {dog && (
        <>
          <div className="grid">
            <div className="card">
              <h3>Runs</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {dog.totalRuns}/{dog.targetRuns}
              </p>
            </div>
            <div className="card">
              <h3>Ok rate</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {(dog.okRate * 100).toFixed(1)}%
              </p>
            </div>
            <div className="card">
              <h3>Day-90</h3>
              <p style={{ fontSize: "1.75rem", margin: 0 }}>
                {dog.day90Ready ? "READY" : "NOT YET"}
              </p>
            </div>
          </div>
          <div className="card" style={{ marginTop: "1rem" }}>
            <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
              {dog.markdown ?? JSON.stringify(dog, null, 2)}
            </pre>
            <ul>
              {(dog.notes ?? []).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
          <div className="card" style={{ marginTop: "1rem" }}>
            <h3>Recent runs</h3>
            <table>
              <thead>
                <tr>
                  <th>runId</th>
                  <th>ok</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {(dog.runs ?? []).slice(-20).map((r) => (
                  <tr key={r.runId}>
                    <td>
                      <code>{r.runId}</code>
                    </td>
                    <td>{r.ok ? "ok" : "fail"}</td>
                    <td>{r.durationMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
