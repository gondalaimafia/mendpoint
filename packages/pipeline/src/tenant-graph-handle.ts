/**
 * Production Change Graph handle for a tenant (spec §11 / §28.1.0).
 *
 * Campaign execution, Fettler impact, and Mission context must consult a REAL
 * tenant-scoped graph — never an empty in-memory store and never a freshly
 * created empty file. `getGraphLearnDb()` / `openGraphLearnDb()` CREATE the
 * sqlite file if it is missing, which would silently present an empty graph as
 * authoritative. This resolver refuses that: the path must already exist, the
 * database must open, and a tenant with zero owned nodes is reported as empty
 * rather than "ready".
 *
 * `runGraphQuery` already wraps a persistent handle in `createTenantGraphView`
 * per query, so this module returns the opened persistent db (not a second
 * nested view). Callers that need a view can still wrap it themselves.
 */
import { existsSync } from "node:fs";
import {
  openGraphLearnDb,
  tenantGraphStats,
  type GraphLearnDb,
  type GraphTenantScope,
} from "@mendpoint/graph-learn";

export type TenantGraphHandleUnavailableReason =
  | "path_missing"
  | "path_ephemeral"
  | "file_missing"
  | "empty_tenant_view"
  | "open_failed";

export type TenantGraphHandle =
  | Readonly<{
      status: "ready";
      graphDb: GraphLearnDb;
      stats: Readonly<{ nodes: number; edges: number }>;
      close: () => void;
    }>
  | Readonly<{
      status: "unavailable";
      reason: TenantGraphHandleUnavailableReason;
      detail: string;
    }>;

function isEphemeralPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return normalized === ":memory:" || normalized === "file::memory:";
}

/**
 * Resolve a production graph handle for one tenant. Fail closed: a missing
 * path, a missing file, an ephemeral/memory path, an empty tenant view, or an
 * open error is `unavailable` — never a fabricated empty store.
 */
export function resolveTenantGraphHandle(input: {
  tenantId: string;
  consumerIds?: readonly string[];
  /** Explicit graph path. Defaults to `GRAPH_LEARN_DB`. Never created if absent. */
  graphPath?: string | null;
  exists?: (path: string) => boolean;
  open?: (path: string) => GraphLearnDb;
}): TenantGraphHandle {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    return { status: "unavailable", reason: "path_missing", detail: "graph_tenant_required" };
  }
  const graphPath = (input.graphPath ?? process.env.GRAPH_LEARN_DB ?? "").trim();
  if (!graphPath) {
    return { status: "unavailable", reason: "path_missing", detail: "GRAPH_LEARN_DB is not set" };
  }
  if (isEphemeralPath(graphPath)) {
    return {
      status: "unavailable",
      reason: "path_ephemeral",
      detail: "in-memory graph is not a production Change Graph handle",
    };
  }
  const exists = input.exists ?? existsSync;
  if (!exists(graphPath)) {
    return {
      status: "unavailable",
      reason: "file_missing",
      detail: `graph file does not exist: ${graphPath}`,
    };
  }
  const open = input.open ?? openGraphLearnDb;
  let graphDb: GraphLearnDb;
  try {
    graphDb = open(graphPath);
  } catch (error) {
    return {
      status: "unavailable",
      reason: "open_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const scope: GraphTenantScope = {
    tenantId,
    ...(input.consumerIds ? { consumerIds: input.consumerIds } : {}),
  };
  let stats: { nodes: number; edges: number };
  try {
    stats = tenantGraphStats(graphDb, scope);
  } catch (error) {
    try { graphDb.raw.close(); } catch { /* already closed */ }
    return {
      status: "unavailable",
      reason: "open_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (stats.nodes === 0) {
    try { graphDb.raw.close(); } catch { /* already closed */ }
    return {
      status: "unavailable",
      reason: "empty_tenant_view",
      detail: `tenant ${tenantId} owns no Change Graph nodes`,
    };
  }
  return {
    status: "ready",
    graphDb,
    stats: Object.freeze({ nodes: stats.nodes, edges: stats.edges }),
    close: () => {
      try { graphDb.raw.close(); } catch { /* already closed */ }
    },
  };
}

/** True when a production worker may claim campaign-execute jobs. */
export function productionGraphFilePresent(graphPath?: string | null): boolean {
  const path = (graphPath ?? process.env.GRAPH_LEARN_DB ?? "").trim();
  if (!path || isEphemeralPath(path)) return false;
  return existsSync(path);
}
