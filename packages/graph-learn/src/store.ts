/**
 * Embedded property graph store (SQLite via node:sqlite).
 * Recommendation path: migrate multi-hop heavy load to Kùzu later.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GlEdge, GlEdgeKind, GlNode, GlNodeKind } from "./schema.js";

export type GraphLearnDb = {
  raw: DatabaseSync;
  path: string;
};

const DDL = `
CREATE TABLE IF NOT EXISTS gl_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  props_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gl_nodes_kind_idx ON gl_nodes(kind);
CREATE TABLE IF NOT EXISTS gl_edges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  props_json TEXT,
  label REAL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gl_edges_source_idx ON gl_edges(source);
CREATE INDEX IF NOT EXISTS gl_edges_target_idx ON gl_edges(target);
CREATE INDEX IF NOT EXISTS gl_edges_kind_idx ON gl_edges(kind);
`;

export function openGraphLearnDb(dbPath?: string): GraphLearnDb {
  const path =
    dbPath ??
    join(process.cwd(), "data", "graph-learn.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(DDL);
  return { raw, path };
}

export function openGraphLearnMemory(): GraphLearnDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DDL);
  return { raw, path: ":memory:" };
}

function now() {
  return new Date().toISOString();
}

export function upsertNode(db: GraphLearnDb, n: GlNode): void {
  db.raw
    .prepare(
      `INSERT INTO gl_nodes (id, kind, label, props_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind,
         label=excluded.label,
         props_json=excluded.props_json,
         updated_at=excluded.updated_at`,
    )
    .run(n.id, n.kind, n.label, n.props ? JSON.stringify(n.props) : null, now());
}

export function upsertEdge(db: GraphLearnDb, e: GlEdge): void {
  db.raw
    .prepare(
      `INSERT INTO gl_edges (id, kind, source, target, props_json, label, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind=excluded.kind,
         source=excluded.source,
         target=excluded.target,
         props_json=excluded.props_json,
         label=excluded.label,
         updated_at=excluded.updated_at`,
    )
    .run(
      e.id,
      e.kind,
      e.source,
      e.target,
      e.props ? JSON.stringify(e.props) : null,
      e.label ?? null,
      now(),
    );
}

export function getNode(db: GraphLearnDb, id: string): GlNode | undefined {
  const row = db.raw.prepare(`SELECT * FROM gl_nodes WHERE id = ?`).get(id) as
    | { id: string; kind: string; label: string; props_json: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    kind: row.kind as GlNodeKind,
    label: row.label,
    props: row.props_json ? JSON.parse(row.props_json) : undefined,
  };
}

export function listNodesByKind(db: GraphLearnDb, kind: GlNodeKind): GlNode[] {
  const rows = db.raw
    .prepare(`SELECT * FROM gl_nodes WHERE kind = ?`)
    .all(kind) as Array<{
    id: string;
    kind: string;
    label: string;
    props_json: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as GlNodeKind,
    label: r.label,
    props: r.props_json ? JSON.parse(r.props_json) : undefined,
  }));
}

export function edgesFrom(
  db: GraphLearnDb,
  source: string,
  kinds?: GlEdgeKind[],
): GlEdge[] {
  let sql = `SELECT * FROM gl_edges WHERE source = ?`;
  const params: unknown[] = [source];
  if (kinds?.length) {
    sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds);
  }
  const rows = db.raw.prepare(sql).all(...params) as Array<{
    id: string;
    kind: string;
    source: string;
    target: string;
    props_json: string | null;
    label: number | null;
  }>;
  return rows.map(rowToEdge);
}

export function edgesTo(
  db: GraphLearnDb,
  target: string,
  kinds?: GlEdgeKind[],
): GlEdge[] {
  let sql = `SELECT * FROM gl_edges WHERE target = ?`;
  const params: unknown[] = [target];
  if (kinds?.length) {
    sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds);
  }
  const rows = db.raw.prepare(sql).all(...params) as Array<{
    id: string;
    kind: string;
    source: string;
    target: string;
    props_json: string | null;
    label: number | null;
  }>;
  return rows.map(rowToEdge);
}

function rowToEdge(r: {
  id: string;
  kind: string;
  source: string;
  target: string;
  props_json: string | null;
  label: number | null;
}): GlEdge {
  return {
    id: r.id,
    kind: r.kind as GlEdgeKind,
    source: r.source,
    target: r.target,
    props: r.props_json ? JSON.parse(r.props_json) : undefined,
    label: r.label ?? undefined,
  };
}

export function countStats(db: GraphLearnDb) {
  const n = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM gl_nodes`).get() as { c: number }
  ).c;
  const e = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM gl_edges`).get() as { c: number }
  ).c;
  return { nodes: n, edges: e, path: db.path, exists: db.path === ":memory:" || existsSync(db.path) };
}
