/**
 * Auto-detect monitored APIs from package.json / requirements.txt / imports.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findVendorByPackage, type VendorEntry, VENDOR_CATALOG } from "./vendors.js";

export type DetectedVendor = {
  slug: string;
  name: string;
  source: "package.json" | "requirements.txt" | "import" | "go.mod";
  packageName: string;
  confidence: "high" | "medium";
};

function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".next") continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) walkFiles(p, out, depth + 1);
      else out.push(p);
    } catch {
      /* skip */
    }
  }
  return out;
}

function detectFromPackageJson(repoRoot: string): DetectedVendor[] {
  const hits: DetectedVendor[] = [];
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return hits;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(all)) {
      const v = findVendorByPackage(name, "npm");
      if (v) {
        hits.push({
          slug: v.slug,
          name: v.name,
          source: "package.json",
          packageName: name,
          confidence: "high",
        });
      }
    }
  } catch {
    /* ignore */
  }
  return hits;
}

function detectFromRequirements(repoRoot: string): DetectedVendor[] {
  const hits: DetectedVendor[] = [];
  for (const fname of ["requirements.txt", "requirements-dev.txt", "pyproject.toml"]) {
    const p = join(repoRoot, fname);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    if (fname.endsWith(".toml")) {
      for (const m of text.matchAll(/([A-Za-z0-9_.-]+)\s*[>=<~!]/g)) {
        const name = m[1]!;
        if (["python", "requires-python"].includes(name.toLowerCase())) continue;
        const v = findVendorByPackage(name, "pypi");
        if (v) {
          hits.push({
            slug: v.slug,
            name: v.name,
            source: "requirements.txt",
            packageName: name,
            confidence: "high",
          });
        }
      }
    } else {
      for (const line of text.split(/\r?\n/)) {
        const name = line.trim().split(/[=>\s<\[]/)[0];
        if (!name || name.startsWith("#")) continue;
        const v = findVendorByPackage(name, "pypi");
        if (v) {
          hits.push({
            slug: v.slug,
            name: v.name,
            source: "requirements.txt",
            packageName: name,
            confidence: "high",
          });
        }
      }
    }
  }
  return hits;
}

function detectFromImports(repoRoot: string): DetectedVendor[] {
  const hits: DetectedVendor[] = [];
  const files = walkFiles(repoRoot).filter((f) => /\.(ts|tsx|js|jsx|py)$/.test(f));
  const seen = new Set<string>();
  for (const f of files.slice(0, 400)) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    // npm-style imports
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const pkg = m[1]!.startsWith("@")
        ? m[1]!.split("/").slice(0, 2).join("/")
        : m[1]!.split("/")[0]!;
      if (pkg.startsWith(".")) continue;
      const v = findVendorByPackage(pkg, "npm");
      if (v && !seen.has(v.slug + ":import")) {
        seen.add(v.slug + ":import");
        hits.push({
          slug: v.slug,
          name: v.name,
          source: "import",
          packageName: pkg,
          confidence: "medium",
        });
      }
    }
    // python imports
    for (const m of text.matchAll(/^\s*(?:from|import)\s+([a-zA-Z0-9_]+)/gm)) {
      const mod = m[1]!;
      const v = findVendorByPackage(mod, "pypi");
      if (v && !seen.has(v.slug + ":import")) {
        seen.add(v.slug + ":import");
        hits.push({
          slug: v.slug,
          name: v.name,
          source: "import",
          packageName: mod,
          confidence: "medium",
        });
      }
    }
  }
  return hits;
}

/**
 * Detect vendors used by a consumer repo. Dedupes by slug (highest confidence wins).
 */
export function detectVendors(repoRoot: string): DetectedVendor[] {
  const all = [
    ...detectFromPackageJson(repoRoot),
    ...detectFromRequirements(repoRoot),
    ...detectFromImports(repoRoot),
  ];
  const bySlug = new Map<string, DetectedVendor>();
  const rank = { high: 2, medium: 1 };
  for (const d of all) {
    const prev = bySlug.get(d.slug);
    if (!prev || rank[d.confidence] > rank[prev.confidence]) {
      bySlug.set(d.slug, d);
    }
  }
  return [...bySlug.values()];
}

export function catalogEntry(slug: string): VendorEntry | undefined {
  return VENDOR_CATALOG.find((v) => v.slug === slug);
}
