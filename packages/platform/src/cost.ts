/**
 * Cost accounting for harness / agent runs.
 * Estimates tokens, sandbox minutes, graph queries → USD-ish units for dashboards.
 */
export type CostRates = {
  /** USD per 1k tokens */
  per1kTokens: number;
  /** USD per sandbox minute */
  perSandboxMinute: number;
  /** USD per graph query */
  perGraphQuery: number;
};

export const DEFAULT_COST_RATES: CostRates = {
  per1kTokens: 0.002,
  perSandboxMinute: 0.01,
  perGraphQuery: 0.0001,
};

export type CostInput = {
  tokensEst?: number;
  sandboxMinutes?: number;
  graphQueries?: number;
  durationMs?: number;
};

export type CostBreakdown = {
  tokensEst: number;
  sandboxMinutes: number;
  graphQueries: number;
  tokenCostUsd: number;
  sandboxCostUsd: number;
  graphCostUsd: number;
  totalUsd: number;
  rates: CostRates;
};

export function estimateCost(
  input: CostInput,
  rates: CostRates = DEFAULT_COST_RATES,
): CostBreakdown {
  const tokensEst = input.tokensEst ?? 0;
  const sandboxMinutes =
    input.sandboxMinutes ??
    (input.durationMs != null ? input.durationMs / 60_000 : 0);
  const graphQueries = input.graphQueries ?? 0;
  const tokenCostUsd = (tokensEst / 1000) * rates.per1kTokens;
  const sandboxCostUsd = sandboxMinutes * rates.perSandboxMinute;
  const graphCostUsd = graphQueries * rates.perGraphQuery;
  return {
    tokensEst,
    sandboxMinutes,
    graphQueries,
    tokenCostUsd,
    sandboxCostUsd,
    graphCostUsd,
    totalUsd: tokenCostUsd + sandboxCostUsd + graphCostUsd,
    rates,
  };
}

/** Rough token estimate from plan step count + trace length */
export function estimateTokensFromRun(opts: {
  steps: number;
  traceBytes?: number;
  promptChars?: number;
}): number {
  const base = 500 + opts.steps * 200;
  const trace = Math.ceil((opts.traceBytes ?? 0) / 4);
  const prompt = Math.ceil((opts.promptChars ?? 0) / 4);
  return base + trace + prompt;
}

export type CostLedgerEntry = CostBreakdown & {
  runId: string;
  ts: string;
  tenantId?: string;
};

export function formatCost(c: CostBreakdown): string {
  return `cost≈$${c.totalUsd.toFixed(4)} (tokens=${c.tokensEst} sbx=${c.sandboxMinutes.toFixed(3)}m gq=${c.graphQueries})`;
}
