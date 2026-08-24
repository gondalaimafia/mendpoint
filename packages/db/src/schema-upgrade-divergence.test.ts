import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";

// Fresh-install CI can only ever see the shape that `CREATE TABLE` produces. It
// never runs the `ALTER TABLE ... ADD COLUMN` path in migrateProvidersFeedColumns,
// so it is blind to upgrade-path drift: `ADD COLUMN` cannot attach a CHECK
// constraint, cannot attach a column-level FOREIGN KEY, and can only set a
// constant default that may differ from the fresh `CREATE TABLE` default. A
// volume created before an additive column was introduced therefore diverges
// permanently from a fresh install for that column.
//
// This test reproduces that upgrade path deterministically: it builds a DB whose
// target tables exist in their pre-additive ("aged") shape, runs the real
// createDb() so the additive ALTERs fire exactly as they do on a live volume,
// then diffs the resulting structural signature against a fresh install. Every
// divergence it finds must appear in ACCEPTED_DIVERGENCES with a rationale;
// anything new fails the run, and any accepted divergence that stops reproducing
// also fails, so the allowlist cannot silently rot.
//
// The two seeded tables were confirmed directly on production (mendpoint-talal,
// volume created 2026-07-31). Each accepted divergence is defence-in-depth only:
// every writer of the affected column supplies a value the DB-level guarantee
// would have enforced anyway (see the PR description for the traced writers), so
// no out-of-enum or orphan row can be written today. A table-rebuild migration
// would be disproportionate for a guarantee no code path can violate; the
// standing rule that ensureTables never alters an existing table stands.
//
// To extend coverage when a future additive column carries a CHECK, a
// column-level FK, or a default that differs from its `CREATE TABLE` default,
// add the table's pre-additive shape to VINTAGE_TABLES and record the expected
// divergences in ACCEPTED_DIVERGENCES.

type DivergenceKind = "default" | "check" | "foreignKey";

