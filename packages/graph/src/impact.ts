/**
 * F1: Impact blast-radius graph from findings + optional call graph.
 */
import {
  impactSubgraph,
  nodeAt,
  type CallGraph,
  type FunctionNode,
} from "@mendpoint/call-graph";
import type { ImpactableSurface } from "@mendpoint/shared";
import { edge, node, withStats, type GraphEdge, type GraphNode, type ProductGraph } from "./types.js";

export type FindingLike = {
  id: string;
  filePath: string;
  lineStart: number;
  lineEnd?: number;
  symbol: string;
  confidence: string;
  consumerId?: string;
  evidenceJson?: string;
};

export type BuildImpactGraphInput = {
  changeId: string;
  summary: string;
  risk: string;
  findings: FindingLike[];
  /** Surfaces from stored diff (optional) */
  surfaces?: Array<{
    id?: string;
    canonicalId?: string;
    op?: string;
    path?: string;
    field?: string;
    fromField?: string;
    toField?: string;
    severity?: string;
    explanation?: string;
  }>;
  callGraph?: CallGraph;
  maxCallerDepth?: number;
  /** Cap expanded call-graph nodes across all findings (default 60) */
  maxFunctionNodes?: number;
  consumerId?: string;
  consumerName?: string;
};

function surfaceNodeId(s: NonNullable<BuildImpactGraphInput["surfaces"]>[0], i: number): string {
  return `surface:${s.id ?? s.canonicalId ?? i}`;
}

/**
 * Build impact graph: change → surfaces → findings → files → functions (+ callers).
 */
