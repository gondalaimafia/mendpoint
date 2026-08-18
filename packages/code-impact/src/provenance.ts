/**
 * Stage helper: Provider provenance.
 *
 * A field name matching in source is not, on its own, evidence that the value
 * comes from the provider under analysis. `AnalyticsEvent.source`,
 * `BUILD_FLAGS.sourceMap`, a "single source of truth" comment, and a real
 * `MeridianChargeRequest.source` all match the token `source`. To keep a field
 * (or SDK-call) finding at confident tiers, we require *provenance*: the file
 * must be able to reach the provider's surface through the module-import graph.
 *
 * Provenance is anchored on files that carry a first-class provider signal (an
 * HTTP path that matches the changed surface, or an import of the provider
 * package). A file is provider-reachable when it transitively imports such an
 * anchor. Files that never import their way to the provider are demoted to a
 * low-confidence notification rather than reported as a confident impact — an
 * honest degrade a reviewer can see, not a silent drop and not a false claim.
 *
 * When no anchor is detectable at all (e.g. a minimal wrapper chain with no
 * HTTP path and no vendor package), provenance cannot be established for *any*
 * file, so gating is disabled and confidence falls back to the token match. The
 * absence of a locatable surface degrades precision, never recall.
 */
import type { FileRecord } from "@mendpoint/codebase-index";
import { HARD_MAX_HOPS, type GraphPath } from "@mendpoint/shared";

const MODULE_EXTENSIONS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
  "/index.cjs",
];

/** Posix-normalize a path, collapsing `.`/`..` segments. */
function normalizePosix(path: string): string {
  const segs = path.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * Resolve a relative import specifier to an indexed file path, or `undefined`
 * for bare package specifiers and unresolved paths. Tolerates extensionless
 * TypeScript imports and `.js` specifiers that resolve to a `.ts` source.
 */
export function resolveRelativeImport(
  fromFile: string,
  spec: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!spec.startsWith(".")) return undefined; // bare package import
  const base = normalizePosix(`${dirOf(fromFile)}/${spec}`);
  const candidates = new Set<string>();
  for (const ext of MODULE_EXTENSIONS) candidates.add(base + ext);
  // A `./foo.js` specifier commonly resolves to a `./foo.ts` source under NodeNext.
  const jsToTs = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsToTs) {
    const stem = base.slice(0, base.length - jsToTs[0].length);
    for (const ext of [".ts", ".tsx"]) candidates.add(stem + ext);
  }
  for (const c of candidates) {
    if (files.has(c)) return c;
  }
  return undefined;
}

/**
 * Build the reverse module-import graph: `imported file -> set of files that
 * import it`. Reverse edges let us walk from provider anchors out to every file
 * that (transitively) depends on the provider.
 */
export function buildImporterGraph(
  files: readonly Pick<FileRecord, "path" | "imports">[],
): Map<string, Set<string>> {
  const paths = new Set(files.map((f) => f.path));
  const importers = new Map<string, Set<string>>();
  for (const f of files) {
    for (const spec of f.imports) {
      const target = resolveRelativeImport(f.path, spec, paths);
      if (!target || target === f.path) continue;
      let set = importers.get(target);
      if (!set) {
        set = new Set<string>();
        importers.set(target, set);
      }
      set.add(f.path);
    }
  }
  return importers;
}

/**
 * A reachability walk from provider anchors: the reachable set plus the
 * predecessor tree that records, for each reached non-anchor file, the neighbour
 * one hop closer to an anchor (the module it imports through which it was first
 * reached). The predecessor tree is what lets us reconstruct the provider->code
 * path behind a finding without re-walking the graph.
 */
export type ReachabilityWalk = {
  reachable: Set<string>;
  /** reached file -> the module it imports that is one hop closer to an anchor. */
  predecessors: Map<string, string>;
  /** The anchor set the walk started from (path roots). */
  anchors: Set<string>;
};