// Pre-additive ("aged") CREATE TABLE for each seeded table: the fresh columns
// minus the additive column, matching the historical shape a legacy volume
// carries before migrateProvidersFeedColumns adds the column via ALTER.
const VINTAGE_TABLES: Readonly<Record<string, string>> = {
  consumers: `CREATE TABLE consumers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    github_owner TEXT NOT NULL,
    github_repo TEXT NOT NULL,
    installation_id TEXT,
    tenant_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  feed_polls: `CREATE TABLE feed_polls (
    id TEXT PRIMARY KEY,
    provider_slug TEXT NOT NULL,
    openapi_url TEXT NOT NULL,
    content_hash TEXT,
    version_label TEXT,
    status TEXT NOT NULL,
    error TEXT,
    version_id TEXT,
    pipeline_change_id TEXT,
    polled_at TEXT NOT NULL
  )`,
};

// Known-accepted divergences, keyed `${table}.${column}:${kind}`. The note
// records why each is defence-in-depth rather than a live integrity gap.
const ACCEPTED_DIVERGENCES: Readonly<Record<string, string>> = {
  "consumers.github_delivery_mode:default":
    "Fresh DEFAULT 'app' vs aged DEFAULT 'legacy_pat'. insertConsumer always " +
    "supplies github_delivery_mode explicitly, so the column default is never " +
    "exercised by any INSERT; the divergence is inert.",
  "consumers.github_delivery_mode:check":
    "Fresh CHECK (github_delivery_mode IN ('app','legacy_pat','revoked')) is " +
    "absent on aged volumes. Every writer supplies a compile-time enum literal " +
    "(insertConsumer's typed param, the backfill, and the literal 'app'/'revoked' " +
    "UPDATEs), so no out-of-enum value can be written; the CHECK is defence-in-depth.",
  "feed_polls.tenant_id:default":
    "Fresh has no default vs aged DEFAULT 'tenant_default'. insertFeedPoll always " +
    "supplies tenant_id explicitly, so the default is never exercised.",
  "feed_polls.tenant_id:foreignKey":
    "Fresh REFERENCES tenants(id) is absent on aged volumes. insertFeedPoll's " +
    "tenant_id comes from tenant-scoped call paths that reference a live tenant, so " +
    "no orphan row is written; the FK is defence-in-depth.",
};

type Db = ReturnType<typeof createDb>;
const openDbs: Db[] = [];

afterEach(() => {
  while (openDbs.length) openDbs.pop()?.raw.close?.();
});

function freshDb(): Db {
  const db = createDb(join(mkdtempSync(join(tmpdir(), "mp-fresh-")), "mendpoint.sqlite"));
  openDbs.push(db);
  return db;
}

// Build the aged shapes first, then run the real createDb() on the same file so
// the additive ALTERs execute exactly as they do on a live upgrade.
function agedDb(): Db {
  const path = join(mkdtempSync(join(tmpdir(), "mp-aged-")), "mendpoint.sqlite");
  const seed = new DatabaseSync(path);
  seed.exec("PRAGMA foreign_keys = OFF;");
  for (const ddl of Object.values(VINTAGE_TABLES)) seed.exec(ddl);
  seed.close();
  const db = createDb(path);
  openDbs.push(db);
  return db;
}

interface ColumnInfo {
  name: string;
  dflt: string | null;
}

function columns(db: Db, table: string): ColumnInfo[] {
  return (
    db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      dflt_value: string | null;
    }>
  ).map((c) => ({ name: c.name, dflt: c.dflt_value }));
}

function foreignKeyColumns(db: Db, table: string): Set<string> {
  return new Set(
    (
      db.raw.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        from: string;
      }>
    ).map((f) => f.from),
  );
}

// Columns named inside any CHECK(...) expression of the table's CREATE TABLE sql.
// A balanced-paren scan isolates each CHECK body; a column is attributed to a
// check when its name appears in that body.
function checkColumns(db: Db, table: string, columnNames: readonly string[]): Set<string> {
  const row = db.raw
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  const sql = row?.sql ?? "";
  const found = new Set<string>();
  const pattern = /CHECK\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < sql.length && depth > 0; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    const body = sql.slice(match.index + match[0].length, i - 1);
    for (const name of columnNames) {
      if (new RegExp(`\\b${name}\\b`).test(body)) found.add(name);
    }
  }
  return found;
}

interface Divergence {
  key: string;
  detail: string;
}

function diffTable(fresh: Db, aged: Db, table: string): Divergence[] {
  const freshCols = columns(fresh, table);
  const agedByName = new Map(columns(aged, table).map((c) => [c.name, c]));
  const names = freshCols.map((c) => c.name);
  const freshFks = foreignKeyColumns(fresh, table);
  const agedFks = foreignKeyColumns(aged, table);
  const freshChecks = checkColumns(fresh, table, names);
  const agedChecks = checkColumns(aged, table, names);

  const out: Divergence[] = [];
  for (const col of freshCols) {
    const agedCol = agedByName.get(col.name);
    if (!agedCol) continue;
    if ((col.dflt ?? null) !== (agedCol.dflt ?? null)) {
      out.push({
        key: `${table}.${col.name}:default`,
        detail: `fresh default ${JSON.stringify(col.dflt)} vs aged ${JSON.stringify(agedCol.dflt)}`,
      });
    }
    if (freshChecks.has(col.name) && !agedChecks.has(col.name)) {
      out.push({ key: `${table}.${col.name}:check`, detail: "fresh CHECK absent on aged volume" });
    }
    if (freshFks.has(col.name) && !agedFks.has(col.name)) {
      out.push({
        key: `${table}.${col.name}:foreignKey`,
        detail: "fresh FOREIGN KEY absent on aged volume",
      });
    }
  }
  return out;
}

describe("schema upgrade divergence", () => {
  it("only carries the accepted upgrade-path divergences", () => {
    const fresh = freshDb();
    const aged = agedDb();

    const detected = Object.keys(VINTAGE_TABLES).flatMap((table) =>
      diffTable(fresh, aged, table),
    );

    const unexpected = detected.filter((d) => !(d.key in ACCEPTED_DIVERGENCES));
    expect(
      unexpected,
      `Unexpected upgrade-path schema divergence(s):\n${unexpected
        .map((d) => `  ${d.key} — ${d.detail}`)
        .join("\n")}\n` +
        `Each divergence means an aged volume permanently differs from a fresh install for that\n` +
        `column. Trace the column's writers: if none can violate the missing guarantee, add the\n` +
        `key to ACCEPTED_DIVERGENCES with a rationale; otherwise fix the writer or the schema.`,
    ).toEqual([]);

    // The allowlist must not rot: every accepted divergence must still reproduce
    // from the aged rebuild, or its entry is stale and must be removed.
    const detectedKeys = new Set(detected.map((d) => d.key));
    const staleAcceptances = Object.keys(ACCEPTED_DIVERGENCES).filter(
      (key) => !detectedKeys.has(key),
    );
    expect(
      staleAcceptances,
      `Accepted divergence(s) no longer reproduce and should be removed from ACCEPTED_DIVERGENCES:\n${staleAcceptances
        .map((key) => `  ${key}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
