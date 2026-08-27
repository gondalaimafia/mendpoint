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
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  edgesFrom,
  listNodesByKind,
  upsertEdge,
  upsertNode,
  type GraphLearnDb,
} from "./store.js";

const PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const GO_MODULE = /^[A-Za-z0-9._~+/-]+$/;
const MAX_DEPENDENCIES = 500;

export type ManifestDependency = Readonly<{
  name: string;
  specifier: string;
  ecosystem: "npm" | "pypi" | "go";
  scope: "repository_local" | "external_registry";
  /** Manifest block the edge came from; a peer/optional dep is a weaker claim than a runtime one. */
  block: "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies" | "require";
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
  coverage: "complete" | "unknown";
  coverageReasons: readonly string[];
  contentDigest: string | null;
  evidenceRefs: readonly string[];
  versionId: string | null;
}>;

/**
 * Discriminated parse outcome so a missing/path-like package name is not
 * conflated with genuinely unparseable text (both once collapsed to `null`).
 */
type ParseOutcome =
  | {
      readonly ok: true;
      readonly name: string;
      readonly deps: ManifestDependency[];
      readonly coverageReasons: readonly string[];
    }
  | { readonly ok: false; readonly reason: Exclude<ManifestSkipReason, "no-manifest"> };

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(...values: readonly string[]): string {
  return `sha256:${createHash("sha256").update(values.join("\u0000"), "utf8").digest("hex")}`;
}

function npmDependencyScope(specifier: string): ManifestDependency["scope"] {
  return /^(?:workspace:|file:|link:|portal:|\.\.?[\\/])/i.test(specifier)
    ? "repository_local"
    : "external_registry";
}

function pythonDependencyScope(specifier: string): ManifestDependency["scope"] {
  return /(?:^|\s)@\s*(?:file:|\.\.?[\\/])|^(?:file:|\.\.?[\\/])/i.test(specifier)
    ? "repository_local"
    : "external_registry";
}

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
  const coverageReasons = new Set<string>();
  const blocks: ReadonlyArray<readonly [ManifestDependency["block"], unknown]> = [
    ["dependencies", record.dependencies],
    ["devDependencies", record.devDependencies],
    ["optionalDependencies", record.optionalDependencies],
    ["peerDependencies", record.peerDependencies],
  ];
  for (const [block, value] of blocks) {
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      coverageReasons.add(`manifest_block_unrepresented:${block}`);
      continue;
    }
    for (const [rawName, rawSpec] of Object.entries(value as Record<string, unknown>)) {
      const depName = safePackageName(rawName);
      if (!depName || typeof rawSpec !== "string" || !rawSpec.trim()) {
        coverageReasons.add(`dependency_declaration_unrepresented:${block}`);
        continue;
      }
      const specifier = rawSpec.trim().slice(0, 80);
      deps.push({
        name: depName,
        specifier,
        ecosystem: "npm",
        block,
        scope: npmDependencyScope(specifier),
      });
    }
  }
  if (record.workspaces !== undefined) coverageReasons.add("workspace_manifest_not_expanded");
  if (deps.length > MAX_DEPENDENCIES) coverageReasons.add("manifest_dependency_limit_exceeded");
  return {
    ok: true,
    name,
    deps: deps.slice(0, MAX_DEPENDENCIES),
    coverageReasons: [...coverageReasons].sort(compareCodeUnits),
  };
}

