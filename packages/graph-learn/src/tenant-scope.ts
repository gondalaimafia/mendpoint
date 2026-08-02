import { DatabaseSync } from "node:sqlite";
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

function openPersistentTenantProjection(
  db: GraphLearnDb,
  scope: GraphTenantScope,
): GraphLearnDb {
  const raw = new DatabaseSync(db.path, { readOnly: true });
  try {
    raw.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TEMP TABLE gl_tenant_scope (
        tenant_id TEXT NOT NULL
      );
      CREATE TEMP TABLE gl_tenant_consumers (
        consumer_id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
    `);
    raw.prepare(`INSERT INTO gl_tenant_scope (tenant_id) VALUES (?)`).run(
      scope.tenantId,
    );
    const insertConsumer = raw.prepare(
      `INSERT OR IGNORE INTO gl_tenant_consumers (consumer_id) VALUES (?)`,
    );
    for (const consumerId of scope.consumerIds ?? []) {
      insertConsumer.run(consumerId);
    }
    raw.exec(`
      CREATE TEMP VIEW gl_nodes AS
      SELECT node.*
      FROM main.gl_nodes AS node
      WHERE
        node.repo_id = (SELECT tenant_id FROM temp.gl_tenant_scope)
        OR substr(node.repo_id, 1, length((SELECT tenant_id FROM temp.gl_tenant_scope)) + 1)
          = (SELECT tenant_id FROM temp.gl_tenant_scope) || ':'
        OR (CASE
          WHEN instr(node.id, ':') > 0 THEN substr(node.id, instr(node.id, ':') + 1)
          ELSE node.id
        END) = (SELECT tenant_id FROM temp.gl_tenant_scope)
        OR substr(
          CASE
            WHEN instr(node.id, ':') > 0 THEN substr(node.id, instr(node.id, ':') + 1)
            ELSE node.id
          END,
          1,
          length((SELECT tenant_id FROM temp.gl_tenant_scope)) + 1
        ) = (SELECT tenant_id FROM temp.gl_tenant_scope) || ':'
        OR coalesce(
          json_extract(node.meta_json, '$.tenant_id'),
          json_extract(node.props_json, '$.tenant_id'),
          ''
        ) = (SELECT tenant_id FROM temp.gl_tenant_scope)
        OR (
          node.kind IN ('Consumer', 'consumer')
          AND CASE
            WHEN substr(node.id, 1, 9) = 'consumer:' THEN substr(node.id, 10)
            ELSE node.id
          END IN (SELECT consumer_id FROM temp.gl_tenant_consumers)
        );

      CREATE TEMP VIEW gl_edges AS
      SELECT edge.*
      FROM main.gl_edges AS edge
      JOIN temp.gl_nodes AS source ON source.id = edge.source
      JOIN temp.gl_nodes AS target ON target.id = edge.target;

      PRAGMA query_only = ON;
    `);
    return { raw, path: db.path };
  } catch (error) {
    raw.close();
    throw error;
  }
}

/**
 * Open a fail-closed view containing only directly tenant-owned nodes and
 * edges whose endpoints are both owned by that tenant. Persistent databases
 * use read-only temporary SQL views, avoiding a full graph copy per query.
 */
export function createTenantGraphView(
  db: GraphLearnDb,
  scope: GraphTenantScope,
): GraphLearnDb {
  if (db.path !== ":memory:") {
    return openPersistentTenantProjection(db, scope);
  }
  const view = openGraphLearnMemory();
  const nodes = listAllNodes(db).filter((node) =>
    graphNodeBelongsToTenant(node, scope),
  );
  const allowed = new Set(nodes.map((node) => node.id));
  view.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const node of nodes) upsertNode(view, node);
    for (const edge of listAllEdges(db)) {
      if (allowed.has(edge.source) && allowed.has(edge.target)) {
        upsertEdge(view, edge);
      }
    }
    view.raw.exec("COMMIT");
  } catch (error) {
    if (view.raw.isTransaction) view.raw.exec("ROLLBACK");
    view.raw.close();
    throw error;
  }
  return view;
}

/** Count tenant-owned graph rows in place without copying the global graph. */
export function tenantGraphStats(db: GraphLearnDb, scope: GraphTenantScope) {
  const tenantPredicate = `(
    repo_id = ?
    OR substr(repo_id, 1, length(?) + 1) = ? || ':'
    OR (CASE WHEN instr(id, ':') > 0 THEN substr(id, instr(id, ':') + 1) ELSE id END) = ?
    OR substr(
      CASE WHEN instr(id, ':') > 0 THEN substr(id, instr(id, ':') + 1) ELSE id END,
      1,
      length(?) + 1
    ) = ? || ':'
    OR coalesce(
      json_extract(meta_json, '$.tenant_id'),
      json_extract(props_json, '$.tenant_id'),
      ''
    ) = ?
  )`;
  const consumerIds = [...(scope.consumerIds ?? [])];
  const consumerPredicate = consumerIds.length
    ? `OR (kind IN ('Consumer', 'consumer') AND CASE
        WHEN substr(id, 1, 9) = 'consumer:' THEN substr(id, 10)
        ELSE id
      END IN (${consumerIds.map(() => "?").join(", ")}))`
    : "";
  const row = db.raw
    .prepare(
      `WITH allowed AS MATERIALIZED (
         SELECT id FROM gl_nodes
         WHERE ${tenantPredicate} ${consumerPredicate}
       )
       SELECT
         (SELECT COUNT(*) FROM allowed) AS nodes,
         (SELECT COUNT(*)
          FROM gl_edges edge
          JOIN allowed source ON source.id = edge.source
          JOIN allowed target ON target.id = edge.target) AS edges`,
    )
    .get(
      scope.tenantId,
      scope.tenantId,
      scope.tenantId,
      scope.tenantId,
      scope.tenantId,
      scope.tenantId,
      scope.tenantId,
      ...consumerIds,
    ) as { nodes: number; edges: number };
  return {
    nodes: row.nodes,
    edges: row.edges,
    path: ":memory:",
    exists: true,
    schema: "v0",
  };
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
