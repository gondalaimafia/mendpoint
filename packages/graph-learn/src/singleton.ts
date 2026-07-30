import { join } from "node:path";
import { openGraphLearnDb, type GraphLearnDb } from "./store.js";

let _db: GraphLearnDb | null = null;

/** Process-wide graph learning DB (data/graph-learn.sqlite under monorepo or cwd). */
export function getGraphLearnDb(explicitPath?: string): GraphLearnDb {
  if (explicitPath) return openGraphLearnDb(explicitPath);
  if (_db) return _db;
  const root =
    process.env.MENDPOINT_ROOT ??
    process.env.GRAPH_LEARN_DB?.replace(/[/\\][^/\\]+$/, "") ??
    process.cwd();
  const path =
    process.env.GRAPH_LEARN_DB ?? join(root, "data", "graph-learn.sqlite");
  _db = openGraphLearnDb(path);
  return _db;
}

export function resetGraphLearnDbForTests(): void {
  try {
    _db?.raw.close();
  } catch {
    /* already closed */
  }
  _db = null;
}
