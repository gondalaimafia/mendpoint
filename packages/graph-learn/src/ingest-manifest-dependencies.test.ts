import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestManifestDependencies } from "./ingest-manifest-dependencies.js";
import { ingestControlPlane } from "./ingest.js";
import { ingestLspSymbols } from "./lsp-ingest.js";
import { runGraphQuery } from "./query.js";
import { edgesFrom, getNode, listNodesByKind, openGraphLearnMemory, upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

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
      status: "ingested",
      reason: null,
      ecosystem: "npm",
      packageName: "@acme/payments",
      dependencies: 2,
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      evidenceRefs: [expect.stringMatching(/^manifest-ingest:sha256:/)],
    });
    const source = "service:tenant-x:@acme/payments";
    const depEdges = edgesFrom(db, source, ["DEPENDS_ON"]);
    const deps = depEdges.map((edge) => edge.target).sort();
    expect(deps).toEqual(["service:tenant-x:react", "service:tenant-x:stripe"]);
    expect(listNodesByKind(db, "Service").map((node) => node.id).sort()).toEqual([
      "service:tenant-x:@acme/payments",
      "service:tenant-x:react",
      "service:tenant-x:stripe",
    ]);
    // The edge records which manifest block declared it: react is a peer dep,
    // stripe a runtime dep, and that weaker/stronger claim must survive.
    const blocks = Object.fromEntries(
      depEdges.map((edge) => [edge.target, (edge.props as { block?: string })?.block]),
    );
    expect(blocks).toEqual({
      "service:tenant-x:react": "peerDependencies",
      "service:tenant-x:stripe": "dependencies",
    });
    expect(getNode(db, source)?.props).toMatchObject({
      tenant_id: "tenant-x",
      manifest_ingest_status: "complete",
      manifest_content_digest: result.contentDigest,
      manifest_evidence_refs: result.evidenceRefs,
    });
    for (const edge of depEdges) {
      expect(edge.props).toMatchObject({
        manifest_content_digest: result.contentDigest,
        evidence_refs: result.evidenceRefs,
      });
    }
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
    // A present-but-broken manifest is distinguishable from an absent one and
    // from one whose package name is unusable.
    expect(result).toMatchObject({ status: "skipped", reason: "unparseable", manifest: "package.json" });
    expect(result).toMatchObject({ contentDigest: null, evidenceRefs: [] });
  });

  it("distinguishes a missing manifest and a missing/path-like package name from unparseable text", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const absent = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{ path: "README.md", text: "# no manifest here" }],
    });
    expect(absent).toMatchObject({ status: "skipped", reason: "no-manifest", manifest: null });
    const noName = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{ path: "package.json", text: JSON.stringify({ name: "../escape", dependencies: { stripe: "1" } }) }],
    });
    expect(noName).toMatchObject({ status: "skipped", reason: "no-package-name", manifest: "package.json" });
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
      expect(edgesFrom(db, "service:tenant-x:shop", ["DEPENDS_ON"]).map((edge) => edge.target)).toEqual([
        "service:tenant-x:stripe",
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

  it("does not report a MigrationUnit ready just because manifest Service DEPENDS_ON edges exist", () => {
    // Manifest ingest writes Service -> Service DEPENDS_ON, not the
    // MigrationUnit -> MigrationUnit relation readiness walks. A gate keyed on
    // *any* DEPENDS_ON would open here, then `deps.every(...)` over a unit with
    // zero deps is vacuously true and the unit would be certified ready. The
    // gate must stay closed on the correct relation.
    const db = openGraphLearnMemory();
    opened.push(db);
    ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      tenantId: "tenant-x",
      files: [{ path: "package.json", text: JSON.stringify({ name: "shop", dependencies: { stripe: "1" } }) }],
    });
    expect(edgesFrom(db, "service:tenant-x:shop", ["DEPENDS_ON"]).length).toBeGreaterThan(0);
    upsertNode(db, {
      id: "migration-unit:checkout",
      kind: "MigrationUnit",
      label: "checkout",
      repo_id: "tenant-x",
      props: { campaign_id: "camp-1", status: "pending" },
    });
    const r = runGraphQuery(
      db,
      { op: "migration_ready_units", campaignId: "camp-1" },
      { tenantId: "tenant-x" },
    );
    expect(r.coverage.basis).toBe("target_absent");
    expect(r.rows).toEqual([]);
  });
});

describe("manifest Service ids do not collide with provider Service nodes", () => {
  it("leaves a provider Service untouched when a repo depends on a package of the same slug", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    // Provider ingest owns `service:stripe` (tenant + tier live in props).
    ingestControlPlane(
      db,
      { provider: { id: "p1", slug: "stripe", name: "Stripe" }, consumers: [], monitors: [] },
      "provider-tenant",
    );
    const before = getNode(db, "service:stripe");
    expect(before).toMatchObject({
      kind: "Service",
      label: "Stripe",
      props: expect.objectContaining({ tenant_id: "provider-tenant", tier: "t1" }),
    });
    // A different tenant's repo declares a dependency literally named "stripe".
    ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "repo-a",
      tenantId: "tenant-a",
      files: [{ path: "package.json", text: JSON.stringify({ name: "shop", dependencies: { stripe: "1" } }) }],
    });
    // The provider node is byte-for-byte what it was: not relabelled, not
    // re-tenanted, not re-homed to repo-a.
    expect(getNode(db, "service:stripe")).toEqual(before);
    // The manifest dependency lives at its own namespaced id.
    expect(getNode(db, "service:repo-a:stripe")).toMatchObject({
      kind: "Service",
      props: expect.objectContaining({ tenant_id: "tenant-a" }),
    });
  });
});
