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
      expect.objectContaining({ statement: "amount is non-negative", symbol: "charge" }),
    ]);
  });

  it("advertises invariants_for_symbol now that a producer exists", () => {
    expect(GRAPH_RAG_TOOLS).toContain("invariants_for_symbol");
    expect(GRAPH_RAG_TOOLS).not.toContain("migration_ready_units");
    const pick = pickGraphQuery("what invariants does symbol charge preserve");
    expect(pick.query.op).toBe("invariants_for_symbol");
  });
});
