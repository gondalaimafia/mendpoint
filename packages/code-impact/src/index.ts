/**
 * Impact Analysis — hybrid multi-stage pipeline.
 *
 *   Surfaces → Index → Candidates → Expand → Confirm → ImpactReport → PR Generation
 */
import {
  buildIndex,
  buildIndexIncremental,
  materializeCodebaseIndex,
  type CodebaseIndex,
  type CodebaseIndexAuthority,
  type CodebaseIndexReuseEvidence,
  type SdkDetectionContext,
} from "@mendpoint/codebase-index";
import { createHash } from "node:crypto";
import {
  compileFettlerImpactContext,
  getSoftwareGraphHead,
  publishSoftwareGraphVersion,
  queryFettlerEndpointImpact,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import type {
  AmbiguousChange,
  Confidence,
  ConfirmedImpact,
  CoverageGap,
  DiffOp,
  ExpandedContext,
  GeneratedReference,
  GraphPath,
  ImpactCoverage,
  ImpactFinding,
  ImpactReport,
  ImpactableSurface,
  ImpactType,
  OverallConfidence,
  StructuralDiff,
  VendoredReference,
} from "@mendpoint/shared";
import { CONF_RANK, confirmedToFinding } from "@mendpoint/shared";
import {
  discoverCandidates,
  computeProviderReachability,
  type ProviderReachability,
} from "./candidates.js";
import type { UnresolvedImport } from "./lang-import-graph.js";
import { expandContexts } from "./expand.js";
import { confirmImpacts, partitionByConfidence } from "./confirm.js";
import type { LlmConfirmObserver } from "./confirm.js";
import { detectGeneratedFiles } from "./generated.js";
import { detectVendoredFiles } from "./vendored.js";
import {
  materializeFettlerSoftwareGraph,
  type FettlerSoftwareGraphMaterializationInput,
} from "./software-graph-materializer.js";

export { detectGeneratedFiles, isGeneratedFile } from "./generated.js";
export { detectVendoredFiles } from "./vendored.js";
export {
  discoverCandidates,
  computeProviderReachability,
  type ProviderReachability,
} from "./candidates.js";
export {
  buildImporterGraph,
  reachableFromAnchors,
  traverseFromAnchors,
  anchorPathTo,
  type ReachabilityWalk,
  resolveRelativeImport,
} from "./provenance.js";
export { expandContexts } from "./expand.js";
export { confirmImpacts, partitionByConfidence } from "./confirm.js";
export { resolveLlmConfirmMode, createBudget } from "./confirm.js";
export type { LlmCallObservation, LlmConfirmObserver } from "./confirm.js";
export {
  analyzeCapabilityAdoption,
  assessConsumerAdoption,
  consumerUsesCapability,
  type CapabilityConsumerInput,
} from "./capability-adoption.js";

export type AnalyzeOptions = {
  minConfidence?: Confidence;
  index?: CodebaseIndex;
  persistIndex?: boolean;
  useLlm?: boolean;
  surfaces?: ImpactableSurface[];
  sdkHints?: string[];
  /** Tenant and stable repository identity required before persisted reuse. */
  indexAuthority?: CodebaseIndexAuthority;
  /** Receives digest-only evidence for each persisted index decision. */
  onIndexMaterialized?: (evidence: CodebaseIndexReuseEvidence) => void;
  /**
   * Observer for each successful live model call made during confirmation.
   * Only fires when `useLlm` is true and the confirm mode resolves to live.
   * Used by the eval live-model lane to attribute provenance to the call.
   */
  onLlmCall?: LlmConfirmObserver;
};

function analysisIndex(
  repoRoot: string,
  surfaces: ImpactableSurface[],
  options: AnalyzeOptions,
  authorityOverride?: CodebaseIndexAuthority,
): { index: CodebaseIndex; evidence?: CodebaseIndexReuseEvidence } {
  if (options.index) return { index: options.index };
  const sdkContext = sdkContextFromSurfaces(surfaces, options.sdkHints);
  if (!options.persistIndex) {
    return { index: buildIndexIncremental(repoRoot, null, { sdkContext }) };
  }
  const authority = authorityOverride ?? options.indexAuthority;
  if (!authority) throw new Error("codebase_index_authority_required");
  const materialized = materializeCodebaseIndex(repoRoot, {
    authority,
    sdkContext,
    persist: true,
  });
  options.onIndexMaterialized?.(materialized.evidence);
  return materialized;
}

/**
 * Derive provider-driven SDK-detection signals from the change under analysis.
 *
 * The surfaces already encode the provider being analysed: `canonicalId` leads
 * with the provider slug, `path` carries the resource names, and `searchTokens`
 * carry spec-derived field / method tokens. We turn those into receiver names,
 * dotted method paths, method leaves, field names, and import hints so the
 * indexer recognises SDK calls for any provider — including ones we have never
 * seen — instead of only the fixtures baked into the old regex.
 */
export function sdkContextFromSurfaces(
  surfaces: ImpactableSurface[],
  extraHints: string[] = [],
): SdkDetectionContext {
  const receivers = new Set<string>();
  const methodPaths = new Set<string>();
  const methods = new Set<string>();
  const fields = new Set<string>();
  const importHints = new Set<string>();

  const addSlug = (slug: string) => {
    const s = slug.trim();
    if (!s) return;
    importHints.add(s.toLowerCase());
    for (const part of s.split(/[^A-Za-z0-9]+/)) {
      if (part.length >= 3) {
        receivers.add(part.toLowerCase());
        importHints.add(part.toLowerCase());
      }
    }
  };

  const addToken = (raw: string) => {
    const tok = raw?.trim();
    if (!tok || tok.includes("/")) return; // path tokens handled via `path`
    if (tok.includes(".")) {
      methodPaths.add(tok.toLowerCase());
      const parts = tok.toLowerCase().split(".");
      if (parts[0]) receivers.add(parts[0]);
      const leaf = parts[parts.length - 1];
      if (leaf) methods.add(leaf);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) {
      fields.add(tok.toLowerCase());
    }
  };

  for (const s of surfaces) {
    const slug = s.canonicalId.split(".")[0];
    if (slug) addSlug(slug);
    if (s.path) {
      const segs = s.path.split("/").filter((p) => p && !p.startsWith("{"));
      const last = segs[segs.length - 1];
      if (last && /^[A-Za-z0-9_]+$/.test(last)) receivers.add(last.toLowerCase());
    }
    for (const f of [s.field, s.fromField, s.toField]) {
      if (f) fields.add(f.toLowerCase());
    }
    for (const t of s.searchTokens) addToken(t);
  }
  for (const h of extraHints) addToken(h);

  return {
    receivers: [...receivers],
    methodPaths: [...methodPaths],
    methods: [...methods],
    fields: [...fields],
    importHints: [...importHints],
  };
}

function surfacesFromDiff(
  change: StructuralDiff,
  sdkHints: string[] = [],
): ImpactableSurface[] {
  return change.entries.map((e, i) => ({
    id: `synthetic-${i}`,
    canonicalId: [e.op, e.path, e.field, e.fromField].filter(Boolean).join("."),
    kind: (e.op.includes("path")
      ? "http_path"
      : e.op.includes("field")
        ? "request_field"
        : "other") as ImpactableSurface["kind"],
    op: e.op,
    path: e.path,
    method: e.method,
    field: e.field,
    fromField: e.fromField,
    toField: e.toField,
    candidates: e.candidates,
    severity: (e.breaking ? "breaking" : "non_breaking") as ImpactableSurface["severity"],
    migrationStrategy: e.detail ?? change.summary,
    explanation: e.detail ?? change.summary,
    searchTokens: [e.path, e.field, e.fromField, e.toField, ...sdkHints].filter(
      Boolean,
    ) as string[],
  }));
}

function overallConfidence(
  sites: ConfirmedImpact[],
  coverage: ImpactCoverage,
): OverallConfidence {
  if (!sites.length) {
    // An empty result is "clean" (complete evidence of no impact) ONLY when the
    // codebase was fully covered. Under partial or absent coverage it is
    // "unknown": absence of findings then carries no information (§11.7). This is
    // the fix for the collapse where "we found nothing" and "we found nothing
    // because we could not look" both returned "low".
    return coverage.basis === "analyzed" ? "high" : "unknown";
  }
  if (sites.every((s) => s.confidence === "high")) return "high";
  if (sites.some((s) => s.confidence === "low") && !sites.some((s) => s.confidence === "high")) {
    return "low";
  }
  return "medium";
}

/**
 * Derive the coverage/basis discriminator (§11.7, §12.4) from signals the index
 * already carries. The key signal is call-graph
 * {@link CallGraphDiagnostics.unsupportedLanguageFiles}: source that IS in scope
 * but that no front-end can read, which is the difference between "no impact" and
 * "no impact we could see". Routine dependency-directory pruning
 * (`skippedDirectories`) is deliberately NOT treated as a coverage gap — those
 * trees (node_modules, virtualenvs, caches) are out of scope by design, so
 * skipping them does not undermine "complete evidence of no impact in your code".
 * File/byte caps throw during indexing rather than truncate, so a successfully
 * built index never carries a cap gap; the pipeline records that on the failure
 * path instead.
 *
 * `providerUnresolved` carries first-party import specifiers that provider
 * provenance could not resolve to indexed files. When non-empty the reachable
 * set is incomplete, so a match demoted for being unreachable may be a false
 * demote — that is a real coverage gap, and it is exactly what keeps a
 * demoted-to-zero provenance result from reporting `analyzed` with no gaps.
 */
function computeCoverage(
  index: CodebaseIndex,
  providerUnresolved: readonly UnresolvedImport[] = [],
): ImpactCoverage {
  const gaps: CoverageGap[] = [];
  const filesInspected = index.files.length;
  const languagesPresent = [...new Set(index.files.map((f) => f.language))].sort();
  const diagnostics = index.callGraph.diagnostics;
  const languagesSupported = diagnostics?.supportedLanguages
    ? [...diagnostics.supportedLanguages].sort()
    : undefined;

  const unsupported = diagnostics?.unsupportedLanguageFiles ?? [];
  if (unsupported.length) {
    const langs = [...new Set(unsupported.map((u) => u.language))].sort();
    gaps.push({
      reason: "unsupported_language",
      detail: `${unsupported.length} in-scope source file(s) in language(s) with no analysis front-end: ${langs.join(", ")}`,
      count: unsupported.length,
    });
  }

  if (providerUnresolved.length) {
    const langs = [...new Set(providerUnresolved.map((u) => u.language))].sort();
    gaps.push({
      reason: "query_truncated",
      detail: `${providerUnresolved.length} first-party import(s) could not be resolved to indexed files, so provider provenance is incomplete and some findings may be under-attributed (languages: ${langs.join(", ")})`,
      count: providerUnresolved.length,
    });
  }

  const basis: ImpactCoverage["basis"] =
    filesInspected === 0 ? "not_analyzed" : gaps.length ? "partial" : "analyzed";

  const reason =
    basis === "not_analyzed"
      ? "No analyzable source files were indexed (repository empty, unsupported, or pruned to nothing during discovery)."
      : basis === "partial"
        ? gaps.map((g) => g.detail).join("; ")
        : undefined;

  return {
    basis,
    ...(reason ? { reason } : {}),
    gaps,
    filesInspected,
    filesInScope: filesInspected,
    ...(languagesSupported ? { languagesSupported } : {}),
    languagesPresent,
  };
}

function strategySummary(surfaces: ImpactableSurface[], sites: ConfirmedImpact[]): string {
  const strategies = [...new Set(surfaces.map((s) => s.migrationStrategy))];
  const types = [...new Set(sites.map((s) => s.impactType))];
  return [
    `Confirmed ${sites.length} site(s); types: ${types.join(", ") || "none"}.`,
    strategies.slice(0, 3).join(" "),
  ].join(" ");
}

function staticConfirmAll(
  contexts: ExpandedContext[],
  surfaces: ImpactableSurface[],
): ConfirmedImpact[] {
  const results: ConfirmedImpact[] = [];
  for (const ctx of contexts) {
    if (
      ctx.candidate.sources.length === 1 &&
      ctx.candidate.sources[0] === "import_expansion"
    ) {
      continue;
    }

    const related = surfaces.filter((s) => ctx.candidate.surfaceIds.includes(s.id));
    if (!related.length) continue;

    let impactType: ImpactType = "unknown";
    if (ctx.isTestFile) impactType = "test_only";
    else if (ctx.candidate.sources.includes("sdk_graph")) impactType = "direct_call";
    else if (
      related.some(
        (s) =>
          s.fromField === ctx.candidate.symbol ||
          s.field === ctx.candidate.symbol ||
          s.toField === ctx.candidate.symbol,
      )
    ) {
      impactType = "field_access";
    } else if (
      String(ctx.candidate.symbol).includes("/") ||
      ctx.candidate.sources.includes("syntactic")
    ) {
      impactType = "http_path";
    } else if (ctx.candidate.symbol === "config") impactType = "configuration";
    else if (ctx.candidate.sources.includes("import_expansion")) impactType = "sdk_import";

    let confidence = ctx.candidate.initialConfidence;
    if (
      ctx.candidate.sources.includes("syntactic") &&
      ctx.candidate.sources.includes("sdk_graph")
    ) {
      confidence = "high";
    }
    if (impactType === "test_only" && confidence === "high") confidence = "medium";
    if (impactType === "configuration") confidence = "low";

    const ops: DiffOp[] = related.map((s) => s.op);
    results.push({
      filePath: ctx.candidate.filePath,
      lineStart: ctx.candidate.lineStart,
      lineEnd: ctx.candidate.lineEnd,
      symbol: ctx.candidate.symbol,
      confidence,
      evidence: ctx.candidate.evidence,
      impactType,
      surfaceIds: ctx.candidate.surfaceIds,
      relatedOps: ops,
      fixHint: related[0]?.migrationStrategy,
      confirmationPath: "static",
    });
  }

  const seen = new Set<string>();
  return results.filter((c) => {
    const k = `${c.filePath}:${c.lineStart}:${c.symbol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Ambiguous surfaces → the labelled human-decision outcome. */
function ambiguousChangesFrom(surfaces: ImpactableSurface[]): AmbiguousChange[] {
  return surfaces
    .filter(
      (s) =>
        s.op === "request_field_ambiguous" || s.op === "response_field_ambiguous",
    )
    .map((s) => ({
      op: s.op,
      path: s.path,
      method: s.method,
      fromField: s.fromField ?? s.field ?? "",
      candidates: s.candidates ?? [],
      reason: s.explanation,
    }));
}

/**
 * Confirmed impacts that landed in generated files → the labelled
 * regenerate-don't-edit outcome, one entry per generated file. These are pulled
 * out of the confident findings and edit targets, but not dropped: a generated
 * file that references the changed field is a real signal that the customer must
 * regenerate from the updated spec.
 */
function generatedReferencesFrom(
  confirmed: ConfirmedImpact[],
  generatedFiles: Set<string>,
): GeneratedReference[] {
  const seen = new Set<string>();
  const out: GeneratedReference[] = [];
  for (const c of confirmed) {
    if (!generatedFiles.has(c.filePath) || seen.has(c.filePath)) continue;
    seen.add(c.filePath);
    out.push({
      filePath: c.filePath,
      lineStart: c.lineStart,
      symbol: c.symbol,
      evidence: c.evidence,
      relatedOps: c.relatedOps,
      note: "Generated file; regenerate from the updated spec rather than editing in place.",
    });
  }
  return out;
}

/**
 * Confirmed impacts that landed in vendored third-party files → the labelled
 * update-from-upstream outcome, one entry per vendored file. Like generated
 * references these are pulled out of the confident findings and edit targets but
 * not dropped: a vendored copy that carries the changed field is a real signal
 * that the customer must refresh their vendored copy from upstream.
 */
function vendoredReferencesFrom(
  confirmed: ConfirmedImpact[],
  vendoredFiles: Set<string>,
): VendoredReference[] {
  const seen = new Set<string>();
  const out: VendoredReference[] = [];
  for (const c of confirmed) {
    if (!vendoredFiles.has(c.filePath) || seen.has(c.filePath)) continue;
    seen.add(c.filePath);
    out.push({
      filePath: c.filePath,
      lineStart: c.lineStart,
      symbol: c.symbol,
      evidence: c.evidence,
      relatedOps: c.relatedOps,
      note: "Vendored third-party copy; update it from upstream rather than editing in place.",
    });
  }
  return out;
}

function buildReport(
  surfaces: ImpactableSurface[],
  candidatesCount: number,
  confirmed: ConfirmedImpact[],
  min: Confidence,
  coverage: ImpactCoverage,
  generatedFiles: Set<string> = new Set(),
  vendoredFiles: Set<string> = new Set(),
  graphPaths: Map<string, GraphPath> = new Map(),
): ImpactReport {
  // FET-016: attach the provider->code path to each confirmed site by file. This
  // is a pure post-hoc lookup keyed on filePath — it never adds, drops, or
  // reorders sites, so the finding set is identical to the pre-change output,
  // only now carrying a path. A file with no computed path stays path-less
  // ("not computed").
  confirmed = confirmed.map((c) => {
    const path = graphPaths.get(c.filePath);
    return path ? { ...c, graphPath: path } : c;
  });
  const generatedReferences = generatedReferencesFrom(confirmed, generatedFiles);
  const vendoredReferences = vendoredReferencesFrom(
    confirmed.filter((c) => !generatedFiles.has(c.filePath)),
    vendoredFiles,
  );
  // Generated output and vendored third-party copies are never confident
  // findings or edit targets.
  const editable = confirmed.filter(
    (c) => !generatedFiles.has(c.filePath) && !vendoredFiles.has(c.filePath),
  );
  const { highMedium, low } = partitionByConfidence(editable);
  const sites = highMedium.filter((s) => CONF_RANK[s.confidence] >= CONF_RANK[min]);
  const ambiguousChanges = ambiguousChangesFrom(surfaces);
  const overallRisk = surfaces.some((s) => s.severity === "breaking")
    ? "breaking"
    : surfaces.some((s) => s.severity === "new_capability")
      ? "new_capability"
      : "non_breaking";

  const extraNotes: string[] = [];
  if (ambiguousChanges.length) {
    extraNotes.push(
      `${ambiguousChanges.length} ambiguous change(s) need a human decision (not auto-applied).`,
    );
  }
  if (generatedReferences.length) {
    extraNotes.push(
      `${generatedReferences.length} generated file(s) reference this; regenerate rather than edit.`,
    );
  }
  if (vendoredReferences.length) {
    extraNotes.push(
      `${vendoredReferences.length} vendored file(s) reference the changed field; update the vendored copy from upstream.`,
    );
  }

  return {
    surfaces,
    sites,
    overallRisk,
    overallConfidence: overallConfidence(sites.length ? sites : low, coverage),
    coverage,
    strategySummary: [strategySummary(surfaces, sites), ...extraNotes].join(" ").trim(),
    candidateCount: candidatesCount,
    confirmedCount: confirmed.length,
    lowConfidenceNotifications: low,
    ambiguousChanges,
    generatedReferences,
    vendoredReferences,
  };
}

/** Full hybrid impact analysis → ImpactReport for PR generation. */
export async function analyzeImpact(
  repoRoot: string,
  surfaces: ImpactableSurface[],
  options: AnalyzeOptions = {},
): Promise<ImpactReport> {
  const { index } = analysisIndex(repoRoot, surfaces, options);

  const provider: ProviderReachability = computeProviderReachability(index, surfaces);
  const candidates = discoverCandidates(index, surfaces, provider);
  const expanded = expandContexts(index, candidates);
  const confirmed = await confirmImpacts(expanded, surfaces, {
    useLlm: options.useLlm,
    onLlmCall: options.onLlmCall,
  });
  return buildReport(
    surfaces,
    candidates.length,
    confirmed,
    options.minConfidence ?? "medium",
    computeCoverage(index, provider.unresolved),
    detectGeneratedFiles(index),
    detectVendoredFiles(index),
    provider.graphPaths,
  );
}

/**
 * Sync entry for tests and simple callers.
 * Runs Index → Candidates → Expand → Static Confirm (no LLM).
 */
export function analyzeRepo(
  repoRoot: string,
  change: StructuralDiff,
  options: AnalyzeOptions = {},
): ImpactFinding[] {
  const surfaces = options.surfaces ?? surfacesFromDiff(change, options.sdkHints);
  const index =
    options.index ??
    buildIndex(repoRoot, { sdkContext: sdkContextFromSurfaces(surfaces, options.sdkHints) });
  const provider: ProviderReachability = computeProviderReachability(index, surfaces);
  const candidates = discoverCandidates(index, surfaces, provider);
  const expanded = expandContexts(index, candidates);
  const confirmed = staticConfirmAll(expanded, surfaces);
  const report = buildReport(
    surfaces,
    candidates.length,
    confirmed,
    options.minConfidence ?? "medium",
    computeCoverage(index, provider.unresolved),
    detectGeneratedFiles(index),
    detectVendoredFiles(index),
    provider.graphPaths,
  );
  return report.sites.map(confirmedToFinding);
}

export async function analyzeRepoAsync(
  repoRoot: string,
  change: StructuralDiff,
  options: AnalyzeOptions = {},
): Promise<ImpactReport> {
  const surfaces = options.surfaces ?? surfacesFromDiff(change, options.sdkHints);
  return analyzeImpact(repoRoot, surfaces, { ...options, surfaces });
}

export function reportToFindings(report: ImpactReport): ImpactFinding[] {
  return report.sites.map(confirmedToFinding);
}

export type AnalyzeImpactWithSoftwareGraphOptions = Omit<
  FettlerSoftwareGraphMaterializationInput,
  "index" | "endpoint" | "parentVersionId" | "providerEndpointSurfaceCount" |
  "repositoryRevision" | "repositorySnapshotId"
> & {
  graphDb: GraphLearnDb;
  repositoryRevision?: string;
  repositorySnapshotId?: string;
  providerEvidenceRefs?: string[];
  maxContextBytes: number;
  impact?: AnalyzeOptions;
};

/**
 * Build one repository index, preserve the existing ImpactReport behavior, and
 * publish the relationship evidence needed to answer the same Fettler question
 * from one immutable graph version.
 */
export async function analyzeImpactWithSoftwareGraph(
  repoRoot: string,
  surfaces: ImpactableSurface[],
  options: AnalyzeImpactWithSoftwareGraphOptions,
) {
  const endpointSurfaces = surfaces.filter((surface) => surface.path);
  const endpointSurface = endpointSurfaces[0];
  if (!endpointSurface?.path) throw new Error("software_graph_endpoint_surface_required");
  const sdkContext = sdkContextFromSurfaces(surfaces, options.impact?.sdkHints);
  const materialized = analysisIndex(repoRoot, surfaces, options.impact ?? {}, {
    tenantId: options.tenantId,
    repositoryId: options.repositoryId,
  });
  const { index } = materialized;
  const impactReport = await analyzeImpact(repoRoot, surfaces, {
    ...options.impact,
    index,
    persistIndex: false,
  });
  const repositoryRevision = options.repositoryRevision ?? createHash("sha256")
    .update(
      index.files
        .map((file) => `${file.path}\0${file.contentHash}`)
        .sort()
        .join("\n"),
      "utf8",
    )
    .digest("hex");
  const repositorySnapshotId = options.repositorySnapshotId ?? `repository-snapshot:${repositoryRevision}`;
  const head = getSoftwareGraphHead(
    options.graphDb,
    options.tenantId,
    options.repositoryId,
    options.providerId,
  );
  const method = (endpointSurface.method ?? "ANY").toUpperCase();
  const publication = materializeFettlerSoftwareGraph({
    ...options,
    index,
    repositoryRevision,
    repositorySnapshotId,
    parentVersionId: head?.versionId,
    providerEndpointSurfaceCount: endpointSurfaces.length,
    endpoint: {
      canonicalKey: `${method} ${endpointSurface.path}`,
      method,
      path: endpointSurface.path,
      sdkMethodPaths: [...sdkContext.methodPaths],
      evidenceRefs: options.providerEvidenceRefs?.length
        ? options.providerEvidenceRefs
        : [`provider-snapshot:${options.providerSnapshotId}:surface:${endpointSurface.id}`],
    },
  });
  const graphVersion = publishSoftwareGraphVersion(options.graphDb, publication);
  const graphImpact = queryFettlerEndpointImpact(options.graphDb, {
    tenantId: options.tenantId,
    repositoryId: options.repositoryId,
    graphVersionId: graphVersion.versionId,
    endpointKey: publication.entities.find((entity) => entity.kind === "endpoint")!.canonicalKey,
    maxHops: Math.min(12, options.maxCallerHops + 2),
    maxEntities: 500,
    maxRelationships: 1_000,
  });
  const context = compileFettlerImpactContext(graphImpact, { maxBytes: options.maxContextBytes });
  return {
    impactReport,
    graphVersion,
    graphImpact,
    context,
    ...(materialized.evidence ? { indexReuse: materialized.evidence } : {}),
  };
}

export * from "./software-graph-materializer.js";
