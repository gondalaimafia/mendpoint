import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestManifestDependencies } from "./ingest-manifest-dependencies.js";
import { ingestLspSymbols } from "./lsp-ingest.js";
import { runGraphQuery } from "./query.js";
import { edgesFrom, listNodesByKind, openGraphLearnMemory, upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

const opened: GraphLearnDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.raw.close();
});

describe("ingestManifestDependencies", () => {
  it("writes Service DEPENDS_ON Service from package.json and skips self/malformed names", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const result = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      tenantId: "tenant-x",
      files: [{
        path: "package.json",
        text: JSON.stringify({
          name: "@acme/payments",
          dependencies: { stripe: "^18.0.0", "@acme/payments": "1.0.0", "../escape": "1.0.0" },
          peerDependencies: { react: "^18" },
        }),
      }],
    });
    expect(result).toMatchObject({
      ecosystem: "npm",
      packageName: "@acme/payments",
      dependencies: 2,
    });
    const source = "service:@acme/payments";
    const deps = edgesFrom(db, source, ["DEPENDS_ON"]).map((edge) => edge.target).sort();
    expect(deps).toEqual(["service:react", "service:stripe"]);
    expect(listNodesByKind(db, "Service").map((node) => node.id).sort()).toEqual([
      "service:@acme/payments",
      "service:react",
      "service:stripe",
    ]);
  });

  it("skips unparseable manifests rather than inventing edges", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const result = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{ path: "package.json", text: "{not json" }],
    });
    expect(result.dependencies).toBe(0);
    expect(listNodesByKind(db, "Service")).toEqual([]);
  });

  it("runs on the lsp ingest live path from a workspace package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-manifest-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "shop",
        dependencies: { stripe: "1.0.0" },
      }));
      writeFileSync(join(dir, "index.ts"), "export function ping() { return 1; }\n");
      const db = openGraphLearnMemory();
      opened.push(db);
      ingestLspSymbols(db, { repoPath: dir, repoId: "tenant-x" });
      expect(edgesFrom(db, "service:shop", ["DEPENDS_ON"]).map((edge) => edge.target)).toEqual([
        "service:stripe",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration_ready_units with a DEPENDS_ON producer", () => {
  it("returns pending units whose dependencies are complete, and not units that still wait", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{ path: "package.json", text: JSON.stringify({ name: "shop", dependencies: { stripe: "1" } }) }],
    });
    upsertNode(db, {
      id: "migration-unit:billing",
      kind: "MigrationUnit",
      label: "billing",
      repo_id: "tenant-x",
      props: { campaign_id: "camp-1", status: "complete" },
    });
    upsertNode(db, {
      id: "migration-unit:checkout",
      kind: "MigrationUnit",
      label: "checkout",
      repo_id: "tenant-x",
      props: { campaign_id: "camp-1", status: "pending" },
    });
    upsertNode(db, {
      id: "migration-unit:storefront",
      kind: "MigrationUnit",
      label: "storefront",
      repo_id: "tenant-x",
      props: { campaign_id: "camp-1", status: "pending" },
    });
    upsertEdge(db, {
      id: "DEPENDS_ON:migration-unit:checkout:migration-unit:billing",
      kind: "DEPENDS_ON",
      source: "migration-unit:checkout",
      target: "migration-unit:billing",
      source_system: "planner",
      confidence: 1,
    });
    upsertEdge(db, {
      id: "DEPENDS_ON:migration-unit:storefront:migration-unit:checkout",
      kind: "DEPENDS_ON",
      source: "migration-unit:storefront",
      target: "migration-unit:checkout",
      source_system: "planner",
      confidence: 1,
    });
    const r = runGraphQuery(
      db,
      { op: "migration_ready_units", campaignId: "camp-1" },
      { tenantId: "tenant-x" },
    );
    expect(r.coverage.basis).toBe("complete");
    expect(r.rows).toEqual([
      expect.objectContaining({ unitId: "migration-unit:checkout", status: "pending" }),
    ]);
  });
});
