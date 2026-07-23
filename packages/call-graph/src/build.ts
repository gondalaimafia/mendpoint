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
import { join, relative } from "node:path";
import type {
  CallEdge,
  CallEdgeConfidence,
  CallGraph,
  CallResolution,
  FunctionNode,
  TypeHierarchy,
} from "./types.js";

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

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
  const parents: Record<string, string[]> = {};
  const methods: Record<string, string[]> = {};
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
};

/**
 * Build application-centered call graph for a repository root.
 */
export function buildCallGraph(
  repoRoot: string,
  opts: BuildCallGraphOptions = {},
): CallGraph {
  const algorithm = opts.algorithm ?? "hybrid";
  const files = walk(repoRoot);
  const rawFns: RawFn[] = [];
  const allInstantiated: string[] = [];
  const parentsOf: Record<string, string[]> = {};

  for (const abs of files) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const language = langOf(rel);
    const isTest = isTestPath(rel);
    if (opts.excludeTests && isTest) continue;
    const text = readFileSync(abs, "utf8");
    rawFns.push(...extractFunctions(rel, text, language, isTest));
    allInstantiated.push(...extractInstantiations(text));
    const hier = extractHierarchy(text, language);
    Object.assign(parentsOf, hier.parents);
  }

  const hierarchy: TypeHierarchy = {
    parentsOf,
    instantiated: [...new Set(allInstantiated)],
    methodsOfType: {},
  };

  const nodes: Record<string, FunctionNode> = {};
  const byName: Record<string, FunctionNode[]> = {};

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
  const outEdges: Record<string, string[]> = {};
  const inEdges: Record<string, string[]> = {};
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

  const byNameIds: Record<string, string[]> = {};
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
  };
}

export function emptyHierarchy(): TypeHierarchy {
  return { parentsOf: {}, instantiated: [], methodsOfType: {} };
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
  const outEdges: Record<string, string[]> = {};
  const inEdges: Record<string, string[]> = {};
  const byName: Record<string, string[]> = {};
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
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
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

  const newNodes: Record<string, FunctionNode> = {};
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
  const byNameMap: Record<string, FunctionNode[]> = {};
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
