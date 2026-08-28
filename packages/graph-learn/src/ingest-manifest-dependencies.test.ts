import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ingestManifestDependencies } from "./ingest-manifest-dependencies.js";
import { ingestControlPlane } from "./ingest.js";
import { ingestLspSymbols } from "./lsp-ingest.js";
import { runGraphQuery } from "./query.js";
import { edgesFrom, getNode, listNodesByKind, openGraphLearnDb, openGraphLearnMemory, upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

const opened: GraphLearnDb[] = [];

function manifestRoots(db: GraphLearnDb, tenantId: string, repoId: string) {
  return listNodesByKind(db, "Service").filter((node) =>
    node.repo_id === repoId && String(node.props?.tenant_id ?? "") === tenantId && node.props?.declared !== true);
}

function currentManifestRoot(db: GraphLearnDb, tenantId: string, repoId: string) {
  return manifestRoots(db, tenantId, repoId).find((node) => node.props?.manifest_valid_to === null);
}

function manifestEdgesAt(db: GraphLearnDb, tenantId: string, repoId: string, at: string) {
  return manifestRoots(db, tenantId, repoId).flatMap((node) =>
    edgesFrom(db, node.id, ["DEPENDS_ON"], { at }));
}

afterEach(() => {
  for (const db of opened.splice(0)) db.raw.close();
});

describe("ingestManifestDependencies", () => {
  it("writes Service DEPENDS_ON Service from package.json and skips self references", () => {
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
          dependencies: { stripe: "^18.0.0", "@acme/payments": "1.0.0" },
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
    const source = currentManifestRoot(db, "tenant-x", "tenant-x")!.id;
    const depEdges = edgesFrom(db, source, ["DEPENDS_ON"]);
    const deps = depEdges.map((edge) => getNode(db, edge.target)?.label).sort();
    expect(deps).toEqual(["react", "stripe"]);
    expect(listNodesByKind(db, "Service")).toHaveLength(3);
    // The edge records which manifest block declared it: react is a peer dep,
    // stripe a runtime dep, and that weaker/stronger claim must survive.
    const blocks = Object.fromEntries(
      depEdges.map((edge) => [getNode(db, edge.target)?.label, (edge.props as { block?: string })?.block]),
    );
    expect(blocks).toEqual({
      react: "peerDependencies",
      stripe: "dependencies",
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

  it("does not certify ignored or truncated dependency declarations as complete", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const ignored = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "repo-a",
      tenantId: "tenant-a",
      files: [{
        path: "package.json",
        text: JSON.stringify({ name: "shop", dependencies: { "../billing": "workspace:*" } }),
      }],
    });
    expect(ignored).toMatchObject({
      status: "ingested",
      coverage: "unknown",
      coverageReasons: ["dependency_declaration_unrepresented:dependencies"],
      dependencies: 0,
    });
    expect(currentManifestRoot(db, "tenant-a", "repo-a")?.props).toMatchObject({
      manifest_ingest_status: "incomplete",
    });

    const tooMany = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`package-${index}`, "1.0.0"]),
    );
    const truncated = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "repo-b",
      tenantId: "tenant-a",
      files: [{ path: "package.json", text: JSON.stringify({ name: "large", dependencies: tooMany }) }],
    });
    expect(truncated).toMatchObject({
      coverage: "unknown",
      coverageReasons: ["manifest_dependency_limit_exceeded"],
      dependencies: 500,
    });
  });

  it("versions removals and rollback without replaying or losing temporal evidence", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const manifest = (dependencies: Record<string, string>) => ({
      repoPath: "/unused",
      repoId: "repo-a",
      tenantId: "tenant-a",
      files: [{ path: "package.json", text: JSON.stringify({ name: "shop", dependencies }) }],
    });
    const first = ingestManifestDependencies(db, {
      ...manifest({ billing: "workspace:*" }),
      observedAt: "2026-08-27T10:00:00.000Z",
    });
    const removed = ingestManifestDependencies(db, {
      ...manifest({}),
      observedAt: "2026-08-27T11:00:00.000Z",
    });
    const replay = ingestManifestDependencies(db, {
      ...manifest({}),
      observedAt: "2026-08-27T11:30:00.000Z",
    });
    const restored = ingestManifestDependencies(db, {
      ...manifest({ billing: "workspace:*" }),
      observedAt: "2026-08-27T12:00:00.000Z",
    });
    expect(replay.versionId).toBe(removed.versionId);
    expect(new Set([first.versionId, removed.versionId, restored.versionId]).size).toBe(3);
    expect(manifestEdgesAt(db, "tenant-a", "repo-a", "2026-08-27T10:30:00.000Z")).toHaveLength(1);
    expect(manifestEdgesAt(db, "tenant-a", "repo-a", "2026-08-27T11:30:00.000Z")).toHaveLength(0);
    expect(manifestEdgesAt(db, "tenant-a", "repo-a", "2026-08-27T12:30:00.000Z")).toHaveLength(1);
    const history = manifestRoots(db, "tenant-a", "repo-a").flatMap((node) =>
      edgesFrom(db, node.id, ["DEPENDS_ON"], { includeInvalidated: true }));
    expect(history).toHaveLength(2);
    expect(history.filter((edge) => edge.valid_to === null)).toHaveLength(1);
  });

  it("persists the manifest stream clock across normal and tombstone replay", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const observe = (text: string, observedAt: string) => ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-clock", tenantId: "tenant-a", observedAt,
      files: [{ path: "package.json", text }],
    });
    const normal = JSON.stringify({ name: "shop", dependencies: { stripe: "1" } });
    const first = observe(normal, "2026-08-27T10:00:00.000Z");
    expect(observe(normal, "2026-08-27T12:00:00.000Z").versionId).toBe(first.versionId);
    expect(() => observe(JSON.stringify({ name: "shop" }), "2026-08-27T12:00:00.000Z"))
      .toThrow("manifest_ingest_observed_at_non_monotonic");
    expect(() => observe(JSON.stringify({ name: "shop" }), "2026-08-27T11:00:00.000Z"))
      .toThrow("manifest_ingest_observed_at_non_monotonic");

    const malformed = observe("{", "2026-08-27T13:00:00.000Z");
    expect(observe("{", "2026-08-27T15:00:00.000Z").versionId).toBe(malformed.versionId);
    expect(() => observe("{bad", "2026-08-27T15:00:00.000Z"))
      .toThrow("manifest_ingest_observed_at_non_monotonic");
    expect(() => observe("{bad", "2026-08-27T14:00:00.000Z"))
      .toThrow("manifest_ingest_observed_at_non_monotonic");
  });

  it("fences cross-manifest replacement ordering with the repository inventory clock", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-polyglot-clock", tenantId: "tenant-a",
      observedAt: "2026-08-27T12:00:00.000Z",
      files: [{ path: "package.json", text: JSON.stringify({ name: "app" }) }],
    });
    expect(() => ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-polyglot-clock", tenantId: "tenant-a",
      observedAt: "2026-08-27T11:00:00.000Z",
      files: [{ path: "pyproject.toml", text: '[project]\nname="app"\n' }],
    })).toThrow("manifest_ingest_observed_at_non_monotonic");
  });

  it("adds the durable manifest stream clock when opening an existing graph database", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-graph-upgrade-"));
    const path = join(dir, "graph.sqlite");
    let db: GraphLearnDb | undefined;
    try {
      const old = new DatabaseSync(path);
      old.exec("CREATE TABLE existing_volume_marker (id TEXT PRIMARY KEY)");
      old.close();
      db = openGraphLearnDb(path);
      const columns = db.raw.prepare("PRAGMA table_info(gl_manifest_stream_heads_v1)")
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "tenant_id", "repository_id", "manifest_stream_path", "last_observed_at",
      ]);
      expect(ingestManifestDependencies(db, {
        repoPath: "/unused", repoId: "repo-upgrade", tenantId: "tenant-a",
        observedAt: "2026-08-27T10:00:00.000Z",
        files: [{ path: "package.json", text: JSON.stringify({ name: "app" }) }],
      }).status).toBe("ingested");
    } finally {
      db?.raw.close();
      rmSync(dir, { recursive: true, force: true });
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
    expect(currentManifestRoot(db, "", "tenant-x")?.props).toMatchObject({
      manifest_ingest_status: "tombstone",
      manifest_extractor_id: "mendpoint.manifest-dependencies",
    });
    // A present-but-broken manifest is distinguishable from an absent one and
    // from one whose package name is unusable.
    expect(result).toMatchObject({ status: "skipped", reason: "unparseable", manifest: "package.json" });
    expect(result).toMatchObject({
      contentDigest: expect.stringMatching(/^sha256:/),
      evidenceRefs: [expect.stringMatching(/^manifest-ingest:sha256:/)],
    });
  });

  it("distinguishes a missing manifest and a missing/path-like package name from unparseable text", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const absent = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      observedAt: "2026-08-27T10:00:00.000Z",
      files: [{ path: "README.md", text: "# no manifest here" }],
    });
    expect(absent).toMatchObject({ status: "skipped", reason: "no-manifest", manifest: null });
    const noName = ingestManifestDependencies(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      observedAt: "2026-08-27T11:00:00.000Z",
      files: [{ path: "package.json", text: JSON.stringify({ name: "../escape", dependencies: { stripe: "1" } }) }],
    });
    expect(noName).toMatchObject({ status: "skipped", reason: "no-package-name", manifest: "package.json" });
    expect(manifestRoots(db, "", "tenant-x")).toHaveLength(2);
    expect(currentManifestRoot(db, "", "tenant-x")?.props).toMatchObject({ manifest_ingest_status: "tombstone" });
  });

  it("uses an explicit declaration inventory and fails closed on unsupported, conflicting, or truncated topology", () => {
    const cases = [
      { name: "workspace", value: { name: "app", workspaces: ["packages/*"] }, reason: "workspace_manifest_not_expanded" },
      { name: "bundled", value: { name: "app", bundledDependencies: ["local"] }, reason: "bundled_dependencies_not_expanded" },
      { name: "override", value: { name: "app", overrides: { local: "file:../local" } }, reason: "package_manager_topology_not_expanded" },
      { name: "conflict", value: { name: "app", dependencies: { local: "1" }, devDependencies: { local: "file:../local" } }, reason: "dependency_declaration_conflict:local" },
      { name: "truncated", value: { name: "app", dependencies: { local: "x".repeat(81) } }, reason: "dependency_specifier_truncated:dependencies" },
    ];
    for (const entry of cases) {
      const db = openGraphLearnMemory();
      opened.push(db);
      const result = ingestManifestDependencies(db, {
        repoPath: "/unused", repoId: `repo-${entry.name}`, tenantId: "tenant-a",
        files: [{ path: "package.json", text: JSON.stringify(entry.value) }],
      });
      expect(result.coverage).toBe("unknown");
      expect(result.coverageReasons).toContain(entry.reason);
      expect(currentManifestRoot(db, "tenant-a", `repo-${entry.name}`)?.props)
        .toMatchObject({ manifest_ingest_status: "incomplete" });
    }
    const supported = openGraphLearnMemory();
    opened.push(supported);
    expect(ingestManifestDependencies(supported, {
      repoPath: "/unused", repoId: "repo-supported", tenantId: "tenant-a",
      files: [{ path: "package.json", text: JSON.stringify({
        name: "app", optionalDependencies: { registry: "1" }, peerDependencies: { react: "18" },
      }) }],
    })).toMatchObject({ coverage: "complete", dependencies: 2 });

    const pyproject = openGraphLearnMemory();
    opened.push(pyproject);
    expect(ingestManifestDependencies(pyproject, {
      repoPath: "/unused", repoId: "repo-python", tenantId: "tenant-a",
      files: [{ path: "pyproject.toml", text: '[project]\nname="app"\ndynamic=["dependencies"]\n[project.optional-dependencies]\ntest=["pytest"]\n' }],
    })).toMatchObject({
      coverage: "unknown",
      coverageReasons: expect.arrayContaining([
        "pyproject_dependency_group_not_expanded",
        "pyproject_dynamic_dependencies_not_expanded",
      ]),
    });
    const go = openGraphLearnMemory();
    opened.push(go);
    expect(ingestManifestDependencies(go, {
      repoPath: "/unused", repoId: "repo-go", tenantId: "tenant-a",
      files: [{ path: "go.mod", text: "module example.com/app\nrequire example.com/lib v1.0.0\nreplace example.com/lib => ../lib\n" }],
    })).toMatchObject({ coverage: "unknown", coverageReasons: ["go_replace_topology_not_expanded"] });
  });

  it("marks every additional supported manifest as explicitly unexpanded", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const withWorkspaceManifest = ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-polyglot", tenantId: "tenant-a",
      files: [
        { path: "package.json", text: JSON.stringify({ name: "app" }) },
        { path: "packages/worker/pyproject.toml", text: '[project]\nname="worker"\n' },
        { path: "tools/go.mod", text: "module example.com/tools\n" },
      ],
    });
    expect(withWorkspaceManifest).toMatchObject({
      coverage: "unknown",
      coverageReasons: [
        "supported_manifest_not_ingested:packages/worker/pyproject.toml",
        "supported_manifest_not_ingested:tools/go.mod",
      ],
    });
    const onlyRoot = ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-root-only", tenantId: "tenant-a",
      files: [{ path: "package.json", text: JSON.stringify({ name: "app" }) }],
    });
    expect(onlyRoot).toMatchObject({ coverage: "complete", coverageReasons: [] });

    const dir = mkdtempSync(join(tmpdir(), "mendpoint-manifest-inventory-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
      mkdirSync(join(dir, "packages", "worker"), { recursive: true });
      const nestedManifest = join(dir, "packages", "worker", "pyproject.toml");
      writeFileSync(nestedManifest, '[project]\nname="worker"\n');
      const incomplete = ingestManifestDependencies(db, {
        repoPath: dir, repoId: "repo-on-disk", tenantId: "tenant-a",
        observedAt: "2026-08-27T10:00:00.000Z",
      });
      expect(incomplete).toMatchObject({
        coverage: "unknown",
        manifest: "package.json",
        coverageReasons: ["supported_manifest_not_ingested:packages/worker/pyproject.toml"],
      });

      // Mutating the live inventory must change the next observation. This
      // catches implementations that only inspect the selected root manifest.
      unlinkSync(nestedManifest);
      const complete = ingestManifestDependencies(db, {
        repoPath: dir, repoId: "repo-on-disk", tenantId: "tenant-a",
        observedAt: "2026-08-27T11:00:00.000Z",
      });
      expect(complete).toMatchObject({ coverage: "complete", coverageReasons: [] });
      expect(complete.versionId).not.toBe(incomplete.versionId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds live inventory traversal and never follows repository symlinks", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-manifest-bounds-"));
    const outside = mkdtempSync(join(tmpdir(), "mendpoint-manifest-outside-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app" }));
      writeFileSync(join(outside, "pyproject.toml"), '[project]\nname="outside"\n');
      symlinkSync(outside, join(dir, "linked"), process.platform === "win32" ? "junction" : "dir");
      let cursor = dir;
      for (let index = 0; index < 34; index++) {
        cursor = join(cursor, `level-${index.toString().padStart(2, "0")}`);
        mkdirSync(cursor);
      }
      writeFileSync(join(cursor, "go.mod"), "module example.com/deep\n");

      const result = ingestManifestDependencies(db, {
        repoPath: dir, repoId: "repo-bounded", tenantId: "tenant-a",
      });
      expect(result.coverage).toBe("unknown");
      expect(result.coverageReasons).toEqual(expect.arrayContaining([
        "manifest_inventory_symlink_skipped:linked",
        expect.stringMatching(/^manifest_inventory_depth_exceeded:/),
      ]));
      expect(result.coverageReasons).not.toContain("supported_manifest_not_ingested:linked/pyproject.toml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("matches repository canonical text digests while retaining raw BOM and CRLF provenance", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const lf = '{\n  "name": "app",\n  "dependencies": {"stripe": "1"}\n}\n';
    const crlfBom = `\uFEFF${lf.replace(/\n/g, "\r\n")}`;
    const first = ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-lf", tenantId: "tenant-a",
      files: [{ path: "package.json", text: lf }],
    });
    const second = ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-crlf", tenantId: "tenant-a",
      files: [{ path: "package.json", text: crlfBom }],
    });
    expect(second.contentDigest).toBe(first.contentDigest);
    expect(second.semanticDigest).toBe(first.semanticDigest);
    expect(second.rawContentDigest).not.toBe(first.rawContentDigest);
    expect(second.evidenceRefs).toEqual([`manifest-ingest:${second.contentDigest}`]);
  });

  it("tombstones malformed observations, closes stale edges, and rejects non-monotonic replacement", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-a", tenantId: "tenant-a",
      observedAt: "2026-08-27T10:00:00.000Z",
      files: [{ path: "package.json", text: JSON.stringify({ name: "app", dependencies: { local: "workspace:*" } }) }],
    });
    const malformed = ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-a", tenantId: "tenant-a",
      observedAt: "2026-08-27T11:00:00.000Z",
      files: [{ path: "package.json", text: "{" }],
    });
    expect(malformed).toMatchObject({ status: "skipped", coverage: "unknown", versionId: expect.stringMatching(/^sha256:/) });
    expect(manifestEdgesAt(db, "tenant-a", "repo-a", "2026-08-27T10:30:00.000Z")).toHaveLength(1);
    expect(manifestEdgesAt(db, "tenant-a", "repo-a", "2026-08-27T11:30:00.000Z")).toHaveLength(0);
    expect(currentManifestRoot(db, "tenant-a", "repo-a")?.props).toMatchObject({ manifest_ingest_status: "tombstone" });
    expect(() => ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-a", tenantId: "tenant-a",
      observedAt: "2026-08-27T09:30:00-01:00",
      files: [{ path: "package.json", text: JSON.stringify({ name: "app" }) }],
    })).toThrow("manifest_ingest_observed_at_non_monotonic");
  });

  it("keeps identical repository and package identities isolated by tenant", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    upsertNode(db, {
      id: "service:repo-shared:app",
      kind: "Service",
      label: "app",
      repo_id: "repo-shared",
      props: {
        tenant_id: "tenant-a",
        manifest: "package.json",
        manifest_ingest_status: "complete",
        manifest_version_id: `sha256:${"1".repeat(64)}`,
        manifest_content_digest: `sha256:${"2".repeat(64)}`,
        manifest_valid_from: "2026-08-27T09:00:00.000Z",
      },
    });
    for (const tenantId of ["tenant-a", "tenant-b"]) ingestManifestDependencies(db, {
      repoPath: "/unused", repoId: "repo-shared", tenantId,
      observedAt: "2026-08-27T10:00:00.000Z",
      files: [{ path: "package.json", text: JSON.stringify({ name: "app", dependencies: { stripe: "1" } }) }],
    });
    const left = currentManifestRoot(db, "tenant-a", "repo-shared")!;
    const right = currentManifestRoot(db, "tenant-b", "repo-shared")!;
    expect(left.id).not.toBe(right.id);
    expect(edgesFrom(db, left.id, ["DEPENDS_ON"])).toHaveLength(1);
    expect(edgesFrom(db, right.id, ["DEPENDS_ON"])).toHaveLength(1);
    expect(getNode(db, "service:repo-shared:app")?.props).toMatchObject({
      manifest_valid_to: "2026-08-27T10:00:00.000Z",
    });
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
      ingestLspSymbols(db, { repoPath: dir, repoId: "tenant-x", tenantId: "tenant-x" });
      expect(edgesFrom(db, currentManifestRoot(db, "tenant-x", "tenant-x")!.id, ["DEPENDS_ON"]))
        .toHaveLength(1);
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
    expect(edgesFrom(db, currentManifestRoot(db, "tenant-x", "tenant-x")!.id, ["DEPENDS_ON"]).length)
      .toBeGreaterThan(0);
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
    const declared = listNodesByKind(db, "Service").find((node) =>
      node.repo_id === "repo-a" && node.label === "stripe" && node.props?.declared === true);
    expect(declared).toMatchObject({
      kind: "Service",
      props: expect.objectContaining({ tenant_id: "tenant-a" }),
    });
  });
});
