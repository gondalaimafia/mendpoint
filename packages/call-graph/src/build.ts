/**
 * Practical multi-language call-graph construction.
 *
 * Pipeline:
 * 1. Parsing & symbol extraction (heuristic front-end; tree-sitter-ready)
 * 2. Symbol table + light type hierarchy
 * 3. Direct call resolution
 * 4. Indirect / virtual (CHA / RTA-lite + name match for dynamic langs)
 * 5. Graph assembly with confidence annotations
 *
 * Prefer soundness for impact: missing a usage is worse than a false positive.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { classifyDependencyDirectory } from "@mendpoint/shared";
import type {
  CallEdge,
  CallEdgeConfidence,
  CallGraph,
  CallResolution,
  FunctionNode,
  SkippedDirectory,
  TypeHierarchy,
} from "./types.js";

function emptyRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

/** Languages the call-graph front-end can extract functions for. */
const SUPPORTED_LANGUAGES = ["typescript", "javascript", "python"] as const;

/**
 * Extensions this front-end recognizes as code but has no extractor for. The
 * codebase-index front-end parses Go/Java/Kotlin/Ruby; this one only branches on
 * Python vs TS/JS. Rather than adding these to CODE_EXTS (which would feed them
 * through the TS/JS heuristic and emit garbage nodes), we record the files as
 * unanalyzed so callers can tell "no edges" from "language not in call graph".
 */
const UNSUPPORTED_CODE_EXTS = new Map<string, string>([
  [".go", "go"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".rb", "ruby"],
]);

type WalkResult = {
  files: string[];
  skipped: SkippedDirectory[];
  unsupported: Array<{ path: string; language: string }>;
};

function relPosix(repoRoot: string, p: string): string {
  return relative(repoRoot, p).replace(/\\/g, "/");
}

type Lang = FunctionNode["language"];

type RawFn = {
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  body: string;
  language: Lang;
  enclosingType?: string;
  isTest: boolean;
};

type RawCall = {
  callerKey: string;
  calleeName: string;
  calleeReceiver?: string;
  filePath: string;
  line: number;
  /** fully static if possible */
  directHint?: string;
};

function walk(repoRoot: string, dir: string, acc: WalkResult): WalkResult {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      // Shared prune list + marker decision (see @mendpoint/shared); only the
      // reason label is local so the three walkers cannot drift apart again.
      const decision = classifyDependencyDirectory(name, (marker) =>
        existsSync(join(p, marker)),
      );
      if (decision) {
        acc.skipped.push({
          path: relPosix(repoRoot, p),
          reason: decision.kind === "ignored_name" ? "dependency-directory" : "virtualenv-marker",
        });
        continue;
      }
      walk(repoRoot, p, acc);
    } else {
      const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
      if (CODE_EXTS.has(ext)) {
        acc.files.push(p);
      } else {
        const lang = UNSUPPORTED_CODE_EXTS.get(ext);
        if (lang) acc.unsupported.push({ path: relPosix(repoRoot, p), language: lang });
      }
    }
  }
  return acc;
}

function langOf(file: string): Lang {
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (/\.(js|jsx|mjs|cjs)$/.test(file)) return "javascript";
  return "other";
}

function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec)(\/|$)/i.test(rel) ||
    /\.(test|spec)\.[jt]sx?$/.test(rel) ||
    /_test\.py$/.test(rel)
  );
}

