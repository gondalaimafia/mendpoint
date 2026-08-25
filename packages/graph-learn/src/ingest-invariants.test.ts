import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractInvariantAnnotations,
  ingestInvariantAnnotations,
} from "./ingest-invariants.js";
import { ingestLspSymbols } from "./lsp-ingest.js";
import { GRAPH_RAG_TOOLS, runGraphQuery } from "./query.js";
import { pickGraphQuery } from "./query-pick.js";
import {
  edgesFrom,
  getNode,
  listNodesByKind,
  openGraphLearnMemory,
  type GraphLearnDb,
} from "./store.js";

const opened: GraphLearnDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.raw.close();
});

describe("extractInvariantAnnotations", () => {
  it("binds JSDoc and line annotations to the adjacent symbol and skips guesses", () => {
    const extracted = extractInvariantAnnotations(`
/** @invariant amount is non-negative */
export function charge(amount: number) { return amount; }

// invariant: id is opaque
export class Ledger {}

export function undocumented() { return 1; }
`);
    expect(extracted.map((item) => `${item.symbol}:${item.statement}`).sort()).toEqual([
      "Ledger:id is opaque",
      "charge:amount is non-negative",
    ]);
  });

  it("binds an invariant inside a body to the enclosing function, not the next one", () => {
    // The comment documents `charge`; a closing brace separates it from `refund`,
    // so it must not be drained onto `refund` (the pre-fix mis-attribution).
    const extracted = extractInvariantAnnotations(
      "function charge() {\n  // invariant: amount >= 0\n}\nfunction refund() {}\n",
    );
    expect(extracted).toEqual([
      { symbol: "charge", statement: "amount >= 0", line: 2, basis: "static_analysis_low" },
    ]);
  });

  it("grades a leading comment high and a heuristic bind low", () => {
    const leading = extractInvariantAnnotations(
      "/** @invariant amount is non-negative */\nexport function charge() {}\n",
    );
    expect(leading[0]?.basis).toBe("static_analysis_high");

    const interior = extractInvariantAnnotations(
      "function charge() {\n  // invariant: amount >= 0\n}\nfunction refund() {}\n",
    );
    expect(interior[0]?.basis).toBe("static_analysis_low");
  });
});

