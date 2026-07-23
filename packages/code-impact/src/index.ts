/**
 * Impact Analysis — hybrid multi-stage pipeline.
 *
 *   Surfaces → Index → Candidates → Expand → Confirm → ImpactReport → PR Generation
 */
import {
  buildIndex,
  buildIndexIncremental,
  type CodebaseIndex,
  writeIndex,
  defaultIndexPath,
} from "@mendpoint/codebase-index";
import type {
  Confidence,
  ConfirmedImpact,
  DiffOp,
  ExpandedContext,
  ImpactFinding,
  ImpactReport,
  ImpactableSurface,
  ImpactType,
  StructuralDiff,
} from "@mendpoint/shared";
import { CONF_RANK, confirmedToFinding } from "@mendpoint/shared";
import { discoverCandidates } from "./candidates.js";
import { expandContexts } from "./expand.js";
import { confirmImpacts, partitionByConfidence } from "./confirm.js";

export { discoverCandidates } from "./candidates.js";
export { expandContexts } from "./expand.js";
export { confirmImpacts, partitionByConfidence } from "./confirm.js";

export type AnalyzeOptions = {
  minConfidence?: Confidence;
  index?: CodebaseIndex;
  persistIndex?: boolean;
  useLlm?: boolean;
  surfaces?: ImpactableSurface[];
  sdkHints?: string[];
};

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
    severity: (e.breaking ? "breaking" : "non_breaking") as ImpactableSurface["severity"],
    migrationStrategy: e.detail ?? change.summary,
    explanation: e.detail ?? change.summary,
    searchTokens: [e.path, e.field, e.fromField, e.toField, ...sdkHints].filter(
      Boolean,
    ) as string[],
  }));
}

function overallConfidence(sites: ConfirmedImpact[]): Confidence {
  if (!sites.length) return "low";
  if (sites.every((s) => s.confidence === "high")) return "high";
  if (sites.some((s) => s.confidence === "low") && !sites.some((s) => s.confidence === "high")) {
    return "low";
  }
  return "medium";
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

function buildReport(
  surfaces: ImpactableSurface[],
  candidatesCount: number,
  confirmed: ConfirmedImpact[],
  min: Confidence,
): ImpactReport {
  const { highMedium, low } = partitionByConfidence(confirmed);
  const sites = highMedium.filter((s) => CONF_RANK[s.confidence] >= CONF_RANK[min]);
  const overallRisk = surfaces.some((s) => s.severity === "breaking")
    ? "breaking"
    : surfaces.some((s) => s.severity === "new_capability")
      ? "new_capability"
      : "non_breaking";

  return {
    surfaces,
    sites,
    overallRisk,
    overallConfidence: overallConfidence(sites.length ? sites : low),
    strategySummary: strategySummary(surfaces, sites),
    candidateCount: candidatesCount,
    confirmedCount: confirmed.length,
    lowConfidenceNotifications: low,
  };
}

/** Full hybrid impact analysis → ImpactReport for PR generation. */
export async function analyzeImpact(
  repoRoot: string,
  surfaces: ImpactableSurface[],
  options: AnalyzeOptions = {},
): Promise<ImpactReport> {
  const index = options.index ?? buildIndexIncremental(repoRoot, null);
  if (options.persistIndex) {
    writeIndex(index, defaultIndexPath(repoRoot));
  }

  const candidates = discoverCandidates(index, surfaces);
  const expanded = expandContexts(index, candidates);
  const confirmed = await confirmImpacts(expanded, surfaces, { useLlm: options.useLlm });
  return buildReport(surfaces, candidates.length, confirmed, options.minConfidence ?? "medium");
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
  const index = options.index ?? buildIndex(repoRoot);
  const candidates = discoverCandidates(index, surfaces);
  const expanded = expandContexts(index, candidates);
  const confirmed = staticConfirmAll(expanded, surfaces);
  const report = buildReport(
    surfaces,
    candidates.length,
    confirmed,
    options.minConfidence ?? "medium",
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