function nodeId(filePath: string, name: string, lineStart: number): string {
  return `${filePath}::${name}@${lineStart}`;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

function extractFunctions(rel: string, text: string, language: Lang, isTest: boolean): RawFn[] {
  const lines = text.split(/\r?\n/);
  const fns: RawFn[] = [];
  let enclosingType: string | undefined;

  if (language === "python") {
    let className: string | undefined;
    let classIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const cls = line.match(/^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (cls) {
        className = cls[2];
        classIndent = cls[1]!.length;
        continue;
      }
      const m = line.match(/^(\s*)def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      if (!m) continue;
      const indent = m[1]!.length;
      if (className !== undefined && indent <= classIndent) {
        className = undefined;
        classIndent = -1;
      }
      const name = m[2]!;
      const start = i + 1;
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (l.trim() === "") continue;
        const ind = l.match(/^\s*/)?.[0].length ?? 0;
        if (ind <= indent && /^(def|class)\s+/.test(l.trim())) {
          end = j;
          break;
        }
      }
      fns.push({
        name,
        filePath: rel,
        lineStart: start,
        lineEnd: end,
        body: lines.slice(i, end).join("\n"),
        language,
        enclosingType: className && indent > classIndent ? className : undefined,
        isTest,
      });
    }
    return fns;
  }

  // TS/JS + classes
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const cls = line.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cls) enclosingType = cls[1];

    let name: string | null = null;
    let isMethod = false;
    const m1 = line.match(
      /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
    );
    const m2 = line.match(
      /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*=>/,
    );
    const m3 = line.match(
      /^\s*(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/,
    );
    if (m1) name = m1[1]!;
    else if (m2) name = m2[1]!;
    else if (m3 && enclosingType && !/^(if|for|while|switch|catch)$/.test(m3[1]!)) {
      name = m3[1]!;
      isMethod = true;
    }
    if (!name) continue;

    const start = i + 1;
    let depth = 0;
    let started = false;
    let end = start;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") depth--;
      }
      end = j + 1;
      if (started && depth <= 0) break;
      if (!started && j === i && !line.includes("{") && line.includes("=>")) {
        end = j + 1;
        break;
      }
    }
    fns.push({
      name,
      filePath: rel,
      lineStart: start,
      lineEnd: end,
      body: lines.slice(i, end).join("\n"),
      language,
      enclosingType: isMethod ? enclosingType : undefined,
      isTest,
    });
  }
  return fns;
}

function extractCalls(fn: RawFn): RawCall[] {
  const lines = fn.body.split(/\r?\n/);
  const calls: RawCall[] = [];
  const callerKey = nodeId(fn.filePath, fn.name, fn.lineStart);

  lines.forEach((line, idx) => {
    const absLine = fn.lineStart + idx;
    // this.method( / self.method(
    for (const m of line.matchAll(/\b(?:this|self)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      calls.push({
        callerKey,
        calleeName: m[1]!,
        calleeReceiver: fn.enclosingType ?? "this",
        filePath: fn.filePath,
        line: absLine,
      });
    }
    // obj.method( or module.fn(
    for (const m of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (m[1] === "this" || m[1] === "self") continue;
      calls.push({
        callerKey,
        calleeName: m[2]!,
        calleeReceiver: m[1],
        filePath: fn.filePath,
        line: absLine,
      });
    }
    // bare calls foo(
    for (const m of line.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const n = m[1]!;
      if (
        /^(if|for|while|switch|catch|function|return|await|typeof|new|class|def|import|from|console|Math|JSON|Object|Array|Promise|Number|String|Boolean|Error)$/.test(
          n,
        )
      ) {
        continue;
      }
      if (n === fn.name) continue;
      calls.push({
        callerKey,
        calleeName: n,
        filePath: fn.filePath,
        line: absLine,
        directHint: n,
      });
    }
  });
  return calls;
}

function extractInstantiations(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bnew\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) out.add(m[1]!);
  // Python Class(
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\(/g)) out.add(m[1]!);
  return [...out];
}

function extractHierarchy(text: string, language: Lang): {
  parents: Record<string, string[]>;
  methods: Record<string, string[]>;
} {
  const parents = emptyRecord<string[]>();
  const methods = emptyRecord<string[]>();
  if (language === "python") {
    for (const m of text.matchAll(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?/g)) {
      const name = m[1]!;
      const bases = (m[2] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "object");
      parents[name] = bases;
    }
  } else {
    for (const m of text.matchAll(
      /class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+extends\s+([A-Za-z_][A-Za-z0-9_.]*))?(?:\s+implements\s+([^{]+))?/g,
    )) {
      const name = m[1]!;
      const bases: string[] = [];
      if (m[2]) bases.push(m[2].split(".").pop()!);
      if (m[3]) {
        for (const p of m[3].split(",")) {
          const t = p.trim().split(".").pop();
          if (t) bases.push(t);
        }
      }
      parents[name] = bases;
    }
  }
  return { parents, methods };
}

