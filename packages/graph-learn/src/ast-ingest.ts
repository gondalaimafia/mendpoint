/**
 * AST / heuristic symbol + CALLS ingest (TS/JS/Python/Java).
 * tree-sitter-ready path: regex extractors today; swap body without changing API.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

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
  let current: string | null = null;

  if (lang === "python") {
    for (const m of source.matchAll(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/gm)) {
      symbols.push(m[1]!);
      current = m[1]!;
    }
    for (const m of source.matchAll(/^\s*class\s+([A-Za-z_][\w]*)/gm)) {
      symbols.push(m[1]!);
    }
    for (const m of source.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const name = m[1]!;
      if (["if", "for", "while", "def", "class", "return", "print"].includes(name))
        continue;
      if (current) calls.push({ from: current, to: name });
    }
  } else if (lang === "java") {
    for (const m of source.matchAll(
      /(?:public|private|protected|static|\s)+[\w<>,\[\]]+\s+([A-Za-z_][\w]*)\s*\(/g,
    )) {
      symbols.push(m[1]!);
      current = m[1]!;
    }
    for (const m of source.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
      const name = m[1]!;
      if (["if", "for", "while", "switch", "catch", "new"].includes(name)) continue;
      if (current) calls.push({ from: current, to: name });
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
      for (const m of body.matchAll(/\b([A-Za-z_][\w]*)\s*\(/g)) {
        const callee = m[1]!;
        if (
          [
            "if",
            "for",
            "while",
            "switch",
            "catch",
            "function",
            "return",
            "typeof",
            "new",
            "await",
          ].includes(callee)
        )
          continue;
        calls.push({ from: name, to: callee });
      }
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
    void current;
  }

  return {
    symbols: [...new Set(symbols)],
    calls: calls.slice(0, 500),
  };
}

/** Export walk for incremental reingest */
export function listCodeFiles(repoPath: string, maxFiles = 400): string[] {
  return walk(repoPath).slice(0, maxFiles);
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
  },
): { symbols: number; calls: number; language: string } {
  const rel =
    opts.relPath ?? relative(opts.repoPath, opts.absPath).replace(/\\/g, "/");
  const lang = langOf(opts.absPath);
  let source = "";
  try {
    source = readFileSync(opts.absPath, "utf8").slice(0, 200_000);
  } catch {
    return { symbols: 0, calls: 0, language: lang };
  }
  const fileId = `file:${opts.repoId}:${rel}`;
  upsertNode(db, {
    id: fileId,
    kind: "File",
    label: rel,
    repo_id: opts.repoId,
    props: { path: rel, language: lang, content_hash: undefined },
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
    const toId = `symbol:${opts.repoId}:${c.to}`;
    upsertNode(db, {
      id: toId,
      kind: "Symbol",
      label: c.to,
      repo_id: opts.repoId,
      props: { qualified_name: c.to, unresolved: true },
    });
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
  return { symbols, calls, language: lang };
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
    opts.onlyFiles ?? walk(opts.repoPath).slice(0, opts.maxFiles ?? 400);
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

  return {
    repoId,
    files: files.length,
    symbols,
    calls,
    languages,
  };
}
