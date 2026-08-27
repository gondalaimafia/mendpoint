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
export const MANIFEST_DEPENDENCY_EXTRACTOR = Object.freeze({
  id: "mendpoint.manifest-dependencies",
  version: "2",
  supported: Object.freeze({
    npm: Object.freeze(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]),
    pypi: Object.freeze(["project.dependencies"]),
    go: Object.freeze(["require"]),
  }),
});

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
  rawContentDigest: string | null;
  semanticDigest: string | null;
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

function canonicalManifestText(value: string): string {
  return value.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
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
function logicalServiceId(repoId: string, name: string, tenantId?: string): string {
  return tenantId
    ? `service:v2:${sha256(tenantId, repoId, name).slice("sha256:".length)}`
    : `service:${repoId}:${name}`;
}

function manifestVersionRootId(repoId: string, path: string, versionId: string, tenantId?: string): string {
  return tenantId
    ? `manifest-service:v2:${sha256(tenantId, repoId, path, versionId).slice("sha256:".length)}`
    : `manifest-service:v1:${sha256(repoId, path, versionId).slice("sha256:".length)}`;
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
      if (rawSpec.trim().length > 80) coverageReasons.add(`dependency_specifier_truncated:${block}`);
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
  if (record.bundledDependencies !== undefined || record.bundleDependencies !== undefined) {
    coverageReasons.add("bundled_dependencies_not_expanded");
  }
  if (record.overrides !== undefined || record.resolutions !== undefined || record.pnpm !== undefined) {
    coverageReasons.add("package_manager_topology_not_expanded");
  }
  const byName = new Map<string, ManifestDependency>();
  for (const dependency of deps) {
    const previous = byName.get(dependency.name);
    if (previous && (previous.specifier !== dependency.specifier || previous.scope !== dependency.scope)) {
      coverageReasons.add(`dependency_declaration_conflict:${dependency.name}`);
    }
    byName.set(dependency.name, dependency);
  }
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
      if (token.length > 80) coverageReasons.add("dependency_specifier_truncated:dependencies");
    }
  }
  if (/\[tool\.(?:poetry|uv|pdm)\b/i.test(text)) {
    coverageReasons.add("pyproject_dependency_table_not_expanded");
  }
  if (/\[project\.optional-dependencies\]/i.test(text) || /\[dependency-groups\]/i.test(text)) {
    coverageReasons.add("pyproject_dependency_group_not_expanded");
  }
  if (/^dynamic\s*=\s*\[[^\]]*["']dependencies["']/mi.test(text)) {
    coverageReasons.add("pyproject_dynamic_dependencies_not_expanded");
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
  let requireBlock = false;
  let unsupportedBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("module ") || trimmed.startsWith("go ")) {
      continue;
    }
    if (/^(?:replace|exclude|retract|tool)(?:\s|\()/u.test(trimmed)) {
      coverageReasons.add(`go_${trimmed.split(/[\s(]/u)[0]}_topology_not_expanded`);
      unsupportedBlock = trimmed.endsWith("(");
      continue;
    }
    if (trimmed === "require (") { requireBlock = true; continue; }
    if (trimmed === ")") { requireBlock = false; unsupportedBlock = false; continue; }
    if (unsupportedBlock) continue;
    if (!requireBlock && !trimmed.startsWith("require ")) {
      coverageReasons.add("go_directive_not_expanded");
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

function advanceManifestStreamClock(db: GraphLearnDb, input: {
  tenantId: string;
  repoId: string;
  sourcePath: string;
  observedAt: string;
}): string | undefined {
  const row = db.raw.prepare(
    `SELECT last_observed_at FROM gl_manifest_stream_heads_v1
     WHERE tenant_id = ? AND repository_id = ? AND manifest_stream_path = ?`,
  ).get(input.tenantId, input.repoId, input.sourcePath) as { last_observed_at: string } | undefined;
  if (row && input.observedAt < row.last_observed_at) {
    throw new Error("manifest_ingest_observed_at_non_monotonic");
  }
  db.raw.prepare(
    `INSERT INTO gl_manifest_stream_heads_v1
       (tenant_id, repository_id, manifest_stream_path, last_observed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, repository_id, manifest_stream_path)
     DO UPDATE SET last_observed_at = excluded.last_observed_at`,
  ).run(input.tenantId, input.repoId, input.sourcePath, input.observedAt);
  return row?.last_observed_at;
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
    rawContentDigest: string;
    semanticDigest: string;
    evidenceRefs: readonly string[];
    observedAt: string;
  },
): { dependencies: number; skipped: number; versionId: string } {
  const tenantProps = input.tenantId ? { tenant_id: input.tenantId } : {};
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
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
  const previousInventoryObservation = advanceManifestStreamClock(db, {
    tenantId: tenantKey,
    repoId: input.repoId,
    sourcePath: "__inventory__",
    observedAt: input.observedAt,
  });
  const previousStreamObservation = advanceManifestStreamClock(db, {
    tenantId: tenantKey,
    repoId: input.repoId,
    sourcePath: input.sourcePath,
    observedAt: input.observedAt,
  });
  const roots = listNodesByKind(db, "Service")
    .filter((node) =>
      node.repo_id === input.repoId &&
      String(node.props?.tenant_id ?? "") === tenantKey &&
      node.props?.declared !== true &&
      (node.props?.manifest_valid_to === null || node.props?.manifest_valid_to === undefined) &&
      ["complete", "incomplete", "tombstone"].includes(String(node.props?.manifest_ingest_status ?? "")))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const replayRoot = roots.find((node) =>
    node.props?.manifest_stream_path === input.sourcePath &&
    node.props?.manifest_content_digest === input.contentDigest &&
    node.props?.manifest_semantic_digest === input.semanticDigest &&
    typeof node.props?.manifest_version_id === "string");
  if (replayRoot) {
    const active = edgesFrom(db, replayRoot.id, ["DEPENDS_ON"], { at: input.observedAt });
    if (ownsTransaction) db.raw.exec("COMMIT");
    return { dependencies: active.length, skipped, versionId: String(replayRoot.props!.manifest_version_id) };
  }
  if (previousInventoryObservation === input.observedAt || previousStreamObservation === input.observedAt) {
    throw new Error("manifest_ingest_observed_at_non_monotonic");
  }
  const predecessors = roots.map((node) =>
    String(node.props?.manifest_version_id ?? node.props?.manifest_content_digest ?? node.id));
  const versionId = sha256(
        "manifest-version-v1",
        tenantKey,
        input.repoId,
        input.sourcePath,
        input.packageName,
        input.contentDigest,
        input.semanticDigest,
        ...predecessors,
      );
  const sourceId = manifestVersionRootId(input.repoId, input.sourcePath, versionId, input.tenantId);
  const logicalSourceId = logicalServiceId(input.repoId, input.packageName, input.tenantId);
  const desired = normalizedDependencies.map((dep) => {
    const targetId = logicalServiceId(input.repoId, dep.name, input.tenantId);
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
    for (const root of roots) {
      upsertNode(db, { ...root, props: { ...root.props, manifest_valid_to: input.observedAt } });
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
        manifest_stream_path: input.sourcePath,
        manifest_ingest_status: input.coverageReasons.length ? "incomplete" : "complete",
        manifest_coverage_reasons: [...input.coverageReasons],
        manifest_content_digest: input.contentDigest,
        manifest_raw_content_digest: input.rawContentDigest,
        manifest_semantic_digest: input.semanticDigest,
        manifest_evidence_refs: [...input.evidenceRefs],
        manifest_version_id: versionId,
        manifest_extractor_id: MANIFEST_DEPENDENCY_EXTRACTOR.id,
        manifest_extractor_version: MANIFEST_DEPENDENCY_EXTRACTOR.version,
        logical_service_id: logicalSourceId,
        identity_version: input.tenantId ? 2 : 1,
        legacy_logical_id: `service:${input.repoId}:${input.packageName}`,
        manifest_valid_from: input.observedAt,
        manifest_valid_to: null,
      },
    });
    for (const entry of desired) {
      upsertNode(db, {
        id: entry.targetId,
        kind: "Service",
        label: entry.dep.name,
        repo_id: input.repoId,
        props: {
          ...tenantProps,
          ecosystem: entry.dep.ecosystem,
          declared: true,
          identity_version: input.tenantId ? 2 : 1,
          legacy_logical_id: `service:${input.repoId}:${entry.dep.name}`,
        },
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
            manifest_raw_content_digest: input.rawContentDigest,
            manifest_semantic_digest: input.semanticDigest,
            manifest_extractor_id: MANIFEST_DEPENDENCY_EXTRACTOR.id,
            manifest_extractor_version: MANIFEST_DEPENDENCY_EXTRACTOR.version,
            evidence_refs: [...input.evidenceRefs],
          },
        });
      }
      dependencies++;
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
    return { dependencies, skipped, versionId };
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function writeManifestTombstone(db: GraphLearnDb, input: {
  repoId: string;
  tenantId?: string;
  manifest: string | null;
  reason: ManifestSkipReason;
  contentDigest: string | null;
  rawContentDigest: string | null;
  observedAt: string;
}): string {
  const tenantKey = input.tenantId ?? "";
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const streamPath = input.manifest ?? "__root__";
    const previousInventoryObservation = advanceManifestStreamClock(db, {
      tenantId: tenantKey,
      repoId: input.repoId,
      sourcePath: "__inventory__",
      observedAt: input.observedAt,
    });
    const previousStreamObservation = advanceManifestStreamClock(db, {
      tenantId: tenantKey,
      repoId: input.repoId,
      sourcePath: streamPath,
      observedAt: input.observedAt,
    });
    const roots = listNodesByKind(db, "Service").filter((node) =>
      node.repo_id === input.repoId && String(node.props?.tenant_id ?? "") === tenantKey &&
      node.props?.declared !== true &&
      (node.props?.manifest_valid_to === null || node.props?.manifest_valid_to === undefined) &&
      typeof node.props?.manifest_version_id === "string");
    const semanticDigest = sha256("manifest-tombstone-v2", input.reason, input.manifest ?? "");
    const replay = roots.find((node) =>
      node.props?.manifest_ingest_status === "tombstone" &&
      node.props?.manifest_semantic_digest === semanticDigest &&
      node.props?.manifest_content_digest === input.contentDigest);
    if (replay) {
      if (ownsTransaction) db.raw.exec("COMMIT");
      return String(replay.props!.manifest_version_id);
    }
    if (previousInventoryObservation === input.observedAt || previousStreamObservation === input.observedAt) {
      throw new Error("manifest_ingest_observed_at_non_monotonic");
    }
    const versionId = sha256(
      "manifest-version-v2", tenantKey, input.repoId, input.manifest ?? "__root__",
      input.reason, input.contentDigest ?? "", semanticDigest,
      ...roots.map((root) => String(root.props?.manifest_version_id ?? root.id)).sort(compareCodeUnits),
    );
    for (const root of roots) {
      upsertNode(db, { ...root, props: { ...root.props, manifest_valid_to: input.observedAt } });
      for (const edge of edgesFrom(db, root.id, ["DEPENDS_ON"], { includeInvalidated: true })) {
        if (edge.source_system === "manifest" && edge.valid_to === null) {
          upsertEdge(db, { ...edge, valid_to: input.observedAt });
        }
      }
    }
    upsertNode(db, {
      id: manifestVersionRootId(input.repoId, input.manifest ?? "__root__", versionId, input.tenantId),
      kind: "Service",
      label: "manifest unavailable",
      repo_id: input.repoId,
      props: {
        ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
        manifest: input.manifest,
        manifest_stream_path: input.manifest ?? "__root__",
        manifest_ingest_status: "tombstone",
        manifest_coverage_reasons: [`manifest_${input.reason}`],
        manifest_content_digest: input.contentDigest,
        manifest_raw_content_digest: input.rawContentDigest,
        manifest_semantic_digest: semanticDigest,
        manifest_evidence_refs: input.contentDigest ? [`manifest-ingest:${input.contentDigest}`] : [],
        manifest_version_id: versionId,
        manifest_extractor_id: MANIFEST_DEPENDENCY_EXTRACTOR.id,
        manifest_extractor_version: MANIFEST_DEPENDENCY_EXTRACTOR.version,
        identity_version: input.tenantId ? 2 : 1,
        manifest_valid_from: input.observedAt,
        manifest_valid_to: null,
      },
    });
    if (ownsTransaction) db.raw.exec("COMMIT");
    return versionId;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
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
    rawText?: string,
  ): ManifestIngestResult => {
    const canonicalText = rawText === undefined ? null : canonicalManifestText(rawText);
    const rawContentDigest = rawText === undefined ? null : sha256(rawText);
    const contentDigest = canonicalText === null ? null : sha256(canonicalText);
    const versionId = writeManifestTombstone(db, {
      repoId: opts.repoId,
      tenantId: opts.tenantId,
      manifest,
      reason,
      contentDigest,
      rawContentDigest,
      observedAt,
    });
    return ({
    status: "skipped",
    reason,
    manifest,
    ecosystem: null,
    packageName: null,
    dependencies: 0,
    skipped: 0,
    coverage: "unknown",
    coverageReasons: [`manifest_${reason}`],
    contentDigest,
    rawContentDigest,
    semanticDigest: sha256("manifest-tombstone-v2", reason, manifest ?? ""),
    evidenceRefs: contentDigest ? [`manifest-ingest:${contentDigest}`] : [],
    versionId,
  }); };
  const observedValue = opts.observedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedValue))) throw new Error("manifest_ingest_observed_at_invalid");
  const observedAt = new Date(observedValue).toISOString();
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
  const rawText = chosen.text;
  const canonicalText = canonicalManifestText(rawText);
  const parsed = parseManifest(chosen.path, canonicalText);
  if (!parsed.ok) return notIngested(parsed.reason, chosen.path, rawText);
  const supportedManifestPaths = (opts.files
    ? opts.files.map((file) => file.path)
    : candidates.filter((path) => existsSync(join(opts.repoPath, path))))
    .map((path) => path.replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((path) => ["package.json", "pyproject.toml", "go.mod"].includes(path.split("/").at(-1) ?? ""))
    .sort(compareCodeUnits);
  const inventoryReasons = supportedManifestPaths
    .filter((path) => path !== chosen!.path)
    .map((path) => `supported_manifest_not_ingested:${path}`);
  const coverageReasons = [...new Set([...parsed.coverageReasons, ...inventoryReasons])]
    .sort(compareCodeUnits);
  const rawContentDigest = `sha256:${createHash("sha256").update(rawText, "utf8").digest("hex")}`;
  const contentDigest = `sha256:${createHash("sha256").update(canonicalText, "utf8").digest("hex")}`;
  const semanticDigest = sha256(JSON.stringify({
    extractor: MANIFEST_DEPENDENCY_EXTRACTOR,
    ecosystem: parsed.ecosystem,
    packageName: parsed.name,
    dependencies: [...parsed.deps].sort((left, right) =>
      compareCodeUnits(`${left.name}\u0000${left.block}\u0000${left.specifier}`, `${right.name}\u0000${right.block}\u0000${right.specifier}`)),
    coverageReasons,
  }));
  const evidenceRefs = [`manifest-ingest:${contentDigest}`];
  const written = writeDependencies(db, {
    repoId: opts.repoId,
    tenantId: opts.tenantId,
    sourcePath: chosen.path,
    packageName: parsed.name,
    deps: parsed.deps,
    ecosystem: parsed.ecosystem,
    coverageReasons,
    contentDigest,
    rawContentDigest,
    semanticDigest,
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
    coverage: coverageReasons.length ? "unknown" : "complete",
    coverageReasons,
    contentDigest,
    rawContentDigest,
    semanticDigest,
    evidenceRefs,
    versionId: written.versionId,
  };
}
