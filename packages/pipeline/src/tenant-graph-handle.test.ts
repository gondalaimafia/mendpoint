import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openGraphLearnDb,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import {
  productionGraphFilePresent,
  resolveTenantGraphHandle,
} from "./tenant-graph-handle.js";

const opened: Array<{ db?: GraphLearnDb; dir?: string; close?: () => void }> = [];

afterEach(() => {
  for (const item of opened.splice(0).reverse()) {
    item.close?.();
    try { item.db?.raw.close(); } catch { /* already closed */ }
    if (item.dir) rmSync(item.dir, { recursive: true, force: true });
  }
});

function persistentGraph(seedTenant = "tenant-a"): { path: string; dir: string; db: GraphLearnDb } {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-graph-handle-"));
  const path = join(dir, "graph-learn.sqlite");
  const db = openGraphLearnDb(path);
  opened.push({ db, dir });
  if (seedTenant) {
    upsertNode(db, {
      id: `file:${seedTenant}:index.ts`,
      kind: "File",
      label: `${seedTenant}/index.ts`,
      repo_id: `${seedTenant}:repo`,
    });
    upsertNode(db, {
      id: `symbol:${seedTenant}:run`,
      kind: "Symbol",
      label: `${seedTenant}.run`,
      repo_id: `${seedTenant}:repo`,
    });
    upsertEdge(db, {
      id: `DEFINES:${seedTenant}:run`,
      kind: "DEFINES",
      source: `file:${seedTenant}:index.ts`,
      target: `symbol:${seedTenant}:run`,
    });
  }
  return { path, dir, db };
}

describe("resolveTenantGraphHandle", () => {
  it("fails closed when GRAPH_LEARN_DB is unset and no path is supplied", () => {
    const previous = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      expect(resolveTenantGraphHandle({ tenantId: "tenant-a" })).toEqual({
        status: "unavailable",
        reason: "path_missing",
        detail: "GRAPH_LEARN_DB is not set",
      });
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  });

  it("refuses an in-memory path as a production handle", () => {
    expect(resolveTenantGraphHandle({ tenantId: "tenant-a", graphPath: ":memory:" })).toMatchObject({
      status: "unavailable",
      reason: "path_ephemeral",
    });
    expect(resolveTenantGraphHandle({ tenantId: "tenant-a", graphPath: "file::memory:" })).toMatchObject({
      status: "unavailable",
      reason: "path_ephemeral",
    });
  });

  it("fails closed when the graph file does not exist rather than creating it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-graph-absent-"));
    opened.push({ dir });
    const path = join(dir, "missing", "graph-learn.sqlite");
    const result = resolveTenantGraphHandle({ tenantId: "tenant-a", graphPath: path });
    expect(result).toMatchObject({ status: "unavailable", reason: "file_missing" });
    expect(existsSync(path)).toBe(false);
  });

  it("fails closed on an empty tenant view even when the file exists", () => {
    const { path } = persistentGraph("tenant-b");
    const result = resolveTenantGraphHandle({ tenantId: "tenant-a", graphPath: path });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "empty_tenant_view",
    });
  });

  it("returns a ready handle for a tenant that owns graph nodes", () => {
    const { path } = persistentGraph("tenant-a");
    const result = resolveTenantGraphHandle({ tenantId: "tenant-a", graphPath: path });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    opened.push({ close: result.close });
    expect(result.stats).toEqual({ nodes: 2, edges: 1 });
    expect(result.graphDb.path).toBe(path);
    expect(result.graphDb.path).not.toBe(":memory:");
  });

  it("does not treat another tenant's nodes as this tenant's graph", () => {
    const { path, db } = persistentGraph("tenant-a");
    upsertNode(db, {
      id: "file:tenant-b:other.ts",
      kind: "File",
      label: "other.ts",
      repo_id: "tenant-b:repo",
    });
    const other = resolveTenantGraphHandle({ tenantId: "tenant-b", graphPath: path });
    expect(other.status).toBe("ready");
    if (other.status === "ready") {
      opened.push({ close: other.close });
      expect(other.stats.nodes).toBe(1);
    }
    const missing = resolveTenantGraphHandle({ tenantId: "tenant-c", graphPath: path });
    expect(missing).toMatchObject({ status: "unavailable", reason: "empty_tenant_view" });
  });

  it("reports open_failed without leaking an ephemeral memory store", () => {
    const result = resolveTenantGraphHandle({
      tenantId: "tenant-a",
      graphPath: "/tmp/does-not-matter.sqlite",
      exists: () => true,
      open: () => {
        throw new Error("disk_readonly");
      },
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "open_failed",
      detail: "disk_readonly",
    });
  });
});

describe("productionGraphFilePresent", () => {
  it("is false for missing, empty, and ephemeral paths", () => {
    expect(productionGraphFilePresent(null)).toBe(false);
    expect(productionGraphFilePresent(":memory:")).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-graph-present-"));
    opened.push({ dir });
    expect(productionGraphFilePresent(join(dir, "nope.sqlite"))).toBe(false);
  });

  it("is true only for an existing non-ephemeral file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-graph-file-"));
    opened.push({ dir });
    const path = join(dir, "graph-learn.sqlite");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "");
    expect(productionGraphFilePresent(path)).toBe(true);
  });
});
