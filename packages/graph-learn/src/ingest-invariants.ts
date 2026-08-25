/**
 * Ingest explicit `@invariant` / `invariant:` annotations as Symbol
 * PRESERVES_INVARIANT Invariant edges (spec §11 / Change Graph writer).
 *
 * Until this module existed, PRESERVES_INVARIANT was a declared edge kind with a
 * reader (`invariants_for_symbol`) and no producer, so that query had to fail
 * closed. This writer is the live path: `@invariant` / `invariant:` comments
 * become Invariant nodes plus PRESERVES_INVARIANT edges. Unannotated symbols are
 * left alone; an annotation that matches no symbol in range is dropped, never
 * attached to a guessed one.
 *
 * The detection is a line-by-line comment scan (regex), not an AST walk, so the
 * edge records honest provenance: `source_system: "human"` (an author assertion,
 * not a machine-derived or verified fact) and a graded `confidence_basis` for how
 * the comment was bound to a symbol — `static_analysis_high` when the comment
 * leads a declaration, `static_analysis_low` for a heuristic bind to the nearest
 * symbol. Nothing here checks that the claimed invariant actually holds.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { listCodeFiles } from "./ast-ingest.js";
import type { SoftwareGraphConfidenceBasis } from "./software-intelligence.js";
import { getNode, upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

const MAX_INVARIANTS = 500;
const MAX_STATEMENT = 400;
const ANNOTATION_WINDOW = 8;
const SYMBOL_LINE =
  /(?:export\s+)?(?:async\s+)?(?:function|class|def)\s+([A-Za-z_][\w]*)/;
const METHOD_LINE =
  /^\s+(?:async\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*[:{]/;
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return"]);
const ANNOTATION_LINE =
  /^\s*(?:\/\/|#|--|\/\*)\s*@?invariant[:\s]+(.+?)(?:\*\/)?\s*$/i;
const JSDOC_INVARIANT = /@invariant\s+([^\n*]+)/gi;

/**
 * How the annotation was bound to its symbol, in the graded static-analysis
 * vocabulary (`SoftwareGraphConfidenceBasis`, introduced by the #241 fix for the
 * prior source-mislabelling defect):
 *  - `static_analysis_high` — the annotation directly leads a declaration, with
 *    only blank or comment lines between them (the reliable leading-comment /
 *    JSDoc style).
 *  - `static_analysis_low`  — a heuristic bind: the annotation sits inside or
 *    after a body (a closing brace or statement separates it from the next
 *    declaration), or trails a declaration with none following, so it is attached
 *    to the nearest symbol within the window as a guess.
 * Neither basis verifies the invariant itself: nothing parses the statement or
 * checks that it holds. The basis records only how the comment text was attached
 * to a symbol, never that the claimed property is true.
 */
export type InvariantBindingBasis = Extract<
  SoftwareGraphConfidenceBasis,
  "static_analysis_high" | "static_analysis_low"
>;

export type InvariantAnnotation = Readonly<{
  statement: string;
  line: number;
  symbol: string;
  basis: InvariantBindingBasis;
}>;

/**
 * Ingest counters. NOTE: both live callers (`ingestLspSymbols`, both its
 * heuristic and AST-fallback paths in lsp-ingest.ts) discard this value, so it is
 * consumed only by tests today. `skipped` counts file-level path rejects
 * (traversal escapes, absolute paths, unreadable/unparseable text) — not
 * per-annotation drops. Too-short statements (`statementOf`) and annotations that
 * bind to no symbol are dropped silently and deliberately left uncounted: no
 * caller reads such a counter, so adding one would be a field nobody reads.
 * Restore per-drop counters here the moment a caller starts acting on them.
 */
export type InvariantIngestResult = Readonly<{
  files: number;
  invariants: number;
  skipped: number;
}>;

function statementOf(raw: string): string | null {
  const statement = raw.replace(/\s+/g, " ").trim().slice(0, MAX_STATEMENT);
  if (!statement || statement.length < 3) return null;
  if (statement.includes("\0")) return null;
  return statement;
}

function symbolOnLine(line: string): string | null {
  const declared = line.match(SYMBOL_LINE)?.[1];
  if (declared) return declared;
  const method = line.match(METHOD_LINE)?.[1];
  if (method && !CONTROL.has(method)) return method;
  return null;
}

