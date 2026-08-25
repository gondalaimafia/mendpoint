import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openGraphLearnDb, upsertNode, type GraphLearnDb } from "@mendpoint/graph-learn";
import { withTenantGraphHandle } from "./tenant-graph-request.js";

const opened: Array<{ db?: GraphLearnDb; dir?: string }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    try { item.db?.raw.close(); } catch { /* already closed */ }
    if (item.dir) rmSync(item.dir, { recursive: true, force: true });
  }
});

function seededGraph(tenantId: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-api-graph-"));
  const path = join(dir, "graph-learn.sqlite");
  const db = openGraphLearnDb(path);
  opened.push({ db, dir });
  upsertNode(db, {
    id: `file:${tenantId}:index.ts`,
    kind: "File",
    label: `${tenantId}/index.ts`,
    repo_id: `${tenantId}:repo`,
  });
  return path;
}

describe("withTenantGraphHandle", () => {
  it("fails closed when GRAPH_LEARN_DB is unset and does not create a file", () => {
    const previous = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      const result = withTenantGraphHandle({ tenantId: "tenant-a" }, () => "used");
      expect(result).toEqual({
        ok: false,
        failure: {
          error: "graph_handle_unavailable",
          reason: "path_missing",
          detail: "GRAPH_LEARN_DB is not set",
        },
      });
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  });

  it("does not create a missing graph file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-api-graph-miss-"));
    opened.push({ dir });
    const path = join(dir, "missing", "graph-learn.sqlite");
    const result = withTenantGraphHandle(
      { tenantId: "tenant-a", graphPath: path },
      () => "used",
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { error: "graph_handle_unavailable", reason: "file_missing" },
    });
    expect(existsSync(path)).toBe(false);
  });

  it("runs the callback against a ready tenant handle and closes it", () => {
    const path = seededGraph("tenant-a");
    const result = withTenantGraphHandle(
      { tenantId: "tenant-a", graphPath: path },
      (graphDb) => graphDb.path,
    );
    expect(result).toEqual({ ok: true, value: path });
  });

  it("refuses an empty tenant view on read and allows it on ingest", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-api-graph-empty-"));
    const path = join(dir, "graph-learn.sqlite");
    const db = openGraphLearnDb(path);
    opened.push({ db, dir });
    const read = withTenantGraphHandle(
      { tenantId: "tenant-a", graphPath: path },
      () => "used",
    );
    expect(read).toMatchObject({
      ok: false,
      failure: { reason: "empty_tenant_view" },
    });
    const ingest = withTenantGraphHandle(
      { tenantId: "tenant-a", graphPath: path, allowEmpty: true },
      (graphDb) => graphDb.path,
    );
    expect(ingest).toEqual({ ok: true, value: path });
  });
});
