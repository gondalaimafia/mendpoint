/**
 * Budgeted LLM confirmation for medium-confidence impact sites.
 *
 * - Only compact slices + structured surfaces leave the trust boundary (never whole repo).
 * - Caps concurrent / total calls per analysis run (LLM_CONFIRM_MAX, default 12).
 * - Supports OpenAI-compatible APIs: OPENAI_API_KEY, XAI_API_KEY (+ base URLs).
 * - Offline: LLM_CONFIRM_MODE=heuristic applies deterministic rules (CI / no keys).
 */
import type {
  Confidence,
  ConfirmedImpact,
  ExpandedContext,
  ImpactableSurface,
} from "@mendpoint/shared";

export type LlmConfirmDecision = {
  affected: boolean;
  confidence: Confidence;
  impactType?: ConfirmedImpact["impactType"];
  fixHint?: string;
  rationale: string;
};

export type LlmConfirmBudget = {
  maxCalls: number;
  used: number;
};

export function createBudget(max = Number(process.env.LLM_CONFIRM_MAX ?? 12)): LlmConfirmBudget {
  return { maxCalls: max, used: 0 };
}

function hasLlmKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.XAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

export function resolveLlmConfirmMode(): "off" | "heuristic" | "live" {
  const mode = (process.env.LLM_CONFIRM_MODE ?? "").toLowerCase();
  if (mode === "off") return "off";
  if (mode === "heuristic") return "heuristic";
  if (mode === "live") return hasLlmKey() ? "live" : "heuristic";
  // default: live if key, else off (preserve static-only unless asked)
  if (process.env.LLM_CONFIRM === "1" || process.env.LLM_CONFIRM === "true") {
    return hasLlmKey() ? "live" : "heuristic";
  }
  if (hasLlmKey()) return "live";
  return "off";
}

function buildPrompt(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
): { system: string; user: string } {
  const related = surfaces.filter((s) => ctx.candidate.surfaceIds.includes(s.id));
  const system = `You are a precise API impact analyst. Given a structured API change and a small code slice, decide if the site is affected.
Reply with ONLY compact JSON:
{"affected":boolean,"confidence":"high"|"medium"|"low","impactType":"direct_call"|"field_access"|"http_path"|"configuration"|"wrapper"|"test_only"|"sdk_import"|"unknown","fixHint":string,"rationale":string}
Rules:
- Prefer precision over recall (false positives are costly).
- If the slice clearly uses a renamed/removed field or path, confidence high.
- If ambiguous or only string coincidence, confidence low or affected false.
- Never invent files outside the slice.`;

  const user = JSON.stringify(
    {
      file: ctx.candidate.filePath,
      line: ctx.candidate.lineStart,
      symbol: ctx.candidate.symbol,
      evidence: ctx.candidate.evidence,
      sources: ctx.candidate.sources,
      isTestFile: ctx.isTestFile,
      enclosingFunction: ctx.enclosingFunction,
      callers: ctx.callers.slice(0, 8),
      wrappers: (ctx.wrappers ?? []).slice(0, 5),
      slice: ctx.slice.slice(0, 2500),
      surfaces: related.map((s) => ({
        op: s.op,
        path: s.path,
        fromField: s.fromField,
        toField: s.toField,
        field: s.field,
        severity: s.severity,
        strategy: s.migrationStrategy,
      })),
    },
    null,
    0,
  );

  return { system, user };
}

function parseDecision(raw: string): LlmConfirmDecision | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    const j = JSON.parse(raw.slice(start, end + 1)) as LlmConfirmDecision;
    if (typeof j.affected !== "boolean") return null;
    if (!["high", "medium", "low"].includes(j.confidence)) return null;
    return j;
  } catch {
    return null;
  }
}

