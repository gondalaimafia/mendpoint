/**
 * Embedded property graph store (SQLite).
 * Schema v0: universal node/edge props + temporal edges.
 * Kùzu escape hatch: schema/v0.md + KUZU_DDL_V0.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
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
`;

const DDL_INDEXES = `
CREATE INDEX IF NOT EXISTS gl_nodes_kind_idx ON gl_nodes(kind);
CREATE INDEX IF NOT EXISTS gl_nodes_repo_idx ON gl_nodes(repo_id);
CREATE INDEX IF NOT EXISTS gl_nodes_label_idx ON gl_nodes(label);
CREATE INDEX IF NOT EXISTS gl_edges_source_idx ON gl_edges(source);
CREATE INDEX IF NOT EXISTS gl_edges_target_idx ON gl_edges(target);
CREATE INDEX IF NOT EXISTS gl_edges_kind_idx ON gl_edges(kind);
CREATE INDEX IF NOT EXISTS gl_edges_valid_from_idx ON gl_edges(valid_from);
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

export function openGraphLearnDb(dbPath?: string): GraphLearnDb {
  const path =
    dbPath ?? join(process.cwd(), "data", "graph-learn.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  migrate(raw);
  return { raw, path };
}

export function openGraphLearnMemory(): GraphLearnDb {
  const raw = new DatabaseSync(":memory:");
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
  const outEdges = edgesFrom(db, fileId);
  let nodes = 0;
  let edges = 0;
  for (const e of outEdges) {
    if (e.kind === "DEFINES" || e.kind === "DECLARES") {
      // remove symbol and its outbound CALLS
      const symEdges = [
        ...edgesFrom(db, e.target),
        ...edgesTo(db, e.target),
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
  for (const e of edgesTo(db, fileId)) {
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
  // Match both PascalCase and legacy lowercase
  const legacy = Object.entries(
    // reverse lookup
    Object.fromEntries(
      Object.entries(
        // inline reverse of LEGACY
        {
          Provider: "provider",
          Consumer: "consumer",
          Endpoint: "endpoint",
          Field: "field",
          Change: "change",
          Surface: "surface",
          PullRequest: "pr",
          File: "file",
          Symbol: "symbol",
          Pattern: "pattern",
        } as Record<string, string>,
      ),
    ),
  );
  const alt = legacy.find(([k]) => k === kind)?.[1];
  const rows = db.raw
    .prepare(`SELECT * FROM gl_nodes WHERE kind = ? OR kind = ?`)
    .all(kind, alt ?? kind) as NodeRow[];
  return rows.map(rowToNode);
}

type SqlParam = string | number | null | bigint;

export function edgesFrom(
  db: GraphLearnDb,
  source: string,
  kinds?: GlEdgeKind[],
  atTime?: string,
): GlEdge[] {
  let sql = `SELECT * FROM gl_edges WHERE source = ?`;
  const params: SqlParam[] = [source];
  if (kinds?.length) {
    // include legacy lowercase forms
    const expanded = expandKinds(kinds);
    sql += ` AND kind IN (${expanded.map(() => "?").join(",")})`;
    params.push(...expanded);
  }
  if (atTime) {
    sql += ` AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)`;
    params.push(atTime, atTime);
  }
  const rows = db.raw.prepare(sql).all(...params) as EdgeRow[];
  return rows.map(rowToEdge);
}

export function edgesTo(
  db: GraphLearnDb,
  target: string,
  kinds?: GlEdgeKind[],
  atTime?: string,
): GlEdge[] {
  let sql = `SELECT * FROM gl_edges WHERE target = ?`;
  const params: SqlParam[] = [target];
  if (kinds?.length) {
    const expanded = expandKinds(kinds);
    sql += ` AND kind IN (${expanded.map(() => "?").join(",")})`;
    params.push(...expanded);
  }
  if (atTime) {
    sql += ` AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)`;
    params.push(atTime, atTime);
  }
  const rows = db.raw.prepare(sql).all(...params) as EdgeRow[];
  return rows.map(rowToEdge);
}

function expandKinds(kinds: GlEdgeKind[]): string[] {
  const legacy: Record<string, string> = {
    CALLS: "calls",
    DEPENDS_ON: "depends_on",
    MONITORS: "monitors",
    IMPACTS: "impacts",
    BREAKS: "breaks",
    HAS_FIELD: "has_field",
    HAS_ENDPOINT: "has_endpoint",
    VERSIONS: "versions_of",
    OUTCOME_MERGED: "outcome_merged",
    OUTCOME_CLOSED: "outcome_closed",
    OUTCOME_BROKE: "outcome_broke",
    OUTCOME_WAIVED: "outcome_waived",
    RELATED: "related",
    IMPORTS: "imports",
  };
  const out: string[] = [];
  for (const k of kinds) {
    out.push(k);
    if (legacy[k]) out.push(legacy[k]!);
  }
  return out;
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
  const n = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM gl_nodes`).get() as { c: number }
  ).c;
  const e = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM gl_edges`).get() as { c: number }
  ).c;
  return {
    nodes: n,
    edges: e,
    path: db.path,
    exists: db.path === ":memory:" || existsSync(db.path),
    schema: "v0",
  };
}
