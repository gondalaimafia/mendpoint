/**
 * Optional node embeddings — deterministic hash vectors (no ML dep).
 * Populates GlNode.embedding and props.embedding for GNN export / RAG.
 */
import { createHash } from "node:crypto";
import type { GraphLearnDb } from "./store.js";
import { listNodesByKind, upsertNode, getNode } from "./store.js";
import type { GlNodeKind } from "./schema.js";
import {
  graphNodeBelongsToTenant,
  type GraphTenantScope,
} from "./tenant-scope.js";

const DEFAULT_DIM = 32;

const KINDS: GlNodeKind[] = [
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
  "Plan",
];

/** Deterministic float embedding in [-1, 1]^dim from text. */
export function hashEmbedding(text: string, dim = DEFAULT_DIM): number[] {
  const out: number[] = [];
  for (let i = 0; i < dim; i++) {
    const h = createHash("sha256")
      .update(`${text}::${i}`)
      .digest();
    const n = h.readUInt32BE(0) / 0xffffffff;
    out.push(n * 2 - 1);
  }
  return out;
}

export type EmbedResult = {
  nodes: number;
  dim: number;
  kinds: string[];
};

/**
 * Fill embedding on nodes missing one (stored in props.embedding for SQLite).
 * @param force recompute even if present
 */
export function embedGraphNodes(
  db: GraphLearnDb,
  opts?: { dim?: number; kinds?: GlNodeKind[]; limit?: number; force?: boolean },
  scope?: GraphTenantScope,
): EmbedResult {
  const dim = opts?.dim ?? DEFAULT_DIM;
  const kinds = opts?.kinds ?? KINDS;
  let n = 0;
  const limit = opts?.limit ?? 50_000;
  for (const kind of kinds) {
    for (const node of listNodesByKind(db, kind)) {
      if (n >= limit) break;
      if (scope && !graphNodeBelongsToTenant(node, scope)) continue;
      const storedEmbedding =
        node.embedding ??
        (Array.isArray(node.props?.embedding)
          ? node.props.embedding
          : undefined);
      if (!opts?.force && storedEmbedding?.length === dim) continue;
      // Strip prior embedding from hash input for stability
      const propsForHash = { ...(node.props ?? {}) };
      delete propsForHash.embedding;
      delete propsForHash.embedding_dim;
      const text = `${node.kind}|${node.id}|${node.label}|${JSON.stringify(propsForHash)}`;
      const emb = hashEmbedding(text, dim);
      upsertNode(db, {
        ...node,
        embedding: emb,
        props: { ...propsForHash, embedding: emb, embedding_dim: dim },
      });
      n++;
    }
  }
  return { nodes: n, dim, kinds: kinds as string[] };
}

export function getNodeEmbedding(
  db: GraphLearnDb,
  id: string,
): number[] | undefined {
  const n = getNode(db, id);
  if (!n) return undefined;
  if (n.embedding?.length) return n.embedding;
  const p = n.props?.embedding;
  if (Array.isArray(p)) return p as number[];
  return undefined;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `cosineSimilarity dimension mismatch: ${a.length} !== ${b.length}`,
    );
  }
  const len = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
