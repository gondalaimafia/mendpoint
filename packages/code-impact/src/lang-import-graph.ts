/**
 * Stage helper: Language-aware module resolution for provider provenance.
 *
 * `provenance.ts` builds the reverse module-import graph for TypeScript/JS using
 * relative-specifier resolution. Python, Go and Java name their imports
 * differently — dotted modules (`app.services.charge_service`), module-qualified
 * package paths (`example.com/m/internal/payments`), and fully-qualified class
 * names (`com.acme.settlement.payments.PaymentsClient`) — so the TS-shaped
 * resolver maps none of them onto files and every file downstream of the
 * provider client stays unreachable.
 *
 * This module resolves each language's import specifiers onto the indexed files
 * and feeds the *same* reverse-import structure the TS resolver produces, so the
 * provenance BFS (`reachableFromAnchors`) works uniformly across languages. It
 * adds two things the TS path does not need:
 *
 *  - Package cohesion for Go and Java. Importing a Go package pulls in every
 *    `.go` file in its directory, and same-package Java classes see each other
 *    with no import at all, so a field defined in a sibling file is part of the
 *    same integration surface. We connect same-directory files so reachability
 *    flows across a package the way the compiler sees it.
 *  - One-hop dependency inclusion. A provider-reachable file's own first-party
 *    imports (its wire DTO modules, its helpers) are part of that file's
 *    provider interaction. We include them so an upstream DTO module the client
 *    imports is provider-connected — without recursing back up through shared
 *    infrastructure hubs, which would bridge to unrelated subsystems.
 *
 * Unresolved first-party specifiers are recorded rather than silently dropped:
 * a silent-zero edge is the defect family this codebase keeps producing. Stdlib
 * and third-party specifiers are deliberately skipped (never recorded and never
 * resolved), so we never build edges into dependency directories.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRecord } from "@mendpoint/codebase-index";
import { resolveRelativeImport, reachableFromAnchors } from "./provenance.js";

/** An import specifier that looked first-party but resolved to no indexed file. */
export type UnresolvedImport = {
  /** Repo-relative path of the file that carried the import. */
  fromFile: string;
  /** The raw import specifier that could not be resolved. */
  spec: string;
  /** Language of the importing file. */
  language: FileRecord["language"];
};

type ResolveResult = {
  /** Resolved indexed file paths (may be several for a Go/Java package import). */
  targets: string[];
  /** True when the specifier looked first-party but resolved to nothing. */
  unresolved: boolean;
};

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

/**
 * Map every indexed Python file to its dotted module name, and record the set
 * of top-level first-party packages (a directory holding `__init__.py`, or the
 * first segment of any module). `__init__.py` maps to the package name itself so
 * a package import (`from app.models import x` → spec `app.models`) resolves.
 */
export function buildPythonModuleMaps(files: readonly Pick<FileRecord, "path">[]): {
  moduleToFile: Map<string, string>;
  firstPartyRoots: Set<string>;
} {
  const moduleToFile = new Map<string, string>();
  const firstPartyRoots = new Set<string>();
  for (const f of files) {
    if (!f.path.endsWith(".py")) continue;
    const noExt = f.path.slice(0, -3);
    const segs = noExt.split("/").filter(Boolean);
    if (!segs.length) continue;
    if (segs[segs.length - 1] === "__init__") {
      const pkg = segs.slice(0, -1);
      if (pkg.length) moduleToFile.set(pkg.join("."), f.path);
      if (pkg[0]) firstPartyRoots.add(pkg[0]);
    } else {
      moduleToFile.set(segs.join("."), f.path);
      if (segs[0]) firstPartyRoots.add(segs[0]);
    }
  }
  return { moduleToFile, firstPartyRoots };
}

/**
 * Resolve a Python import specifier (as captured by the indexer — the dotted
 * name after `from`/`import`, leading dots preserved for relative imports) onto
 * an indexed module file. Relative specifiers resolve against the importing
 * file's package; absolute ones against the module map. Stdlib / third-party
 * names (not under a first-party root) are skipped, never recorded.
 */
