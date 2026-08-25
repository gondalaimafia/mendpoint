/**
 * Evidence reachability check — npm run evidence:reachability
 *
 * The problem this guards against
 * --------------------------------
 * `docs/PRODUCT_REQUIREMENTS.json` and `apps/web/app/docs/catalog.ts` cite
 * evidence (mostly test files) for capabilities. The existing checks
 * (product-spec-check, public-claims-check, build-public-docs --check) verify
 * that the cited file *exists*. They do not verify that the code the test
 * exercises is *reachable* from anything that runs in production.
 *
 * So a capability can be marked "verified" by the test suite of code that no
 * live entry point ever calls, and the gate stays green forever. This has
 * already bitten the register at least four times (see the PR body). Each was
 * only caught because someone happened to delete the dead code.
 *
 * What this check establishes
 * ---------------------------
 * For every evidence citation that points at repository TypeScript source, it
 * identifies the "code under test" (the first-party value symbols the cited
 * test imports, or the exports of a cited source file) and asks two questions:
 *
 *   1. hasNonTestCaller(S) — does ANY non-test, non-barrel source file
 *      reference S in real code (not an import re-export, not a declaration)?
 *      This is COMPLETE over the repository (a whole-word scan of every live
 *      file), so a negative answer is a proof: if literally nothing outside
 *      tests and barrels uses S, no entry point can reach it, transitively or
 *      otherwise. This is what drives the UNREACHABLE verdict, and it is sound
 *      by construction — zero false positives.
 *
 *   2. entryTraced(S) — is S used by a module that is itself reachable from a
 *      live entry point (server routes, worker CLI, package.json scripts, fly
 *      manifests, workflows, Next.js pages), following import and re-export
 *      edges? This upgrades a citation to LIVE. The import graph is best
 *      effort; when it cannot connect a real caller to an entry point the
 *      citation is reported as NOT_DETERMINED, never silently as fine.
 *
 * Three visible outcomes, never two
 * ---------------------------------
 *   LIVE           — at least one tested symbol is used on a traced entry path.
 *   UNREACHABLE    — every tested symbol has zero non-test callers (proven dead).
 *   NOT_DETERMINED — reported, does not block: the subject could not be
 *                    identified (e.g. an e2e spec, a dynamic import, a
 *                    type-only import) or a caller exists but could not be
 *                    connected to an entry point.
 *
 * Enforcing mode (--strict): fail ONLY on a proven-unreachable citation that
 * belongs to a `verified` requirement. That narrowing is the whole point. A
 * partial or scaffold requirement citing code nothing calls is honest about
 * being incomplete; a `verified` requirement doing so is a false claim, and a
 * false claim is the only thing that should block the build. Every other
 * proven-dead citation (on a non-verified requirement) stays reported and
 * visible but does not block, and everything ambiguous is NOT_DETERMINED and
 * does not block. Static reachability is genuinely hard; an over-eager blocking
 * rule would flag legitimate code, get muted, and be deleted, leaving the
 * register worse off than a precise reporter.
 *
 * Known limitations (stated plainly, not hidden):
 *   - Transitive deadness beyond the first hop is not chased. If S's only
 *     caller is itself dead, S is reported as having a caller (LIVE or
 *     NOT_DETERMINED), not UNREACHABLE. Catching this soundly needs
 *     symbol-level call-graph flow and would risk false positives; the
 *     UNREACHABLE verdict is deliberately restricted to provable dead leaves.
 *   - Symbol matching for the DEAD proof is whole-word and name-based. A name
 *     collision (two packages exporting the same identifier) can only make the
 *     check MORE conservative (mark something live that is dead) — a false
 *     negative, never a false positive.
 *   - The entry-point import graph does not resolve dynamic string dispatch or
 *     every Next.js convention; a genuine caller it fails to trace surfaces as
 *     NOT_DETERMINED, not as UNREACHABLE.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  type ProductRegisterSet,
  type ProductRequirement,
  type ProductRequirementManifest,
} from "@mendpoint/contract";
import { PRODUCT_DOCS } from "../apps/web/app/docs/catalog.js";

export type ReachabilityVerdict = "live" | "unreachable" | "not_determined";

export type SymbolStatus = Readonly<{
  name: string;
  hasNonTestCaller: boolean;
  entryTraced: boolean;
  definedIn: readonly string[];
}>;

export type CitationResult = Readonly<{
  source: "register" | "catalog";
  requirementId?: string;
  implementationStatus?: string;
  evidenceId?: string;
  docSlug?: string;
  label?: string;
  type: string;
  locator: string;
  verdict: ReachabilityVerdict;
  reason: string;
  symbols: readonly SymbolStatus[];
}>;

const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  "website-upload",
]);

const SOURCE_EXTENSIONS = /\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/;

/** A citation of these types never points at repository source we can trace. */
const NON_SOURCE_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  "planned",
  "external",
  "live",
  "document",
]);

