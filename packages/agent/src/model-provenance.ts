import { performance } from "node:perf_hooks";
import type { LiveModelProvenanceRecord } from "./types.js";

/** Fail-closed ceiling on retained per-call provenance records. */
export const MAX_LIVE_MODEL_PROVENANCE = 64;

export type LiveModelPrice = Readonly<{
  promptUsdPerMillion: number;
  completionUsdPerMillion: number;
}>;

/**
 * Price table keyed by the EXACT provider model id. Unknown models resolve to
 * a null cost — cost is never guessed.
 */
export const DEFAULT_MODEL_PRICE_TABLE: Readonly<Record<string, LiveModelPrice>> =
  Object.freeze({
    "muse-spark-1.2": Object.freeze({
      promptUsdPerMillion: 1.25,
      completionUsdPerMillion: 4.25,
    }),
    "muse-spark-1.2-contributor": Object.freeze({
      promptUsdPerMillion: 0.1,
      completionUsdPerMillion: 0.2,
    }),
  });

/**
 * Compute the USD cost of a single call from the configured price table.
 * Returns null when the exact model id is not priced.
 */
export function computeModelCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  table: Readonly<Record<string, LiveModelPrice>> = DEFAULT_MODEL_PRICE_TABLE,
): number | null {
  const price = table[model];
  if (!price) return null;
  const prompt = Math.max(0, promptTokens);
  const completion = Math.max(0, completionTokens);
  return (
    (prompt * price.promptUsdPerMillion + completion * price.completionUsdPerMillion) /
    1_000_000
  );
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Build a machine-verifiable provenance record from a successful live call.
 * Captures the body `id`, the `x-request-id` header, the echoed model, token
 * use, the host and protocol actually used, computed cost, and a monotonic
 * timestamp.
 */
export function buildLiveModelProvenance(input: Readonly<{
  url: string;
  headerRequestId: string | null;
  /** Gateway provider id that served the call. Null for the legacy default path. */
  providerId?: string | null;
  body: Readonly<{
    id?: unknown;
    model?: unknown;
    usage?: Readonly<{
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    }>;
  }>;
  priceTable?: Readonly<Record<string, LiveModelPrice>>;
}>): LiveModelProvenanceRecord {
  const parsed = new URL(input.url);
  const model = trimmedString(input.body.model) ?? "";
  const promptTokens = nonNegativeInteger(input.body.usage?.prompt_tokens);
  const completionTokens = nonNegativeInteger(input.body.usage?.completion_tokens);
  const totalTokens = nonNegativeInteger(input.body.usage?.total_tokens);
  return Object.freeze({
    providerId: input.providerId ?? null,
    bodyRequestId: trimmedString(input.body.id),
    headerRequestId: trimmedString(input.headerRequestId),
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    host: parsed.host,
    protocol: parsed.protocol,
    costUsd: model
      ? computeModelCostUsd(model, promptTokens, completionTokens, input.priceTable)
      : null,
    monotonicTimestampMs: performance.now(),
  });
}
