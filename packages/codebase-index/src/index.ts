/**
 * Codebase Indexing Layer (pre-computation).
 *
 * Extracts a lightweight, queryable index without retaining full source longer
 * than needed for a given analysis window. MVP uses regex/heuristic front-ends
 * in the spirit of tree-sitter; plug in tree-sitter / LSP / CodeQL later without
 * changing the Impact pipeline contract.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import {
  buildCallGraph,
  buildCallGraphIncremental,
  reverseReachability,
  type CallGraph,
} from "@mendpoint/call-graph";
import {
  extractWithTypescript,
  isTypescriptFile,
  loadTypescriptSync,
} from "./ts-frontend.js";

const CODE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".rb",
  ".kt",
]);

export type IndexedFunction = {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  /** Approximate callee names referenced in body */
  callees: string[];
};

export type ApiUsageRecord = {
  filePath: string;
  line: number;
  kind: "sdk_call" | "http_path" | "import" | "config" | "graphql" | "field_token";
  value: string;
  functionName?: string;
};

export type FileRecord = {
  path: string;
  language: "typescript" | "javascript" | "python" | "go" | "java" | "ruby" | "other";
  isTest: boolean;
  imports: string[];
  contentHash: string;
  lineCount: number;
};

export type CodebaseIndex = {
  repoRoot: string;
  builtAt: string;
  files: FileRecord[];
  functions: IndexedFunction[];
  /** name → functions that call it (legacy name-only reverse edges) */
  callersOf: Record<string, string[]>;
  /** name → callees */
  calleesOf: Record<string, string[]>;
  apiUsages: ApiUsageRecord[];
  packageImports: string[];
  /**
   * Graph-based call graph (primary mechanism for transitive impact).
   * Prefer this over callersOf/calleesOf for expansion.
   */
  callGraph: CallGraph;
};


function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else {
      const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
      if (CODE_EXTS.has(ext)) out.push(p);
    }
  }
  return out;
}

function langOf(file: string): FileRecord["language"] {
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".java") || file.endsWith(".kt")) return "java";
  if (file.endsWith(".rb")) return "ruby";
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs") || file.endsWith(".cjs"))
    return "javascript";
  return "other";
}

function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(rel) ||
    /\.(test|spec)\.[jt]sx?$/.test(rel) ||
    /_test\.py$/.test(rel)
  );
}

function extractImports(text: string, language: FileRecord["language"]): string[] {
  const imports: string[] = [];
  if (language === "python") {
    for (const m of text.matchAll(/^\s*(?:from|import)\s+([a-zA-Z0-9_.]+)/gm)) {
      imports.push(m[1]!);
    }
  } else {
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) imports.push(m[1]!);
    for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(m[1]!);
    for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) imports.push(m[1]!);
  }
  return [...new Set(imports)];
}

type FnSpan = { name: string; start: number; end: number; body: string };