/** Next.js file conventions that act as live entry points. */
const NEXT_ENTRY_FILES: ReadonlySet<string> = new Set([
  "page.tsx",
  "page.ts",
  "route.ts",
  "route.tsx",
  "layout.tsx",
  "layout.ts",
  "middleware.ts",
  "default.tsx",
  "template.tsx",
  "loading.tsx",
  "error.tsx",
  "not-found.tsx",
  "global-error.tsx",
  "sitemap.ts",
  "robots.ts",
  "opengraph-image.tsx",
]);

function isTestPath(rel: string): boolean {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel)) return true;
  const segments = rel.split("/");
  return segments.includes("__tests__");
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

type FileInfo = {
  rel: string;
  abs: string;
  text: string;
  isTest: boolean;
  /** Text with import/re-export statement spans blanked to spaces. */
  codeText: string;
  /** Start offsets of declaration-name identifiers to exclude from use counts. */
  declPositions: Set<number>;
  /** Top-level declared value+type names in this file. */
  declaredNames: Set<string>;
  /** Names re-exported by `export { x } from`/`export { x }` (barrel edges). */
  reExportedNames: Set<string>;
  /** True when the file only re-exports (a pure barrel). */
  isPureBarrel: boolean;
  /** Resolved import/re-export edges (specifier -> target rel path). */
  edges: string[];
};

function parseFile(rel: string, abs: string, text: string): FileInfo {
  const isTest = isTestPath(rel);
  const sourceFile = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    rel.endsWith(".tsx") || rel.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const blankSpans: Array<[number, number]> = [];
  const declPositions = new Set<number>();
  const declaredNames = new Set<string>();
  const reExportedNames = new Set<string>();
  const specifiers: string[] = [];
  let nonReExportStatements = 0;

  const recordName = (node: ts.Node | undefined) => {
    if (node && ts.isIdentifier(node)) {
      declPositions.add(node.getStart(sourceFile));
      declaredNames.add(node.text);
    }
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      blankSpans.push([statement.getStart(sourceFile), statement.getEnd()]);
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      // `export ... from "x"` or bare `export { a }` re-export — a barrel edge.
      blankSpans.push([statement.getStart(sourceFile), statement.getEnd()]);
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          reExportedNames.add(element.name.text);
        }
      }
      continue;
    }
    nonReExportStatements += 1;
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      recordName(statement.name);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) recordName(decl.name);
      }
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      recordName(statement.name);
    }
  }

  const chars = text.split("");
  for (const [start, end] of blankSpans) {
    for (let i = start; i < end; i += 1) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  const codeText = chars.join("");

  // Import/re-export edges for the reachability graph.
  const specSet = new Set<string>();
  const collectSpec = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      // Type-only whole-declaration imports do not create a runtime edge.
      const typeOnly =
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly);
      if (!typeOnly) specSet.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specSet.add((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, collectSpec);
  };
  collectSpec(sourceFile);
  specifiers.push(...specSet);

  return {
    rel,
    abs,
    text,
    isTest,
    codeText,
    declPositions,
    declaredNames,
    reExportedNames,
    isPureBarrel: nonReExportStatements === 0 && (reExportedNames.size > 0 || specSet.size > 0),
    edges: specifiers,
  };
}

