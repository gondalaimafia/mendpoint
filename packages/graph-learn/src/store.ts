/**
 * Embedded property graph store (SQLite).
 * Schema v0: universal node/edge props + temporal edges.
 * Kùzu escape hatch: schema/v0.md + KUZU_DDL_V0.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LEGACY_EDGE_KIND,
  LEGACY_NODE_KIND,
  normalizeEdgeKind,
  normalizeNodeKind,
  type GlEdge,
  type GlEdgeKind,
  type GlNode,
  type GlNodeKind,
} from "./schema.js";

export type GraphLearnDb = {
  raw: DatabaseSync;
  path: string;
};

/** Tables only — indexes run after additive column migration so pre-v0 DBs upgrade cleanly. */
const DDL_TABLES = `
CREATE TABLE IF NOT EXISTS gl_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  repo_id TEXT DEFAULT '',
  first_seen TEXT,
  last_seen TEXT,
  props_json TEXT,
  meta_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gl_edges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  source_system TEXT DEFAULT 'pipeline',
  confidence REAL DEFAULT 1.0,
  props_json TEXT,
  label REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gl_software_versions_v1 (
  version_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  repository_snapshot_id TEXT NOT NULL,
  repository_revision TEXT NOT NULL,
  parent_version_id TEXT,
  content_digest TEXT NOT NULL,
  content_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gl_software_heads_v1 (
  tenant_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, repository_id, provider_id),
  FOREIGN KEY(version_id) REFERENCES gl_software_versions_v1(version_id)
);
`;

const DDL_INDEXES = `
CREATE INDEX IF NOT EXISTS gl_nodes_kind_idx ON gl_nodes(kind);
CREATE INDEX IF NOT EXISTS gl_nodes_repo_idx ON gl_nodes(repo_id);
CREATE INDEX IF NOT EXISTS gl_nodes_label_idx ON gl_nodes(label);
CREATE INDEX IF NOT EXISTS gl_edges_source_idx ON gl_edges(source);
CREATE INDEX IF NOT EXISTS gl_edges_target_idx ON gl_edges(target);
CREATE INDEX IF NOT EXISTS gl_edges_kind_idx ON gl_edges(kind);
CREATE INDEX IF NOT EXISTS gl_edges_valid_from_idx ON gl_edges(valid_from);
CREATE UNIQUE INDEX IF NOT EXISTS gl_software_versions_v1_digest_idx
  ON gl_software_versions_v1(tenant_id, repository_id, content_digest);
CREATE INDEX IF NOT EXISTS gl_software_versions_v1_scope_idx
  ON gl_software_versions_v1(tenant_id, repository_id, observed_at);
`;

