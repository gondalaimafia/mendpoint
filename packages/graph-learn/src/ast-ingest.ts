/**
 * AST / heuristic symbol + CALLS ingest (TS/JS/Python/Java).
 * tree-sitter-ready path: regex extractors today; swap body without changing API.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import {
  upsertEdge,
  upsertNode,
  deleteNode,
  deleteFileSubgraph,
  edgesFrom,
  edgesTo,
  listNodesByKind,
  type GraphLearnDb,
} from "./store.js";

export type AstIngestResult = {
  repoId: string;
  files: number;
  symbols: number;
  calls: number;
  languages: Record<string, number>;
};

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".java",
]);

function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (
      name === "node_modules" ||
      name === ".git" ||
      name === "dist" ||
      name === ".next" ||
      name === "coverage"
    )
      continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (CODE_EXTS.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

function langOf(file: string): string {
  const e = extname(file).toLowerCase();
  if (e === ".py") return "python";
  if (e === ".java") return "java";
  if (e === ".ts" || e === ".tsx") return "typescript";
  return "javascript";
}

/** Extract function/class symbols + naive callee names */
export function extractSymbolsFromSource(
  source: string,
  lang: string,
): { symbols: string[]; calls: Array<{ from: string; to: string }> } {
  const symbols: string[] = [];
  const calls: Array<{ from: string; to: string }> = [];
  const ignoredCalls = new Set([
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "def",
    "class",
    "return",
    "print",
    "function",
    "typeof",
    "new",
    "await",
  ]);
  const addCalls = (from: string, body: string) => {
    for (const m of body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const callee = m[1]!;
      if (!ignoredCalls.has(callee)) calls.push({ from, to: callee });
    }
  };

  if (lang === "python") {
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const row = lines[i]!;
      const m = row.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
      if (!m) continue;
      const indent = m[1]!.replace(/\t/g, "    ").length;
      const name = m[2]!;
      symbols.push(name);
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = lines[j]!;
        if (!candidate.trim()) {
          body.push(candidate);
          continue;
        }
        const candidateIndent =
          candidate.match(/^\s*/)![0].replace(/\t/g, "    ").length;
        if (candidateIndent <= indent) break;
        body.push(candidate);
      }
      addCalls(name, body.join("\n"));
    }
    for (const m of source.matchAll(/^\s*class\s+([A-Za-z_][\w]*)/gm)) {
      symbols.push(m[1]!);
    }
  } else if (lang === "java") {
    const methodRe =
      /(?:public|private|protected|static|final|synchronized|native|abstract|\s)+[\w<>,.?\[\]]+\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*(?:throws[^{]+)?\{/g;
    let method: RegExpExecArray | null;
    while ((method = methodRe.exec(source))) {
      const name = method[1]!;
      symbols.push(name);
      const bodyStart = method.index + method[0].length;
      let depth = 1;
      let i = bodyStart;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
      }
      addCalls(name, source.slice(bodyStart, i - 1));
    }
  } else {
    // TS/JS — per-function body scan so CALLS attach to the defining function
    const fnRe =
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)\s*\([^)]*\)\s*\{/g;
    let fm: RegExpExecArray | null;
    while ((fm = fnRe.exec(source))) {
      const name = fm[1]!;
      symbols.push(name);
      const bodyStart = fm.index + fm[0].length;
      let depth = 1;
      let i = bodyStart;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
      }
      const body = source.slice(bodyStart, i - 1);
      addCalls(name, body);
    }
    for (const m of source.matchAll(
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*(?:async\s*)?\(/g,
    )) {
      symbols.push(m[1]!);
    }
    for (const m of source.matchAll(
      /(?:export\s+)?class\s+([A-Za-z_][\w]*)/g,
    )) {
      symbols.push(m[1]!);
    }
  }

  return {
    symbols: [...new Set(symbols)],
    calls: calls.slice(0, 500),
  };
}

/** Export walk for incremental reingest */
export function listCodeFiles(repoPath: string, maxFiles = 400): string[] {
  return walk(repoPath).sort().slice(0, maxFiles);
}

export function langOfPath(file: string): string {
  return langOf(file);
}