function confRank(c: CallEdgeConfidence): number {
  return c === "high" ? 2 : c === "medium" ? 1 : 0;
}

function minConf(a: CallEdgeConfidence, b: CallEdgeConfidence): CallEdgeConfidence {
  return confRank(a) <= confRank(b) ? a : b;
}

function resolveTargets(
  call: RawCall,
  byName: Record<string, FunctionNode[]>,
  hierarchy: TypeHierarchy,
  algorithm: CallGraph["algorithm"],
): Array<{ node: FunctionNode; resolution: CallResolution; confidence: CallEdgeConfidence; virtual: boolean }> {
  const nameHits = byName[call.calleeName] ?? [];
  if (!nameHits.length) {
    // external / unresolved — no edge (we only model application graph)
    return [];
  }

  // Direct same-file or unique name
  if (nameHits.length === 1) {
    return [
      {
        node: nameHits[0]!,
        resolution: "direct",
        confidence: "high",
        virtual: false,
      },
    ];
  }

  // Prefer same file
  const sameFile = nameHits.filter((n) => n.filePath === call.filePath);
  if (sameFile.length === 1) {
    return [
      {
        node: sameFile[0]!,
        resolution: "direct",
        confidence: "high",
        virtual: false,
      },
    ];
  }

  // Receiver-based / CHA / RTA
  if (call.calleeReceiver && call.calleeReceiver !== "this") {
    // Prefer methods whose enclosing type matches receiver name (class style)
    const typed = nameHits.filter(
      (n) =>
        n.enclosingType === call.calleeReceiver ||
        n.name === call.calleeName && n.qualifiedName.includes(call.calleeReceiver!),
    );
    if (typed.length) {
      return typed.map((node) => ({
        node,
        resolution: "import_context" as const,
        confidence: "medium" as const,
        virtual: false,
      }));
    }
  }

  if (algorithm === "rta" || algorithm === "hybrid" || algorithm === "cha") {
    // RTA-lite: if methods belong to types, keep those that are instantiated or all subtypes
    const typedMethods = nameHits.filter((n) => n.enclosingType);
    if (typedMethods.length) {
      const inst = new Set(hierarchy.instantiated);
      let filtered = typedMethods.filter(
        (n) => !n.enclosingType || inst.has(n.enclosingType) || inst.size === 0,
      );
      if (algorithm === "cha" || filtered.length === 0) filtered = typedMethods;
      // also include subtypes of instantiated types
      if (algorithm === "rta" || algorithm === "hybrid") {
        const expanded = new Set(inst);
        for (const [child, parents] of Object.entries(hierarchy.parentsOf)) {
          if (parents.some((p) => inst.has(p))) expanded.add(child);
        }
        filtered = typedMethods.filter(
          (n) => !n.enclosingType || expanded.has(n.enclosingType) || expanded.size === 0,
        );
        if (!filtered.length) filtered = typedMethods;
      }
      return filtered.map((node) => ({
        node,
        resolution: algorithm === "cha" ? ("cha" as const) : ("rta" as const),
        confidence: filtered.length === 1 ? ("high" as const) : ("medium" as const),
        virtual: true,
      }));
    }
  }

  // Name-based RA — sound-biased: keep all targets with low confidence
  return nameHits.map((node) => ({
    node,
    resolution: "name_match" as const,
    confidence: "low" as const,
    virtual: true,
  }));
}

export type BuildCallGraphOptions = {
  /** Default hybrid: direct + RTA-lite + name fallback */
  algorithm?: CallGraph["algorithm"];
  /** Skip test files when building (still can be queried separately) */
  excludeTests?: boolean;
  /**
   * Exact pre-read source snapshot keyed by absolute path. When present, this
   * map is the complete authority: graph construction does not walk or read the
   * mutable repository. This prevents files added, removed, replaced, or linked
   * after bounded capture from changing the graph under the captured snapshot.
   */
  sources?: ReadonlyMap<string, string>;
};

