/**
 * Budgeted LLM confirmation for medium-confidence impact sites.
 *
 * - Only compact slices + structured surfaces leave the trust boundary (never whole repo).
 * - Caps concurrent / total calls per analysis run (LLM_CONFIRM_MAX, default 12).
 * - Supports OpenAI-compatible APIs: OPENAI_API_KEY, XAI_API_KEY (+ base URLs).
 * - Offline: LLM_CONFIRM_MODE=heuristic applies deterministic rules (CI / no keys).
 */
import { createHash } from "node:crypto";
import {
  enforceModelEndpointEgress,
  fetchBoundedText,
  redactSourceForModel,
  type Confidence,
  type ConfirmedImpact,
  type ExpandedContext,
  type ImpactableSurface,
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
  /**
   * Cumulative token ceiling for the whole analysis run. A call-count cap is not
   * a spend cap when per-call token usage varies by orders of magnitude, so this
   * lane also refuses once observed tokens reach this ceiling. Enforced in
   * `llmConfirmLive` before each call; `usedTokens` accumulates the tokens each
   * successful call actually reported.
   */
  maxTokens: number;
  usedTokens: number;
};

/**
 * Durable reserve/settle boundary for the confirmation model call, mirroring the
 * agent's `AgentExternalModelAccounting`. When supplied, `llmConfirmLive`
 * reserves before the call and settles the observed tokens after, so the call is
 * metered rather than billed to nothing. An accounting failure is a
 * safety-boundary failure and is re-thrown (never swallowed into a static
 * fallback), exactly as the agent treats its own accounting failures.
 */
export type LlmConfirmReservation = Readonly<{
  reservationId: string;
  /** Upper bound of tokens this one call may consume, reserved before egress. */
  maxTokens: number;
}>;

export type LlmConfirmSettlement = Readonly<{
  reservationId: string;
  status: "succeeded" | "failed";
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string | null;
  headerRequestId?: string | null;
}>;

export type LlmConfirmAccounting = Readonly<{
  reserve: (reservation: LlmConfirmReservation) => void | Promise<void>;
  settle: (settlement: LlmConfirmSettlement) => void | Promise<void>;
}>;

/**
 * Per-call token reservation ceiling. The request pins `max_tokens` to 300
 * completion tokens; the prompt adds the bounded slice. This ceiling reserves
 * generously above that so a reservation never rejects an in-budget call, while
 * still being a real per-call bound.
 */
const PER_CALL_TOKEN_RESERVATION = 8_000;

function defaultMaxTokens(maxCalls: number, env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.LLM_CONFIRM_MAX_TOKENS ?? Number.NaN);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  return Math.max(1, maxCalls) * PER_CALL_TOKEN_RESERVATION;
}

/**
 * A single successful live model call, as observed on the wire. Emitted through
 * the optional confirm observer so an eval lane can build machine-verifiable
 * provenance (echoed model, tokens, host) without this package depending on the
 * agent's provenance builder.
 */
export type LlmCallObservation = Readonly<{
  /** Endpoint URL actually contacted. */
  url: string;
  /** `x-request-id` response header, or null when the provider omits it. */
  headerRequestId: string | null;
  /** Response body fields needed to attribute the call. */
  body: Readonly<{
    id?: unknown;
    model?: unknown;
    usage?: Readonly<{
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    }>;
  }>;
}>;

/** Observer invoked once per successful live model call. */
export type LlmConfirmObserver = (observation: LlmCallObservation) => void;

export function createBudget(
  max = Number(process.env.LLM_CONFIRM_MAX ?? 12),
  maxTokens = defaultMaxTokens(max),
): LlmConfirmBudget {
  return { maxCalls: max, used: 0, maxTokens, usedTokens: 0 };
}

function hasLlmKey(env: NodeJS.ProcessEnv = process.env): boolean {
  // This transport is OpenAI-compatible and implements only the OpenAI and xAI
  // credential paths below. An Anthropic-only key cannot authorize either
  // request and must not switch the lane to live mode.
  return Boolean(env.OPENAI_API_KEY || env.XAI_API_KEY);
}

