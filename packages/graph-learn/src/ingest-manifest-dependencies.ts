/**
 * Ingest declared package-manifest dependencies as Service DEPENDS_ON Service
 * edges (spec §11 / Change Graph DEPENDS_ON writer).
 *
 * Until this module existed, DEPENDS_ON was a declared edge kind with readers
 * (`dependency-paths`, `migration_ready_units`) and no producer, so those
 * queries had to fail closed. This writer is the live path: workspace manifests
 * (`package.json`, `pyproject.toml`, `go.mod`) become tenant-scoped Service
 * nodes plus DEPENDS_ON edges. Malformed manifests are skipped, never guessed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { upsertEdge, upsertNode, type GraphLearnDb } from "./store.js";

const PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const GO_MODULE = /^[A-Za-z0-9._~+/-]+$/;
const MAX_DEPENDENCIES = 500;

export type ManifestDependency = Readonly<{
  name: string;
  specifier: string;
  ecosystem: "npm" | "pypi" | "go";
}>;

export type ManifestIngestResult = Readonly<{
  manifest: string | null;
  ecosystem: "npm" | "pypi" | "go" | null;
  packageName: string | null;
  dependencies: number;
  skipped: number;
}>;

function serviceId(name: string): string {
  return `service:${name}`;
}

function safePackageName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 200 || name.includes("..") || name.includes("\\")) {
    return null;
  }
  if (!PACKAGE_NAME.test(name) && !GO_MODULE.test(name)) return null;
  return name;
}

function parsePackageJson(text: string): { name: string; deps: ManifestDependency[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? safePackageName(record.name) : null;
  if (!name) return null;
  const deps: ManifestDependency[] = [];
  const blocks = [record.dependencies, record.peerDependencies];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    for (const [rawName, rawSpec] of Object.entries(block as Record<string, unknown>)) {
      const depName = safePackageName(rawName);
      if (!depName) continue;
      const specifier = typeof rawSpec === "string" ? rawSpec.trim().slice(0, 80) : "*";
      deps.push({ name: depName, specifier: specifier || "*", ecosystem: "npm" });
    }
  }
  return { name, deps: deps.slice(0, MAX_DEPENDENCIES) };
}

function parsePyproject(text: string): { name: string; deps: ManifestDependency[] } | null {
  const nameMatch = text.match(/^name\s*=\s*["']([^"']+)["']/m);
  const name = nameMatch ? safePackageName(nameMatch[1] ?? "") : null;
  if (!name) return null;
  const deps: ManifestDependency[] = [];
  const block = text.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (block) {
    for (const raw of block[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
      const token = (raw[1] ?? "").trim();
      const depName = safePackageName(token.split(/[\s<>=!~\[]/)[0] ?? "");
      if (!depName) continue;
      deps.push({ name: depName, specifier: token.slice(0, 80), ecosystem: "pypi" });
    }
  }
  return { name, deps: deps.slice(0, MAX_DEPENDENCIES) };
}

function parseGoMod(text: string): { name: string; deps: ManifestDependency[] } | null {
  const moduleMatch = text.match(/^module\s+(\S+)/m);
  const name = moduleMatch ? safePackageName(moduleMatch[1] ?? "") : null;
  if (!name) return null;
  const deps: ManifestDependency[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("module ") || trimmed.startsWith("go ") || trimmed === "require (" || trimmed === ")") {
      continue;
    }
    const requireLine = trimmed.replace(/^require\s+/, "");
    const parts = requireLine.split(/\s+/);
    const depName = safePackageName(parts[0] ?? "");
    if (!depName || depName === name) continue;
    deps.push({
      name: depName,
      specifier: (parts[1] ?? "*").slice(0, 80),
      ecosystem: "go",
    });
  }
  return { name, deps: deps.slice(0, MAX_DEPENDENCIES) };
}

function parseManifest(path: string, text: string): { name: string; deps: ManifestDependency[]; ecosystem: ManifestIngestResult["ecosystem"] } | null {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? "";
  if (file === "package.json") {
    const parsed = parsePackageJson(text);
    return parsed ? { ...parsed, ecosystem: "npm" } : null;
  }
  if (file === "pyproject.toml") {
    const parsed = parsePyproject(text);
    return parsed ? { ...parsed, ecosystem: "pypi" } : null;
  }
  if (file === "go.mod") {
    const parsed = parseGoMod(text);
    return parsed ? { ...parsed, ecosystem: "go" } : null;
  }
  return null;
}

function writeDependencies(
  db: GraphLearnDb,
  input: {
    repoId: string;
    tenantId?: string;
    sourcePath: string;
    packageName: string;
    deps: readonly ManifestDependency[];
  },
): { dependencies: number; skipped: number } {
  const tenantProps = input.tenantId ? { tenant_id: input.tenantId } : {};
  const sourceId = serviceId(input.packageName);
  upsertNode(db, {
    id: sourceId,
    kind: "Service",
    label: input.packageName,
    repo_id: input.repoId,
    props: { ...tenantProps, ecosystem: input.deps[0]?.ecosystem ?? "npm", manifest: input.sourcePath },
  });
  let dependencies = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const dep of input.deps) {
    if (dep.name === input.packageName || seen.has(dep.name)) {
      skipped++;
      continue;
    }
    seen.add(dep.name);
    const targetId = serviceId(dep.name);
    upsertNode(db, {
      id: targetId,
      kind: "Service",
      label: dep.name,
      repo_id: input.repoId,
      props: { ...tenantProps, ecosystem: dep.ecosystem, declared: true },
    });
    upsertEdge(db, {
      id: `DEPENDS_ON:${sourceId}:${targetId}`,
      kind: "DEPENDS_ON",
      source: sourceId,
      target: targetId,
      source_system: "manifest",
      confidence: 1,
      props: { specifier: dep.specifier, ecosystem: dep.ecosystem, manifest: input.sourcePath },
    });
    dependencies++;
  }
  return { dependencies, skipped };
}

/**
 * Ingest DEPENDS_ON edges from a repository workspace manifest. Looks for
 * package.json, pyproject.toml, then go.mod at the repo root. Missing or
 * unparseable manifests return zeros — never an invented graph.
 */
