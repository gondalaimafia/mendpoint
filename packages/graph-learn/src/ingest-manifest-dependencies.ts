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
  /** Manifest block the edge came from; a peer/optional dep is a weaker claim than a runtime one. */
  block: "dependencies" | "peerDependencies" | "require";
}>;

/** Why a manifest was not ingested; `null` on the ingested path. */
export type ManifestSkipReason = "no-manifest" | "unparseable" | "no-package-name";

export type ManifestIngestResult = Readonly<{
  /** `ingested` when a manifest parsed and produced a (possibly empty) edge set; `skipped` otherwise. */
  status: "ingested" | "skipped";
  reason: ManifestSkipReason | null;
  manifest: string | null;
  ecosystem: "npm" | "pypi" | "go" | null;
  packageName: string | null;
  dependencies: number;
  skipped: number;
}>;

/**
 * Discriminated parse outcome so a missing/path-like package name is not
 * conflated with genuinely unparseable text (both once collapsed to `null`).
 */
type ParseOutcome =
  | { readonly ok: true; readonly name: string; readonly deps: ManifestDependency[] }
  | { readonly ok: false; readonly reason: Exclude<ManifestSkipReason, "no-manifest"> };

// Manifest-derived Services are namespaced by repo (mirroring `symbol:${repoId}:...`)
// so a declared dependency can never collide with a provider Service (`service:${slug}`)
// or with another tenant/repo that depends on a package of the same name.
function serviceId(repoId: string, name: string): string {
  return `service:${repoId}:${name}`;
}

function safePackageName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > 200 || name.includes("..") || name.includes("\\")) {
    return null;
  }
  if (!PACKAGE_NAME.test(name) && !GO_MODULE.test(name)) return null;
  return name;
}

function parsePackageJson(text: string): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "unparseable" };
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? safePackageName(record.name) : null;
  if (!name) return { ok: false, reason: "no-package-name" };
  const deps: ManifestDependency[] = [];
  const blocks: ReadonlyArray<readonly [ManifestDependency["block"], unknown]> = [
    ["dependencies", record.dependencies],
    ["peerDependencies", record.peerDependencies],
  ];
  for (const [block, value] of blocks) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [rawName, rawSpec] of Object.entries(value as Record<string, unknown>)) {
      const depName = safePackageName(rawName);
      if (!depName) continue;
      const specifier = typeof rawSpec === "string" ? rawSpec.trim().slice(0, 80) : "*";
      deps.push({ name: depName, specifier: specifier || "*", ecosystem: "npm", block });
    }
  }
  return { ok: true, name, deps: deps.slice(0, MAX_DEPENDENCIES) };
}

function parsePyproject(text: string): ParseOutcome {
  const nameMatch = text.match(/^name\s*=\s*["']([^"']+)["']/m);
  const name = nameMatch ? safePackageName(nameMatch[1] ?? "") : null;
  if (!name) return { ok: false, reason: "no-package-name" };
  const deps: ManifestDependency[] = [];
  const block = text.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (block) {
    for (const raw of block[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
      const token = (raw[1] ?? "").trim();
      const depName = safePackageName(token.split(/[\s<>=!~\[]/)[0] ?? "");
      if (!depName) continue;
      deps.push({ name: depName, specifier: token.slice(0, 80), ecosystem: "pypi", block: "dependencies" });
    }
  }
  return { ok: true, name, deps: deps.slice(0, MAX_DEPENDENCIES) };
}

function parseGoMod(text: string): ParseOutcome {
  const moduleMatch = text.match(/^module\s+(\S+)/m);
  const name = moduleMatch ? safePackageName(moduleMatch[1] ?? "") : null;
  if (!name) return { ok: false, reason: "no-package-name" };
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
      block: "require",
    });
  }
  return { ok: true, name, deps: deps.slice(0, MAX_DEPENDENCIES) };
}

type ManifestParse =
  | { readonly ok: true; readonly name: string; readonly deps: ManifestDependency[]; readonly ecosystem: "npm" | "pypi" | "go" }
  | { readonly ok: false; readonly reason: Exclude<ManifestSkipReason, "no-manifest"> };

function withEcosystem(outcome: ParseOutcome, ecosystem: "npm" | "pypi" | "go"): ManifestParse {
  return outcome.ok ? { ...outcome, ecosystem } : outcome;
}

function parseManifest(path: string, text: string): ManifestParse {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? "";
  if (file === "package.json") return withEcosystem(parsePackageJson(text), "npm");
  if (file === "pyproject.toml") return withEcosystem(parsePyproject(text), "pypi");
  if (file === "go.mod") return withEcosystem(parseGoMod(text), "go");
  return { ok: false, reason: "unparseable" };
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
  const sourceId = serviceId(input.repoId, input.packageName);
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
    const targetId = serviceId(input.repoId, dep.name);
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
      props: { specifier: dep.specifier, ecosystem: dep.ecosystem, block: dep.block, manifest: input.sourcePath },
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
  const notIngested = (
    reason: ManifestSkipReason,
    manifest: string | null,
  ): ManifestIngestResult => ({
    status: "skipped", reason, manifest, ecosystem: null, packageName: null, dependencies: 0, skipped: 0,
  });
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
  if (!chosen) return notIngested("no-manifest", null);
  const parsed = parseManifest(chosen.path, chosen.text);
  if (!parsed.ok) return notIngested(parsed.reason, chosen.path);
  const written = writeDependencies(db, {
    repoId: opts.repoId,
    tenantId: opts.tenantId,
    sourcePath: chosen.path,
    packageName: parsed.name,
    deps: parsed.deps,
  });
  return {
    status: "ingested",
    reason: null,
    manifest: chosen.path,
    ecosystem: parsed.ecosystem,
    packageName: parsed.name,
    dependencies: written.dependencies,
    skipped: written.skipped,
  };
}
