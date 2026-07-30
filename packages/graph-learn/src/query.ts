/**
 * Graph-RAG query layer — deterministic multi-hop templates for planners.
 * All queries record latency samples for SLO checks.
 */
import type { GlEdge, GlNode, GraphQuery, GraphQueryResult } from "./schema.js";
import {
  countStats,
  edgesByKindAt,
  edgesFrom,
  edgesTo,
  getNode,
  listNodesByKind,
  type GraphLearnDb,
} from "./store.js";
import {
  formatLatencyReport,
  latencyReport,
  recordLatency,
} from "./slo.js";

function collectNodes(db: GraphLearnDb, ids: Iterable<string>): GlNode[] {
  const out: GlNode[] = [];
  for (const id of ids) {
    const n = getNode(db, id);
    if (n) out.push(n);
  }
  return out;
}

/** BFS multi-hop neighborhood. */
export function blastRadius(
  db: GraphLearnDb,
  nodeId: string,
  maxHops = 2,
): { nodes: GlNode[]; edges: GlEdge[] } {
  const seen = new Set<string>([nodeId]);
  const seenEdges = new Set<string>();
  const edgeAcc: GlEdge[] = [];
  let frontier = [nodeId];
  for (let h = 0; h < maxHops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of [...edgesFrom(db, id), ...edgesTo(db, id)]) {
        if (!seenEdges.has(e.id)) {
          seenEdges.add(e.id);
          edgeAcc.push(e);
        }
        const other = e.source === id ? e.target : e.source;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { nodes: collectNodes(db, seen), edges: edgeAcc };
}

export function runGraphQuery(db: GraphLearnDb, q: GraphQuery): GraphQueryResult {
  const t0 = performance.now();
  try {
    return runGraphQueryInner(db, q);
  } finally {
    recordLatency(q.op, performance.now() - t0);
  }
}

function runGraphQueryInner(
  db: GraphLearnDb,
  q: GraphQuery,
): GraphQueryResult {
  switch (q.op) {
    case "stats": {
      const s = countStats(db);
      return {
        op: "stats",
        nodes: [],
        edges: [],
        summary: `${s.nodes} nodes, ${s.edges} edges`,
        rows: [s],
      };
    }
    case "latency_stats": {
      const report = latencyReport();
      return {
        op: "latency_stats",
        nodes: [],
        edges: [],
        summary: formatLatencyReport(report),
        rows: report.ops.map((o) => ({
          op: o.op,
          n: o.n,
          p50Ms: Number(o.p50Ms.toFixed(2)),
          p99Ms: Number(o.p99Ms.toFixed(2)),
          maxMs: Number(o.maxMs.toFixed(2)),
          p50Ok: o.p50Ok,
          p99Ok: o.p99Ok,
          targetP50: o.target.p50Ms,
          targetP99: o.target.p99Ms,
        })),
      };
    }
    case "who_consumes_provider": {
      const pId = `provider:${q.providerSlug}`;
      const edges = [
        ...edgesTo(db, pId, ["MONITORS", "CONSUMES"]),
      ];
      const consumerIds = [...new Set(edges.map((e) => e.source))];
      const nodes = collectNodes(db, [pId, ...consumerIds]);
      return {
        op: q.op,
        nodes,
        edges,
        summary: `${consumerIds.length} consumer(s) monitor ${q.providerSlug}`,
        rows: consumerIds.map((id) => ({ consumerId: id.replace(/^consumer:/, "") })),
      };
    }
    case "who_consumes_endpoint": {
      const eid = `endpoint:${q.providerSlug}:${(q.method ?? "ANY").toUpperCase()}:${q.path}`;
      const p = runGraphQuery(db, {
        op: "who_consumes_provider",
        providerSlug: q.providerSlug,
      });
      const breakEdges = edgesTo(db, eid, ["BREAKS"]);
      const consumeEp = edgesTo(db, eid, ["CONSUMES"]);
      return {
        op: q.op,
        nodes: [...p.nodes, ...collectNodes(db, [eid])],
        edges: [...p.edges, ...breakEdges, ...consumeEp],
        summary: `endpoint ${q.method ?? ""} ${q.path} — ${p.rows?.length ?? 0} provider consumer(s); ${breakEdges.length} break edge(s)`,
        rows: p.rows,
      };
    }
    case "blast_radius": {
      const r = blastRadius(db, q.nodeId, q.maxHops ?? 2);
      return {
        op: q.op,
        nodes: r.nodes,
        edges: r.edges,
        summary: `blast radius from ${q.nodeId}: ${r.nodes.length} nodes, ${r.edges.length} edges`,
      };
    }
    case "neighbors": {
      const dir = q.direction ?? "both";
      const outE =
        dir === "in" ? [] : edgesFrom(db, q.nodeId, q.edgeKinds);
      const inE = dir === "out" ? [] : edgesTo(db, q.nodeId, q.edgeKinds);
      const edges = [...outE, ...inE];
      const ids = new Set<string>([q.nodeId]);
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} neighbor edge(s)`,
      };
    }
    case "depends_on_path": {
      const path: string[] = [q.nodeId];
      const edges: GlEdge[] = [];
      let cur = q.nodeId;
      for (let i = 0; i < (q.maxHops ?? 8); i++) {
        const deps = edgesFrom(db, cur, ["DEPENDS_ON"]);
        if (!deps.length) break;
        edges.push(deps[0]!);
        cur = deps[0]!.target;
        path.push(cur);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, path),
        edges,
        summary: `depends_on path length ${path.length - 1}`,
        rows: path.map((id, i) => ({ step: i, nodeId: id })),
      };
    }
    case "neighborhood": {
      return runGraphQuery(db, {
        op: "blast_radius",
        nodeId: q.nodeId,
        maxHops: q.k ?? 1,
      });
    }
    case "callers": {
      const edges = edgesTo(db, q.symbolId, ["CALLS", "IMPACTS"]);
      const ids = new Set<string>([q.symbolId, ...edges.map((e) => e.source)]);
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} caller edge(s) into ${q.symbolId}`,
        rows: edges.map((e) => ({ from: e.source, kind: e.kind })),
      };
    }
    case "path": {
      // BFS path from → to
      const maxHops = q.maxHops ?? 6;
      const prev = new Map<string, { id: string; edge?: GlEdge }>();
      prev.set(q.fromId, { id: q.fromId });
      let frontier = [q.fromId];
      let found = false;
      for (let h = 0; h < maxHops && !found; h++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const e of edgesFrom(db, id)) {
            if (prev.has(e.target)) continue;
            prev.set(e.target, { id: e.target, edge: e });
            if (e.target === q.toId) {
              found = true;
              break;
            }
            next.push(e.target);
          }
          if (found) break;
        }
        frontier = next;
      }
      if (!found) {
        return {
          op: q.op,
          nodes: [],
          edges: [],
          summary: `no path ${q.fromId} → ${q.toId}`,
        };
      }
      const pathIds: string[] = [];
      const pathEdges: GlEdge[] = [];
      let cur: string | undefined = q.toId;
      while (cur) {
        pathIds.unshift(cur);
        const p = prev.get(cur);
        if (p?.edge) pathEdges.unshift(p.edge);
        if (cur === q.fromId) break;
        cur = p?.edge?.source;
        if (cur === undefined) break;
      }
      return {
        op: q.op,
        nodes: collectNodes(db, pathIds),
        edges: pathEdges,
        summary: `path length ${pathEdges.length}`,
        rows: pathIds.map((id, i) => ({ step: i, nodeId: id })),
      };
    }
    case "pattern_success_rates": {
      const minS = q.minSamples ?? 1;
      const stats = new Map<string, { ok: number; fail: number }>();
      for (const c of listNodesByKind(db, "Consumer")) {
        for (const e of edgesFrom(db, c.id, [
          "OUTCOME_MERGED",
          "OUTCOME_CLOSED",
          "OUTCOME_BROKE",
          "OUTCOME_WAIVED",
        ])) {
          const pattern = String(
            (e.props as { pattern?: string } | undefined)?.pattern ?? e.target,
          );
          const s = stats.get(pattern) ?? { ok: 0, fail: 0 };
          if (e.kind === "OUTCOME_MERGED" || e.kind === "OUTCOME_WAIVED") s.ok++;
          else s.fail++;
          stats.set(pattern, s);
        }
      }
      const rows = [...stats.entries()]
        .map(([pattern, s]) => {
          const n = s.ok + s.fail;
          return {
            pattern,
            samples: n,
            successRate: n ? s.ok / n : 0,
            ok: s.ok,
            fail: s.fail,
          };
        })
        .filter((r) => r.samples >= minS)
        .sort((a, b) => b.successRate - a.successRate);
      return {
        op: q.op,
        nodes: [],
        edges: [],
        summary: `${rows.length} pattern(s) with >=${minS} samples`,
        rows,
      };
    }
    case "outcomes_for_pattern": {
      const allOut = [...listNodesByKind(db, "PullRequest")];
      const rows: Array<Record<string, unknown>> = [];
      const edges: GlEdge[] = [];
      const nodes: GlNode[] = [];
      for (const n of allOut) {
        if (
          n.label.toLowerCase().includes(q.pattern.toLowerCase()) ||
          JSON.stringify(n.props ?? {}).toLowerCase().includes(q.pattern.toLowerCase())
        ) {
          nodes.push(n);
          const es = edgesFrom(db, n.id);
          edges.push(...es);
          rows.push({ pr: n.id, label: n.label, props: n.props });
        }
      }
      for (const kind of [
        "OUTCOME_MERGED",
        "OUTCOME_CLOSED",
        "OUTCOME_BROKE",
      ] as const) {
        const consumers = listNodesByKind(db, "Consumer");
        for (const c of consumers) {
          for (const e of edgesFrom(db, c.id, [kind])) {
            if (
              JSON.stringify(e.props ?? {})
                .toLowerCase()
                .includes(q.pattern.toLowerCase()) ||
              e.target.includes(q.pattern)
            ) {
              edges.push(e);
              rows.push({ edge: e.id, kind: e.kind, label: e.label });
            }
          }
        }
      }
      return {
        op: q.op,
        nodes,
        edges,
        summary: `${rows.length} outcome hit(s) for pattern ${JSON.stringify(q.pattern)}`,
        rows,
      };
    }
    case "consumers_of_field": {
      const fields = listNodesByKind(db, "Field").filter(
        (f) =>
          f.label === q.fieldName ||
          String(f.props?.name) === q.fieldName,
      );
      const edges: GlEdge[] = [];
      const nodeIds = new Set<string>();
      const schemaIds = new Set<string>();
      for (const f of fields) {
        for (const e of edgesTo(db, f.id, ["HAS_FIELD"])) {
          const schema = getNode(db, e.source);
          if (
            !schema ||
            !(
              schema.label === q.schemaName ||
              schema.id === q.schemaName ||
              schema.id.endsWith(`:${q.schemaName}`) ||
              String(schema.props?.name) === q.schemaName
            )
          ) {
            continue;
          }
          nodeIds.add(f.id);
          edges.push(e);
          nodeIds.add(e.source);
          schemaIds.add(e.source);
        }
      }

      const endpointIds = new Set<string>();
      for (const schemaId of schemaIds) {
        for (const edge of edgesTo(db, schemaId, ["HAS_SCHEMA"])) {
          edges.push(edge);
          endpointIds.add(edge.source);
          nodeIds.add(edge.source);
        }
        const schema = getNode(db, schemaId);
        const path = String(schema?.props?.path ?? "");
        const method = String(schema?.props?.method ?? "").toUpperCase();
        if (path) {
          for (const endpoint of listNodesByKind(db, "Endpoint")) {
            if (
              String(endpoint.props?.path) === path &&
              (!method || String(endpoint.props?.method).toUpperCase() === method)
            ) {
              endpointIds.add(endpoint.id);
              nodeIds.add(endpoint.id);
            }
          }
        }
      }

      const providerIds = new Set<string>();
      const consumerIds = new Set<string>();
      for (const endpointId of endpointIds) {
        for (const edge of edgesTo(db, endpointId, ["HAS_ENDPOINT"])) {
          edges.push(edge);
          providerIds.add(edge.source);
          nodeIds.add(edge.source);
        }
        for (const edge of edgesTo(db, endpointId, ["CONSUMES"])) {
          edges.push(edge);
          consumerIds.add(edge.source);
        }
      }
      for (const providerId of providerIds) {
        for (const edge of edgesTo(db, providerId, ["MONITORS", "CONSUMES"])) {
          edges.push(edge);
          consumerIds.add(edge.source);
        }
      }
      for (const id of consumerIds) nodeIds.add(id);

      return {
        op: q.op,
        nodes: collectNodes(db, nodeIds),
        edges,
        summary: `field ${q.schemaName}.${q.fieldName}: ${consumerIds.size} consumer(s)`,
        rows: [...consumerIds].map((id) => ({
          consumerId: id.replace(/^consumer:/, ""),
          schemaName: q.schemaName,
          fieldName: q.fieldName,
        })),
      };
    }
    case "broke_modes_for_endpoint": {
      const eps = listNodesByKind(db, "Endpoint").filter(
        (e) =>
          String(e.props?.operation_id ?? e.label).includes(q.operationId) ||
          e.id.includes(q.operationId),
      );
      const rows: Array<Record<string, unknown>> = [];
      const edges: GlEdge[] = [];
      const relatedChanges = new Set<string>();
      for (const ep of eps) {
        for (const e of edgesTo(db, ep.id, ["BREAKS", "BROKE"])) {
          edges.push(e);
          if (e.kind === "BREAKS") relatedChanges.add(e.source);
          const mode = (e.props as { failure_mode?: string } | undefined)
            ?.failure_mode ?? e.kind;
          rows.push({ endpoint: ep.id, failure_mode: mode });
        }
        for (const e of edgesFrom(db, ep.id, ["BROKE"])) {
          edges.push(e);
        }
      }
      // A PR failure is relevant only when it targets a change that breaks
      // the matched endpoint.
      for (const changeId of relatedChanges) {
        for (const e of edgesTo(db, changeId, ["BROKE"])) {
          edges.push(e);
          rows.push({
            pr: e.source,
            failure_mode: (e.props as { failure_mode?: string })?.failure_mode,
          });
        }
      }
      return {
        op: q.op,
        nodes: collectNodes(db, new Set(edges.flatMap((e) => [e.source, e.target]))),
        edges,
        summary: `${rows.length} break signal(s) for ${q.operationId}`,
        rows,
      };
    }
    case "migration_ready_units": {
      const units = listNodesByKind(db, "MigrationUnit").filter(
        (u) =>
          String(u.props?.campaign_id) === q.campaignId &&
          (u.props?.status === "pending" || !u.props?.status),
      );
      const ready = units.filter((u) => {
        const deps = edgesFrom(db, u.id, ["DEPENDS_ON"]);
        return deps.every((d) => {
          const dep = getNode(db, d.target);
          return dep?.props?.status === "merged" || deps.length === 0;
        });
      });
      const batch = ready.slice(0, q.batchSize ?? 10);
      return {
        op: q.op,
        nodes: batch,
        edges: [],
        summary: `${batch.length} ready MigrationUnit(s) for campaign ${q.campaignId}`,
        rows: batch.map((u) => ({ id: u.id, label: u.label, props: u.props })),
      };
    }
    case "invariants_for_symbol": {
      const symbols = listNodesByKind(db, "Symbol").filter(
        (s) =>
          s.label === q.qualifiedName ||
          String(s.props?.qualified_name) === q.qualifiedName,
      );
      const invs: GlNode[] = [];
      const edges: GlEdge[] = [];
      for (const s of symbols) {
        for (const e of edgesFrom(db, s.id, ["PRESERVES_INVARIANT"])) {
          edges.push(e);
          const inv = getNode(db, e.target);
          if (inv) invs.push(inv);
        }
        // via BSG: REALIZED_BY reverse
        for (const e of edgesTo(db, s.id, ["REALIZED_BY"])) {
          edges.push(e);
          for (const e2 of edgesFrom(db, e.source, ["EXTRACTED_FROM"])) {
            for (const e3 of edgesFrom(db, e2.target, ["PRESERVES_INVARIANT"])) {
              edges.push(e3);
              const inv = getNode(db, e3.target);
              if (inv) invs.push(inv);
            }
          }
        }
      }
      return {
        op: q.op,
        nodes: [...symbols, ...invs],
        edges,
        summary: `${invs.length} invariant(s) for ${q.qualifiedName}`,
        rows: invs.map((i) => ({
          id: i.id,
          expression: i.props?.expression ?? i.label,
          kind: i.props?.inv_kind,
        })),
      };
    }
    case "time_travel_calls": {
      // All CALLS edges valid at timestamp t
      const symbols = listNodesByKind(db, "Symbol");
      const edges: GlEdge[] = [];
      for (const s of symbols) {
        for (const e of edgesFrom(db, s.id, ["CALLS"], q.at)) {
          edges.push(e);
        }
      }
      const ids = new Set<string>();
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} CALLS edge(s) valid at ${q.at}`,
      };
    }
    case "time_travel_modifies": {
      let edges = edgesByKindAt(db, ["MODIFIES", "TOUCHES"], q.at, 5000);
      // Git emits both names for compatibility. Prefer MODIFIES so one commit
      // and file pair is one temporal fact, and exclude non-git TOUCHES.
      const temporal = new Map<string, GlEdge>();
      for (const edge of edges) {
        if (edge.source_system !== "git") continue;
        const key = `${edge.source}\u0000${edge.target}`;
        const current = temporal.get(key);
        if (!current || edge.kind === "MODIFIES") temporal.set(key, edge);
      }
      edges = [...temporal.values()];
      if (q.repoId) {
        const needle = q.repoId;
        edges = edges.filter(
          (e) => e.source.includes(needle) || e.target.includes(needle),
        );
      }
      const ids = new Set<string>();
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} MODIFIES edge(s) valid at ${q.at}`,
        rows: edges.slice(0, 50).map((e) => ({
          id: e.id,
          from: e.source,
          to: e.target,
          valid_from: e.valid_from,
          valid_to: e.valid_to,
        })),
      };
    }
    default:
      return { op: "unknown", nodes: [], edges: [], summary: "unknown query" };
  }
}

/** Planner tool surface — string templates */
export const GRAPH_RAG_TOOLS = [
  "who_consumes_provider",
  "who_consumes_endpoint",
  "blast_radius",
  "neighbors",
  "neighborhood",
  "callers",
  "path",
  "depends_on_path",
  "outcomes_for_pattern",
  "pattern_success_rates",
  "consumers_of_field",
  "broke_modes_for_endpoint",
  "migration_ready_units",
  "invariants_for_symbol",
  "time_travel_calls",
  "time_travel_modifies",
  "latency_stats",
  "stats",
] as const;

export function formatQueryForPlanner(r: GraphQueryResult): string {
  return [
    `### Graph-RAG: ${r.op}`,
    r.summary,
    r.rows?.length
      ? r.rows
          .slice(0, 12)
          .map((row) => `- ${JSON.stringify(row)}`)
          .join("\n")
      : r.nodes
          .slice(0, 12)
          .map((n) => `- (${n.kind}) ${n.label} \`${n.id}\``)
          .join("\n"),
  ].join("\n");
}
