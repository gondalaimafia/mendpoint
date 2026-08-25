/**
 * Graph-RAG v1 query picker — deterministic ranking of which template to run.
 * Optional LLM hook later; v1 is keyword + intent scoring only.
 */
import type { GraphQuery } from "./schema.js";
import { GRAPH_RAG_TOOLS } from "./query.js";

export type QueryPick = {
  query: GraphQuery;
  score: number;
  reason: string;
  alternatives: Array<{ op: string; score: number }>;
};

const RULES: Array<{
  re: RegExp;
  op: GraphQuery["op"];
  build: (m: RegExpMatchArray, text: string) => GraphQuery;
  weight: number;
}> = [
  {
    re: /who\s+consumes|consumers?\s+of|which\s+apps/i,
    op: "who_consumes_provider",
    build: (_m, text) => {
      const slug =
        text.match(/provider[:\s]+([a-z0-9_-]+)/i)?.[1] ??
        text.match(/\b([a-z][a-z0-9_-]{2,})\b/)?.[1] ??
        "acme";
      return { op: "who_consumes_provider", providerSlug: slug };
    },
    weight: 10,
  },
  {
    re: /blast\s*radius|impact\s+of|what\s+breaks/i,
    op: "blast_radius",
    build: (_m, text) => {
      const id =
        text.match(/change:[\w-]+/)?.[0] ??
        text.match(/node[:\s]+([\w:.-]+)/i)?.[1] ??
        "change:ch1";
      return { op: "blast_radius", nodeId: id, maxHops: 2 };
    },
    weight: 10,
  },
  {
    re: /callers?|who\s+calls/i,
    op: "callers",
    build: (_m, text) => {
      const id =
        text.match(/symbol:[\w/.:-]+/)?.[0] ??
        text.match(/symbol[:\s]+([\w.]+)/i)?.[1] ??
        "symbol:missing";
      return { op: "callers", symbolId: id };
    },
    weight: 9,
  },
  {
    re: /success\s*rate|pattern\s+rank|learned/i,
    op: "pattern_success_rates",
    build: () => ({ op: "pattern_success_rates", minSamples: 1 }),
    weight: 8,
  },
  {
    re: /time\s*travel|as\s+of|historical\s+calls|at\s+timestamp/i,
    op: "time_travel_calls",
    build: (_m, text) => {
      const at =
        text.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/)?.[0] ??
        new Date().toISOString();
      return { op: "time_travel_calls", at };
    },
    weight: 8,
  },
  {
    re: /modif(?:y|ied)|git\s+history|touched\s+files/i,
    op: "time_travel_modifies",
    build: (_m, text) => {
      const at =
        text.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/)?.[0] ??
        new Date().toISOString();
      return { op: "time_travel_modifies", at };
    },
    weight: 7,
  },
  {
    re: /broke|failure\s+mode|break\s+mode/i,
    op: "broke_modes_for_endpoint",
    build: (_m, text) => {
      const opId =
        text.match(/operation[:\s]+([\w/.-]+)/i)?.[1] ??
        text.match(/\b([a-z]+(?:_[a-z]+)*)\b/)?.[1] ??
        "charges";
      return { op: "broke_modes_for_endpoint", operationId: opId };
    },
    weight: 8,
  },
  // No rule routes to `invariants_for_symbol` while PRESERVES_INVARIANT has no
  // ingest producer. `migration_ready_units` is restored now that
  // ingestManifestDependencies writes DEPENDS_ON; the handler still fails
  // closed when that relation is empty.
  {
    re: /ready\s+units|migration\s+ready|units\s+are\s+ready/i,
    op: "migration_ready_units",
    build: (_m, text) => {
      const campaignId =
        text.match(/campaign[:\s]+([\w-]+)/i)?.[1] ??
        text.match(/\bcamp-[\w-]+\b/i)?.[0] ??
        "unknown";
      return { op: "migration_ready_units", campaignId };
    },
    weight: 7,
  },
  {
    re: /latency|slo|p99|p50/i,
    op: "latency_stats",
    build: () => ({ op: "latency_stats" }),
    weight: 6,
  },
  {
    re: /stats|how\s+many\s+nodes|graph\s+size/i,
    op: "stats",
    build: () => ({ op: "stats" }),
    weight: 5,
  },
];

export function pickGraphQuery(naturalLanguage: string): QueryPick {
  const text = naturalLanguage.trim();
  const scored: Array<{ op: string; score: number; query: GraphQuery; reason: string }> =
    [];

  for (const rule of RULES) {
    if (rule.re.test(text)) {
      const m = text.match(rule.re)!;
      scored.push({
        op: rule.op,
        score: rule.weight,
        query: rule.build(m, text),
        reason: `matched /${rule.re.source}/`,
      });
    }
  }

  if (!scored.length) {
    return {
      query: { op: "stats" },
      score: 1,
      reason: "default fallback",
      alternatives: GRAPH_RAG_TOOLS.slice(0, 5).map((op) => ({
        op,
        score: 0,
      })),
    };
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  return {
    query: best.query,
    score: best.score,
    reason: best.reason,
    alternatives: scored.slice(1, 5).map((s) => ({ op: s.op, score: s.score })),
  };
}

/** Rank ops by outcome success rates for planner injection */
export function rankOpsByOutcomes(
  patternRows: Array<Record<string, unknown>>,
): Array<{ pattern: string; successRate: number; samples: number }> {
  return patternRows
    .map((r) => ({
      pattern: String(r.pattern ?? ""),
      successRate: Number(r.successRate ?? 0),
      samples: Number(r.samples ?? 0),
    }))
    .filter((r) => r.pattern)
    .sort((a, b) => b.successRate - a.successRate || b.samples - a.samples);
}