function extractFunctions(text: string, language: FileRecord["language"]): FnSpan[] {
  const lines = text.split(/\r?\n/);
  const fns: FnSpan[] = [];

  if (language === "go" || language === "java") {
    for (let i = 0; i < lines.length; i++) {
      // Go: func Name(  Java: modifiers Type name(
      const goM = lines[i]!.match(
        /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      );
      const javaM = lines[i]!.match(
        /^\s*(?:public|private|protected|static|final|synchronized|\s)*[\w.<>,\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
      );
      const name = goM?.[1] ?? (language === "java" ? javaM?.[1] : undefined);
      if (!name || name === "if" || name === "for" || name === "while" || name === "switch") continue;
      const start = i + 1;
      let depth = 0;
      let started = false;
      let end = start;
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]!) {
          if (ch === "{") {
            depth++;
            started = true;
          } else if (ch === "}") {
            depth--;
          }
        }
        end = j + 1;
        if (started && depth <= 0) break;
      }
      fns.push({
        name,
        start,
        end,
        body: lines.slice(i, end).join("\n"),
      });
    }
    return fns;
  }

  if (language === "ruby") {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      if (!m) continue;
      const name = m[1]!;
      const start = i + 1;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*end\b/.test(lines[j]!) && !/^\s*#/.test(lines[j]!)) {
          // crude: first end at same or lower indent
          const ind = (lines[i]!.match(/^\s*/)?.[0].length ?? 0);
          const jind = lines[j]!.match(/^\s*/)?.[0].length ?? 0;
          if (jind <= ind) {
            end = j + 1;
            break;
          }
        }
      }
      fns.push({
        name,
        start,
        end,
        body: lines.slice(i, end).join("\n"),
      });
    }
    return fns;
  }

  if (language === "python") {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!m) continue;
      const name = m[1]!;
      const start = i + 1;
      let end = lines.length;
      const indent = lines[i]!.match(/^\s*/)?.[0].length ?? 0;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (line.trim() === "") continue;
        const ind = line.match(/^\s*/)?.[0].length ?? 0;
        if (ind <= indent && /^(def|class)\s+/.test(line.trim())) {
          end = j;
          break;
        }
      }
      fns.push({
        name,
        start,
        end,
        body: lines.slice(i, end).join("\n"),
      });
    }
    return fns;
  }

  // TS/JS: export function, function, const x = (...) =>, async function
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let name: string | null = null;
    const m1 = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    const m2 = line.match(
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/,
    );
    if (m1) name = m1[1]!;
    else if (m2) name = m2[1]!;
    if (!name) continue;

    const start = i + 1;
    // crude brace matching from this line
    let depth = 0;
    let started = false;
    let end = start;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      end = j + 1;
      if (started && depth <= 0) break;
      // arrow one-liners without braces
      if (!started && j === i && !line.includes("{") && line.includes("=>")) {
        end = j + 1;
        break;
      }
    }
    fns.push({
      name,
      start,
      end,
      body: lines.slice(i, end).join("\n"),
    });
  }
  return fns;
}

