import type { GlNode } from "./schema.js";
import {
  edgesFrom,
  listAllEdges,
  listAllNodes,
  listNodesByKind,
  openGraphLearnMemory,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
} from "./store.js";

export type GraphTenantScope = {
  tenantId: string;
  /** Legacy outcome nodes use raw consumer IDs, so bind them from the app DB. */
  consumerIds?: readonly string[];
};

function hasTenantPrefix(value: string | undefined, tenantId: string): boolean {
  return value === tenantId || value?.startsWith(`${tenantId}:`) === true;
}

export function graphNodeBelongsToTenant(
  node: GlNode,
  scope: GraphTenantScope,
): boolean {
  if (hasTenantPrefix(node.repo_id, scope.tenantId)) return true;
  const namespacedId = node.id.slice(node.id.indexOf(":") + 1);
  if (hasTenantPrefix(namespacedId, scope.tenantId)) return true;
  if (String(node.meta?.tenant_id ?? node.props?.tenant_id ?? "") === scope.tenantId) {
    return true;
  }
  if (node.kind !== "Consumer") return false;
  const consumerId = node.id.replace(/^consumer:/, "");
  return scope.consumerIds?.includes(consumerId) === true;
}

/**
 * Build a fail-closed in-memory view containing only directly tenant-owned
 * nodes and edges whose endpoints are both owned by that tenant.
 */
export function createTenantGraphView(
  db: GraphLearnDb,
  scope: GraphTenantScope,
): GraphLearnDb {
  const view = openGraphLearnMemory();
  const nodes = listAllNodes(db).filter((node) =>
    graphNodeBelongsToTenant(node, scope),
  );
  const allowed = new Set(nodes.map((node) => node.id));
  for (const node of nodes) upsertNode(view, node);
  for (const edge of listAllEdges(db)) {
    if (allowed.has(edge.source) && allowed.has(edge.target)) {
      upsertEdge(view, edge);
    }
  }
  return view;
}

/** Tenant-only outcome aggregation used by query and pattern promotion. */
export function tenantPatternSuccessRows(
  db: GraphLearnDb,
  scope: GraphTenantScope,
  minSamples = 1,
): Array<Record<string, unknown>> {
  const stats = new Map<string, { ok: number; fail: number }>();
  const consumers = listNodesByKind(db, "Consumer").filter((node) =>
    graphNodeBelongsToTenant(node, scope),
  );
  for (const consumer of consumers) {
    for (const edge of edgesFrom(db, consumer.id, [
      "OUTCOME_MERGED",
      "OUTCOME_CLOSED",
      "OUTCOME_BROKE",
      "OUTCOME_WAIVED",
    ])) {
      const pattern = String(
        (edge.props as { pattern?: string } | undefined)?.pattern ?? edge.target,
      );
      const current = stats.get(pattern) ?? { ok: 0, fail: 0 };
      if (edge.kind === "OUTCOME_MERGED" || edge.kind === "OUTCOME_WAIVED") {
        current.ok++;
      } else {
        current.fail++;
      }
      stats.set(pattern, current);
    }
  }
  return [...stats.entries()]
    .map(([pattern, samples]) => {
      const total = samples.ok + samples.fail;
      return {
        pattern,
        samples: total,
        successRate: total ? samples.ok / total : 0,
        ok: samples.ok,
        fail: samples.fail,
      };
    })
    .filter((row) => Number(row.samples) >= minSamples)
    .sort((a, b) => Number(b.successRate) - Number(a.successRate));
}