/** Ingest a single relative file (absolute path) into the graph. */
export function ingestAstFile(
  db: GraphLearnDb,
  opts: {
    repoPath: string;
    repoId: string;
    absPath: string;
    relPath?: string;
    /** Content hash to store on File props */
    contentHash?: string;
    /** Wipe prior DEFINES/CALLS for this file before write (default true) */
    replace?: boolean;
  },
): { symbols: number; calls: number; language: string; fileId: string } {
  const rel =
    opts.relPath ?? relative(opts.repoPath, opts.absPath).replace(/\\/g, "/");
  const lang = langOf(opts.absPath);
  let source = "";
  try {
    source = readFileSync(opts.absPath, "utf8").slice(0, 200_000);
  } catch {
    return { symbols: 0, calls: 0, language: lang, fileId: `file:${opts.repoId}:${rel}` };
  }
  const fileId = `file:${opts.repoId}:${rel}`;
  if (opts.replace !== false) {
    deleteFileSubgraph(db, fileId);
  }
  upsertNode(db, {
    id: fileId,
    kind: "File",
    label: rel,
    repo_id: opts.repoId,
    props: {
      path: rel,
      language: lang,
      content_hash: opts.contentHash,
      deleted: false,
    },
  });
  upsertEdge(db, {
    id: `CONTAINS:${opts.repoId}:${rel}`.slice(0, 240),
    kind: "CONTAINS",
    source: `repo:${opts.repoId}`,
    target: fileId,
    source_system: "ast",
    confidence: 1,
  });

  let symbols = 0;
  let calls = 0;
  const extracted = extractSymbolsFromSource(source, lang);
  const localDefinitions = new Set(extracted.symbols);
  for (const sym of extracted.symbols) {
    const sid = `symbol:${opts.repoId}:${rel}:${sym}`;
    upsertNode(db, {
      id: sid,
      kind: "Symbol",
      label: sym,
      repo_id: opts.repoId,
      props: {
        qualified_name: `${rel}::${sym}`,
        symbol_kind: "function",
        file: rel,
      },
    });
    upsertEdge(db, {
      id: `DEFINES:${sid}`.slice(0, 240),
      kind: "DEFINES",
      source: fileId,
      target: sid,
      source_system: "ast",
      confidence: 0.85,
    });
    symbols++;
  }
  for (const c of extracted.calls) {
    const fromId = `symbol:${opts.repoId}:${rel}:${c.from}`;
    const isLocal = localDefinitions.has(c.to);
    const toId = isLocal
      ? `symbol:${opts.repoId}:${rel}:${c.to}`
      : `symbol:${opts.repoId}:${c.to}`;
    if (!isLocal) {
      upsertNode(db, {
        id: toId,
        kind: "Symbol",
        label: c.to,
        repo_id: opts.repoId,
        props: { qualified_name: c.to, unresolved: true },
      });
    }
    upsertEdge(db, {
      id: `CALLS:${fromId}:${c.to}`.slice(0, 240),
      kind: "CALLS",
      source: fromId,
      target: toId,
      source_system: "ast",
      confidence: 0.6,
    });
    calls++;
  }
  return { symbols, calls, language: lang, fileId };
}

/**
 * Repoint unresolved call targets when the repository contains exactly one
 * matching definition. Ambiguous names remain explicit unresolved symbols.
 */
export function reconcileAstCallTargets(
  db: GraphLearnDb,
  repoId: string,
): number {
  const symbols = listNodesByKind(db, "Symbol").filter(
    (n) => n.repo_id === repoId,
  );
  const definitions = new Map<string, string[]>();
  for (const symbol of symbols) {
    if (symbol.props?.unresolved === true) continue;
    const ids = definitions.get(symbol.label) ?? [];
    ids.push(symbol.id);
    definitions.set(symbol.label, ids);
  }

  let reconciled = 0;
  for (const unresolved of symbols.filter(
    (n) => n.props?.unresolved === true,
  )) {
    const matches = definitions.get(unresolved.label) ?? [];
    if (matches.length !== 1) continue;
    const incoming = edgesTo(db, unresolved.id, ["CALLS"]);
    for (const edge of incoming) {
      upsertEdge(db, { ...edge, target: matches[0]! });
      reconciled++;
    }
    if (
      edgesTo(db, unresolved.id).length === 0 &&
      edgesFrom(db, unresolved.id).length === 0
    ) {
      deleteNode(db, unresolved.id);
    }
  }
  return reconciled;
}

export function ingestAstRepo(
  db: GraphLearnDb,
  opts: {
    repoPath: string;
    repoId?: string;
    maxFiles?: number;
    /** If set, only these absolute paths (must be under repoPath) */
    onlyFiles?: string[];
  },
): AstIngestResult {
  if (!existsSync(opts.repoPath)) {
    throw new Error(`ast-ingest: path not found ${opts.repoPath}`);
  }
  const repoId =
    opts.repoId ??
    opts.repoPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
    "repo";
  const files =
    opts.onlyFiles ??
    walk(opts.repoPath).sort().slice(0, opts.maxFiles ?? 400);
  const languages: Record<string, number> = {};
  let symbols = 0;
  let calls = 0;

  upsertNode(db, {
    id: `repo:${repoId}`,
    kind: "Repository",
    label: repoId,
    repo_id: repoId,
    props: { path: opts.repoPath, source: "ast-ingest" },
  });

  for (const abs of files) {
    const rel = relative(opts.repoPath, abs).replace(/\\/g, "/");
    const r = ingestAstFile(db, {
      repoPath: opts.repoPath,
      repoId,
      absPath: abs,
      relPath: rel,
    });
    languages[r.language] = (languages[r.language] ?? 0) + 1;
    symbols += r.symbols;
    calls += r.calls;
  }
  reconcileAstCallTargets(db, repoId);

  return {
    repoId,
    files: files.length,
    symbols,
    calls,
    languages,
  };
}