function walkCapturedSources(
  repoRoot: string,
  sources: ReadonlyMap<string, string>,
): WalkResult {
  const root = resolve(repoRoot);
  const result: WalkResult = { files: [], skipped: [], unsupported: [] };
  const seen = new Set<string>();
  for (const sourcePath of sources.keys()) {
    if (!isAbsolute(sourcePath)) throw new Error("call_graph_source_path_not_absolute");
    const absolute = resolve(sourcePath);
    const rel = relPosix(root, absolute);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      throw new Error("call_graph_source_outside_repository");
    }
    const identity = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (seen.has(identity)) throw new Error("call_graph_source_path_duplicate");
    seen.add(identity);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const ext = name.includes(".") ? `.${name.split(".").pop()}` : "";
    if (CODE_EXTS.has(ext)) {
      result.files.push(absolute);
    } else {
      const language = UNSUPPORTED_CODE_EXTS.get(ext);
      if (language) result.unsupported.push({ path: rel, language });
    }
  }
  result.files.sort((left, right) => relPosix(root, left).localeCompare(relPosix(root, right)));
  result.unsupported.sort((left, right) => left.path.localeCompare(right.path));
  return result;
}

/**
 * Build application-centered call graph for a repository root.
 */
export function buildCallGraph(
  repoRoot: string,
  opts: BuildCallGraphOptions = {},
): CallGraph {
  const algorithm = opts.algorithm ?? "hybrid";
  const walkResult = opts.sources
    ? walkCapturedSources(repoRoot, opts.sources)
    : walk(repoRoot, repoRoot, { files: [], skipped: [], unsupported: [] });
  const files = walkResult.files;
  const rawFns: RawFn[] = [];
  const allInstantiated: string[] = [];
  const parentsOf = emptyRecord<string[]>();

  for (const abs of files) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const language = langOf(rel);
    const isTest = isTestPath(rel);
    if (opts.excludeTests && isTest) continue;
    const text = opts.sources
      ? opts.sources.get(abs)
      : readFileSync(abs, "utf8");
    if (text === undefined) throw new Error("call_graph_captured_source_missing");
    rawFns.push(...extractFunctions(rel, text, language, isTest));
    allInstantiated.push(...extractInstantiations(text));
    const hier = extractHierarchy(text, language);
    Object.assign(parentsOf, hier.parents);
  }

  const hierarchy: TypeHierarchy = {
    parentsOf,
    instantiated: [...new Set(allInstantiated)],
    methodsOfType: emptyRecord<string[]>(),
  };

  const nodes = emptyRecord<FunctionNode>();
  const byName = emptyRecord<FunctionNode[]>();

  for (const fn of rawFns) {
    const id = nodeId(fn.filePath, fn.name, fn.lineStart);
    const bodyH = hashBody(fn.body);
    const node: FunctionNode = {
      id,
      qualifiedName: `${fn.filePath}:${fn.enclosingType ? fn.enclosingType + "." : ""}${fn.name}`,
      name: fn.name,
      filePath: fn.filePath,
      lineStart: fn.lineStart,
      lineEnd: fn.lineEnd,
      language: fn.language,
      enclosingType: fn.enclosingType,
      isExternalApi: false,
      isTest: fn.isTest,
      bodyHash: bodyH,
      // first-line fingerprint for signature-change detection
      signature: fn.body
        .split(/\r?\n/)
        .find((l) => l.includes(fn.name))
        ?.replace(/\s+/g, " ")
        .replace(/\{.*$/, "")
        .trim()
        .slice(0, 240),
    };
    nodes[id] = node;
    byName[fn.name] = byName[fn.name] ?? [];
    byName[fn.name]!.push(node);
    if (fn.enclosingType) {
      hierarchy.methodsOfType[fn.enclosingType] = hierarchy.methodsOfType[fn.enclosingType] ?? [];
      hierarchy.methodsOfType[fn.enclosingType]!.push(fn.name);
    }
  }

  const byNameMap: Record<string, FunctionNode[]> = byName;
  const edges: CallEdge[] = [];
  const outEdges = emptyRecord<string[]>();
  const inEdges = emptyRecord<string[]>();
  let directEdges = 0;
  let approxEdges = 0;
  const edgeKeys = new Set<string>();

  for (const fn of rawFns) {
    const calls = extractCalls(fn);
    for (const call of calls) {
      const targets = resolveTargets(call, byNameMap, hierarchy, algorithm);
      for (const t of targets) {
        // skip self-edges for constructors noise
        if (t.node.id === call.callerKey) continue;
        const edgeKey = `${call.callerKey}->${t.node.id}@${call.line}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        const edge: CallEdge = {
          id: edgeKey,
          callerId: call.callerKey,
          calleeId: t.node.id,
          callSiteFile: call.filePath,
          callSiteLine: call.line,
          resolution: t.resolution,
          confidence: t.confidence,
          virtual: t.virtual,
        };
        edges.push(edge);
        outEdges[call.callerKey] = outEdges[call.callerKey] ?? [];
        outEdges[call.callerKey]!.push(edge.id);
        inEdges[t.node.id] = inEdges[t.node.id] ?? [];
        inEdges[t.node.id]!.push(edge.id);
        if (t.resolution === "direct") directEdges++;
        else approxEdges++;
      }
    }
  }

  const byNameIds = emptyRecord<string[]>();
  for (const [name, list] of Object.entries(byNameMap)) {
    byNameIds[name] = list.map((n) => n.id);
  }

  return {
    repoRoot,
    builtAt: new Date().toISOString(),
    algorithm,
    nodes,
    edges,
    outEdges,
    inEdges,
    byName: byNameIds,
    hierarchy,
    stats: {
      nodeCount: Object.keys(nodes).length,
      edgeCount: edges.length,
      directEdges,
      approxEdges,
    },
    diagnostics: {
      skippedDirectories: walkResult.skipped,
      supportedLanguages: [...SUPPORTED_LANGUAGES],
      unsupportedLanguageFiles: walkResult.unsupported,
    },
  };
}

export function emptyHierarchy(): TypeHierarchy {
  return {
    parentsOf: emptyRecord<string[]>(),
    instantiated: [],
    methodsOfType: emptyRecord<string[]>(),
  };
}

export function mergeHierarchies(a: TypeHierarchy, b: TypeHierarchy): TypeHierarchy {
  const parentsOf = { ...a.parentsOf, ...b.parentsOf };
  const instantiated = [...new Set([...a.instantiated, ...b.instantiated])];
  const methodsOfType = { ...a.methodsOfType };
  for (const [k, v] of Object.entries(b.methodsOfType)) {
    methodsOfType[k] = [...new Set([...(methodsOfType[k] ?? []), ...v])];
  }
  return { parentsOf, instantiated, methodsOfType };
}

/** Rebuild outEdges/inEdges/byName/stats from nodes+edges. */
export function rebuildAdjacency(graph: CallGraph): void {
  const outEdges = emptyRecord<string[]>();
  const inEdges = emptyRecord<string[]>();
  const byName = emptyRecord<string[]>();
  let directEdges = 0;
  let approxEdges = 0;
  for (const n of Object.values(graph.nodes)) {
    byName[n.name] = byName[n.name] ?? [];
    byName[n.name]!.push(n.id);
  }
  for (const e of graph.edges) {
    if (!graph.nodes[e.callerId] || !graph.nodes[e.calleeId]) continue;
    outEdges[e.callerId] = outEdges[e.callerId] ?? [];
    outEdges[e.callerId]!.push(e.id);
    inEdges[e.calleeId] = inEdges[e.calleeId] ?? [];
    inEdges[e.calleeId]!.push(e.id);
    if (e.resolution === "direct") directEdges++;
    else approxEdges++;
  }
  graph.outEdges = outEdges;
  graph.inEdges = inEdges;
  graph.byName = byName;
  graph.stats = {
    nodeCount: Object.keys(graph.nodes).length,
    edgeCount: graph.edges.length,
    directEdges,
    approxEdges,
  };
}

export type PartialAnalysis = {
  nodes: Record<string, FunctionNode>;
  edges: CallEdge[];
  hierarchy: TypeHierarchy;
};

/**
 * Re-analyze a subset of files and produce nodes/edges that resolve against
 * survivorNodes ∪ newly extracted nodes (application-centered).
 */
export function reanalyzeFiles(
  repoRoot: string,
  relFiles: string[],
  survivorGraph: Pick<CallGraph, "nodes" | "hierarchy">,
  opts: BuildCallGraphOptions = {},
): PartialAnalysis {
  const algorithm = opts.algorithm ?? "hybrid";
  const rawFns: RawFn[] = [];
  let hierarchy = emptyHierarchy();
  const allInstantiated: string[] = [];

  for (const rel of relFiles) {
    const abs = join(repoRoot, rel);
    const text = opts.sources
      ? opts.sources.get(resolve(abs))
      : existsSync(abs)
        ? readFileSync(abs, "utf8")
        : undefined;
    if (text === undefined) continue;
    const language = langOf(rel);
    const isTest = isTestPath(rel);
    if (opts.excludeTests && isTest) continue;
    rawFns.push(...extractFunctions(rel, text, language, isTest));
    allInstantiated.push(...extractInstantiations(text));
    const hier = extractHierarchy(text, language);
    hierarchy = mergeHierarchies(hierarchy, {
      parentsOf: hier.parents,
      instantiated: [],
      methodsOfType: {},
    });
  }
  hierarchy.instantiated = [...new Set(allInstantiated)];

  const newNodes = emptyRecord<FunctionNode>();
  for (const fn of rawFns) {
    const id = nodeId(fn.filePath, fn.name, fn.lineStart);
    const bodyH = hashBody(fn.body);
    const node: FunctionNode = {
      id,
      qualifiedName: `${fn.filePath}:${fn.enclosingType ? fn.enclosingType + "." : ""}${fn.name}`,
      name: fn.name,
      filePath: fn.filePath,
      lineStart: fn.lineStart,
      lineEnd: fn.lineEnd,
      language: fn.language,
      enclosingType: fn.enclosingType,
      isExternalApi: false,
      isTest: fn.isTest,
      bodyHash: bodyH,
      signature: fn.body
        .split(/\r?\n/)
        .find((l) => l.includes(fn.name))
        ?.replace(/\s+/g, " ")
        .replace(/\{.*$/, "")
        .trim()
        .slice(0, 240),
    };
    newNodes[id] = node;
    if (fn.enclosingType) {
      hierarchy.methodsOfType[fn.enclosingType] = hierarchy.methodsOfType[fn.enclosingType] ?? [];
      hierarchy.methodsOfType[fn.enclosingType]!.push(fn.name);
    }
  }

  // Resolution universe = survivors + new
  const universe: Record<string, FunctionNode> = { ...survivorGraph.nodes, ...newNodes };
  const byNameMap = emptyRecord<FunctionNode[]>();
  for (const n of Object.values(universe)) {
    byNameMap[n.name] = byNameMap[n.name] ?? [];
    byNameMap[n.name]!.push(n);
  }
  const mergedHierarchy = mergeHierarchies(survivorGraph.hierarchy, hierarchy);

  const edges: CallEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const fn of rawFns) {
    for (const call of extractCalls(fn)) {
      // Only emit edges from newly analyzed callers
      if (!newNodes[call.callerKey]) continue;
      const targets = resolveTargets(call, byNameMap, mergedHierarchy, algorithm);
      for (const t of targets) {
        if (t.node.id === call.callerKey) continue;
        const edgeKey = `${call.callerKey}->${t.node.id}@${call.line}`;
        if (edgeKeys.has(edgeKey)) continue;
        edgeKeys.add(edgeKey);
        edges.push({
          id: edgeKey,
          callerId: call.callerKey,
          calleeId: t.node.id,
          callSiteFile: call.filePath,
          callSiteLine: call.line,
          resolution: t.resolution,
          confidence: t.confidence,
          virtual: t.virtual,
        });
      }
    }
  }

  return { nodes: newNodes, edges, hierarchy };
}

// re-export incremental entry from incremental module to avoid circular init issues:
// buildCallGraphIncremental lives in incremental.ts

export { minConf, confRank };
