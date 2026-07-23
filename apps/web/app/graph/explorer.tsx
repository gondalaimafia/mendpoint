"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type GNode = {
  id: string;
  kind: string;
  label: string;
  rank?: number;
  meta?: Record<string, unknown>;
};

type GEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  meta?: Record<string, unknown>;
};

type ProductGraph = {
  id: string;
  title: string;
  description?: string;
  nodes: GNode[];
  edges: GEdge[];
  stats?: { nodeCount: number; edgeCount: number; byKind: Record<string, number> };
};

const KIND_COLOR: Record<string, string> = {
  change: "#fbbf24",
  surface: "#60a5fa",
  operation: "#38bdf8",
  field: "#a78bfa",
  finding: "#34d399",
  function: "#2dd4bf",
  file: "#94a3b8",
  provider: "#f472b6",
  version: "#fb7185",
  consumer: "#4ade80",
  pr: "#f87171",
  tenant: "#e2e8f0",
  installation: "#c084fc",
};

/** Deterministic jitter so same-rank nodes don't fully overlap */
function hashJitter(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 1000) / 1000) * 2 - 1; // -1..1
}

function layout(
  nodes: GNode[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const byRank = new Map<number, GNode[]>();
  for (const n of nodes) {
    const r = n.rank ?? 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(n);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  const padX = 56;
  const padY = 48;

  ranks.forEach((rank, ri) => {
    const row = byRank.get(rank)!;
    const yBase =
      padY +
      (ranks.length <= 1 ? height / 2 : (ri / Math.max(ranks.length - 1, 1)) * (height - padY * 2));
    row.forEach((n, i) => {
      const xBase =
        padX +
        (row.length <= 1
          ? width / 2
          : (i / Math.max(row.length - 1, 1)) * (width - padX * 2));
      const jx = hashJitter(n.id) * 12;
      const jy = hashJitter(n.id + ":y") * 10;
      pos.set(n.id, { x: xBase + jx, y: yBase + jy });
    });
  });
  return pos;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GraphExplorer({
  initial,
  changes,
  selectedChangeId,
}: {
  initial: ProductGraph;
  changes: Array<{ id: string; risk: string; summary: string }>;
  selectedChangeId?: string;
}) {
  const router = useRouter();
  const [graph, setGraph] = useState(initial);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const debouncedFilter = useDebounced(filter, 120);
  const [kindFilter, setKindFilter] = useState<string>("all");

  useEffect(() => {
    setGraph(initial);
    setSelected(null);
    setError(null);
  }, [initial]);

  const kindsPresent = useMemo(() => {
    const s = new Set(graph.nodes.map((n) => n.kind));
    return [...s].sort();
  }, [graph.nodes]);

  const filteredNodes = useMemo(() => {
    let list = graph.nodes;
    if (kindFilter !== "all") list = list.filter((n) => n.kind === kindFilter);
    if (!debouncedFilter.trim()) return list;
    const q = debouncedFilter.toLowerCase();
    return list.filter(
      (n) =>
        n.label.toLowerCase().includes(q) ||
        n.kind.includes(q) ||
        n.id.toLowerCase().includes(q),
    );
  }, [graph.nodes, debouncedFilter, kindFilter]);

  const visible = useMemo(
    () => new Set(filteredNodes.map((n) => n.id)),
    [filteredNodes],
  );

  const edges = useMemo(
    () => graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
    [graph.edges, visible],
  );

  const w = 920;
  const h = Math.min(620, Math.max(420, 80 + filteredNodes.length * 4));
  const pos = useMemo(() => layout(filteredNodes, w, h), [filteredNodes, w, h]);

  const loadChange = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const path = id ? `/graph/changes/${id}` : "/graph/product";
        const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
        if (!res.ok) {
          const t = await res.text();
          throw new Error(t.slice(0, 200) || res.statusText);
        }
        setGraph(await res.json());
        setSelected(null);
        router.replace(id ? `/graph?changeId=${id}` : "/graph?view=product");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const empty = filteredNodes.length === 0;

  return (
    <div className="graph-layout">
      <section className="card graph-main">
        <div className="row-between">
          <div>
            <h2 style={{ margin: 0 }}>{graph.title}</h2>
            <p className="muted small" style={{ margin: "0.25rem 0 0" }}>
              {graph.description} · {graph.stats?.nodeCount ?? graph.nodes.length} nodes ·{" "}
              {graph.stats?.edgeCount ?? graph.edges.length} edges
              {busy ? " · loading…" : ""}
            </p>
          </div>
          <select
            className="input"
            style={{ maxWidth: 280 }}
            value={selectedChangeId ?? ""}
            onChange={(e) => loadChange(e.target.value)}
            disabled={busy}
            aria-label="Select change or product overview"
          >
            <option value="">Product overview</option>
            {changes.map((ch) => (
              <option key={ch.id} value={ch.id}>
                [{ch.risk}] {ch.summary.slice(0, 48)}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="banner-error" role="alert">
            {error}
            <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => loadChange(selectedChangeId ?? "")}>
              Retry
            </button>
          </div>
        )}

        <div className="graph-toolbar">
          <input
            className="input"
            placeholder="Filter nodes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter graph nodes"
          />
          <select
            className="input"
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            aria-label="Filter by node kind"
            style={{ maxWidth: 160 }}
          >
            <option value="all">All kinds</option>
            {kindsPresent.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>

        {empty ? (
          <div className="empty-state">
            <p>
              {graph.nodes.length === 0
                ? "No graph data yet. Run a demo or publish a change, then refresh."
                : "No nodes match this filter."}
            </p>
            {graph.nodes.length === 0 && (
              <p className="muted small">
                <code>npm run demo</code> or open Provider → Publish
              </p>
            )}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className={`graph-svg${busy ? " is-loading" : ""}`}
            role="img"
            aria-label="Mendpoint impact graph"
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5c56" />
              </marker>
            </defs>
            {edges.map((e) => {
              const a = pos.get(e.source);
              const b = pos.get(e.target);
              if (!a || !b) return null;
              const highlight =
                selected && (e.source === selected.id || e.target === selected.id);
              return (
                <line
                  key={e.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={highlight ? "#34d399" : "#4b5c56"}
                  strokeWidth={highlight ? 2 : 1.2}
                  markerEnd="url(#arrow)"
                  opacity={highlight ? 0.95 : 0.65}
                />
              );
            })}
            {filteredNodes.map((n) => {
              const p = pos.get(n.id);
              if (!p) return null;
              const color = KIND_COLOR[n.kind] ?? "#94a3b8";
              const active = selected?.id === n.id;
              return (
                <g
                  key={n.id}
                  transform={`translate(${p.x},${p.y})`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelected(n)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      setSelected(n);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`${n.kind}: ${n.label}`}
                >
                  <circle
                    r={active ? 16 : 12}
                    fill={color}
                    stroke={active ? "#fff" : "#0b0f0e"}
                    strokeWidth={active ? 2.5 : 1}
                    opacity={0.95}
                  />
                  <title>{`${n.kind}: ${n.label}`}</title>
                  <text
                    y={28}
                    textAnchor="middle"
                    fill="#c5d4cc"
                    fontSize={10}
                    style={{ pointerEvents: "none" }}
                  >
                    {n.label.length > 20 ? n.label.slice(0, 18) + "…" : n.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        <div className="legend" aria-hidden>
          {Object.entries(KIND_COLOR)
            .filter(([k]) => kindsPresent.includes(k) || kindsPresent.length === 0)
            .map(([k, c]) => (
              <span key={k} className="legend-item">
                <span className="legend-dot" style={{ background: c }} />
                {k}
              </span>
            ))}
        </div>
      </section>

      <aside className="card graph-side">
        <h3>Node detail</h3>
        {!selected && (
          <p className="muted">
            Click a node to inspect evidence. Edges highlight when a node is selected.
          </p>
        )}
        {selected && (
          <div className="stack">
            <div>
              <span
                className="badge kind-badge"
                style={{ background: KIND_COLOR[selected.kind] ?? "#64748b", color: "#0b0f0e" }}
              >
                {selected.kind}
              </span>
              {typeof selected.meta?.confidence === "string" && (
                <span className={`badge ${selected.meta.confidence}`} style={{ marginLeft: 6 }}>
                  {String(selected.meta.confidence)}
                </span>
              )}
            </div>
            <strong>{selected.label}</strong>
            <code className="small break-all">{selected.id}</code>
            {selected.meta && (
              <pre className="code-block">{JSON.stringify(selected.meta, null, 2)}</pre>
            )}
            <div>
              <p className="muted small">Connected edges</p>
              <ul className="edge-list">
                {graph.edges
                  .filter((e) => e.source === selected.id || e.target === selected.id)
                  .slice(0, 24)
                  .map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => {
                          const otherId = e.source === selected.id ? e.target : e.source;
                          const n = graph.nodes.find((x) => x.id === otherId);
                          if (n) setSelected(n);
                        }}
                      >
                        <code>{e.kind}</code>{" "}
                        <span className="muted">
                          {e.source === selected.id ? "→" : "←"}{" "}
                          {e.source === selected.id ? e.target : e.source}
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
            {selected.kind === "pr" && selected.meta?.url && (
              <a className="btn primary" href={String(selected.meta.url)} target="_blank" rel="noreferrer">
                Open PR
              </a>
            )}
            {(selected.kind === "change" || selected.id.startsWith("change:")) && (
              <a
                className="btn"
                href={`/provider/changes/${
                  selected.meta?.changeId
                    ? String(selected.meta.changeId)
                    : selected.id.replace(/^change:/, "")
                }`}
              >
                Change detail
              </a>
            )}
          </div>
        )}

        {graph.stats?.byKind && (
          <div style={{ marginTop: "1.5rem" }}>
            <h3>By kind</h3>
            <ul className="edge-list">
              {Object.entries(graph.stats.byKind).map(([k, n]) => (
                <li key={k}>
                  <button type="button" className="linkish" onClick={() => setKindFilter(k)}>
                    {k}: <strong>{n}</strong>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