describe("ingestInvariantAnnotations", () => {
  it("writes Symbol PRESERVES_INVARIANT Invariant from annotations", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const result = ingestInvariantAnnotations(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{
        path: "src/charge.ts",
        text: "/** @invariant amount is non-negative */\nexport function charge() { return 1; }\n",
      }],
    });
    expect(result.invariants).toBe(1);
    const symbol = "symbol:tenant-x:src/charge.ts:charge";
    const edges = edgesFrom(db, symbol, ["PRESERVES_INVARIANT"]);
    expect(edges).toHaveLength(1);
    expect(listNodesByKind(db, "Invariant")).toHaveLength(1);
    expect(listNodesByKind(db, "Invariant")[0]?.props?.statement).toBe("amount is non-negative");
  });

  it("skips unannotated files rather than inventing edges", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const result = ingestInvariantAnnotations(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{ path: "src/plain.ts", text: "export function ping() { return 1; }\n" }],
    });
    expect(result.invariants).toBe(0);
    expect(listNodesByKind(db, "Invariant")).toEqual([]);
  });

  it("records human provenance and binding basis on the edge, not ast", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    ingestInvariantAnnotations(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{
        path: "src/charge.ts",
        text: "/** @invariant amount is non-negative */\nexport function charge() { return 1; }\n",
      }],
    });
    const [edge] = edgesFrom(db, "symbol:tenant-x:src/charge.ts:charge", ["PRESERVES_INVARIANT"]);
    // `ast` was a misattribution: this is a comment scan, not an AST walk, and the
    // invariant is an unverified author assertion.
    expect(edge?.source_system).toBe("human");
    expect(edge?.props?.confidence_basis).toBe("static_analysis_high");
    expect(edge?.props?.verified).toBe(false);
    expect(edge?.props?.source).toBe("annotation");
  });

  it("runs on the lsp ingest live path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-invariant-"));
    try {
      writeFileSync(
        join(dir, "charge.ts"),
        "/** @invariant amount is non-negative */\nexport function charge() { return 1; }\n",
      );
      const db = openGraphLearnMemory();
      opened.push(db);
      ingestLspSymbols(db, { repoPath: dir, repoId: "tenant-x" });
      const symbol = "symbol:tenant-x:charge.ts:charge";
      expect(edgesFrom(db, symbol, ["PRESERVES_INVARIANT"])).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clobber Symbol props written by an earlier ingest pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-invariant-"));
    try {
      writeFileSync(
        join(dir, "charge.ts"),
        "/** @invariant amount is non-negative */\nexport function charge() { return 1; }\n",
      );
      const db = openGraphLearnMemory();
      opened.push(db);
      // The AST/LSP pass writes symbol_kind and file; the invariant ingest runs
      // after it and must merge, not replace, the Symbol's props.
      ingestLspSymbols(db, { repoPath: dir, repoId: "tenant-x" });
      const symbol = getNode(db, "symbol:tenant-x:charge.ts:charge");
      expect(symbol?.props?.symbol_kind).toBeDefined();
      expect(symbol?.props?.qualified_name).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("invariants_for_symbol with a PRESERVES_INVARIANT producer", () => {
  it("still fails closed when the relation is empty", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    const r = runGraphQuery(
      db,
      { op: "invariants_for_symbol", qualifiedName: "com.acme.Charge" },
      { tenantId: "tenant-x" },
    );
    expect(r.coverage.basis).toBe("target_absent");
    expect(r.coverage.reason).toContain("PRESERVES_INVARIANT is not populated");
  });

  it("returns annotated invariants once the producer has written the relation", () => {
    const db = openGraphLearnMemory();
    opened.push(db);
    ingestInvariantAnnotations(db, {
      repoPath: "/unused",
      repoId: "tenant-x",
      files: [{
        path: "src/charge.ts",
        text: "/** @invariant amount is non-negative */\nexport function charge() { return 1; }\n",
      }],
    });
    const r = runGraphQuery(
      db,
      { op: "invariants_for_symbol", qualifiedName: "charge" },
      { tenantId: "tenant-x" },
    );
    expect(r.coverage.basis).toBe("complete");
    expect(r.summary).toContain("1 invariant");
    expect(r.rows).toEqual([
      expect.objectContaining({
        statement: "amount is non-negative",
        symbol: "charge",
        source: "annotation",
        confidenceBasis: "static_analysis_high",
        verified: false,
      }),
    ]);
  });

  it("returns target_absent for an existing symbol with no annotation", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-invariant-"));
    try {
      // `charge` is annotated so the relation is populated; `refund` exists in the
      // same file (created by the AST/LSP pass) but has no annotation. An
      // existing-but-unannotated symbol must not read as "preserves nothing".
      writeFileSync(
        join(dir, "charge.ts"),
        "/** @invariant amount is non-negative */\nexport function charge() { return 1; }\nexport function refund() { return 1; }\n",
      );
      const db = openGraphLearnMemory();
      opened.push(db);
      ingestLspSymbols(db, { repoPath: dir, repoId: "tenant-x" });
      expect(getNode(db, "symbol:tenant-x:charge.ts:refund")).toBeDefined();
      const r = runGraphQuery(
        db,
        { op: "invariants_for_symbol", qualifiedName: "refund" },
        { tenantId: "tenant-x" },
      );
      expect(r.coverage.basis).toBe("target_absent");
      expect(r.coverage.reason).toContain("no PRESERVES_INVARIANT annotation");
      expect(r.rows).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advertises invariants_for_symbol now that a producer exists", () => {
    expect(GRAPH_RAG_TOOLS).toContain("invariants_for_symbol");
    // migration_ready_units is also advertised on main (ingestManifestDependencies
    // writes DEPENDS_ON); both producers coexist after this change.
    expect(GRAPH_RAG_TOOLS).toContain("migration_ready_units");
    const pick = pickGraphQuery("what invariants does symbol charge preserve");
    expect(pick.query.op).toBe("invariants_for_symbol");
  });
});
