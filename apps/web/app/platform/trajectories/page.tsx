import Link from "next/link";
import { apiGet } from "../../../lib/api";

export const dynamic = "force-dynamic";

type Run = {
  runId: string;
  ok?: boolean;
  durationMs?: number;
  hasTrace: boolean;
  hasPlan: boolean;
};

export default async function TrajectoriesPage({
  searchParams,
}: {
  searchParams?: Promise<{ runId?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  let runs: Run[] = [];
  let detail: string | null = null;
  let error: string | null = null;
  try {
    const list = await apiGet<{ runs: Run[] }>("/platform/trajectories");
    runs = list.runs ?? [];
    if (sp.runId) {
      const d = await apiGet<{ text: string }>(
        `/platform/trajectories/${encodeURIComponent(sp.runId)}`,
      );
      detail = d.text;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Trajectories</h1>
      <p className="lead">runs/&lt;id&gt;/ plan · trace · score</p>
      {error && <div className="card muted">API: {error}</div>}
      <div className="card">
        <ul>
          {runs.map((r) => (
            <li key={r.runId}>
              <Link href={`/platform/trajectories?runId=${encodeURIComponent(r.runId)}`}>
                {r.runId}
              </Link>{" "}
              <span className="muted small">
                [{r.ok === undefined ? "?" : r.ok ? "ok" : "FAIL"}] {r.durationMs ?? "?"}
                ms plan={String(r.hasPlan)} trace={String(r.hasTrace)}
              </span>
            </li>
          ))}
          {!runs.length && <li className="muted">No runs yet</li>}
        </ul>
      </div>
      {detail && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem" }}>{detail}</pre>
        </div>
      )}
    </div>
  );
}