// ---------------------------------------------------------------------------
// Repository index
// ---------------------------------------------------------------------------

export type RepoIndex = {
  root: string;
  files: Map<string, FileInfo>;
  packageMain: Map<string, string>; // "@mendpoint/db" -> "packages/db/src/index.ts"
  reachedModules: Set<string>;
  entries: string[];
};

function walk(dir: string, root: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, root, out);
    else if (SOURCE_EXTENSIONS.test(entry)) out.push(full);
  }
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split("\\").join("/");
}

function readPackageMains(root: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const base of ["packages", "apps"]) {
    const dir = join(root, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgJson = join(dir, name, "package.json");
      if (!existsSync(pkgJson)) continue;
      try {
        const parsed = JSON.parse(readFileSync(pkgJson, "utf8")) as {
          name?: string;
          main?: string;
        };
        if (parsed.name && parsed.main) {
          const mainRel = toRel(root, resolve(join(dir, name), parsed.main));
          map.set(parsed.name, mainRel);
        } else if (parsed.name) {
          // No main: fall back to src/index.ts if present.
          const candidate = join(dir, name, "src", "index.ts");
          if (existsSync(candidate)) map.set(parsed.name, toRel(root, candidate));
        }
      } catch {
        // ignore malformed package.json
      }
    }
  }
  return map;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveExisting(
  files: Map<string, FileInfo>,
  root: string,
  candidateAbs: string,
): string | undefined {
  const rel = toRel(root, candidateAbs);
  if (files.has(rel)) return rel;
  // Try mapping a `.js`/`.jsx`/`.mjs` extension back to a TS source.
  const jsMatch = rel.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsMatch) {
    const withoutExt = rel.slice(0, -jsMatch[0].length);
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
      if (files.has(withoutExt + ext)) return withoutExt + ext;
    }
  }
  // Bare specifier with no extension.
  for (const ext of RESOLVE_EXTENSIONS) {
    if (files.has(rel + ext)) return rel + ext;
  }
  // Directory index.
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexRel = `${rel}/index${ext}`;
    if (files.has(indexRel)) return indexRel;
  }
  return undefined;
}

function resolveSpecifier(
  index: RepoIndex,
  fromRel: string,
  spec: string,
): string | undefined {
  if (spec.startsWith("@mendpoint/")) {
    const parts = spec.split("/"); // ["@mendpoint","pkg", ...sub]
    const pkgName = `${parts[0]}/${parts[1]}`;
    const sub = parts.slice(2);
    if (sub.length === 0) {
      return index.packageMain.get(pkgName);
    }
    // Subpath import within a package.
    const pkgMain = index.packageMain.get(pkgName);
    if (pkgMain) {
      const pkgDir = pkgMain.replace(/\/src\/.*$/, "/src");
      return resolveExisting(
        index.files,
        index.root,
        resolve(index.root, pkgDir, sub.join("/")),
      );
    }
    return undefined;
  }
  if (spec.startsWith(".")) {
    return resolveExisting(
      index.files,
      index.root,
      resolve(index.root, dirname(fromRel), spec),
    );
  }
  return undefined; // bare third-party specifier
}