// A line carries code when it is neither blank nor a pure comment line. It is the
// boundary that separates a *leading* annotation (only blank or comment lines
// between it and the declaration it documents) from an annotation that lives
// inside or after a body, where a closing brace or statement interposes.
const COMMENT_OR_BLANK = /^\s*(?:\/\/|#|--|\/\*|\*|$)/;

function isCodeLine(line: string): boolean {
  return !COMMENT_OR_BLANK.test(line);
}

type SymbolSite = { name: string; line: number };

/**
 * Bind one annotation to a symbol, distinguishing the reliable leading-comment
 * case from a heuristic guess so the two are never emitted as identical edges.
 *
 * A trailing annotation must not be drained onto the *next* declaration below it:
 * an invariant written inside `charge`'s body would otherwise attach to a
 * following `refund`. So a following declaration wins only when nothing but blank
 * or comment lines sits between it and the annotation (high basis). Otherwise the
 * annotation is inside/after a body or trailing, and binds to the nearest symbol
 * within the window as an explicit low-basis guess, tie-broken toward the
 * enclosing symbol above. An annotation with no symbol in range is dropped.
 */
function bindAnnotation(
  line: number,
  symbols: readonly SymbolSite[],
  codeLine: readonly boolean[],
): { name: string; basis: InvariantBindingBasis } | null {
  let leading: SymbolSite | null = null;
  for (const symbol of symbols) {
    if (symbol.line <= line) continue;
    if (symbol.line - line > ANNOTATION_WINDOW) continue;
    if (!leading || symbol.line < leading.line) leading = symbol;
  }
  if (leading) {
    let interposed = false;
    for (let l = line + 1; l < leading.line; l++) {
      if (codeLine[l]) {
        interposed = true;
        break;
      }
    }
    if (!interposed) return { name: leading.name, basis: "static_analysis_high" };
  }

  let nearest: SymbolSite | null = null;
  for (const symbol of symbols) {
    const distance = Math.abs(symbol.line - line);
    if (distance > ANNOTATION_WINDOW) continue;
    if (
      !nearest ||
      distance < Math.abs(nearest.line - line) ||
      (distance === Math.abs(nearest.line - line) && symbol.line < nearest.line)
    ) {
      nearest = symbol;
    }
  }
  return nearest ? { name: nearest.name, basis: "static_analysis_low" } : null;
}

export function extractInvariantAnnotations(text: string): InvariantAnnotation[] {
  const lines = text.split(/\r?\n/);
  const symbols: SymbolSite[] = [];
  const annotations: Array<{ statement: string; line: number }> = [];
  // 1-based; index 0 is unused so a line number indexes directly.
  const codeLine: boolean[] = new Array(lines.length + 1).fill(false);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const number = i + 1;
    JSDOC_INVARIANT.lastIndex = 0;
    let jsdoc: RegExpExecArray | null;
    while ((jsdoc = JSDOC_INVARIANT.exec(line))) {
      const statement = statementOf(jsdoc[1] ?? "");
      if (statement) annotations.push({ statement, line: number });
    }
    const annotated = line.match(ANNOTATION_LINE);
    if (annotated) {
      const statement = statementOf(annotated[1] ?? "");
      if (statement) annotations.push({ statement, line: number });
    }
    const symbol = symbolOnLine(line);
    if (symbol) symbols.push({ name: symbol, line: number });
    codeLine[number] = isCodeLine(line);
  }

  const out: InvariantAnnotation[] = [];
  for (const annotation of annotations) {
    const bound = bindAnnotation(annotation.line, symbols, codeLine);
    if (bound) {
      out.push({
        statement: annotation.statement,
        line: annotation.line,
        symbol: bound.name,
        basis: bound.basis,
      });
    }
  }

  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.symbol}\u0000${item.statement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_INVARIANTS);
}

function invariantId(repoId: string, statement: string): string {
  const digest = createHash("sha256").update(`${repoId}\0${statement}`, "utf8").digest("hex").slice(0, 24);
  return `invariant:${repoId}:${digest}`;
}

function symbolId(repoId: string, path: string, name: string): string {
  return `symbol:${repoId}:${path}:${name}`;
}

export function ingestInvariantAnnotations(
  db: GraphLearnDb,
  opts: {
    repoPath: string;
    repoId?: string;
    files?: Array<{ path: string; text: string }>;
  },
): InvariantIngestResult {
  const repoId =
    opts.repoId ??
    opts.repoPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
    "repo";
  const files =
    opts.files ??
    (existsSync(opts.repoPath)
      ? listCodeFiles(opts.repoPath, 200).map((abs) => ({
          path: relative(opts.repoPath, abs).replace(/\\/g, "/"),
          text: readFileSync(abs, "utf8"),
        }))
      : []);

  let invariants = 0;
  let skipped = 0;
  for (const file of files) {
    const path = file.path.replace(/\\/g, "/");
    if (!path || path.includes("..") || path.startsWith("/")) {
      skipped++;
      continue;
    }
    let annotations: InvariantAnnotation[];
    try {
      annotations = extractInvariantAnnotations(file.text);
    } catch {
      skipped++;
      continue;
    }
    for (const annotation of annotations) {
      const sid = symbolId(repoId, path, annotation.symbol);
      const iid = invariantId(repoId, annotation.statement);
      // A Symbol upserted by the LSP/AST pass carries symbol_kind, line and its
      // own `source`. upsertNode replaces props_json wholesale and both ingests
      // run after the symbol pass, so spread the existing props last to preserve
      // them; only backfill fields a bare annotation-only symbol would lack.
      const existing = getNode(db, sid);
      upsertNode(db, {
        id: sid,
        kind: "Symbol",
        label: existing?.label ?? annotation.symbol,
        repo_id: repoId,
        props: {
          qualified_name: `${path}::${annotation.symbol}`,
          source: "invariant-ingest",
          ...(existing?.props ?? {}),
        },
      });
      upsertNode(db, {
        id: iid,
        kind: "Invariant",
        label: annotation.statement.slice(0, 120),
        repo_id: repoId,
        props: {
          statement: annotation.statement,
          source: "annotation",
        },
      });
      upsertEdge(db, {
        id: `PRESERVES_INVARIANT:${sid}:${iid}`.slice(0, 240),
        kind: "PRESERVES_INVARIANT",
        source: sid,
        target: iid,
        // The invariant is an unverified assertion in a source comment: a human
        // wrote it, nothing parses or checks that it holds. `source_system` is
        // therefore `human` (the provenance vocabulary in schema.ts), not `ast` —
        // this is a line-by-line comment scan, not an AST walk. The graded
        // `confidence_basis` records only how the comment was bound to the symbol
        // (`static_analysis_high` for a leading comment, `static_analysis_low` for
        // a heuristic guess), never that the claimed property is true.
        source_system: "human",
        confidence: annotation.basis === "static_analysis_high" ? 0.9 : 0.5,
        props: {
          path,
          line: annotation.line,
          source: "annotation",
          confidence_basis: annotation.basis,
          verified: false,
        },
      });
      invariants++;
    }
  }

  return Object.freeze({
    files: files.length,
    invariants,
    skipped,
  });
}