function parsePyproject(text: string): ParseOutcome {
  const nameMatch = text.match(/^name\s*=\s*["']([^"']+)["']/m);
  const name = nameMatch ? safePackageName(nameMatch[1] ?? "") : null;
  if (!name) return { ok: false, reason: "no-package-name" };
  const deps: ManifestDependency[] = [];
  const coverageReasons = new Set<string>();
  const block = text.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (block) {
    for (const raw of block[1]?.matchAll(/["']([^"']+)["']/g) ?? []) {
      const token = (raw[1] ?? "").trim();
      const depName = safePackageName(token.split(/[\s<>=!~\[]/)[0] ?? "");
      if (!depName) {
        coverageReasons.add("dependency_declaration_unrepresented:dependencies");
        continue;
      }
      deps.push({
        name: depName,
        specifier: token.slice(0, 80),
        ecosystem: "pypi",
        block: "dependencies",
        scope: pythonDependencyScope(token),
      });
    }
  }
  if (/\[tool\.(?:poetry|uv|pdm)\b/i.test(text)) {
    coverageReasons.add("pyproject_dependency_table_not_expanded");
  }
  if (deps.length > MAX_DEPENDENCIES) coverageReasons.add("manifest_dependency_limit_exceeded");
  return {
    ok: true,
    name,
    deps: deps.slice(0, MAX_DEPENDENCIES),
    coverageReasons: [...coverageReasons].sort(compareCodeUnits),
  };
}

function parseGoMod(text: string): ParseOutcome {
  const moduleMatch = text.match(/^module\s+(\S+)/m);
  const name = moduleMatch ? safePackageName(moduleMatch[1] ?? "") : null;
  if (!name) return { ok: false, reason: "no-package-name" };
  const deps: ManifestDependency[] = [];
  const coverageReasons = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("module ") || trimmed.startsWith("go ") || trimmed === "require (" || trimmed === ")") {
      continue;
    }
    const requireLine = trimmed.replace(/^require\s+/, "");
    const parts = requireLine.split(/\s+/);
    const depName = safePackageName(parts[0] ?? "");
    if (!depName) {
      if (requireLine && !requireLine.startsWith("//")) {
        coverageReasons.add("dependency_declaration_unrepresented:require");
      }
      continue;
    }
    if (depName === name) continue;
    deps.push({
      name: depName,
      specifier: (parts[1] ?? "*").slice(0, 80),
      ecosystem: "go",
      block: "require",
      scope: "external_registry",
    });
  }
  if (/^replace\s+/m.test(text) || /^\s*replace\s*\(/m.test(text)) {
    coverageReasons.add("go_replace_topology_not_expanded");
  }
  if (deps.length > MAX_DEPENDENCIES) coverageReasons.add("manifest_dependency_limit_exceeded");
  return {
    ok: true,
    name,
    deps: deps.slice(0, MAX_DEPENDENCIES),
    coverageReasons: [...coverageReasons].sort(compareCodeUnits),
  };
}

type ManifestParse =
  | {
      readonly ok: true;
      readonly name: string;
      readonly deps: ManifestDependency[];
      readonly ecosystem: "npm" | "pypi" | "go";
      readonly coverageReasons: readonly string[];
    }
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
    ecosystem: "npm" | "pypi" | "go";
    coverageReasons: readonly string[];
    contentDigest: string;
    evidenceRefs: readonly string[];
    observedAt: string;
  },
): { dependencies: number; skipped: number; versionId: string } {
  const tenantProps = input.tenantId ? { tenant_id: input.tenantId } : {};
  const sourceId = serviceId(input.repoId, input.packageName);
  let dependencies = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const normalizedDependencies: ManifestDependency[] = [];
  for (const dep of input.deps) {
    if (dep.name === input.packageName || seen.has(dep.name)) {
      skipped++;
      continue;
    }
    seen.add(dep.name);
    normalizedDependencies.push(dep);
  }
  const tenantKey = input.tenantId ?? "";
  const roots = listNodesByKind(db, "Service")
    .filter((node) =>
      node.repo_id === input.repoId &&
      String(node.props?.tenant_id ?? "") === tenantKey &&
      node.props?.declared !== true &&
      node.props?.manifest === input.sourcePath &&
      ["complete", "incomplete"].includes(String(node.props?.manifest_ingest_status ?? "")))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const replayRoot = roots.find((node) =>
    node.id === sourceId &&
    node.props?.manifest_content_digest === input.contentDigest &&
    typeof node.props?.manifest_version_id === "string");
  const predecessors = roots.map((node) =>
    String(node.props?.manifest_version_id ?? node.props?.manifest_content_digest ?? node.id));
  const versionId = replayRoot
    ? String(replayRoot.props!.manifest_version_id)
    : sha256(
        "manifest-version-v1",
        tenantKey,
        input.repoId,
        input.sourcePath,
        input.packageName,
        input.contentDigest,
        ...predecessors,
      );
  const desired = normalizedDependencies.map((dep) => {
    const targetId = serviceId(input.repoId, dep.name);
    return {
      dep,
      targetId,
      edgeId: `DEPENDS_ON:manifest:${sha256(
        tenantKey,
        input.repoId,
        versionId,
        sourceId,
        targetId,
      ).slice("sha256:".length)}`,
    };
  });
  const desiredEdgeIds = new Set(desired.map((entry) => entry.edgeId));
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const root of roots) {
      if (root.id !== sourceId || root.props?.manifest_content_digest !== input.contentDigest) {
        upsertNode(db, {
          ...root,
          props: {
            ...root.props,
            manifest_ingest_status: "superseded",
            manifest_valid_to: input.observedAt,
          },
        });
      }
      for (const edge of edgesFrom(db, root.id, ["DEPENDS_ON"], { includeInvalidated: true })) {
        if (
          edge.source_system === "manifest" &&
          edge.valid_to === null &&
          edge.props?.manifest === input.sourcePath &&
          !desiredEdgeIds.has(edge.id)
        ) {
          upsertEdge(db, { ...edge, valid_to: input.observedAt });
        }
      }
    }
    upsertNode(db, {
      id: sourceId,
      kind: "Service",
      label: input.packageName,
      repo_id: input.repoId,
      props: {
        ...tenantProps,
        ecosystem: input.ecosystem,
        manifest: input.sourcePath,
        manifest_ingest_status: input.coverageReasons.length ? "incomplete" : "complete",
        manifest_coverage_reasons: [...input.coverageReasons],
        manifest_content_digest: input.contentDigest,
        manifest_evidence_refs: [...input.evidenceRefs],
        manifest_version_id: versionId,
        manifest_valid_from: replayRoot?.props?.manifest_valid_from ?? input.observedAt,
        manifest_valid_to: null,
      },
    });
    for (const entry of desired) {
      upsertNode(db, {
        id: entry.targetId,
        kind: "Service",
        label: entry.dep.name,
        repo_id: input.repoId,
        props: { ...tenantProps, ecosystem: entry.dep.ecosystem, declared: true },
      });
      const activeReplay = edgesFrom(db, sourceId, ["DEPENDS_ON"], { includeInvalidated: true })
        .find((edge) => edge.id === entry.edgeId && edge.valid_to === null);
      if (!activeReplay) {
        upsertEdge(db, {
          id: entry.edgeId,
          kind: "DEPENDS_ON",
          source: sourceId,
          target: entry.targetId,
          valid_from: input.observedAt,
          valid_to: null,
          source_system: "manifest",
          confidence: 1,
          props: {
            specifier: entry.dep.specifier,
            ecosystem: entry.dep.ecosystem,
            block: entry.dep.block,
            dependency_scope: entry.dep.scope,
            manifest: input.sourcePath,
            manifest_version_id: versionId,
            manifest_content_digest: input.contentDigest,
            evidence_refs: [...input.evidenceRefs],
          },
        });
      }
      dependencies++;
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return { dependencies, skipped, versionId };
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
    observedAt?: string;
  },
): ManifestIngestResult {
  const notIngested = (
    reason: ManifestSkipReason,
    manifest: string | null,
  ): ManifestIngestResult => ({
    status: "skipped",
    reason,
    manifest,
    ecosystem: null,
    packageName: null,
    dependencies: 0,
    skipped: 0,
    coverage: "unknown",
    coverageReasons: [`manifest_${reason}`],
    contentDigest: null,
    evidenceRefs: [],
    versionId: null,
  });
  const observedAt = opts.observedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt))) throw new Error("manifest_ingest_observed_at_invalid");
  const candidates = ["package.json", "pyproject.toml", "go.mod"] as const;
  let chosen: { path: string; text: string } | undefined;
  if (opts.files) {
    for (const name of candidates) {
      const match = opts.files.find((file) =>
        file.path.replace(/\\/g, "/").replace(/^\.\//, "") === name);
      if (match) {
        chosen = match;
        break;
      }
    }
  } else if (existsSync(opts.repoPath)) {
    for (const name of candidates) {
      const absolutePath = join(opts.repoPath, name);
      if (!existsSync(absolutePath)) continue;
      chosen = { path: name, text: readFileSync(absolutePath, "utf8") };
      break;
    }
  }
  if (!chosen) return notIngested("no-manifest", null);
  const parsed = parseManifest(chosen.path, chosen.text);
  if (!parsed.ok) return notIngested(parsed.reason, chosen.path);
  const contentDigest = `sha256:${createHash("sha256").update(chosen.text, "utf8").digest("hex")}`;
  const evidenceRefs = [`manifest-ingest:${contentDigest}`];
  const written = writeDependencies(db, {
    repoId: opts.repoId,
    tenantId: opts.tenantId,
    sourcePath: chosen.path,
    packageName: parsed.name,
    deps: parsed.deps,
    ecosystem: parsed.ecosystem,
    coverageReasons: parsed.coverageReasons,
    contentDigest,
    evidenceRefs,
    observedAt,
  });
  return {
    status: "ingested",
    reason: null,
    manifest: chosen.path,
    ecosystem: parsed.ecosystem,
    packageName: parsed.name,
    dependencies: written.dependencies,
    skipped: written.skipped,
    coverage: parsed.coverageReasons.length ? "unknown" : "complete",
    coverageReasons: parsed.coverageReasons,
    contentDigest,
    evidenceRefs,
    versionId: written.versionId,
  };
}