function migrate(raw: DatabaseSync): void {
  raw.exec(DDL_TABLES);
  // Additive columns for DBs created pre-v0 (must run before indexes on new cols)
  const ncols = (
    raw.prepare(`PRAGMA table_info(gl_nodes)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const [col, def] of [
    ["repo_id", "TEXT DEFAULT ''"],
    ["first_seen", "TEXT"],
    ["last_seen", "TEXT"],
    ["meta_json", "TEXT"],
  ] as const) {
    if (!ncols.includes(col)) {
      try {
        raw.exec(`ALTER TABLE gl_nodes ADD COLUMN ${col} ${def}`);
      } catch {
        /* */
      }
    }
  }
  const ecols = (
    raw.prepare(`PRAGMA table_info(gl_edges)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const [col, def] of [
    ["valid_from", "TEXT"],
    ["valid_to", "TEXT"],
    ["source_system", "TEXT DEFAULT 'pipeline'"],
    ["confidence", "REAL DEFAULT 1.0"],
  ] as const) {
    if (!ecols.includes(col)) {
      try {
        raw.exec(`ALTER TABLE gl_edges ADD COLUMN ${col} ${def}`);
      } catch {
        /* */
      }
    }
  }
  raw.exec(DDL_INDEXES);
}

function configureConnection(raw: DatabaseSync, persistent: boolean): void {
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  if (persistent) {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA synchronous = NORMAL");
  }
}

export function openGraphLearnDb(dbPath?: string): GraphLearnDb {
  const path =
    dbPath ?? join(process.cwd(), "data", "graph-learn.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  configureConnection(raw, true);
  migrate(raw);
  return { raw, path };
}

export function openGraphLearnMemory(): GraphLearnDb {
  const raw = new DatabaseSync(":memory:");
  configureConnection(raw, false);
  migrate(raw);
  return { raw, path: ":memory:" };
}

function now() {
  return new Date().toISOString();
}

export function upsertNode(db: GraphLearnDb, n: GlNode): void {
  const t = now();
  db.raw
    .prepare(
      `INSERT INTO gl_nodes (id, kind, label, repo_id, first_seen, last_seen, props_json, meta_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind,
         label=excluded.label,
         repo_id=excluded.repo_id,
         last_seen=excluded.last_seen,
         props_json=excluded.props_json,
         meta_json=excluded.meta_json,
         updated_at=excluded.updated_at`,
    )
    .run(
      n.id,
      n.kind,
      n.label,
      n.repo_id ?? "",
      n.first_seen ?? t,
      n.last_seen ?? t,
      n.props ? JSON.stringify(n.props) : null,
      n.meta ? JSON.stringify(n.meta) : null,
      t,
    );
}

export function upsertEdge(db: GraphLearnDb, e: GlEdge): void {
  const t = now();
  db.raw
    .prepare(
      `INSERT INTO gl_edges (id, kind, source, target, valid_from, valid_to, source_system, confidence, props_json, label, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind,
         source=excluded.source,
         target=excluded.target,
         valid_from=excluded.valid_from,
         valid_to=excluded.valid_to,
         source_system=excluded.source_system,
         confidence=excluded.confidence,
         props_json=excluded.props_json,
         label=excluded.label,
         updated_at=excluded.updated_at`,
    )
    .run(
      e.id,
      e.kind,
      e.source,
      e.target,
      e.valid_from ?? t,
      e.valid_to ?? null,
      e.source_system ?? "pipeline",
      e.confidence ?? 1.0,
      e.props ? JSON.stringify(e.props) : null,
      e.label ?? null,
      t,
    );
}

type NodeRow = {
  id: string;
  kind: string;
  label: string;
  repo_id?: string | null;
  first_seen?: string | null;
  last_seen?: string | null;
  props_json: string | null;
  meta_json?: string | null;
};

type EdgeRow = {
  id: string;
  kind: string;
  source: string;
  target: string;
  valid_from?: string | null;
  valid_to?: string | null;
  source_system?: string | null;
  confidence?: number | null;
  props_json: string | null;
  label: number | null;
};

function rowToNode(r: NodeRow): GlNode {
  return {
    id: r.id,
    kind: normalizeNodeKind(r.kind),
    label: r.label,
    repo_id: r.repo_id ?? undefined,
    first_seen: r.first_seen ?? undefined,
    last_seen: r.last_seen ?? undefined,
    props: r.props_json ? JSON.parse(r.props_json) : undefined,
    meta: r.meta_json ? JSON.parse(r.meta_json) : undefined,
  };
}

function rowToEdge(r: EdgeRow): GlEdge {
  return {
    id: r.id,
    kind: normalizeEdgeKind(r.kind),
    source: r.source,
    target: r.target,
    valid_from: r.valid_from ?? undefined,
    valid_to: r.valid_to ?? null,
    source_system: r.source_system ?? undefined,
    confidence: r.confidence ?? undefined,
    props: r.props_json ? JSON.parse(r.props_json) : undefined,
    label: r.label ?? undefined,
  };
}

/** Complete graph snapshots for constructing read-only tenant views. */
export function listAllNodes(db: GraphLearnDb): GlNode[] {
  const rows = db.raw.prepare(`SELECT * FROM gl_nodes`).all() as NodeRow[];
  return rows.map(rowToNode);
}

export function listAllEdges(db: GraphLearnDb): GlEdge[] {
  const rows = db.raw.prepare(`SELECT * FROM gl_edges`).all() as EdgeRow[];
  return rows.map(rowToEdge);
}

export function getNode(db: GraphLearnDb, id: string): GlNode | undefined {
  const row = db.raw.prepare(`SELECT * FROM gl_nodes WHERE id = ?`).get(id) as
    | NodeRow
    | undefined;
  return row ? rowToNode(row) : undefined;
}

export function deleteNode(db: GraphLearnDb, id: string): void {
  db.raw.prepare(`DELETE FROM gl_edges WHERE source = ? OR target = ?`).run(id, id);
  db.raw.prepare(`DELETE FROM gl_nodes WHERE id = ?`).run(id);
}

export function deleteEdge(db: GraphLearnDb, id: string): void {
  db.raw.prepare(`DELETE FROM gl_edges WHERE id = ?`).run(id);
}

/** Remove node and all incident edges; also drop DEFINES/CALLS targets that become orphaned under this file. */
export function deleteFileSubgraph(
  db: GraphLearnDb,
  fileId: string,
): { nodes: number; edges: number } {
  // Deletion must reach every incident edge, including ones already closed with
  // a past valid_to, so invalidated rows are not orphaned behind the deleted node.
  const allHistory: EdgeQueryOptions = { includeInvalidated: true };
  const outEdges = edgesFrom(db, fileId, undefined, allHistory);
  let nodes = 0;
  let edges = 0;
  for (const e of outEdges) {
    if (e.kind === "DEFINES" || e.kind === "DECLARES") {
      // remove symbol and its outbound CALLS
      const symEdges = [
        ...edgesFrom(db, e.target, undefined, allHistory),
        ...edgesTo(db, e.target, undefined, allHistory),
      ];
      for (const se of symEdges) {
        deleteEdge(db, se.id);
        edges++;
      }
      deleteNode(db, e.target);
      nodes++;
    } else {
      deleteEdge(db, e.id);
      edges++;
    }
  }
  for (const e of edgesTo(db, fileId, undefined, allHistory)) {
    deleteEdge(db, e.id);
    edges++;
  }
  if (getNode(db, fileId)) {
    db.raw.prepare(`DELETE FROM gl_nodes WHERE id = ?`).run(fileId);
    nodes++;
  }
  return { nodes, edges };
}

export function listNodesByKind(db: GraphLearnDb, kind: GlNodeKind): GlNode[] {
  const legacyKinds = Object.entries(LEGACY_NODE_KIND)
    .filter(([, normalized]) => normalized === kind)
    .map(([legacy]) => legacy);
  const accepted = [kind, ...legacyKinds];
  const rows = db.raw
    .prepare(
      `SELECT * FROM gl_nodes WHERE kind IN (${accepted.map(() => "?").join(",")})`,
    )
    .all(...accepted) as NodeRow[];
  return rows.map(rowToNode);
}

type SqlParam = string | number | null | bigint;

export type EdgeQueryOptions = {
  /**
   * Point-in-time filter: return only edges whose validity window contains this
   * instant (`valid_from <= at < valid_to`). Used by time-travel ops.
   */
  at?: string;
  /**
   * Return every edge ever recorded, including ones whose `valid_to` has already
   * passed. Opt-in for ingest, export, and deletion paths that must operate on
   * the full stored graph rather than the currently-valid slice. Ignored when
   * `at` is set.
   */
  includeInvalidated?: boolean;
};

/**
 * Resolve the instant a temporal filter is evaluated at. An explicit `at` wins
 * (point-in-time). Otherwise the default is *now*, so reads see only currently
 * valid edges: an edge closed with a past `valid_to`, or one whose `valid_from`
 * is still in the future, is not a current fact. `includeInvalidated` opts out
 * of the filter entirely, returning all history.
 */
function temporalInstant(opts: EdgeQueryOptions): string | undefined {
  if (opts.at) return opts.at;
  if (opts.includeInvalidated) return undefined;
  return now();
}

export function edgesFrom(
  db: GraphLearnDb,
  source: string,
  kinds?: GlEdgeKind[],
  opts: EdgeQueryOptions = {},
): GlEdge[] {
  let sql = `SELECT * FROM gl_edges WHERE source = ?`;
  const params: SqlParam[] = [source];
  if (kinds?.length) {
    // include legacy lowercase forms
    const expanded = expandKinds(kinds);
    sql += ` AND kind IN (${expanded.map(() => "?").join(",")})`;
    params.push(...expanded);
  }
  const instant = temporalInstant(opts);
  if (instant) {
    sql += ` AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)`;
    params.push(instant, instant);
  }
  const rows = db.raw.prepare(sql).all(...params) as EdgeRow[];
  return rows.map(rowToEdge);
}

export function edgesTo(
  db: GraphLearnDb,
  target: string,
  kinds?: GlEdgeKind[],
  opts: EdgeQueryOptions = {},
): GlEdge[] {
  let sql = `SELECT * FROM gl_edges WHERE target = ?`;
  const params: SqlParam[] = [target];
  if (kinds?.length) {
    const expanded = expandKinds(kinds);
    sql += ` AND kind IN (${expanded.map(() => "?").join(",")})`;
    params.push(...expanded);
  }
  const instant = temporalInstant(opts);
  if (instant) {
    sql += ` AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)`;
    params.push(instant, instant);
  }
  const rows = db.raw.prepare(sql).all(...params) as EdgeRow[];
  return rows.map(rowToEdge);
}

function expandKinds(kinds: GlEdgeKind[]): string[] {
  const out = new Set<string>();
  for (const k of kinds) {
    out.add(k);
    for (const [legacy, normalized] of Object.entries(LEGACY_EDGE_KIND)) {
      if (normalized === k) out.add(legacy);
    }
  }
  return [...out];
}

/** Edges of given kinds valid at timestamp (SQL path for temporal queries). */
export function edgesByKindAt(
  db: GraphLearnDb,
  kinds: GlEdgeKind[],
  atTime: string,
  limit = 5000,
): GlEdge[] {
  const expanded = expandKinds(kinds);
  const sql = `SELECT * FROM gl_edges
    WHERE kind IN (${expanded.map(() => "?").join(",")})
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to > ?)
    LIMIT ?`;
  const rows = db.raw
    .prepare(sql)
    .all(...expanded, atTime, atTime, limit) as EdgeRow[];
  return rows.map(rowToEdge);
}

export function countStats(db: GraphLearnDb) {
  // Per-kind breakdown (spec v3 §22.4, "entities/edges by type"). Legacy raw
  // kinds are folded into their v0 form so a dashboard sees one bucket per
  // logical kind. Totals are summed from the same GROUP BY so they can never
  // disagree with the breakdown. The "epistemic state" half of that metric is
  // deliberately omitted: no epistemic-status column exists in the schema yet
  // (see docs/GRAPH_OBSERVABILITY.md), so emitting it would be a fabricated
  // zero rather than a measurement.
  const nodeRows = db.raw
    .prepare(`SELECT kind, COUNT(*) as c FROM gl_nodes GROUP BY kind`)
    .all() as Array<{ kind: string; c: number }>;
  const edgeRows = db.raw
    .prepare(`SELECT kind, COUNT(*) as c FROM gl_edges GROUP BY kind`)
    .all() as Array<{ kind: string; c: number }>;
  const nodesByKind: Record<string, number> = {};
  let n = 0;
  for (const row of nodeRows) {
    const kind = normalizeNodeKind(row.kind);
    nodesByKind[kind] = (nodesByKind[kind] ?? 0) + row.c;
    n += row.c;
  }
  const edgesByKind: Record<string, number> = {};
  let e = 0;
  for (const row of edgeRows) {
    const kind = normalizeEdgeKind(row.kind);
    edgesByKind[kind] = (edgesByKind[kind] ?? 0) + row.c;
    e += row.c;
  }
  return {
    nodes: n,
    edges: e,
    nodesByKind,
    edgesByKind,
    path: db.path,
    exists: db.path === ":memory:" || existsSync(db.path),
    schema: "v0",
  };
}
