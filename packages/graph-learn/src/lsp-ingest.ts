/**
 * LSP-shaped ingester using in-process document symbol backends.
 * External language-server processes are rejected until a protocol client exists.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";
import {
  extractSymbolsFromSource,
  ingestAstRepo,
  reconcileAstCallTargets,
} from "./ast-ingest.js";
import { ingestManifestDependencies } from "./ingest-manifest-dependencies.js";
import { ingestInvariantAnnotations } from "./ingest-invariants.js";

export type LspSymbol = {
  name: string;
  kind: string;
  file: string;
  line: number;
  containerName?: string;
};

export type LspBackend = {
  /** language id */
  language: string;
  /** Reserved for a future protocol client; currently rejected explicitly. */
  command?: string;
  /** Extract document symbols from text */
  documentSymbols: (file: string, text: string) => LspSymbol[];
};

export function heuristicTsBackend(): LspBackend {
  return {
    language: "typescript",
    documentSymbols(file, text) {
      const out: LspSymbol[] = [];
      let line = 0;
      for (const row of text.split(/\r?\n/)) {
        line++;
        const fn = row.match(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][\w]*)/);
        if (fn) out.push({ name: fn[1]!, kind: "Function", file, line });
        const cls = row.match(/(?:export\s+)?class\s+([A-Za-z_][\w]*)/);
        if (cls) out.push({ name: cls[1]!, kind: "Class", file, line });
        const meth = row.match(/^\s+(?:async\s+)?([A-Za-z_][\w]*)\s*\([^)]*\)\s*[:{]/);
        if (meth && !["if", "for", "while", "switch", "catch"].includes(meth[1]!)) {
          out.push({ name: meth[1]!, kind: "Method", file, line });
        }
      }
      return out;
    },
  };
}

export function heuristicPythonBackend(): LspBackend {
  return {
    language: "python",
    documentSymbols(file, text) {
      const out: LspSymbol[] = [];
      let line = 0;
      for (const row of text.split(/\r?\n/)) {
        line++;
        const fn = row.match(/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/);
        if (fn) out.push({ name: fn[1]!, kind: "Function", file, line });
        const cls = row.match(/^\s*class\s+([A-Za-z_][\w]*)/);
        if (cls) out.push({ name: cls[1]!, kind: "Class", file, line });
      }
      return out;
    },
  };
}

export type LspIngestResult = {
  repoId: string;
  symbols: number;
  backends: string[];
  mode: "heuristic" | "ast-fallback";
};

/**
 * Ingest document symbols via LSP-shaped backends (heuristic default).
 * For full repo walk, delegates file discovery to AST ingest then overlays LSP kinds.
 */
export function ingestLspSymbols(
  db: GraphLearnDb,
  opts: {
    repoPath: string;
    repoId?: string;
    tenantId?: string;
    observedAt?: string;
    files?: Array<{ path: string; text: string }>;
    backends?: LspBackend[];
  },
): LspIngestResult {
  const repoId =
    opts.repoId ??
    opts.repoPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ??
    "repo";
  const backends = opts.backends ?? [
    heuristicTsBackend(),
    heuristicPythonBackend(),
  ];
  if (backends.some((backend) => backend.command)) {
    throw new Error(
      "External LSP commands are not implemented; provide a documentSymbols backend",
    );
  }
  let symbols = 0;

  upsertNode(db, {
    id: `repo:${repoId}`,
    kind: "Repository",
    label: repoId,
    repo_id: repoId,
    props: { source: "lsp-ingest" },
  });

  const files =
    opts.files ??
    (() => {
      // light: use a few known paths if provided via walk from ast
      return [] as Array<{ path: string; text: string }>;
    })();

  if (!files.length && existsSync(opts.repoPath)) {
    // Fall back: AST ingest full repo then return
    const ast = ingestAstRepo(db, {
      repoPath: opts.repoPath,
      repoId,
      maxFiles: 200,
    });
    ingestManifestDependencies(db, {
      repoPath: opts.repoPath,
      repoId,
      tenantId: opts.tenantId,
      observedAt: opts.observedAt,
    });
    ingestInvariantAnnotations(db, { repoPath: opts.repoPath, repoId });
    return {
      repoId,
      symbols: ast.symbols,
      backends: [],
      mode: "ast-fallback",
    };
  }

  for (const f of files) {
    const ext = f.path.split(".").pop()?.toLowerCase() ?? "";
    const lang =
      ext === "py" ? "python" : ext === "java" ? "java" : "typescript";
    const backend =
      backends.find((b) => b.language === lang) ?? backends[0]!;
    const syms = backend.documentSymbols(f.path, f.text);
    const localSymbols = new Set(syms.map((symbol) => symbol.name));
    const fileId = `file:${repoId}:${f.path}`;
    upsertNode(db, {
      id: fileId,
      kind: "File",
      label: f.path,
      repo_id: repoId,
      props: { path: f.path, language: lang },
    });
    for (const s of syms) {
      const sid = `symbol:${repoId}:${f.path}:${s.name}`;
      upsertNode(db, {
        id: sid,
        kind: "Symbol",
        label: s.name,
        repo_id: repoId,
        props: {
          qualified_name: `${f.path}::${s.name}`,
          symbol_kind: s.kind.toLowerCase(),
          line: s.line,
          source: "lsp",
        },
      });
      upsertEdge(db, {
        id: `DECLARES:${sid}`.slice(0, 240),
        kind: "DECLARES",
        source: fileId,
        target: sid,
        source_system: "lsp",
        confidence: 0.9,
      });
      symbols++;
    }
    // also CALLS from extract
    const { calls } = extractSymbolsFromSource(f.text, lang);
    for (const c of calls.slice(0, 100)) {
      const isLocal = localSymbols.has(c.to);
      const target = isLocal
        ? `symbol:${repoId}:${f.path}:${c.to}`
        : `symbol:${repoId}:${c.to}`;
      if (!isLocal) {
        upsertNode(db, {
          id: target,
          kind: "Symbol",
          label: c.to,
          repo_id: repoId,
          props: { qualified_name: c.to, unresolved: true },
        });
      }
      upsertEdge(db, {
        id: `CALLS:lsp:${repoId}:${f.path}:${c.from}:${c.to}`.slice(0, 240),
        kind: "CALLS",
        source: `symbol:${repoId}:${f.path}:${c.from}`,
        target,
        source_system: "lsp",
        confidence: 0.55,
      });
    }
  }
  reconcileAstCallTargets(db, repoId);
  ingestManifestDependencies(db, {
    repoPath: opts.repoPath,
    repoId,
    tenantId: opts.tenantId,
    observedAt: opts.observedAt,
    files: files.map((file) => ({ path: file.path, text: file.text })),
  });
  ingestInvariantAnnotations(db, {
    repoPath: opts.repoPath,
    repoId,
    files: files.map((file) => ({ path: file.path, text: file.text })),
  });

  return {
    repoId,
    symbols,
    backends: backends.map((b) => b.language),
    mode: "heuristic",
  };
}

/** Read a single file through LSP backend for tests */
export function lspSymbolsForFile(
  filePath: string,
  backend?: LspBackend,
): LspSymbol[] {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  const b = backend ?? heuristicTsBackend();
  return b.documentSymbols(filePath, text);
}

export function lspWorkspaceRootHint(repoPath: string): string {
  // package.json or pyproject as workspace root markers
  for (const m of ["package.json", "pyproject.toml", "go.mod", "pom.xml"]) {
    if (existsSync(join(repoPath, m))) return join(repoPath, m);
  }
  return repoPath;
}