function extractCallees(body: string, selfName: string): string[] {
  const names = new Set<string>();
  for (const m of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const n = m[1]!;
    if (n === selfName || n === "if" || n === "for" || n === "while" || n === "switch") continue;
    if (n === "function" || n === "catch" || n === "return") continue;
    names.add(n);
  }
  // method style client.charges.create
  for (const m of body.matchAll(/\b([A-Za-z_][\w.]*)\s*\(/g)) {
    if (m[1]!.includes(".")) names.add(m[1]!);
  }
  return [...names];
}

function extractApiUsages(
  rel: string,
  text: string,
  fns: FnSpan[],
): ApiUsageRecord[] {
  const lines = text.split(/\r?\n/);
  const out: ApiUsageRecord[] = [];

  const fnAt = (lineNo: number): string | undefined => {
    const hit = fns.find((f) => lineNo >= f.start && lineNo <= f.end);
    return hit?.name;
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    // HTTP path literals (quoted or embedded in template strings / concatenations)
    for (const m of line.matchAll(/['"`](\/v\d+\/[^'"`\s]+)['"`]/g)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "http_path",
        value: m[1]!,
        functionName: fnAt(lineNo),
      });
    }
    for (const m of line.matchAll(/(\/v\d+\/[A-Za-z0-9_{}\/-]+)/g)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "http_path",
        value: m[1]!,
        functionName: fnAt(lineNo),
      });
    }

    // SDK-ish patterns
    for (const m of line.matchAll(
      /\b((?:client|acme|stripe|api|sdk)\.[\w.]+|(?:charges|customers|paymentIntents)\.[\w]+)\b/g,
    )) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "sdk_call",
        value: m[1]!,
        functionName: fnAt(lineNo),
      });
    }
    // config / base URL
    if (/BASE_URL|API_URL|API_KEY|ACME_BASE|STRIPE_/i.test(line)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "config",
        value: line.trim().slice(0, 120),
        functionName: fnAt(lineNo),
      });
    }
    // GraphQL operation hints
    for (const m of line.matchAll(/\b(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      out.push({
        filePath: rel,
        line: lineNo,
        kind: "graphql",
        value: `${m[1]} ${m[2]}`,
        functionName: fnAt(lineNo),
      });
    }
  });

  return out;
}

export function buildIndex(
  repoRoot: string,
  opts?: { callGraph?: CallGraph },
): CodebaseIndex {
  const filesAbs = walk(repoRoot);
  const files: FileRecord[] = [];
  const functions: IndexedFunction[] = [];
  const apiUsages: ApiUsageRecord[] = [];
  const packageImports = new Set<string>();
  // null prototype — avoid 'constructor' / other Object.prototype keys breaking spreads
  const calleesOf: Record<string, string[]> = Object.create(null);
  const callersOf: Record<string, string[]> = Object.create(null);


  const tsApi = loadTypescriptSync();

  for (const abs of filesAbs) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const text = readFileSync(abs, "utf8");
    const language = langOf(rel);
    let imports = extractImports(text, language);
    let fns = extractFunctions(text, language);

    // Phase B: prefer TypeScript compiler API for .ts/.tsx/.js when available
    if (tsApi && isTypescriptFile(rel)) {
      try {
        const richer = extractWithTypescript(repoRoot, abs, tsApi);
        if (richer.imports.length) imports = [...new Set([...imports, ...richer.imports])];
        if (richer.functions.length) {
          // merge compiler functions with heuristic spans
          for (const rf of richer.functions) {
            if (!fns.some((f) => f.name === rf.name && f.start === rf.lineStart)) {
              fns.push({
                name: rf.name,
                start: rf.lineStart,
                end: rf.lineEnd,
                body: "",
              });
            }
          }
        }
        for (const u of richer.usages) {
          apiUsages.push({
            filePath: u.filePath,
            line: u.line,
            kind: u.kind === "field_token" ? "config" : u.kind,
            value: u.value,
            functionName: u.functionName,
          });
        }
        for (const rf of richer.functions) {
          calleesOf[rf.name] = [
            ...new Set([...(calleesOf[rf.name] ?? []), ...rf.callees]),
          ];
          for (const c of rf.callees) {
            callersOf[c] = [...new Set([...(callersOf[c] ?? []), rf.name])];
          }
        }
      } catch {
        /* keep heuristic */
      }
    }

    imports.forEach((i) => packageImports.add(i));

    files.push({
      path: rel,
      language,
      isTest: isTestPath(rel),
      imports,
      contentHash: createHash("sha256").update(text).digest("hex").slice(0, 16),
      lineCount: text.split(/\r?\n/).length,
    });

    for (const fn of fns) {
      const callees =
        fn.body && fn.body.length
          ? extractCallees(fn.body, fn.name)
          : (calleesOf[fn.name] ?? []);
      functions.push({
        name: fn.name,
        filePath: rel,
        lineStart: fn.start,
        lineEnd: fn.end,
        callees,
      });
      calleesOf[fn.name] = [...new Set([...(calleesOf[fn.name] ?? []), ...callees])];
      for (const c of callees) {
        callersOf[c] = [...new Set([...(callersOf[c] ?? []), fn.name])];
      }
    }

    apiUsages.push(...extractApiUsages(rel, text, fns));
  }


  // Lockfile package names (lightweight)
  for (const lock of ["package.json", "requirements.txt", "go.mod", "Gemfile"]) {
    const p = join(repoRoot, lock);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    if (lock === "package.json") {
      try {
        const pkg = JSON.parse(raw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const k of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
          packageImports.add(k);
        }
      } catch {
        /* ignore */
      }
    }
  }

  const callGraph =
    opts?.callGraph ?? buildCallGraph(repoRoot, { algorithm: "hybrid" });

  // Prefer graph-derived reverse edges when available (richer than name-only)
  const nameMaps = deriveNameMaps(callGraph);
  Object.assign(calleesOf, nameMaps.calleesOf);
  Object.assign(callersOf, nameMaps.callersOf);

  return {
    repoRoot,
    builtAt: new Date().toISOString(),
    files,
    functions,
    callersOf,
    calleesOf,
    apiUsages,
    packageImports: [...packageImports],
    callGraph,
  };
}



export function writeIndex(index: CodebaseIndex, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index, null, 2), "utf8");
}

export function loadIndex(path: string): CodebaseIndex {
  return JSON.parse(readFileSync(path, "utf8")) as CodebaseIndex;
}

/**
 * Incremental index update (reset-recompute for the call graph).
 * - Detect changed files via content hashes
 * - Reset-recompute only the affected call-graph region
 * - Refresh non-graph metadata once, reusing the incremental graph
 */
export function buildIndexIncremental(
  repoRoot: string,
  previous?: CodebaseIndex | null,
): CodebaseIndex {
  if (!previous) return buildIndex(repoRoot);

  // Hash probe without building a second full graph
  const filesAbs = walk(repoRoot);
  const currentHashes = new Map<string, string>();
  for (const abs of filesAbs) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const text = readFileSync(abs, "utf8");
    currentHashes.set(rel, createHash("sha256").update(text).digest("hex").slice(0, 16));
  }
  const prevMap = new Map(previous.files.map((f) => [f.path, f.contentHash]));
  const changedFiles = [...currentHashes.entries()]
    .filter(([path, hash]) => prevMap.get(path) !== hash)
    .map(([path]) => path);
  const deleted = previous.files
    .filter((f) => !currentHashes.has(f.path))
    .map((f) => f.path);
  const allChanged = [...new Set([...changedFiles, ...deleted])];

  if (!allChanged.length) return previous;

  const callGraph = buildCallGraphIncremental(repoRoot, previous.callGraph, allChanged, {
    algorithm: "hybrid",
    strategy: "hybrid",
  });

  // Single metadata pass, inject incremental graph (no second full graph build)
  return buildIndex(repoRoot, { callGraph });
}


function deriveNameMaps(callGraph: CallGraph): {
  callersOf: Record<string, string[]>;
  calleesOf: Record<string, string[]>;
} {
  const callersOf: Record<string, string[]> = Object.create(null);
  const calleesOf: Record<string, string[]> = Object.create(null);
  for (const edge of callGraph.edges) {
    const caller = callGraph.nodes[edge.callerId];
    const callee = callGraph.nodes[edge.calleeId];
    if (!caller || !callee) continue;
    calleesOf[caller.name] = [...new Set([...(calleesOf[caller.name] ?? []), callee.name])];
    callersOf[callee.name] = [...new Set([...(callersOf[callee.name] ?? []), caller.name])];
  }
  return { callersOf, calleesOf };
}



export function functionAt(
  index: CodebaseIndex,
  filePath: string,
  line: number,
): IndexedFunction | undefined {
  return index.functions.find(
    (f) => f.filePath === filePath && line >= f.lineStart && line <= f.lineEnd,
  );
}

export function getCallers(index: CodebaseIndex, functionName: string, hops = 1): string[] {
  // Prefer graph-based reverse reachability (qualified, depth-limited)
  if (index.callGraph) {
    const ids = index.callGraph.byName[functionName] ?? [];
    if (ids.length >= 1) {
      const names = new Set<string>();
      for (const id of ids) {
        for (const hit of reverseReachability(index.callGraph, id, { maxDepth: hops })) {
          names.add(hit.node.name);
        }
      }
      if (names.size) return [...names];
    }
  }
  const out = new Set<string>();
  let frontier = [functionName];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const c of index.callersOf[name] ?? []) {
        if (!out.has(c)) {
          out.add(c);
          next.push(c);
        }
      }
    }
    frontier = next;
  }
  return [...out];
}

/** Re-export call-graph types for consumers of the index package. */
export type { CallGraph } from "@mendpoint/call-graph";



export function defaultIndexPath(repoRoot: string): string {
  return join(repoRoot, ".mendpoint", "codebase-index.json");
}

export function packageBoundary(filePath: string): string {
  const parts = filePath.split("/");
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === "apps" && parts[1]) return `apps/${parts[1]}`;
  if (parts[0] === "src") return "src";
  return dirname(filePath) === "." ? basename(filePath) : parts[0] ?? ".";
}