function collectEntries(index: RepoIndex): string[] {
  const root = index.root;
  const entries = new Set<string>();
  const addIfSource = (rel: string) => {
    if (index.files.has(rel) && !index.files.get(rel)!.isTest) entries.add(rel);
  };

  // Fixed application entry points.
  for (const fixed of ["apps/api/src/server.ts", "apps/worker/src/cli.ts"]) {
    addIfSource(fixed);
  }

  // File paths named in package.json scripts, fly manifests, workflows, Dockerfiles.
  const configTexts: string[] = [];
  const pushIfExists = (rel: string) => {
    const abs = join(root, rel);
    if (existsSync(abs)) configTexts.push(readFileSync(abs, "utf8"));
  };
  pushIfExists("package.json");
  for (const file of readdirSync(root)) {
    if (/^fly\..*\.toml$/.test(file) || file === "fly.toml") pushIfExists(file);
    if (/^Dockerfile/.test(file)) pushIfExists(file);
  }
  const workflowsDir = join(root, ".github", "workflows");
  if (existsSync(workflowsDir)) {
    for (const file of readdirSync(workflowsDir)) {
      pushIfExists(toRel(root, join(workflowsDir, file)));
    }
  }
  const pathPattern =
    /(?:scripts|apps|packages|evals|tests)\/[A-Za-z0-9_./-]+\.(?:tsx?|mts|cts|mjs|cjs|jsx?)/g;
  for (const text of configTexts) {
    for (const match of text.matchAll(pathPattern)) {
      const rel = match[0];
      // Map .js/.mjs deploy scripts to their real source if present.
      const resolved = resolveExisting(index.files, root, join(root, rel));
      if (resolved) addIfSource(resolved);
    }
  }

  // Next.js entry conventions under apps/web.
  for (const [rel, info] of index.files) {
    if (!rel.startsWith("apps/web/")) continue;
    if (info.isTest) continue;
    const base = rel.split("/").pop()!;
    if (NEXT_ENTRY_FILES.has(base)) entries.add(rel);
    if (rel === "apps/web/middleware.ts") entries.add(rel);
    if (/\.mjs$/.test(rel) && /start|server|production/.test(base)) entries.add(rel);
  }

  return [...entries];
}

