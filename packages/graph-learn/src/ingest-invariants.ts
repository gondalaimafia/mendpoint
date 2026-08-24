/**
 * Ingest explicit `@invariant` / `invariant:` annotations as Symbol
 * PRESERVES_INVARIANT Invariant edges (spec §11 / Change Graph writer).
 *
 * Until this module existed, PRESERVES_INVARIANT was a declared edge kind with a
 * reader (`invariants_for_symbol`) and no producer, so that query had to fail
 * closed. This writer is the live path: annotations adjacent to a function or
 * class become Invariant nodes plus PRESERVES_INVARIANT edges. Unannotated
 * symbols are left alone; a missing annotation is never guessed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { listCodeFiles } from "./ast-ingest.js";
import { upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

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

export type InvariantAnnotation = Readonly<{
  statement: string;
  line: number;
  symbol: string;
}>;

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

export function extractInvariantAnnotations(text: string): InvariantAnnotation[] {
  const lines = text.split(/\r?\n/);
  const symbols: Array<{ name: string; line: number }> = [];
  const pending: Array<{ statement: string; line: number }> = [];
  const out: InvariantAnnotation[] = [];

  const attach = (statement: string, line: number, symbol: string) => {
    out.push({ statement, line, symbol });
  };

  const nearestSymbol = (line: number): string | null => {
    let best: { name: string; line: number } | null = null;
    for (const symbol of symbols) {
      const distance = Math.abs(symbol.line - line);
      if (distance > ANNOTATION_WINDOW) continue;
      if (!best || distance < Math.abs(best.line - line) || (distance === Math.abs(best.line - line) && symbol.line < best.line)) {
        best = symbol;
      }
    }
    return best?.name ?? null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const number = i + 1;
    JSDOC_INVARIANT.lastIndex = 0;
    let jsdoc: RegExpExecArray | null;
    while ((jsdoc = JSDOC_INVARIANT.exec(line))) {
      const statement = statementOf(jsdoc[1] ?? "");
      if (statement) pending.push({ statement, line: number });
    }
    const annotated = line.match(ANNOTATION_LINE);
    if (annotated) {
      const statement = statementOf(annotated[1] ?? "");
      if (statement) pending.push({ statement, line: number });
    }
    const symbol = symbolOnLine(line);
    if (symbol) {
      symbols.push({ name: symbol, line: number });
      const still: Array<{ statement: string; line: number }> = [];
      for (const item of pending) {
        if (number - item.line <= ANNOTATION_WINDOW) attach(item.statement, item.line, symbol);
        else still.push(item);
      }
      pending.length = 0;
      pending.push(...still);
    }
  }

  for (const item of pending) {
    const symbol = nearestSymbol(item.line);
    if (symbol) attach(item.statement, item.line, symbol);
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
      upsertNode(db, {
        id: sid,
        kind: "Symbol",
        label: annotation.symbol,
        repo_id: repoId,
        props: {
          qualified_name: `${path}::${annotation.symbol}`,
          source: "invariant-ingest",
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
        source_system: "ast",
        confidence: 0.9,
        props: { path, line: annotation.line },
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