export function buildImpactGraph(input: BuildImpactGraphInput): ProductGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let ei = 0;

  const changeNid = `change:${input.changeId}`;
  nodes.set(
    changeNid,
    node(changeNid, "change", input.summary.slice(0, 72) || input.changeId, {
      risk: input.risk,
      changeId: input.changeId,
    }, 0),
  );

  if (input.consumerId) {
    const cid = `consumer:${input.consumerId}`;
    nodes.set(
      cid,
      node(cid, "consumer", input.consumerName ?? input.consumerId, {
        consumerId: input.consumerId,
      }, 0),
    );
    edges.push(edge(`e${ei++}`, changeNid, cid, "AFFECTS_CONSUMER"));
  }

  const surfaces = input.surfaces ?? [];
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i]!;
    const sid = surfaceNodeId(s, i);
    const label =
      s.fromField && s.toField
        ? `${s.fromField} → ${s.toField}`
        : s.path ?? s.field ?? s.op ?? s.canonicalId ?? `surface-${i}`;
    nodes.set(
      sid,
      node(sid, "surface", String(label).slice(0, 64), {
        op: s.op,
        path: s.path,
        field: s.field,
        fromField: s.fromField,
        toField: s.toField,
        severity: s.severity,
      }, 1),
    );
    edges.push(edge(`e${ei++}`, changeNid, sid, "HAS_SURFACE"));
  }

  // Map findings to nearest surface by token overlap
  const surfaceList = surfaces.map((s, i) => ({ s, id: surfaceNodeId(s, i) }));
  const maxFn = input.maxFunctionNodes ?? 60;
  let functionNodesAdded = 0;
  const seedFnsSeen = new Set<string>();

  for (const f of input.findings) {
    const fid = `finding:${f.id}`;
    nodes.set(
      fid,
      node(fid, "finding", f.symbol || f.filePath, {
        filePath: f.filePath,
        lineStart: f.lineStart,
        lineEnd: f.lineEnd,
        confidence: f.confidence,
        consumerId: f.consumerId,
      }, 2),
    );

    // Link to best surface
    let linked = false;
    for (const { s, id: sid } of surfaceList) {
      const tokens = [s.path, s.field, s.fromField, s.toField, s.op].filter(Boolean) as string[];
      if (
        tokens.some(
          (t) =>
            f.symbol.includes(t) ||
            f.filePath.includes(t) ||
            (f.evidenceJson && f.evidenceJson.includes(t)),
        )
      ) {
        edges.push(edge(`e${ei++}`, sid, fid, "IMPACTS", { confidence: f.confidence }));
        linked = true;
        break;
      }
    }
    if (!linked && surfaceList[0]) {
      edges.push(
        edge(`e${ei++}`, surfaceList[0].id, fid, "IMPACTS", {
          confidence: f.confidence,
          heuristic: true,
        }),
      );
    } else if (!linked) {
      edges.push(edge(`e${ei++}`, changeNid, fid, "IMPACTS", { confidence: f.confidence }));
    }

    // File node
    const fileId = `file:${f.filePath.replace(/\\/g, "/")}`;
    if (!nodes.has(fileId)) {
      nodes.set(
        fileId,
        node(fileId, "file", f.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/"), {
          filePath: f.filePath,
        }, 3),
      );
    }
    edges.push(edge(`e${ei++}`, fid, fileId, "IN_FILE"));

    // Call-graph function + callers (budgeted for performance)
    if (input.callGraph && functionNodesAdded < maxFn) {
      const fn = nodeAt(input.callGraph, f.filePath, f.lineStart);
      if (fn && !seedFnsSeen.has(fn.id)) {
        seedFnsSeen.add(fn.id);
        const fnId = `fn:${fn.id}`;
        if (!nodes.has(fnId)) {
          nodes.set(
            fnId,
            node(fnId, "function", fn.name, {
              filePath: fn.filePath,
              lineStart: fn.lineStart,
              lineEnd: fn.lineEnd,
              callGraphNodeId: fn.id,
            }, 4),
          );
          functionNodesAdded++;
        }
        edges.push(edge(`e${ei++}`, fid, fnId, "IN_FUNCTION"));

        if (functionNodesAdded < maxFn) {
          const sub = impactSubgraph(input.callGraph, [fn.id], {
            maxDepth: input.maxCallerDepth ?? 2,
          });
          for (const n of sub.nodes) {
            if (functionNodesAdded >= maxFn) break;
            const nid = `fn:${n.id}`;
            if (!nodes.has(nid)) {
              nodes.set(
                nid,
                node(nid, "function", n.name, {
                  filePath: n.filePath,
                  lineStart: n.lineStart,
                  callGraphNodeId: n.id,
                  seed: sub.seedNodeIds.includes(n.id),
                }, sub.seedNodeIds.includes(n.id) ? 4 : 5),
              );
              functionNodesAdded++;
            }
          }
          for (const e of sub.edges) {
            const a = `fn:${e.callerId}`;
            const b = `fn:${e.calleeId}`;
            if (!nodes.has(a) || !nodes.has(b)) continue;
            edges.push(
              edge(`e${ei++}`, a, b, "CALLS", {
                confidence: e.confidence,
                resolution: e.resolution,
              }),
            );
          }
        }
      } else if (fn) {
        const fnId = `fn:${fn.id}`;
        if (nodes.has(fnId)) {
          edges.push(edge(`e${ei++}`, fid, fnId, "IN_FUNCTION"));
        }
      }
    }
  }

  return withStats({
    id: `impact:${input.changeId}${input.consumerId ? `:${input.consumerId}` : ""}`,
    title: `Impact · ${input.summary.slice(0, 60)}`,
    description: `risk=${input.risk} findings=${input.findings.length}`,
    nodes: [...nodes.values()],
    edges,
    layoutHints: {
      ranks: Object.fromEntries([...nodes.values()].map((n) => [n.id, n.rank ?? 0])),
    },
  });
}

/** Merge API change graph + impact graph into one dual-pane friendly graph. */
export function mergeGraphs(a: ProductGraph, b: ProductGraph, title?: string): ProductGraph {
  const nodes = new Map<string, GraphNode>();
  for (const n of a.nodes) nodes.set(n.id, n);
  for (const n of b.nodes) {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  }
  const edgeIds = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of [...a.edges, ...b.edges]) {
    if (edgeIds.has(e.id)) continue;
    edgeIds.add(e.id);
    edges.push(e);
  }
  // Bridge: same change id if both have change nodes
  const aChange = a.nodes.find((n) => n.kind === "change");
  const bChange = b.nodes.find((n) => n.kind === "change");
  if (aChange && bChange && aChange.id !== bChange.id) {
    edges.push(edge(`bridge:${aChange.id}:${bChange.id}`, aChange.id, bChange.id, "SAME_CHANGE"));
  }
  return withStats({
    id: `merged:${a.id}+${b.id}`,
    title: title ?? `${a.title} + ${b.title}`,
    nodes: [...nodes.values()],
    edges,
  });
}

export function surfacesFromImpactable(surfaces: ImpactableSurface[]) {
  return surfaces.map((s) => ({
    id: s.id,
    canonicalId: s.canonicalId,
    op: s.op,
    path: s.path,
    field: s.field,
    fromField: s.fromField,
    toField: s.toField,
    severity: s.severity,
    explanation: s.explanation,
  }));
}

export type { FunctionNode };