function computeReached(index: RepoIndex): Set<string> {
  const reached = new Set<string>();
  const queue = [...index.entries];
  for (const entry of queue) reached.add(entry);
  while (queue.length > 0) {
    const current = queue.pop()!;
    const info = index.files.get(current);
    if (!info) continue;
    for (const spec of info.edges) {
      const target = resolveSpecifier(index, current, spec);
      if (target && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return reached;
}

export function buildRepoIndex(root: string): RepoIndex {
  const absFiles: string[] = [];
  walk(root, root, absFiles);
  const files = new Map<string, FileInfo>();
  for (const abs of absFiles) {
    const rel = toRel(root, abs);
    try {
      files.set(rel, parseFile(rel, abs, readFileSync(abs, "utf8")));
    } catch {
      // Unparseable file: skip; it simply never contributes a caller edge.
    }
  }
  const index: RepoIndex = {
    root,
    files,
    packageMain: readPackageMains(root),
    reachedModules: new Set(),
    entries: [],
  };
  index.entries = collectEntries(index);
  index.reachedModules = computeReached(index);
  return index;
}

// ---------------------------------------------------------------------------
// Symbol reference engine
// ---------------------------------------------------------------------------

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** All non-test files that USE `name` in real code (not a declaration of it). */
function callerFiles(index: RepoIndex, name: string): string[] {
  const callers: string[] = [];
  // Deliberately NOT excluding a leading `.`: a namespace-qualified use
  // (`m.reserveUsage()`) must count as a caller. Counting an unrelated
  // same-named member access only over-links (marks something live that is
  // dead) — a false negative, never a false positive. Under-counting a real
  // qualified use would be a false UNREACHABLE, which the ship-decider forbids.
  const needle = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`, "g");
  for (const [rel, info] of index.files) {
    if (info.isTest) continue;
    if (!info.codeText.includes(name)) continue;
    let matched = false;
    for (const match of info.codeText.matchAll(needle)) {
      const start = match.index ?? -1;
      if (start < 0) continue;
      if (info.declPositions.has(start)) continue; // this is the declaration itself
      matched = true;
      break;
    }
    if (matched) callers.push(rel);
  }
  return callers;
}

function definingModules(index: RepoIndex, name: string): string[] {
  const out: string[] = [];
  for (const [rel, info] of index.files) {
    if (info.isTest) continue;
    if (info.declaredNames.has(name)) out.push(rel);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function analyzeSymbol(index: RepoIndex, name: string): SymbolStatus {
  const callers = callerFiles(index, name);
  const definedIn = definingModules(index, name);
  const entrySet = new Set(index.entries);
  // A symbol defined in an entry-point file (e.g. a Next.js page/route export,
  // a CLI command module) is invoked by the framework or runtime, not by an
  // in-code caller; its defining module running is the live path.
  const definedInEntry = definedIn.some((rel) => entrySet.has(rel));
  const entryTraced =
    definedInEntry || callers.some((rel) => index.reachedModules.has(rel));
  return {
    name,
    hasNonTestCaller: callers.length > 0 || definedInEntry,
    entryTraced,
    definedIn,
  };
}

// ---------------------------------------------------------------------------
// Subject-symbol extraction from citations
// ---------------------------------------------------------------------------

function isFirstParty(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("@mendpoint/");
}

/** Value symbols a test imports from first-party source (types excluded). */
function subjectSymbolsFromTest(
  info: FileInfo,
): { names: string[]; sawNamespace: boolean; sawFirstParty: boolean } {
  const names = new Set<string>();
  let sawNamespace = false;
  let sawFirstParty = false;
  const sourceFile = ts.createSourceFile(
    info.rel,
    info.text,
    ts.ScriptTarget.Latest,
    true,
    info.rel.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isFirstParty(statement.moduleSpecifier.text)) continue;
    sawFirstParty = true;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.isTypeOnly) continue;
    if (clause.name) names.add(clause.name.text); // default import
    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        sawNamespace = true;
      } else if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          names.add(element.name.text);
        }
      }
    }
  }
  return { names: [...names], sawNamespace, sawFirstParty };
}

/** Exported value names of a cited source file (types excluded, following `export *`). */
function subjectSymbolsFromSource(
  index: RepoIndex,
  rel: string,
  seen: Set<string> = new Set(),
): string[] {
  if (seen.has(rel)) return [];
  seen.add(rel);
  const info = index.files.get(rel);
  if (!info) return [];
  const names = new Set<string>();
  const sourceFile = ts.createSourceFile(
    rel,
    info.text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const starTargets: string[] = [];
  for (const statement of sourceFile.statements) {
    const isExported =
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && isExported && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && isExported && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement) && isExported) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    } else if (ts.isEnumDeclaration(statement) && isExported && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      } else if (!statement.exportClause && statement.moduleSpecifier) {
        // `export * from "./x"` — resolve one level.
        if (ts.isStringLiteral(statement.moduleSpecifier)) {
          const target = resolveSpecifier(index, rel, statement.moduleSpecifier.text);
          if (target) starTargets.push(target);
        }
      }
    }
  }
  for (const target of starTargets) {
    for (const name of subjectSymbolsFromSource(index, target, seen)) names.add(name);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Citation analysis
// ---------------------------------------------------------------------------

type RawCitation = {
  source: "register" | "catalog";
  requirementId?: string;
  implementationStatus?: string;
  evidenceId?: string;
  docSlug?: string;
  label?: string;
  type: string;
  locator: string;
};

function verdictFromSymbols(symbols: readonly SymbolStatus[]): {
  verdict: ReachabilityVerdict;
  reason: string;
} {
  const traced = symbols.filter((s) => s.entryTraced);
  const called = symbols.filter((s) => s.hasNonTestCaller);
  const dead = symbols.filter((s) => !s.hasNonTestCaller);
  if (traced.length > 0) {
    // A live co-imported symbol must not silently rescue proven-dead symbols
    // cited alongside it (the ME-WAR-005 shape: DEFAULT_POLICY vouching for a
    // dead WardenPolicyStore). The aggregate verdict stays `live` — demoting it
    // has a measured wide blast radius and is deferred — but the dead symbols
    // are named here and collected into the report's livePartiallyDead list so
    // an operator can see the partial deadness instead of it rounding up.
    const base = `traced to an entry path via ${traced.map((s) => s.name).join(", ")}`;
    return {
      verdict: "live",
      reason:
        dead.length > 0
          ? `${base}; but ${dead
              .map((s) => s.name)
              .join(", ")} has no non-test caller (cited alongside proven-dead code)`
          : base,
    };
  }
  if (called.length === 0) {
    return {
      verdict: "unreachable",
      reason: `no non-test caller for ${dead.map((s) => s.name).join(", ")}`,
    };
  }
  return {
    verdict: "not_determined",
    reason: `caller(s) exist for ${called
      .map((s) => s.name)
      .join(", ")} but none could be traced to a live entry point`,
  };
}

export function analyzeCitation(index: RepoIndex, raw: RawCitation): CitationResult {
  const base = {
    source: raw.source,
    requirementId: raw.requirementId,
    implementationStatus: raw.implementationStatus,
    evidenceId: raw.evidenceId,
    docSlug: raw.docSlug,
    label: raw.label,
    type: raw.type,
    locator: raw.locator,
  };
  const nd = (reason: string, symbols: SymbolStatus[] = []): CitationResult => ({
    ...base,
    verdict: "not_determined",
    reason,
    symbols,
  });

  if (NON_SOURCE_EVIDENCE_TYPES.has(raw.type)) {
    return nd(`evidence type "${raw.type}" does not point at traceable repository source`);
  }
  const rel = raw.locator.split("#", 1)[0]!;
  if (!SOURCE_EXTENSIONS.test(rel)) {
    return nd(`locator "${rel}" is not a TypeScript/JavaScript source file`);
  }
  const info = index.files.get(rel);
  if (!info) {
    return nd(`locator "${rel}" was not found in the source index`);
  }
  if (/\.e2e\.|e2e\/|\.spec\./.test(rel) || raw.type === "e2e") {
    return nd(
      `"${rel}" drives the running application over HTTP; reachability is not import-traceable`,
    );
  }

  let names: string[];
  if (info.isTest) {
    const extracted = subjectSymbolsFromTest(info);
    if (!extracted.sawFirstParty) {
      return nd(`test "${rel}" imports no first-party source symbols`);
    }
    if (extracted.names.length === 0) {
      return nd(
        extracted.sawNamespace
          ? `test "${rel}" imports first-party code only via a namespace import; individual subjects are not resolvable`
          : `test "${rel}" imports first-party code only as types`,
      );
    }
    names = extracted.names;
  } else {
    names = subjectSymbolsFromSource(index, rel);
    if (names.length === 0) {
      return nd(`source "${rel}" exports no value symbols to trace`);
    }
  }

  const symbols = names.map((name) => analyzeSymbol(index, name));
  const { verdict, reason } = verdictFromSymbols(symbols);
  return { ...base, verdict, reason, symbols };
}

// ---------------------------------------------------------------------------
// Citation collection
// ---------------------------------------------------------------------------

export function collectRegisterCitations(
  manifest: ProductRequirementManifest,
): RawCitation[] {
  const sets: ProductRequirement[][] = [manifest.requirements];
  for (const set of (manifest.additionalRegisterSets ?? []) as ProductRegisterSet[]) {
    sets.push(set.requirements);
  }
  const citations: RawCitation[] = [];
  for (const requirements of sets) {
    for (const requirement of requirements) {
      for (const criterion of requirement.acceptance) {
        for (const evidence of criterion.evidence) {
          citations.push({
            source: "register",
            requirementId: requirement.id,
            implementationStatus: requirement.implementationStatus,
            evidenceId: evidence.id,
            type: evidence.type,
            locator: evidence.locator,
          });
        }
      }
    }
  }
  return citations;
}

export function collectCatalogCitations(): RawCitation[] {
  const citations: RawCitation[] = [];
  for (const doc of PRODUCT_DOCS) {
    for (const evidence of doc.evidence) {
      citations.push({
        source: "catalog",
        docSlug: doc.slug,
        label: evidence.label,
        type: "catalog",
        locator: evidence.locator,
      });
    }
  }
  return citations;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ReachabilityReport = Readonly<{
  results: readonly CitationResult[];
  counts: Readonly<Record<ReachabilityVerdict, number>>;
  unreachable: readonly CitationResult[];
  /**
   * LIVE citations that also cite at least one proven-dead symbol. These are
   * NOT failures and do not gate — the aggregate verdict is still live because
   * a traced symbol exists — but they are the shape where a live co-imported
   * symbol vouches for dead code (ME-WAR-005), so they are surfaced separately
   * for an operator to inspect rather than being invisible inside the live set.
   */
  livePartiallyDead: readonly CitationResult[];
  /** Verified requirements with no citation traceable to a live path. */
  verifiedWithoutLivePath: readonly string[];
  /** Verified requirements that cite at least one proven-unreachable test. */
  verifiedCitingUnreachable: readonly string[];
  verifiedTotal: number;
}>;

export function runReachabilityReport(root: string): ReachabilityReport {
  const index = buildRepoIndex(root);
  const manifestPath = join(root, "docs", "PRODUCT_REQUIREMENTS.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProductRequirementManifest;

  const citations = [...collectRegisterCitations(manifest), ...collectCatalogCitations()];
  const results = citations.map((raw) => analyzeCitation(index, raw));

  const counts: Record<ReachabilityVerdict, number> = {
    live: 0,
    unreachable: 0,
    not_determined: 0,
  };
  for (const result of results) counts[result.verdict] += 1;

  // Verified-requirement traceability deliverable.
  const registerReqs: ProductRequirement[] = [
    ...manifest.requirements,
    ...(manifest.additionalRegisterSets ?? []).flatMap((set) => set.requirements),
  ];
  const verified = registerReqs.filter((r) => r.implementationStatus === "verified");
  const resultsByReq = new Map<string, CitationResult[]>();
  for (const result of results) {
    if (result.source !== "register" || !result.requirementId) continue;
    const list = resultsByReq.get(result.requirementId) ?? [];
    list.push(result);
    resultsByReq.set(result.requirementId, list);
  }
  const verifiedWithoutLivePath: string[] = [];
  const verifiedCitingUnreachable: string[] = [];
  for (const requirement of verified) {
    const list = resultsByReq.get(requirement.id) ?? [];
    const hasLive = list.some((r) => r.verdict === "live");
    if (!hasLive) verifiedWithoutLivePath.push(requirement.id);
    if (list.some((r) => r.verdict === "unreachable")) {
      verifiedCitingUnreachable.push(requirement.id);
    }
  }

  return {
    results,
    counts,
    unreachable: results.filter((r) => r.verdict === "unreachable"),
    livePartiallyDead: results.filter(
      (r) =>
        r.verdict === "live" &&
        r.symbols.length > 0 &&
        r.symbols.some((s) => !s.hasNonTestCaller),
    ),
    verifiedWithoutLivePath,
    verifiedCitingUnreachable,
    verifiedTotal: verified.length,
  };
}

function formatCitation(result: CitationResult): string {
  const who =
    result.source === "register"
      ? `${result.requirementId}/${result.evidenceId}`
      : `docs:${result.docSlug} (${result.label})`;
  return `  ${who} [${result.type}] ${result.locator}\n    ${result.reason}`;
}

export type StrictGateResult = Readonly<{
  /** True when the build must fail: a verified requirement rests on dead code. */
  failed: boolean;
  /** The verified requirement ids that cite a proven-unreachable test. */
  blockers: readonly string[];
}>;

/**
 * The enforcing-mode (--strict) decision, isolated so the narrowing is testable.
 * Blocks ONLY on unreachable citations that belong to a `verified` requirement;
 * proven-dead citations on partial/scaffold requirements are reported but never
 * block. Reverting this to `report.counts.unreachable > 0` is exactly the
 * regression the narrowing test guards against.
 */
export function evaluateStrictGate(report: ReachabilityReport): StrictGateResult {
  const blockers = report.verifiedCitingUnreachable;
  return { failed: blockers.length > 0, blockers };
}

function main(): void {
  const root = resolve(process.cwd());
  const strict = process.argv.includes("--strict");
  const report = runReachabilityReport(root);

  console.log("=== Evidence reachability check ===");
  console.log(
    `citations: ${report.results.length}  live=${report.counts.live}  ` +
      `unreachable=${report.counts.unreachable}  not_determined=${report.counts.not_determined}`,
  );

  console.log("\n--- UNREACHABLE (proven: no non-test caller) ---");
  if (report.unreachable.length === 0) {
    console.log("  none");
  } else {
    for (const result of report.unreachable) console.log(formatCitation(result));
  }

  console.log(
    `\n--- LIVE but partially dead (${report.livePartiallyDead.length}; reported, does not block) ---`,
  );
  console.log(
    "  These citations are live via a traced symbol but also cite a proven-dead one,",
  );
  console.log(
    "  so a live co-import must not be read as vouching for the dead symbol beside it:",
  );
  if (report.livePartiallyDead.length === 0) {
    console.log("  none");
  } else {
    for (const result of report.livePartiallyDead) console.log(formatCitation(result));
  }

  const notDetermined = report.results.filter((r) => r.verdict === "not_determined");
  const ambiguousCode = notDetermined.filter((r) => r.reason.startsWith("caller(s) exist"));
  const nonSource = notDetermined.filter((r) => NON_SOURCE_EVIDENCE_TYPES.has(r.type));
  const other = notDetermined.filter(
    (r) => !ambiguousCode.includes(r) && !nonSource.includes(r),
  );
  console.log(`\n--- NOT_DETERMINED (${notDetermined.length}; reported, does not block) ---`);
  console.log(
    `  ${nonSource.length} cite non-source evidence (document/external/live/planned) — nothing to trace.`,
  );
  console.log(`  ${other.length} are e2e or non-TypeScript locators.`);
  console.log(`  ${ambiguousCode.length} cite code with a caller that could not be traced to an entry point:`);
  for (const result of ambiguousCode) console.log(formatCitation(result));

  console.log("\n--- Verified-requirement traceability (the deliverable) ---");
  console.log(
    `${report.verifiedWithoutLivePath.length} of ${report.verifiedTotal} verified requirements ` +
      `cite NO evidence traceable to a live path:`,
  );
  for (const id of report.verifiedWithoutLivePath) console.log(`  ${id}`);
  console.log(
    `\n${report.verifiedCitingUnreachable.length} of ${report.verifiedTotal} verified requirements ` +
      `cite at least one PROVEN-UNREACHABLE test (verified partly on dead code):`,
  );
  for (const id of report.verifiedCitingUnreachable) console.log(`  ${id}`);

  if (strict) {
    const gate = evaluateStrictGate(report);
    if (gate.failed) {
      console.error(
        `\nFAIL (--strict): ${gate.blockers.length} verified requirement(s) cite a ` +
          `proven-unreachable test: ${gate.blockers.join(", ")}.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  if (report.counts.unreachable > 0) {
    console.log(
      strict
        ? `\nEnforcing mode: ${report.counts.unreachable} proven-unreachable citation(s) above, ` +
            `none on a verified requirement — the gate passes. They stay reported until wired or removed.`
        : `\nReporting mode: ${report.counts.unreachable} proven-unreachable citation(s) above. ` +
            `Run with --strict to fail the build on any that belong to a verified requirement.`,
    );
  } else {
    console.log("\nNo citation could be proven unreachable.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
