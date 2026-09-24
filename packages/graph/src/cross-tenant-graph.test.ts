/**
 * Cross-tenant graph isolation (tenant-isolation audit fix, defect 3).
 *
 * GET /graph/changes/:id and GET /graph/consumers/:id build a change-impact graph for the
 * calling tenant via buildChangeImpactGraph(db, changeId, { tenantId }). Previously the change
 * was read tenant-blind, so tenant A could materialize the title and diff nodes of a change on
 * tenant B's PRIVATE provider. The change is now read through getVisibleChange, so a change on
 * another tenant's private provider is 404-equivalent (null). buildProductKnowledgeGraph's
 * provider focus is likewise scoped. Reverting getVisibleChange to the tenant-blind read fails
 * these tests.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertProvider,
  type AppDb,
} from "@mendpoint/db";
import { buildChangeImpactGraph, invalidateGraphCaches } from "./build-from-db.js";
import { buildProductKnowledgeGraph } from "./product.js";

const NOW = "2026-09-23T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  invalidateGraphCaches();
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedProvider(db: AppDb, slug: string, tenantId: string | null): string {
  const providerId = `provider-${slug}`;
  insertProvider(db, { id: providerId, slug, name: `Provider ${slug}`, tenantId, createdAt: NOW });
  insertApiVersion(db, {
    id: `${slug}-v1`,
    providerId,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "1" }, paths: {} }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: `${slug}-v2`,
    providerId,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "2" }, paths: {} }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: `change-${slug}`,
    providerId,
    fromVersionId: `${slug}-v1`,
    toVersionId: `${slug}-v2`,
    risk: "breaking",
    summary: `SECRET change on ${slug}`,
    diffJson: "[]",
    createdAt: NOW,
  });
  return providerId;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-cross-tenant-graph-"));
  const db = createDb(join(directory, "graph.sqlite"));
  opened.push({ db, directory });
  seedProvider(db, "shared-vendor", null);
  seedProvider(db, "a-private", "tenant-a");
  seedProvider(db, "b-private", "tenant-b");
  return { db };
}

describe("cross-tenant graph isolation", () => {
  it("buildChangeImpactGraph: a change on B's private provider is null for A (never its diff/title)", () => {
    const { db } = fixture();
    const cross = buildChangeImpactGraph(db, "change-b-private", { tenantId: "tenant-a" });
    expect(cross).toBeNull();
    // An unknown change id is likewise null — indistinguishable.
    expect(buildChangeImpactGraph(db, "change-unknown", { tenantId: "tenant-a" })).toBeNull();
  });

  it("buildChangeImpactGraph: positive controls — A's own private and a shared change build a graph", () => {
    const { db } = fixture();
    expect(buildChangeImpactGraph(db, "change-a-private", { tenantId: "tenant-a" })).not.toBeNull();
    expect(buildChangeImpactGraph(db, "change-shared-vendor", { tenantId: "tenant-a" })).not.toBeNull();
    // System build (no tenant) still resolves any change.
    expect(buildChangeImpactGraph(db, "change-b-private", {})).not.toBeNull();
  });

  it("buildProductKnowledgeGraph: focusing on B's private provider yields no B nodes for A", () => {
    const { db } = fixture();
    const graph = buildProductKnowledgeGraph(db, { type: "provider", slug: "b-private" }, "tenant-a");
    // The graph `id` echoes the caller's own focus string; the isolation property is that no
    // node for B's provider (nor its name) enters the graph for A.
    expect(graph.nodes.some((n) => n.id === "provider:provider-b-private")).toBe(false);
    expect(JSON.stringify(graph.nodes)).not.toContain("Provider b-private");
    // Contrast: B focusing on its own provider does get the node (proves the focus works).
    const bGraph = buildProductKnowledgeGraph(db, { type: "provider", slug: "b-private" }, "tenant-b");
    expect(bGraph.nodes.some((n) => n.id === "provider:provider-b-private")).toBe(true);
  });
});