/** Deterministic offline stand-in when no API key (still exercises hybrid path). */
export function heuristicConfirm(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
  staticResult: ConfirmedImpact | null,
): ConfirmedImpact | null {
  const related = surfaces.filter((s) => ctx.candidate.surfaceIds.includes(s.id));
  const slice = `${ctx.slice}\n${ctx.candidate.evidence}`;
  let hits = 0;
  for (const s of related) {
    for (const t of [s.fromField, s.field, s.path, ...(s.searchTokens ?? [])]) {
      if (t && t.length > 2 && slice.includes(t)) hits++;
    }
  }
  if (hits === 0 && staticResult) {
    return {
      ...staticResult,
      confidence: "low",
      confirmationPath: "hybrid_llm",
      fixHint: staticResult.fixHint,
    };
  }
  if (hits === 0) return null;

  const base = staticResult ?? {
    filePath: ctx.candidate.filePath,
    lineStart: ctx.candidate.lineStart,
    lineEnd: ctx.candidate.lineEnd,
    symbol: ctx.candidate.symbol,
    confidence: "medium" as Confidence,
    evidence: ctx.candidate.evidence,
    impactType: "unknown" as const,
    surfaceIds: ctx.candidate.surfaceIds,
    relatedOps: related.map((s) => s.op),
    fixHint: related[0]?.migrationStrategy,
    confirmationPath: "hybrid_llm" as const,
  };

  const confidence: Confidence = hits >= 2 ? "high" : "medium";
  return {
    ...base,
    confidence,
    confirmationPath: "hybrid_llm",
    fixHint: related[0]?.migrationStrategy ?? base.fixHint,
  };
}

async function callOpenAiCompatible(
  system: string,
  user: string,
): Promise<string> {
  const xai = process.env.XAI_API_KEY;
  const oai = process.env.OPENAI_API_KEY;
  const base = xai
    ? process.env.XAI_API_BASE ?? "https://api.x.ai/v1"
    : process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
  const key = xai ?? oai!;
  const model =
    process.env.LLM_CONFIRM_MODEL ??
    (xai ? "grok-3-mini" : "gpt-4o-mini");

  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM confirm HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

export async function llmConfirmLive(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
  staticResult: ConfirmedImpact | null,
  budget: LlmConfirmBudget,
): Promise<ConfirmedImpact | null> {
  if (budget.used >= budget.maxCalls) return staticResult;
  budget.used++;

  const { system, user } = buildPrompt(ctx, surfaces);
  try {
    const raw = await callOpenAiCompatible(system, user);
    const decision = parseDecision(raw);
    if (!decision) return staticResult;
    if (!decision.affected) {
      return staticResult
        ? { ...staticResult, confidence: "low", confirmationPath: "hybrid_llm" }
        : null;
    }
    const base = staticResult ?? {
      filePath: ctx.candidate.filePath,
      lineStart: ctx.candidate.lineStart,
      lineEnd: ctx.candidate.lineEnd,
      symbol: ctx.candidate.symbol,
      confidence: decision.confidence,
      evidence: ctx.candidate.evidence,
      impactType: decision.impactType ?? "unknown",
      surfaceIds: ctx.candidate.surfaceIds,
      relatedOps: surfaces
        .filter((s) => ctx.candidate.surfaceIds.includes(s.id))
        .map((s) => s.op),
      confirmationPath: "hybrid_llm" as const,
    };
    return {
      ...base,
      confidence: decision.confidence,
      impactType: decision.impactType ?? base.impactType,
      fixHint: decision.fixHint ?? base.fixHint,
      confirmationPath: "hybrid_llm",
    };
  } catch {
    // Fail closed to static result on LLM errors
    return staticResult;
  }
}

/**
 * Confirm medium/null static results only. High-confidence static skips LLM (budget).
 */
export async function confirmWithLlmBudget(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
  staticResult: ConfirmedImpact | null,
  budget: LlmConfirmBudget,
): Promise<ConfirmedImpact | null> {
  const mode = resolveLlmConfirmMode();
  if (mode === "off") return staticResult;

  // Only budget LLM for medium or missing static (precision path)
  if (staticResult && staticResult.confidence === "high") return staticResult;

  if (mode === "heuristic") {
    return heuristicConfirm(ctx, surfaces, staticResult);
  }
  return llmConfirmLive(ctx, surfaces, staticResult, budget);
}
