/**
 * Stage: Deep Confirmation (hybrid static + optional LLM).
 * Static first; LLM only on medium/ambiguous slices with budget.
 */
import type {
  Confidence,
  ConfirmedImpact,
  DiffOp,
  ExpandedContext,
  ImpactType,
  ImpactableSurface,
} from "@mendpoint/shared";
import { CONF_RANK } from "@mendpoint/shared";
import {
  confirmWithLlmBudget,
  createBudget,
  resolveLlmConfirmMode,
  type LlmConfirmBudget,
  type LlmConfirmObserver,
} from "./llm-confirm.js";

export { createBudget, resolveLlmConfirmMode } from "./llm-confirm.js";
export type { LlmCallObservation, LlmConfirmObserver } from "./llm-confirm.js";

function impactTypeFor(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
): ImpactType {
  if (ctx.isTestFile) return "test_only";
  const sources = ctx.candidate.sources;
  if (sources.includes("sdk_graph")) return "direct_call";
  if (ctx.candidate.symbol.includes("/") || sources.includes("syntactic")) {
    if (surfaces.some((s) => s.kind === "request_field" || s.kind === "response_field")) {
      if (
        surfaces.some(
          (s) =>
            s.fromField === ctx.candidate.symbol ||
            s.field === ctx.candidate.symbol ||
            s.toField === ctx.candidate.symbol,
        )
      ) {
        return "field_access";
      }
    }
    return "http_path";
  }
  if (ctx.candidate.symbol === "config" || sources.includes("string_heuristic")) {
    return "configuration";
  }
  if (sources.includes("import_expansion")) return "sdk_import";
  if ((ctx.wrappers?.length ?? 0) > 0 || (ctx.graphCallers?.length ?? 0) > 0) {
    if (ctx.candidate.sources.includes("import_expansion")) return "wrapper";
  }
  if (ctx.callers.length > 0 && !ctx.candidate.sources.includes("sdk_graph")) return "wrapper";
  return "unknown";
}

export function staticConfirm(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
): ConfirmedImpact | null {
  const related = surfaces.filter((s) => ctx.candidate.surfaceIds.includes(s.id));
  if (!related.length) return null;

  if (
    ctx.candidate.sources.length === 1 &&
    ctx.candidate.sources[0] === "import_expansion"
  ) {
    return null;
  }

  let confidence: Confidence = ctx.candidate.initialConfidence;
  const impactType = impactTypeFor(ctx, related);

  if (
    ctx.candidate.sources.includes("syntactic") &&
    ctx.candidate.sources.includes("sdk_graph")
  ) {
    confidence = "high";
  }

  if (impactType === "test_only" && confidence === "high") {
    confidence = "medium";
  }

  const ops: DiffOp[] = related.map((s) => s.op);
  const primary = related[0]!;
  const fixHint = primary.migrationStrategy;

  if (
    (primary.kind === "request_field" || primary.kind === "response_field") &&
    primary.fromField &&
    !ctx.slice.includes(primary.fromField) &&
    !ctx.candidate.evidence.includes(primary.fromField)
  ) {
    if (
      !ctx.candidate.sources.includes("syntactic") &&
      !ctx.candidate.sources.includes("sdk_graph")
    ) {
      return null;
    }
  }

  return {
    filePath: ctx.candidate.filePath,
    lineStart: ctx.candidate.lineStart,
    lineEnd: ctx.candidate.lineEnd,
    symbol: ctx.candidate.symbol,
    confidence,
    evidence: ctx.candidate.evidence,
    impactType,
    surfaceIds: ctx.candidate.surfaceIds,
    relatedOps: ops,
    fixHint,
    confirmationPath: "static",
  };
}

/** @deprecated use confirmImpacts — kept for tests */
export async function llmConfirm(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
  staticResult: ConfirmedImpact | null,
): Promise<ConfirmedImpact | null> {
  const budget = createBudget();
  return confirmWithLlmBudget(ctx, surfaces, staticResult, budget);
}

export async function confirmImpacts(
  contexts: ExpandedContext[],
  surfaces: ImpactableSurface[],
  opts: {
    useLlm?: boolean;
    budget?: LlmConfirmBudget;
    /** Observer for each successful live model call (eval provenance lane). */
    onLlmCall?: LlmConfirmObserver;
  } = {},
): Promise<ConfirmedImpact[]> {
  const budget = opts.budget ?? createBudget();
  const confirmed: ConfirmedImpact[] = [];
  const useLlm = opts.useLlm !== false && resolveLlmConfirmMode() !== "off";

  for (const ctx of contexts) {
    let result = staticConfirm(ctx, surfaces);
    if (useLlm && (result === null || result.confidence === "medium")) {
      result = await confirmWithLlmBudget(ctx, surfaces, result, budget, opts.onLlmCall);
    }
    if (result) confirmed.push(result);
  }

  const seen = new Set<string>();
  return confirmed.filter((c) => {
    const k = `${c.filePath}:${c.lineStart}:${c.symbol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function partitionByConfidence(sites: ConfirmedImpact[]): {
  highMedium: ConfirmedImpact[];
  low: ConfirmedImpact[];
} {
  const highMedium: ConfirmedImpact[] = [];
  const low: ConfirmedImpact[] = [];
  for (const s of sites) {
    if (CONF_RANK[s.confidence] >= CONF_RANK.medium) highMedium.push(s);
    else low.push(s);
  }
  return { highMedium, low };
}