/**
 * Files that transitively import any anchor (anchors included), together with a
 * BFS predecessor tree. BFS over the reverse-import graph. BFS gives the
 * shortest anchor->file path, so the predecessor tree is acyclic even when the
 * import graph contains cycles: a cyclic graph terminates here, it never loops.
 */
export function traverseFromAnchors(
  anchors: Iterable<string>,
  importerGraph: Map<string, Set<string>>,
): ReachabilityWalk {
  const anchorSet = new Set<string>(anchors);
  const reachable = new Set<string>(anchorSet);
  const predecessors = new Map<string, string>();
  // FIFO for genuine shortest paths (breadth-first layers).
  const queue = [...reachable];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    const importers = importerGraph.get(node);
    if (!importers) continue;
    for (const importer of importers) {
      if (!reachable.has(importer)) {
        reachable.add(importer);
        // `importer` imports `node`, so `node` is one hop closer to the anchor.
        predecessors.set(importer, node);
        queue.push(importer);
      }
    }
  }
  return { reachable, predecessors, anchors: anchorSet };
}

/**
 * Files that transitively import any anchor (anchors included). BFS over the
 * reverse-import graph. Thin wrapper over {@link traverseFromAnchors} that keeps
 * the original Set-only contract for callers that only gate on membership.
 */
export function reachableFromAnchors(
  anchors: Iterable<string>,
  importerGraph: Map<string, Set<string>>,
): Set<string> {
  return traverseFromAnchors(anchors, importerGraph).reachable;
}

/**
 * Reconstruct the provider->code path for one reached file by walking the
 * predecessor tree from the file back to its anchor, then orienting the result
 * anchor-first. Returns `undefined` when the file is not reachable (no path was
 * computed — "not computed", distinct from an empty path).
 *
 * The walk is bounded and cycle-guarded so it always terminates and always
 * reports HOW it ended rather than trimming silently:
 *  - reaching an anchor yields terminal `anchor`, coverage `complete`;
 *  - exceeding {@link HARD_MAX_HOPS} yields terminal `max_hops`, `truncated`;
 *  - revisiting a node (only possible on a malformed/cyclic predecessor map, a
 *    defensive guarantee since BFS predecessors are acyclic) yields terminal
 *    `cycle`, `truncated`;
 *  - a reachable node whose predecessor chain runs out before an anchor (a
 *    detached/malformed predecessor map, equally defensive) yields terminal
 *    `no_anchor`, `truncated` — it never claims it reached an anchor.
 */
export function anchorPathTo(
  target: string,
  walk: Pick<ReachabilityWalk, "predecessors" | "anchors" | "reachable">,
  maxHops: number = HARD_MAX_HOPS,
): GraphPath | undefined {
  if (!walk.reachable.has(target)) return undefined;
  // Build target-first, then reverse to anchor-first for display.
  const chain: string[] = [target];
  const seen = new Set<string>([target]);
  let current = target;
  let terminal: GraphPath["terminal"] = "anchor";
  let truncated = false;
  while (!walk.anchors.has(current)) {
    if (chain.length - 1 >= maxHops) {
      terminal = "max_hops";
      truncated = true;
      break;
    }
    const next = walk.predecessors.get(current);
    if (next === undefined) {
      // Reachable non-anchor whose predecessor chain ran out: the walk did NOT
      // reach an anchor, so it must not be reported `anchor`/`complete`. Fail
      // closed with its own terminal, mirroring the `cycle` guard below.
      terminal = "no_anchor";
      truncated = true;
      break;
    }
    if (seen.has(next)) {
      terminal = "cycle";
      truncated = true;
      break;
    }
    chain.push(next);
    seen.add(next);
    current = next;
  }
  const nodes = chain.reverse();
  return {
    nodes,
    hops: nodes.length - 1,
    terminal,
    truncated,
    coverage: truncated ? "partial" : "complete",
  };
}
