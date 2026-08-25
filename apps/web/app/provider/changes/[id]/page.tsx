import Link from "next/link";
import { graphPathDisplay, type GraphPath } from "@mendpoint/shared";
import { ApiRequestError, apiGet, type ChangeImpactCoverage, type MigrationPr } from "../../../../lib/api";
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
    // Provider->code path behind the finding (FET-016). null = not computed.
    // The shared GraphPath type is the single source of truth for the shape
    // (including the `no_anchor` terminal), so this cannot silently drift from
    // the analyzer that produces it or the formatter that renders it.
    graphPath: GraphPath | null;
  }>;
  prs: MigrationPr[];
  impactCoverage?: ChangeImpactCoverage;
};

type FindingGraphPath = ChangeDetail["findings"][number]["graphPath"];

/**
 * Render the provider->code reachability path for a finding (FET-016): the
 * import chain, provider anchor first. An absent path reads as "not computed"
 * (no locatable provider anchor), which is distinct from a short computed path.
 * The direct-vs-bounded decision comes from the shared graphPathDisplay helper
 * so this renderer stays in lockstep with the PR-body formatter: a one-node but
 * truncated `no_anchor` path is labelled incomplete, never "direct provider
 * usage".
 */
function renderGraphPath(graphPath: FindingGraphPath) {
  if (!graphPath) return <span className="muted">not computed</span>;
  const display = graphPathDisplay(graphPath);
  if (display.kind === "direct") {
    return <code title="Direct provider usage">{display.node}</code>;
  }
  const suffix =
    display.bound === "cycle"
      ? " (truncated at an import cycle)"
      : display.bound === "no_anchor"
        ? " (incomplete: no provider anchor reached)"
        : display.bound === "max_hops"
          ? ` (truncated at the ${display.hops}-hop limit)`
          : "";
  return (
    <code>
      {display.nodes.join(" → ")}
      {suffix}
    </code>
  );
}

function emptyFindingsCopy(coverage?: ChangeImpactCoverage): string {
  if (coverage?.impact === "no_impact" && coverage.fallback === "raw_retrieval") {
    return "No impact — analyzed without a tenant graph. This is not a graph-authoritative no-impact result; Fettler used bounded raw retrieval.";
  }
  if (coverage?.impact === "no_impact") {
    return "No impact — verified. Fettler analyzed the in-scope code with full coverage and found nothing affected.";
  }
  if (coverage?.impact === "unknown_impact" && coverage.reason === "partial_or_unknown_coverage") {
    return "No known impact under partial coverage. There may be affected code that was not analyzed.";
  }
  if (coverage?.impact === "unknown_impact" && coverage.reason === "analysis_did_not_run") {
    return "No analysis ran against real code. An empty findings list is not evidence of no impact.";
  }
  return "No impact findings are recorded. Confirm pipeline completion before treating this as no impact.";
}

function changeLoadMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) {
    return "The change could not be loaded. Retry or check system status.";
  }
  if (error.status === 401) return "Your session has expired. Sign in again and retry.";
  if (error.status === 403) return "You do not have access to this change.";
  if (error.status === 404) return "This change was not found.";
  if (error.status === 429) return "The service is busy. Wait a moment and retry.";
  return `The change service is temporarily unavailable${error.requestId ? `. Request ${error.requestId}` : ""}.`;
}

export default async function ChangeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let data: ChangeDetail | null = null;
  let error: unknown = null;
  try {
    data = await apiGet<ChangeDetail>(`/changes/${id}`);
  } catch (e) {
    error = e;
  }

  if (error || !data) {
    return (
      <div>
        <h1>Change unavailable</h1>
        <p className="muted">{changeLoadMessage(error)}</p>
        <p className="btn-row">
          <Link className="btn primary" href={`/provider/changes/${id}`}>Retry</Link>
          <Link className="btn" href="/status">System status</Link>
        </p>
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
        <span className="muted">
          {new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.createdAt))}
        </span>
      </div>
      <p className="lead" style={{ marginTop: "1rem" }}>
        {data.summary}
      </p>
      <p className="btn-row">
        <Link className="btn primary" href={`/graph?changeId=${data.id}`}>
          Open impact graph
        </Link>
        <a className="btn" href="/api/audit/export?format=json">
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
              <td className="muted">{String(e.path ?? "Not specified")}</td>
              <td>
                {e.fromField
                  ? `${String(e.fromField)} → ${String(e.toField)}`
                  : String(e.detail ?? e.field ?? "")}
              </td>
            </tr>
          ))}
          {data.diff.entries.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                No structural diff entries are recorded. Confirm analysis completed before closing this change.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Impact findings</h2>
      {data.findings.length > 0 && data.impactCoverage?.fallback === "raw_retrieval" && (
        <p className="muted">
          Impact was analyzed via raw retrieval, not a tenant graph.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Symbol</th>
            <th>Confidence</th>
            <th>Why (provider path)</th>
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
              <td>{renderGraphPath(f.graphPath)}</td>
            </tr>
          ))}
          {data.findings.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                {emptyFindingsCopy(data.impactCoverage)}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h2>Customer PRs</h2>
      <ul>
        {data.prs.map((p) => (
          <li key={p.id}>
            <Link href={`/consumer/prs/${p.id}`}>{p.title}</Link>{" "}
            <span className={`badge ${p.status}`}>{p.status}</span>
            {p.coverage && (
              <>
                {" "}
                <span className={`badge coverage-${p.coverage.basis}`}>
                  coverage: {p.coverage.basis}
                </span>
                {p.coverage.basis !== "analyzed" && p.coverage.reason && (
                  <span className="muted"> {p.coverage.reason}</span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {data.prs.length === 0 && (
        <p className="muted">
          No customer pull request has been generated. Review pipeline status and impact findings for the next action.
        </p>
      )}
    </div>
  );
}
