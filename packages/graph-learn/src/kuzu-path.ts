/**
 * Optional Kùzu native driver path.
 * - Without `kuzu` npm package: returns DDL + status, SQLite remains default.
 * - With `kuzu` installed: open/close helpers for dual-write experiments.
 */
import { KUZU_DDL_V0 } from "./schema.js";
import type { GraphLearnDb } from "./store.js";
import { listNodesByKind, edgesFrom } from "./store.js";
import type { GlNodeKind } from "./schema.js";

export type KuzuStatus = {
  available: boolean;
  reason: string;
  ddl: string;
  packageName: string;
};

export function kuzuStatus(): KuzuStatus {
  try {
    // Optional peer dependency — do not hard-require
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require.resolve("kuzu");
    return {
      available: true,
      reason: "kuzu package resolvable",
      ddl: KUZU_DDL_V0,
      packageName: "kuzu",
    };
  } catch {
    return {
      available: false,
      reason:
        "kuzu not installed — npm i kuzu to enable native graph; SQLite remains default",
      ddl: KUZU_DDL_V0,
      packageName: "kuzu",
    };
  }
}

export type KuzuExportScript = {
  ddl: string;
  nodeInserts: string[];
  edgeInserts: string[];
  note: string;
};

/**
 * Generate Cypher/Kùzu-style insert script from SQLite graph (offline migration).
 */
export function exportSqliteToKuzuScript(
  db: GraphLearnDb,
  opts?: { kinds?: GlNodeKind[]; maxNodes?: number },
): KuzuExportScript {
  const kinds =
    opts?.kinds ??
    ([
      "Provider",
      "Consumer",
      "Endpoint",
      "Change",
      "File",
      "Symbol",
      "PullRequest",
      "Pattern",
    ] as GlNodeKind[]);
  const max = opts?.maxNodes ?? 2000;
  const nodeInserts: string[] = [];
  const edgeInserts: string[] = [];
  let count = 0;

  for (const kind of kinds) {
    for (const n of listNodesByKind(db, kind)) {
      if (count++ >= max) break;
      const props = JSON.stringify(n.props ?? {}).replace(/'/g, "''");
      nodeInserts.push(
        `CREATE (n:Node {id: '${n.id.replace(/'/g, "''")}', kind: '${n.kind}', label: '${n.label.replace(/'/g, "''")}', repo_id: '${(n.repo_id ?? "").replace(/'/g, "''")}', props: '${props}'});`,
      );
      for (const e of edgesFrom(db, n.id)) {
        edgeInserts.push(
          `MATCH (a:Node {id: '${e.source.replace(/'/g, "''")}'}), (b:Node {id: '${e.target.replace(/'/g, "''")}'}) CREATE (a)-[:Edge {kind: '${e.kind}', confidence: ${e.confidence ?? 1}}]->(b);`,
        );
      }
    }
  }

  return {
    ddl: KUZU_DDL_V0,
    nodeInserts,
    edgeInserts: edgeInserts.slice(0, max * 4),
    note: kuzuStatus().available
      ? "kuzu available — run script against native store"
      : "export only; install kuzu for native execution",
  };
}

/**
 * Try opening a Kùzu database directory. Returns null if package missing.
 */
export async function tryOpenKuzu(
  dbPath: string,
): Promise<{ path: string; close: () => void } | null> {
  try {
    // Dynamic import keeps graph-learn usable without native addon
    const kuzu = await import(
      /* webpackIgnore: true */ "kuzu" as string
    ).catch(() => null);
    if (!kuzu) return null;
    // API surface varies by version — treat as opaque handle
    const Database = (kuzu as { Database?: new (p: string) => { close?: () => void } })
      .Database;
    if (!Database) return null;
    const db = new Database(dbPath);
    return {
      path: dbPath,
      close: () => {
        try {
          db.close?.();
        } catch {
          /* */
        }
      },
    };
  } catch {
    return null;
  }
}
