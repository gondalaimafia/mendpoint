import Link from "next/link";
import { apiGet, type MigrationPr } from "../../../../lib/api";
import { SeverityForm } from "./severity-form";

export const dynamic = "force-dynamic";

type ChangeDetail = {
  id: string;
  risk: string;
  summary: string;
  severity?: string;
  createdAt: string;
  diff: { entries: Array<Record<string, unknown>> };
  findings: Array<{
    id: string;
    filePath: string;
    lineStart: number;
    symbol: string;
    confidence: string;
  }>;
  prs: MigrationPr[];
};

export default async function ChangeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let data: ChangeDetail | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<ChangeDetail>(`/changes/${id}`);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !data) {
    return (
      <div>
        <p className="muted">{error ?? "Not found"}</p>
        <Link href="/provider">← Back</Link>
      </div>
    );
  }

  return (
    <div>
      <p className="muted">
        <Link href="/provider">← Provider</Link>
      </p>
      <h1>Change detail</h1>
      <div className="btn-row">
        <span className={`badge ${data.risk}`}>{data.risk}</span>
        {data.severity && <span className="badge">{data.severity}</span>}
        <span className="muted">{data.createdAt}</span>
      </div>
      <p className="lead" style={{ marginTop: "1rem" }}>
        {data.summary}
      </p>
      <p className="btn-row">
        <Link className="btn primary" href={`/graph?changeId=${data.id}`}>
          Open impact graph
        </Link>
        <a className="btn" href="http://localhost:3001/audit/export?format=json" target="_blank" rel="noreferrer">
          Export audit (JSON)
        </a>
      </p>

      <SeverityForm changeId={data.id} initial={data.severity} />

      <h2>Diff entries</h2>
      <table>
        <thead>
          <tr>
            <th>Op</th>
            <th>Path</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {data.diff.entries.map((e, i) => (
            <tr key={i}>
              <td>
                <code>{String(e.op)}</code>
              </td>
              <td className="muted">{String(e.path ?? "—")}</td>
              <td>
                {e.fromField
                  ? `${String(e.fromField)} → ${String(e.toField)}`
                  : String(e.detail ?? e.field ?? "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Impact findings</h2>
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Symbol</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {data.findings.map((f) => (
            <tr key={f.id}>
              <td>
                <code>
                  {f.filePath}:{f.lineStart}
                </code>
              </td>
              <td>{f.symbol}</td>
              <td className="muted">{f.confidence}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Customer PRs</h2>
      <ul>
        {data.prs.map((p) => (
          <li key={p.id}>
            <Link href={`/consumer/prs/${p.id}`}>{p.title}</Link>{" "}
            <span className={`badge ${p.status}`}>{p.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
