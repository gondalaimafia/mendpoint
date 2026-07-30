import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blastRadius,
  backfillGitTemporal,
  clearSnapshot,
  cosineSimilarity,
  edgesFrom,
  embedGraphNodes,
  exportGnnFeatures,
  extractSymbolsFromSource,
  getNode,
  getNodeEmbedding,
  getGraphLearnDb,
  incrementalReingest,
  ingestAstRepo,
  ingestLspSymbols,
  ingestSpecDiff,
  labelPrOutcome,
  listNodesByKind,
  measureAbLift,
  openGraphLearnMemory,
  runGraphQuery,
  resetGraphLearnDbForTests,
  upsertEdge,
  upsertNode,
} from "./index.js";
import type { ImpactableSurface, StructuralDiff } from "@mendpoint/shared";

afterEach(() => {
  resetGraphLearnDbForTests();
  vi.unstubAllEnvs();
});

describe("GA review regressions", () => {
  it("does not treat capped files as deleted and removes stale files on forceFull", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-cap-"));
    const snap = join(dir, "graph-hash.json");
    const db = openGraphLearnMemory();
    try {
      writeFileSync(join(dir, "b.ts"), "export function b() { return 1; }\n");
      incrementalReingest(db, {
        repoPath: dir,
        repoId: "cap",
        snapshotPath: snap,
        maxFiles: 1,
      });
      expect(getNode(db, "file:cap:b.ts")).toBeDefined();

      writeFileSync(join(dir, "a.ts"), "export function a() { return 1; }\n");
      const capped = incrementalReingest(db, {
        repoPath: dir,
        repoId: "cap",
        snapshotPath: snap,
        maxFiles: 1,
      });
      expect(capped.removed).not.toContain("b.ts");
      expect(getNode(db, "file:cap:b.ts")).toBeDefined();

      unlinkSync(join(dir, "b.ts"));
      const forced = incrementalReingest(db, {
        repoPath: dir,
        repoId: "cap",
        snapshotPath: snap,
        maxFiles: 1,
        forceFull: true,
      });
      expect(forced.removed).toContain("b.ts");
      expect(getNode(db, "file:cap:b.ts")).toBeUndefined();
    } finally {
      clearSnapshot(snap);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates the capped ingestion window so later files are not starved", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-cursor-"));
    const snap = join(dir, "graph-hash.json");
    const db = openGraphLearnMemory();
    try {
      for (const name of ["a.ts", "b.ts", "c.ts"]) {
        writeFileSync(join(dir, name), `export function ${name[0]}() { return 1; }\n`);
      }
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const run = incrementalReingest(db, {
          repoPath: dir,
          repoId: "cursor",
          snapshotPath: snap,
          maxFiles: 1,
        });
        run.changed.forEach((file) => seen.add(file));
      }
      expect([...seen].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    } finally {
      clearSnapshot(snap);
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes the process singleton when tests reset it", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-singleton-"));
    try {
      vi.stubEnv("GRAPH_LEARN_DB", join(dir, "graph.sqlite"));
      const db = getGraphLearnDb();
      resetGraphLearnDbForTests();
      expect(() => db.raw.prepare("SELECT 1").get()).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("correlates field consumers through the matching schema and provider", () => {
    const db = openGraphLearnMemory();
    try {
      for (const node of [
        { id: "field:amount", kind: "Field", label: "amount" },
        {
          id: "schema:Charge",
          kind: "Schema",
          label: "Charge",
          props: { name: "Charge" },
        },
        { id: "endpoint:charges", kind: "Endpoint", label: "POST /charges" },
        { id: "provider:acme", kind: "Provider", label: "Acme" },
        { id: "consumer:shop", kind: "Consumer", label: "Shop" },
        { id: "consumer:other", kind: "Consumer", label: "Other" },
      ] as const) {
        upsertNode(db, node);
      }
      for (const edge of [
        {
          id: "has-field",
          kind: "HAS_FIELD",
          source: "schema:Charge",
          target: "field:amount",
        },
        {
          id: "has-schema",
          kind: "HAS_SCHEMA",
          source: "endpoint:charges",
          target: "schema:Charge",
        },
        {
          id: "has-endpoint",
          kind: "HAS_ENDPOINT",
          source: "provider:acme",
          target: "endpoint:charges",
        },
        {
          id: "shop-monitors",
          kind: "MONITORS",
          source: "consumer:shop",
          target: "provider:acme",
        },
        {
          id: "other-monitors",
          kind: "MONITORS",
          source: "consumer:other",
          target: "provider:other",
        },
      ] as const) {
        upsertEdge(db, edge);
      }
      const result = runGraphQuery(db, {
        op: "consumers_of_field",
        schemaName: "Charge",
        fieldName: "amount",
      });
      expect(result.rows).toEqual([
        { consumerId: "shop", schemaName: "Charge", fieldName: "amount" },
      ]);
    } finally {
      db.raw.close();
    }
  });

  it("reconciles a PR to one current outcome and one A/B sample", () => {
    const db = openGraphLearnMemory();
    labelPrOutcome(db, {
      prId: "42",
      changeId: "change",
      consumerId: "consumer",
      outcome: "closed",
      experiment: "treatment",
    });
    labelPrOutcome(db, {
      prId: "42",
      changeId: "change",
      consumerId: "consumer",
      outcome: "merged",
      experiment: "treatment",
    });

    const outcomes = edgesFrom(db, "consumer:consumer", [
      "OUTCOME_MERGED",
      "OUTCOME_CLOSED",
      "OUTCOME_BROKE",
      "OUTCOME_WAIVED",
    ]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe("OUTCOME_MERGED");
    expect(edgesFrom(db, "pr:42", ["BROKE"])).toHaveLength(0);
    expect(edgesFrom(db, "pr:42", ["SUCCEEDED_ON"])).toHaveLength(1);
    expect(measureAbLift(db).treatment.samples).toBe(1);
    db.raw.close();
  });

  it("connects calls to definitions and attributes Python and Java bodies", () => {
    const python = extractSymbolsFromSource(
      [
        "def first():",
        "    alpha()",
        "",
        "def second():",
        "    beta()",
      ].join("\n"),
      "python",
    );
    expect(python.calls).toEqual([
      { from: "first", to: "alpha" },
      { from: "second", to: "beta" },
    ]);

    const java = extractSymbolsFromSource(
      [
        "class Example {",
        "  public void first() { alpha(); }",
        "  public void second() { beta(); }",
        "}",
      ].join("\n"),
      "java",
    );
    expect(java.calls).toContainEqual({ from: "first", to: "alpha" });
    expect(java.calls).toContainEqual({ from: "second", to: "beta" });

    const dir = mkdtempSync(join(tmpdir(), "gl-calls-"));
    const db = openGraphLearnMemory();
    try {
      writeFileSync(
        join(dir, "a.ts"),
        "export function foo() { bar(); baz(); }\nexport function bar() {}\n",
      );
      writeFileSync(join(dir, "b.ts"), "export function baz() {}\n");
      ingestAstRepo(db, { repoPath: dir, repoId: "calls" });
      const calls = edgesFrom(db, "symbol:calls:a.ts:foo", ["CALLS"]);
      expect(calls.map((edge) => edge.target).sort()).toEqual([
        "symbol:calls:a.ts:bar",
        "symbol:calls:b.ts:baz",
      ]);
      expect(getNode(db, "symbol:calls:baz")).toBeUndefined();
    } finally {
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns only endpoint-related failures and one temporal fact per touch", () => {
    const db = openGraphLearnMemory();
    const diff: StructuralDiff = {
      risk: "breaking",
      summary: "charge change",
      entries: [],
    };
    const surfaces: ImpactableSurface[] = [
      {
        id: "charges",
        canonicalId: "createCharge",
        kind: "http_path",
        op: "path_removed",
        path: "/charges",
        method: "post",
        severity: "breaking",
        migrationStrategy: "replace endpoint",
        explanation: "removed",
        searchTokens: ["charges"],
      },
    ];
    ingestSpecDiff(db, {
      providerSlug: "acme",
      changeId: "related",
      diff,
      surfaces,
    });
    labelPrOutcome(db, {
      prId: "related-pr",
      changeId: "related",
      consumerId: "c",
      outcome: "broke",
    });
    labelPrOutcome(db, {
      prId: "unrelated-pr",
      changeId: "other",
      consumerId: "c",
      outcome: "broke",
    });
    const broke = runGraphQuery(db, {
      op: "broke_modes_for_endpoint",
      operationId: "createCharge",
    });
    expect(broke.edges.some((edge) => edge.source === "pr:related-pr")).toBe(true);
    expect(broke.edges.some((edge) => edge.source === "pr:unrelated-pr")).toBe(
      false,
    );

    upsertNode(db, { id: "commit:r:c1", kind: "Commit", label: "c1" });
    upsertNode(db, { id: "commit:r:c2", kind: "Commit", label: "c2" });
    upsertNode(db, { id: "file:r:a.ts", kind: "File", label: "a.ts" });
    for (const kind of ["MODIFIES", "TOUCHES"] as const) {
      upsertEdge(db, {
        id: `${kind}:c1:a.ts`,
        kind,
        source: "commit:r:c1",
        target: "file:r:a.ts",
        valid_from: "2025-01-01T00:00:00.000Z",
        valid_to: "2025-02-01T00:00:00.000Z",
        source_system: "git",
      });
      upsertEdge(db, {
        id: `${kind}:c2:a.ts`,
        kind,
        source: "commit:r:c2",
        target: "file:r:a.ts",
        valid_from: "2025-02-01T00:00:00.000Z",
        valid_to: null,
        source_system: "git",
      });
    }
    upsertEdge(db, {
      id: "TOUCHES:pipeline",
      kind: "TOUCHES",
      source: "change:other",
      target: "file:r:a.ts",
      valid_from: "2025-01-01T00:00:00.000Z",
      source_system: "pipeline",
    });
    const temporal = runGraphQuery(db, {
      op: "time_travel_modifies",
      at: "2025-03-01T00:00:00.000Z",
      repoId: "r",
    });
    expect(temporal.edges).toHaveLength(1);
    expect(temporal.edges[0]?.id).toBe("MODIFIES:c2:a.ts");
    db.raw.close();
  });

  it("closes a git TOUCHES edge when the file is touched again", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-temporal-"));
    const db = openGraphLearnMemory();
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
    try {
      git("init");
      git("config", "user.name", "Graph Test");
      git("config", "user.email", "graph@example.test");
      git("config", "commit.gpgsign", "false");
      writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
      git("add", "a.ts");
      git(
        "-c",
        "user.name=Graph Test",
        "-c",
        "user.email=graph@example.test",
        "commit",
        "-m",
        "first",
        "--date=2025-01-01T00:00:00Z",
      );
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      git("add", "a.ts");
      git(
        "-c",
        "user.name=Graph Test",
        "-c",
        "user.email=graph@example.test",
        "commit",
        "-m",
        "second",
        "--date=2025-02-01T00:00:00Z",
      );

      backfillGitTemporal(db, {
        repoPath: dir,
        repoId: "temporal",
        since: "2024-01-01",
      });
      const touches = db.raw
        .prepare(
          "SELECT valid_from, valid_to FROM gl_edges WHERE kind = 'TOUCHES' ORDER BY valid_from",
        )
        .all() as Array<{ valid_from: string; valid_to: string | null }>;
      expect(touches).toHaveLength(2);
      expect(touches[0]?.valid_to).toBe(touches[1]?.valid_from);
      expect(touches[1]?.valid_to).toBeNull();
    } finally {
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the complete legacy kind maps", () => {
    const db = openGraphLearnMemory();
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO gl_nodes (id, kind, label, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run("service:legacy", "service", "Legacy", now);
    db.raw
      .prepare(
        "INSERT INTO gl_edges (id, kind, source, target, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("reads:legacy", "reads", "service:legacy", "field:x", now);
    expect(listNodesByKind(db, "Service")).toHaveLength(1);
    expect(edgesFrom(db, "service:legacy", ["READS_FIELD"])).toHaveLength(1);
    db.raw.close();
  });

  it("does not export dangling GNN edges", () => {
    const db = openGraphLearnMemory();
    labelPrOutcome(db, {
      prId: "gnn",
      changeId: "change",
      consumerId: "consumer",
      outcome: "merged",
      planId: "excluded-plan",
    });
    const exported = exportGnnFeatures(db);
    const ids = new Set(exported.nodes.map((node) => node.id));
    expect(exported.edges.every((edge) => ids.has(edge.source))).toBe(true);
    expect(exported.edges.every((edge) => ids.has(edge.target))).toBe(true);
    expect(
      exported.edges.some((edge) => edge.target === "plan:excluded-plan"),
    ).toBe(false);
    db.raw.close();
  });

  it("reports AST fallback honestly and rejects ignored external commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-lsp-"));
    const db = openGraphLearnMemory();
    try {
      writeFileSync(join(dir, "a.ts"), "export function a() {}\n");
      const fallback = ingestLspSymbols(db, {
        repoPath: dir,
        repoId: "lsp",
      });
      expect(fallback.mode).toBe("ast-fallback");
      expect(fallback.backends).toEqual([]);
      expect(
        db.raw
          .prepare("SELECT COUNT(*) AS count FROM gl_edges WHERE kind = 'DECLARES'")
          .get(),
      ).toEqual({ count: 0 });

      expect(() =>
        ingestLspSymbols(db, {
          repoPath: dir,
          repoId: "lsp",
          files: [{ path: "a.ts", text: "function a() {}" }],
          backends: [
            {
              language: "typescript",
              command: "typescript-language-server",
              documentSymbols: () => [],
            },
          ],
        }),
      ).toThrow(/not implemented/);
    } finally {
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates undirected BFS edges", () => {
    const db = openGraphLearnMemory();
    upsertNode(db, { id: "a", kind: "Symbol", label: "a" });
    upsertNode(db, { id: "b", kind: "Symbol", label: "b" });
    upsertEdge(db, {
      id: "CALLS:a:b",
      kind: "CALLS",
      source: "a",
      target: "b",
    });
    expect(blastRadius(db, "a", 2).edges).toHaveLength(1);
    db.raw.close();
  });

  it("recomputes wrong-sized embeddings and rejects mismatched cosine vectors", () => {
    const db = openGraphLearnMemory();
    upsertNode(db, {
      id: "provider:embedding",
      kind: "Provider",
      label: "embedding",
      props: { embedding: [1], embedding_dim: 1 },
    });
    expect(embedGraphNodes(db, { dim: 4 }).nodes).toBe(1);
    expect(getNodeEmbedding(db, "provider:embedding")).toHaveLength(4);
    expect(() => cosineSimilarity([1], [1, 100])).toThrow(/dimension mismatch/);
    db.raw.close();
  });

  it("clamps equal-arm p-values to the probability range", () => {
    const db = openGraphLearnMemory();
    for (const arm of ["control", "treatment"] as const) {
      for (let i = 0; i < 5; i++) {
        labelPrOutcome(db, {
          prId: `${arm}-${i}`,
          changeId: "equal",
          consumerId: arm,
          outcome: i < 2 ? "merged" : "closed",
          experiment: arm,
        });
      }
    }
    const report = measureAbLift(db);
    expect(report.pValue).toBe(1);
    expect(report.pValue).toBeLessThanOrEqual(1);
    db.raw.close();
  });
});
