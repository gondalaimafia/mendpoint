/**
 * Vendored third-party detection.
 *
 * A committed copy of a provider's own SDK (a "vendored" dependency) must never
 * be an edit target: the customer does not own that code, and rewriting it
 * diverges their copy from upstream, producing a diff that conflicts on the next
 * re-vendoring. Like generated output, the field it carries is *useful
 * information* — the vendored copy has to be refreshed from upstream — but it is
 * not a file we edit in place. We surface it as its own labelled outcome.
 *
 * We detect it by *third-party provenance*, never by a path named `vendor`:
 * committed `vendor/` trees are legitimate first-party-consumed source in other
 * ecosystems (Go vendoring is checked in and compiled from) and must stay
 * analysable. The signal is a package boundary — a directory carrying its own
 * `package.json` whose declared name differs from the repo's own — that
 * first-party code reaches into by a *relative* import (the module the client
 * imports *from*) and that is never imported by its bare package name.
 *
 * Diving into a package's files with a relative path is the hallmark of a
 * vendored copy: the customer pasted the dependency into their tree and points
 * directly at its source. A properly installed dependency or a workspace package
 * is imported by its name (`acmepay-sdk`, `@acme/payments`) and resolved through
 * node_modules / the workspace, so neither a real dependency nor a first-party
 * monorepo package matches — only a copied-in third-party module does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodebaseIndex } from "@mendpoint/codebase-index";
import { resolveRelativeImport } from "./provenance.js";

type RootPackageMetadata = {
  name?: string;
  workspacePatterns: string[];
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Read the root package identity and every declared JavaScript workspace pattern. */
function readRootPackageMetadata(repoRoot: string): RootPackageMetadata {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      name?: unknown;
      workspaces?: unknown;
    };
    const workspacePatterns = Array.isArray(parsed.workspaces)
      ? stringArray(parsed.workspaces)
      : parsed.workspaces && typeof parsed.workspaces === "object"
        ? stringArray((parsed.workspaces as { packages?: unknown }).packages)
        : [];
    return {
      name: typeof parsed.name === "string" && parsed.name.length ? parsed.name : undefined,
      workspacePatterns,
    };
  } catch {
    return { workspacePatterns: [] };
  }
}

/** Read pnpm workspace package patterns without accepting arbitrary YAML features. */
function readPnpmWorkspacePatterns(repoRoot: string): string[] {
  try {
    const lines = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
    const patterns: string[] = [];
    let inPackages = false;
    for (const line of lines) {
      if (/^packages\s*:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages && /^\S/.test(line)) break;
      if (!inPackages) continue;
      const match = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
      if (match?.[1]?.trim()) patterns.push(match[1].trim());
    }
    return patterns;
  } catch {
    return [];
  }
}

/** Convert the small workspace-glob subset (`*`, `**`, `?`) to a path regex. */
function workspacePatternRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*" && normalized[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function isDeclaredWorkspace(dir: string, patterns: string[]): boolean {
  let included = false;
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const excluded = trimmed.startsWith("!");
    const pattern = excluded ? trimmed.slice(1) : trimmed;
    if (pattern && workspacePatternRegex(pattern).test(dir)) included = !excluded;
  }
  return included;
}

/** Read the `name` field of a `package.json`, or undefined when absent/unparsable. */
function readPackageName(repoRoot: string, dir: string): string | undefined {
  try {
    const raw = readFileSync(join(repoRoot, dir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.length ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** Every ancestor directory prefix of a repo-relative file path (excluding the file). */
function ancestorDirs(path: string): string[] {
  const segs = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const out: string[] = [];
  let prefix = "";
  for (let i = 0; i < segs.length - 1; i++) {
    prefix = prefix ? `${prefix}/${segs[i]}` : segs[i]!;
    out.push(prefix);
  }
  return out;
}

/** True when `filePath` sits inside directory `dir` (or is `dir` itself). */
function within(dir: string, filePath: string): boolean {
  return filePath === dir || filePath.startsWith(`${dir}/`);
}

/**
 * The set of vendored third-party file paths in a codebase index. A file is
 * vendored when it lives under a package boundary that first-party code imports
 * *into* by a relative path and never imports by its bare package name.
 */
export function detectVendoredFiles(index: CodebaseIndex): Set<string> {
  const filePaths = new Set(index.files.map((f) => f.path));
  const root = readRootPackageMetadata(index.repoRoot);
  const workspacePatterns = [
    ...root.workspacePatterns,
    ...readPnpmWorkspacePatterns(index.repoRoot),
  ];

  // Discover package boundaries: ancestor directories of indexed files that
  // carry their own package.json declaring a name distinct from the repo's own.
  const boundaryDirs = new Set<string>();
  for (const f of index.files) {
    for (const dir of ancestorDirs(f.path)) boundaryDirs.add(dir);
  }
  const boundaries = new Map<string, string>(); // dir -> package name
  for (const dir of boundaryDirs) {
    const name = readPackageName(index.repoRoot, dir);
    if (name && name !== root.name && !isDeclaredWorkspace(dir, workspacePatterns)) {
      boundaries.set(dir, name);
    }
  }
  if (!boundaries.size) return new Set();

  // A package imported anywhere by its bare name is an installed dependency or a
  // workspace package, not a vendored copy — exclude it.
  const importedByName = new Set<string>();
  for (const f of index.files) {
    for (const spec of f.imports) {
      if (spec.startsWith(".")) continue; // relative, handled below
      for (const [dir, name] of boundaries) {
        if (spec === name || spec.startsWith(`${name}/`)) importedByName.add(dir);
      }
    }
  }

  // A boundary reached into by a relative import from a file outside it is a
  // vendored copy (the module the client imports *from*).
  const vendoredDirs = new Set<string>();
  for (const f of index.files) {
    for (const spec of f.imports) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelativeImport(f.path, spec, filePaths);
      if (!target) continue;
      for (const [dir] of boundaries) {
        if (importedByName.has(dir)) continue;
        if (within(dir, target) && !within(dir, f.path)) vendoredDirs.add(dir);
      }
    }
  }

  const out = new Set<string>();
  if (!vendoredDirs.size) return out;
  for (const f of index.files) {
    if ([...vendoredDirs].some((dir) => within(dir, f.path))) out.add(f.path);
  }
  return out;
}