export function resolvePythonImport(
  fromFile: string,
  spec: string,
  moduleToFile: Map<string, string>,
  firstPartyRoots: ReadonlySet<string>,
): ResolveResult {
  const none = { targets: [], unresolved: false } as ResolveResult;
  let dotted = spec;
  if (spec.startsWith(".")) {
    // Relative: count leading dots. One dot = current package, two = parent, …
    let dots = 0;
    while (dots < spec.length && spec[dots] === ".") dots++;
    const tail = spec.slice(dots);
    const fromSegs = fromFile.slice(0, -3).split("/").filter(Boolean); // drop .py
    const pkgSegs = fromSegs.slice(0, -1); // package of the importing module
    const up = dots - 1; // one dot stays in current package
    if (up > pkgSegs.length) return none; // escapes the tree — unresolvable but not first-party
    const base = pkgSegs.slice(0, pkgSegs.length - up);
    dotted = [...base, ...tail.split(".").filter(Boolean)].join(".");
  } else {
    const root = spec.split(".")[0]!;
    if (!firstPartyRoots.has(root)) return none; // stdlib / third-party
  }
  const direct = moduleToFile.get(dotted);
  if (direct) return { targets: [direct], unresolved: false };
  // `from pkg.mod import name` where the spec stops at the package: try the
  // package module (its __init__) which the module map already carries.
  return { targets: [], unresolved: true };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

/** Read the `module` path from a repo's go.mod, or null when absent. */
export function readGoModule(repoRoot: string): string | null {
  try {
    const raw = readFileSync(join(repoRoot, "go.mod"), "utf8");
    const m = raw.match(/^\s*module\s+(\S+)/m);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** Group every indexed `.go` file under its directory (a Go package). */
export function buildGoDirMap(
  files: readonly Pick<FileRecord, "path">[],
): Map<string, string[]> {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    if (!f.path.endsWith(".go")) continue;
    const dir = dirOf(f.path);
    const list = byDir.get(dir);
    if (list) list.push(f.path);
    else byDir.set(dir, [f.path]);
  }
  return byDir;
}

/**
 * Resolve a Go import path to every `.go` file in the corresponding package
 * directory. Only import paths under this repo's module are first-party; stdlib
 * (no dot in the first segment) and external modules are skipped, never recorded
 * — we must not build edges into vendored / external code.
 */
export function resolveGoImport(
  spec: string,
  goModule: string | null,
  dirMap: Map<string, string[]>,
): ResolveResult {
  const none = { targets: [], unresolved: false } as ResolveResult;
  if (!goModule) return none;
  if (spec !== goModule && !spec.startsWith(`${goModule}/`)) {
    // Not our module: stdlib or external dependency — intentionally skipped.
    return none;
  }
  const rel = spec === goModule ? "" : spec.slice(goModule.length + 1);
  const targets = dirMap.get(rel);
  if (targets && targets.length) return { targets: [...targets], unresolved: false };
  return { targets: [], unresolved: true };
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const JAVA_SOURCE_ROOTS = ["src/main/java/", "src/test/java/", "src/main/kotlin/", "src/test/kotlin/"];

/** Strip a recognised Java/Kotlin source-root prefix, if present. */
function stripJavaSourceRoot(path: string): string | null {
  for (const root of JAVA_SOURCE_ROOTS) {
    const i = path.indexOf(root);
    if (i >= 0) return path.slice(i + root.length);
  }
  return null;
}

/**
 * Index Java files by fully-qualified class name (`com.acme.Foo`) and by package
 * (`com.acme` → every class file in it), plus the set of first-party base
 * packages (top two segments of each package) so an import can be classed as
 * first-party even when it names a class we did not index.
 */
export function buildJavaMaps(files: readonly Pick<FileRecord, "path">[]): {
  fqnToFile: Map<string, string>;
  packageToFiles: Map<string, string[]>;
  firstPartyPackages: Set<string>;
} {
  const fqnToFile = new Map<string, string>();
  const packageToFiles = new Map<string, string[]>();
  const firstPartyPackages = new Set<string>();
  for (const f of files) {
    if (!f.path.endsWith(".java") && !f.path.endsWith(".kt")) continue;
    const rel = stripJavaSourceRoot(f.path);
    if (!rel) continue;
    const noExt = rel.replace(/\.(java|kt)$/, "");
    const segs = noExt.split("/").filter(Boolean);
    if (!segs.length) continue;
    const fqn = segs.join(".");
    fqnToFile.set(fqn, f.path);
    const pkg = segs.slice(0, -1).join(".");
    const list = packageToFiles.get(pkg);
    if (list) list.push(f.path);
    else packageToFiles.set(pkg, [f.path]);
    // First-party base = first two package segments (e.g. `com.acme`), enough to
    // distinguish our own packages from `java.*`, `org.springframework.*`, etc.
    const base = segs.slice(0, 2).join(".");
    if (base) firstPartyPackages.add(base);
  }
  return { fqnToFile, packageToFiles, firstPartyPackages };
}

/**
 * Resolve a Java import (class, wildcard, or static import) onto indexed files.
 * `a.b.C` → the class file; `a.b.*` → every class in the package; static imports
 * resolve their declaring class. `java.*` / `javax.*` / external groups are
 * skipped, never recorded.
 */
export function resolveJavaImport(
  spec: string,
  fqnToFile: Map<string, string>,
  packageToFiles: Map<string, string[]>,
  firstPartyPackages: ReadonlySet<string>,
): ResolveResult {
  const none = { targets: [], unresolved: false } as ResolveResult;
  const base = spec.split(".").slice(0, 2).join(".");
  if (!firstPartyPackages.has(base)) return none; // external / stdlib group

  if (spec.endsWith(".*")) {
    const pkg = spec.slice(0, -2);
    const files = packageToFiles.get(pkg);
    if (files && files.length) return { targets: [...files], unresolved: false };
    return { targets: [], unresolved: true };
  }
  const direct = fqnToFile.get(spec);
  if (direct) return { targets: [direct], unresolved: false };
  // Static import: `a.b.Class.member` → strip the member and resolve the class.
  const parent = spec.split(".").slice(0, -1).join(".");
  const asClass = fqnToFile.get(parent);
  if (asClass) return { targets: [asClass], unresolved: false };
  return { targets: [], unresolved: true };
}

// ---------------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------------

type Graphs = {
  /** file → set of first-party files it imports (forward edges). */
  forward: Map<string, Set<string>>;
  /** imported file → set of files that import it (reverse edges, for the BFS). */
  reverse: Map<string, Set<string>>;
  unresolved: UnresolvedImport[];
};

function addEdge(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
}

/**
 * Build forward + reverse module-import graphs across all languages, plus Go/Java
 * package cohesion. TypeScript/JS reuse the existing relative-specifier resolver;
 * Python/Go/Java use the language resolvers above.
 */
export function buildLanguageGraphs(
  files: readonly Pick<FileRecord, "path" | "imports" | "language">[],
  repoRoot: string,
): Graphs {
  const paths = new Set(files.map((f) => f.path));
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const unresolved: UnresolvedImport[] = [];

  const py = buildPythonModuleMaps(files);
  const goModule = readGoModule(repoRoot);
  const goDirs = buildGoDirMap(files);
  const java = buildJavaMaps(files);

  const link = (from: string, targets: string[]) => {
    for (const t of targets) {
      if (t === from) continue;
      addEdge(forward, from, t);
      addEdge(reverse, t, from);
    }
  };

  for (const f of files) {
    for (const spec of f.imports) {
      let res: ResolveResult;
      if (f.language === "python") {
        res = resolvePythonImport(f.path, spec, py.moduleToFile, py.firstPartyRoots);
      } else if (f.language === "go") {
        res = resolveGoImport(spec, goModule, goDirs);
      } else if (f.language === "java") {
        res = resolveJavaImport(spec, java.fqnToFile, java.packageToFiles, java.firstPartyPackages);
      } else if (f.language === "typescript" || f.language === "javascript") {
        const target = resolveRelativeImport(f.path, spec, paths);
        res = { targets: target ? [target] : [], unresolved: false };
      } else {
        res = { targets: [], unresolved: false };
      }
      if (res.targets.length) link(f.path, res.targets);
      else if (res.unresolved) {
        unresolved.push({ fromFile: f.path, spec, language: f.language });
      }
    }
  }

  // Package cohesion (Go, Java): same-directory files are one compilation unit /
  // share a package namespace, so a field on a sibling file belongs to the same
  // integration surface. Connect them so reachability flows across the package.
  const cohesionDirs = new Map<string, string[]>();
  for (const f of files) {
    if (f.language !== "go" && f.language !== "java") continue;
    const dir = dirOf(f.path);
    const list = cohesionDirs.get(dir);
    if (list) list.push(f.path);
    else cohesionDirs.set(dir, [f.path]);
  }
  for (const members of cohesionDirs.values()) {
    if (members.length < 2) continue;
    for (const a of members) {
      for (const b of members) {
        if (a === b) continue;
        addEdge(reverse, a, b);
        addEdge(forward, a, b);
      }
    }
  }

  return { forward, reverse, unresolved };
}

/**
 * Compute the provider-reachable file set across all languages. Reachability is
 * the union of:
 *   1. files that transitively import a provider anchor (BFS over reverse edges);
 *   2. the first-party modules those files directly import (one hop over forward
 *      edges) — a reachable file's own wire-DTO / helper modules. The one hop is
 *      deliberately terminal: we do not walk back up from a dependency to its
 *      other importers, which would bridge across the repo through shared
 *      infrastructure hubs and pull in unrelated subsystems.
 *
 * Returns the reachable set and any first-party specifiers that could not be
 * resolved (recorded, never silently dropped).
 */
export function buildProviderReachability(
  files: readonly Pick<FileRecord, "path" | "imports" | "language">[],
  repoRoot: string,
  anchors: Iterable<string>,
  opts: { includeDependencies?: boolean } = {},
): { reachable: Set<string>; unresolved: UnresolvedImport[] } {
  const includeDependencies = opts.includeDependencies ?? true;
  const { forward, reverse, unresolved } = buildLanguageGraphs(files, repoRoot);
  const importers = reachableFromAnchors(anchors, reverse);
  const reachable = new Set<string>(importers);
  // One-hop terminal dependency inclusion. Applied for Python, whose wire-DTO
  // modules live in a separate module the client imports (upstream of the
  // anchor) and are otherwise unreachable — a reachable file's directly imported
  // first-party modules are part of its provider interaction. TypeScript/JS
  // co-locate or re-export their DTO types from the client module (reached by
  // R1), and Go/Java co-locate them in the client's package (reached by
  // cohesion); for those, a dependency hop only pulls in shared infrastructure
  // and dependency packages, so it is not applied.
  if (includeDependencies) {
    const langOf = new Map(files.map((f) => [f.path, f.language]));
    for (const file of importers) {
      if (langOf.get(file) !== "python") continue;
      const deps = forward.get(file);
      if (!deps) continue;
      for (const dep of deps) reachable.add(dep);
    }
  }
  return { reachable, unresolved };
}