export function resolveLlmConfirmMode(
  env: NodeJS.ProcessEnv = process.env,
): "off" | "heuristic" | "live" {
  const mode = (env.LLM_CONFIRM_MODE ?? "").toLowerCase();
  if (mode === "off") return "off";
  if (mode === "heuristic") return "heuristic";
  if (mode === "live") return hasLlmKey(env) ? "live" : "heuristic";
  // Opt-in only: a live external call requires an explicit LLM_CONFIRM opt-in.
  // The mere presence of an API key must never enable egress of source slices.
  if (env.LLM_CONFIRM === "1" || env.LLM_CONFIRM === "true") {
    return hasLlmKey(env) ? "live" : "heuristic";
  }
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
  onCall?: LlmConfirmObserver,
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

  const endpoint = new URL(`${base.replace(/\/$/, "")}/chat/completions`);
  const loopback =
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "::1" ||
    endpoint.hostname === "[::1]";
  if (
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("llm_confirm_endpoint_invalid");
  }
  // Enforced no-egress mode: code slices may only reach a private, loopback,
  // link-local, unique-local, or operator allowlisted model host. This lane
  // builds its endpoint (including the hardcoded api.x.ai / api.openai.com
  // defaults) outside resolveProviderEndpoint, so it must call the shared
  // enforcement primitive itself. Under local_only a public default throws
  // rather than silently egressing.
  enforceModelEndpointEgress(endpoint.toString(), process.env);
  const configuredTimeout = Number(process.env.LLM_CONFIRM_TIMEOUT_MS ?? 30_000);
  const timeoutMs =
    Number.isSafeInteger(configuredTimeout) &&
    configuredTimeout >= 1 &&
    configuredTimeout <= 120_000
      ? configuredTimeout
      : 30_000;

  const { response: res, text } = await fetchBoundedText(
    endpoint,
    {
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
    },
    {
      timeoutMs,
      maxResponseBytes: 64 * 1_024,
    },
  );
  if (!res.ok) {
    throw new Error(`LLM confirm HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text) as {
    id?: unknown;
    model?: unknown;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    choices?: Array<{ message?: { content?: string } }>;
  };
  // Record what actually answered on the wire (echoed id/model/usage + request
  // id) before returning the content. Fires only on a successful response, so a
  // provenance record always corresponds to a real, billable call.
  if (onCall) {
    onCall(
      Object.freeze({
        url: endpoint.toString(),
        headerRequestId: res.headers.get("x-request-id"),
        body: Object.freeze({ id: json.id, model: json.model, usage: json.usage }),
      }),
    );
  }
  return json.choices?.[0]?.message?.content ?? "";
}

export async function llmConfirmLive(
  ctx: ExpandedContext,
  surfaces: ImpactableSurface[],
  staticResult: ConfirmedImpact | null,
  budget: LlmConfirmBudget,
  onCall?: LlmConfirmObserver,
  accounting?: LlmConfirmAccounting,
): Promise<ConfirmedImpact | null> {
  if (budget.used >= budget.maxCalls) return staticResult;
  // A call-count cap is not a spend cap: refuse once the run has consumed its
  // token ceiling, before any further egress or reservation.
  if (budget.usedTokens >= budget.maxTokens) return staticResult;

  const { system, user } = buildPrompt(ctx, surfaces);
  // Redact secret material from the raw code slices before egress. The engine
  // fails closed on high-entropy residue: if it excludes, send nothing and fall
  // back to the static result rather than leaking an unredacted slice.
  const redaction = redactSourceForModel(
    user,
    Math.min(Math.max(user.length, 1), 1_000_000),
  );
  if (redaction.excluded) return staticResult;

  const reservationId = `llmconfirm_${createHash("sha256")
    .update(`${ctx.candidate.filePath}\0${ctx.candidate.lineStart}\0${ctx.candidate.symbol}\0${budget.used}`)
    .digest("hex")
    .slice(0, 32)}`;
  // Reserve before the call. An accounting failure here is a safety-boundary
  // failure and must propagate — it is NOT swallowed into a static fallback.
  if (accounting) await accounting.reserve({ reservationId, maxTokens: PER_CALL_TOKEN_RESERVATION });

  budget.used++;
  let observedUsage:
    | { input?: number; output?: number; total?: number; model?: unknown; headerRequestId: string | null }
    | undefined;
  const captureUsage: LlmConfirmObserver = (observation) => {
    const usage = observation.body.usage;
    observedUsage = {
      input: usage?.prompt_tokens,
      output: usage?.completion_tokens,
      total: usage?.total_tokens,
      model: observation.body.model,
      headerRequestId: observation.headerRequestId,
    };
    onCall?.(observation);
  };

  let raw: string | undefined;
  let callFailed = false;
  try {
    raw = await callOpenAiCompatible(system, redaction.text, captureUsage);
  } catch {
    // Model-call failure (network/HTTP/timeout) fails closed to the static
    // result. Accounting failures are handled separately below and propagate.
    callFailed = true;
  }

  // Meter what the call actually consumed. Token counts accumulate onto the
  // run budget so the NEXT call refuses once the token ceiling is reached, and
  // settle records the call rather than leaving it billed to nothing. A settle
  // failure is a safety-boundary failure and propagates.
  const totalTokens =
    observedUsage?.total ??
    (observedUsage && (observedUsage.input !== undefined || observedUsage.output !== undefined)
      ? (observedUsage.input ?? 0) + (observedUsage.output ?? 0)
      : undefined);
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
    budget.usedTokens += totalTokens;
  }
  if (accounting) {
    await accounting.settle({
      reservationId,
      status: callFailed ? "failed" : "succeeded",
      ...(observedUsage?.input !== undefined ? { inputTokens: observedUsage.input } : {}),
      ...(observedUsage?.output !== undefined ? { outputTokens: observedUsage.output } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(typeof observedUsage?.model === "string" ? { model: observedUsage.model } : {}),
      ...(observedUsage ? { headerRequestId: observedUsage.headerRequestId } : {}),
    });
  }

  if (callFailed || raw === undefined) return staticResult;
  try {
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
  onCall?: LlmConfirmObserver,
  accounting?: LlmConfirmAccounting,
): Promise<ConfirmedImpact | null> {
  const mode = resolveLlmConfirmMode();
  if (mode === "off") return staticResult;

  // Only budget LLM for medium or missing static (precision path)
  if (staticResult && staticResult.confidence === "high") return staticResult;

  if (mode === "heuristic") {
    return heuristicConfirm(ctx, surfaces, staticResult);
  }
  return llmConfirmLive(ctx, surfaces, staticResult, budget, onCall, accounting);
}
