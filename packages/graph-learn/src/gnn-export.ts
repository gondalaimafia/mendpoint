/**
 * GNN feature export — node/edge tensors as JSONL for offline training.
 * No training loop in-repo (post-90); export is the contract.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GraphLearnDb } from "./store.js";
import { listNodesByKind, edgesFrom } from "./store.js";
import type { GlNodeKind } from "./schema.js";

const NODE_KINDS: GlNodeKind[] = [
  "Provider",
  "Service",
  "Endpoint",
  "Field",
  "Consumer",
  "Change",
  "PullRequest",
  "File",
  "Symbol",
  "Commit",
  "Pattern",
  "MigrationUnit",
];

export type GnnNodeFeature = {
  id: string;
  kind: string;
  kindId: number;
  label: string;
  repo_id?: string;
  /** Scalar features */
  x: number[];
};

export type GnnEdgeFeature = {
  source: string;
  target: string;
  kind: string;
  kindId: number;
  confidence: number;
  label: number | null;
  valid_from?: string;
};

export type GnnExport = {
  exportedAt: string;
  nodes: GnnNodeFeature[];
  edges: GnnEdgeFeature[];
  kindIndex: Record<string, number>;
  edgeKindIndex: Record<string, number>;
};

function kindIndexOf(kinds: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  kinds.forEach((k, i) => {
    m[k] = i;
  });
  return m;
}

export function exportGnnFeatures(db: GraphLearnDb): GnnExport {
  const kindIndex = kindIndexOf(NODE_KINDS as string[]);
  const edgeKinds = new Set<string>();
  const nodes: GnnNodeFeature[] = [];
  const candidateEdges: GnnEdgeFeature[] = [];
  const seen = new Set<string>();

  for (const kind of NODE_KINDS) {
    for (const n of listNodesByKind(db, kind)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      const embRaw =
        n.embedding ??
        (Array.isArray(n.props?.embedding)
          ? (n.props!.embedding as number[])
          : null);
      const emb = embRaw?.slice(0, 16) ?? [];
      // Pad/truncate embedding so feature dim is stable
      const embPad = [...emb];
      while (embPad.length < 8) embPad.push(0);
      nodes.push({
        id: n.id,
        kind: n.kind,
        kindId: kindIndex[n.kind] ?? 0,
        label: n.label,
        repo_id: n.repo_id,
        x: [
          kindIndex[n.kind] ?? 0,
          n.label.length / 100,
          n.repo_id ? 1 : 0,
          Object.keys(n.props ?? {}).length / 10,
          ...embPad.slice(0, 8),
        ],
      });
      for (const e of edgesFrom(db, n.id)) {
        candidateEdges.push({
          source: e.source,
          target: e.target,
          kind: e.kind,
          kindId: 0, // filled below
          confidence: e.confidence ?? 1,
          label: e.label ?? null,
          valid_from: e.valid_from,
        });
      }
    }
  }

  const edges = candidateEdges.filter(
    (edge) => seen.has(edge.source) && seen.has(edge.target),
  );
  for (const edge of edges) edgeKinds.add(edge.kind);
  const edgeKindIndex = kindIndexOf([...edgeKinds].sort());
  for (const e of edges) {
    e.kindId = edgeKindIndex[e.kind] ?? 0;
  }

  return {
    exportedAt: new Date().toISOString(),
    nodes,
    edges,
    kindIndex,
    edgeKindIndex,
  };
}

export function writeGnnExport(
  db: GraphLearnDb,
  outPath: string,
): { path: string; nodes: number; edges: number } {
  const exp = exportGnnFeatures(db);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(exp, null, 2), "utf8");
  // also JSONL for torch geometric loaders
  const jsonl = outPath.replace(/\.json$/i, "") + ".nodes.jsonl";
  writeFileSync(
    jsonl,
    exp.nodes.map((n) => JSON.stringify(n)).join("\n") + "\n",
    "utf8",
  );
  return { path: outPath, nodes: exp.nodes.length, edges: exp.edges.length };
}
