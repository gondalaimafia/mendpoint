import Link from "next/link";
import { apiGet } from "../../lib/api";
import { GraphExplorer } from "./explorer";

export const dynamic = "force-dynamic";

type Change = { id: string; risk: string; summary: string; createdAt: string };
type ProductGraph = {
  id: string;
  title: string;
  description?: string;
  nodes: Array<{
    id: string;
    kind: string;
    label: string;
    rank?: number;
    meta?: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    kind: string;
    meta?: Record<string, unknown>;
  }>;
  stats?: { nodeCount: number; edgeCount: number; byKind: Record<string, number> };
};

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ changeId?: string; view?: string; provider?: string }>;
}) {
  const sp = await searchParams;
  let changes: Change[] = [];
  let graph: ProductGraph | null = null;
  let error: string | null = null;

  try {
    const view = sp.view ?? (sp.changeId ? "change" : "product");
    if (view === "product" && !sp.changeId) {
      [changes, graph] = await Promise.all([
        apiGet<Change[]>("/changes"),
        apiGet<ProductGraph>("/graph/product"),
      ]);
    } else if (sp.provider) {
      [changes, graph] = await Promise.all([
        apiGet<Change[]>("/changes"),
        apiGet<ProductGraph>(`/graph/api/${sp.provider}`),
      ]);
    } else {
      changes = await apiGet<Change[]>("/changes");
      const changeId = sp.changeId ?? changes[0]?.id;
      if (changeId) {
        graph = await apiGet<ProductGraph>(`/graph/changes/${changeId}`);
      } else {
        graph = await apiGet<ProductGraph>("/graph/product");
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Graph explorer</h1>
        <p className="muted">
          Graph-native Mendpoint — API delta, blast radius, and product knowledge graph. PRs remain
          the action; this is the lens.
        </p>
      </div>

      {error && (
        <div className="card">
          <p className="error">{error}</p>
          <p className="muted">
            Start API with <code>npm run dev:api</code> and seed with <code>npm run db:seed</code> /
            demo.
          </p>
        </div>
      )}

      <div className="card">
        <div className="btn-row">
          <Link className="btn" href="/graph?view=product">
            Product graph
          </Link>
          {changes[0] && (
            <Link className="btn primary" href={`/graph?changeId=${changes[0].id}`}>
              Latest change impact
            </Link>
          )}
          <Link className="btn" href="/graph?provider=acme-payments">
            Acme API graph
          </Link>
        </div>
        {!changes.length && !error && (
          <p className="muted small" style={{ marginTop: "0.75rem" }}>
            No changes yet — run <code>npm run demo</code> or publish from Provider.
          </p>
        )}
      </div>

      {graph ? (
        <GraphExplorer initial={graph} changes={changes} selectedChangeId={sp.changeId} />
      ) : (
        !error && (
          <div className="card empty-state">
            <p>No graph to display.</p>
          </div>
        )
      )}
    </div>
  );
}
