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
 * Files that transitively import any anchor (anchors included). BFS over the
 * reverse-import graph.
 */
export function reachableFromAnchors(
  anchors: Iterable<string>,
  importerGraph: Map<string, Set<string>>,
): Set<string> {
  const reachable = new Set<string>(anchors);
  const queue = [...reachable];
  while (queue.length) {
    const node = queue.pop()!;
    const importers = importerGraph.get(node);
    if (!importers) continue;
    for (const importer of importers) {
      if (!reachable.has(importer)) {
        reachable.add(importer);
        queue.push(importer);
      }
    }
  }
  return reachable;
}