export function ingestManifestDependencies(
  db: GraphLearnDb,
  opts: {
    repoPath: string;
    repoId: string;
    tenantId?: string;
    /** Optional in-memory files (tests); otherwise read from repoPath. */
    files?: ReadonlyArray<{ path: string; text: string }>;
  },
): ManifestIngestResult {
  const empty: ManifestIngestResult = {
    manifest: null, ecosystem: null, packageName: null, dependencies: 0, skipped: 0,
  };
  const candidates = ["package.json", "pyproject.toml", "go.mod"] as const;
  let chosen: { path: string; text: string } | undefined;
  if (opts.files) {
    for (const name of candidates) {
      const match = opts.files.find((file) => file.path.replace(/\\/g, "/").endsWith(name));
      if (match) {
        chosen = match;
        break;
      }
    }
  } else if (existsSync(opts.repoPath)) {
    for (const name of candidates) {
      const path = join(opts.repoPath, name);
      if (!existsSync(path)) continue;
      chosen = { path, text: readFileSync(path, "utf8") };
      break;
    }
  }
  if (!chosen) return empty;
  const parsed = parseManifest(chosen.path, chosen.text);
  if (!parsed) return empty;
  const written = writeDependencies(db, {
    repoId: opts.repoId,
    tenantId: opts.tenantId,
    sourcePath: chosen.path,
    packageName: parsed.name,
    deps: parsed.deps,
  });
  return {
    manifest: chosen.path,
    ecosystem: parsed.ecosystem,
    packageName: parsed.name,
    dependencies: written.dependencies,
    skipped: written.skipped,
  };
}
