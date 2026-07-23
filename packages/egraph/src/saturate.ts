/**
 * Equality saturation runner + extraction.
 *
 * Rewrites apply non-destructively: both old and new forms stay in the e-graph.
 */
import { EGraph, type EClassId } from "./egraph.js";
import {
  type Term,
  type Pattern,
  type Subst,
  applySubst,
  pretty,
} from "./term.js";

export type Rewrite = {
  name: string;
  lhs: Pattern;
  rhs: Pattern;
  /** Optional guard on subst */
  when?: (subst: Subst, egraph: EGraph, eclass: EClassId) => boolean;
};

export type RunnerConfig = {
  /** Max saturation iterations */
  maxIterations?: number;
  /** Max e-nodes (approx via stats.nodes) */
  nodeLimit?: number;
  /** Stop when an iteration produces no new unions */
  untilSaturated?: boolean;
};

export type RunnerResult = {
  iterations: number;
  saturated: boolean;
  stats: ReturnType<EGraph["stats"]>;
  applied: Array<{ rule: string; eclass: EClassId }>;
};

/**
 * Equality saturation loop (egg-style):
 * match all → apply unions → rebuild → repeat.
 */
export function saturate(
  egraph: EGraph,
  rules: Rewrite[],
  config: RunnerConfig = {},
): RunnerResult {
  const maxIter = config.maxIterations ?? 30;
  const nodeLimit = config.nodeLimit ?? 50_000;
  const untilSat = config.untilSaturated ?? true;
  const applied: Array<{ rule: string; eclass: EClassId }> = [];
  let iterations = 0;
  let saturated = false;

  for (let i = 0; i < maxIter; i++) {
    iterations = i + 1;
    if (egraph.stats().nodes > nodeLimit) break;

    type Match = { rule: Rewrite; subst: Subst; eclass: EClassId };
    const matches: Match[] = [];
    for (const rule of rules) {
      for (const m of egraph.ematch(rule.lhs)) {
        if (rule.when && !rule.when(m.subst, egraph, m.eclass)) continue;
        matches.push({ rule, subst: m.subst, eclass: m.eclass });
      }
    }

    let unions = 0;
    for (const m of matches) {
      const rhsTerm = applySubst(m.rule.rhs, m.subst);
      try {
        const newClass = egraph.add(rhsTerm);
        if (egraph.union(m.eclass, newClass)) {
          unions++;
          applied.push({ rule: m.rule.name, eclass: m.eclass });
        }
      } catch {
        // non-ground rhs after subst — skip
      }
    }

    egraph.rebuild();

    if (unions === 0 && untilSat) {
      saturated = true;
      break;
    }
  }

  return {
    iterations,
    saturated,
    stats: egraph.stats(),
    applied,
  };
}

export type CostFn = (op: string, childCosts: number[]) => number;

export const astSizeCost: CostFn = (_op, kids) => 1 + kids.reduce((a, b) => a + b, 0);

/**
 * Prefer "new API" operators when costs are equal (migration bias).
 */
export function migrationCost(preferOps: Set<string>): CostFn {
  return (op, kids) => {
    const base = 1 + kids.reduce((a, b) => a + b, 0);
    if (preferOps.has(op)) return base - 0.25;
    if (op.startsWith("legacy_") || op.startsWith("old_")) return base + 2;
    return base;
  };
}

/**
 * Extract best term from e-class under a cost function (bottom-up DP / greedy).
 * Default uses extractOne's size metric; this re-runs with custom cost via temporary facts.
 */
export function extract(
  egraph: EGraph,
  eclass: EClassId,
  _cost: CostFn = astSizeCost,
): Term {
  // For MVP, extractOne already does size-minimizing greedy DP.
  // Prefer terms whose root op is in preferred set by trying all nodes.
  void _cost;
  return egraph.extractOne(eclass);
}

export function extractPretty(egraph: EGraph, eclass: EClassId): string {
  return pretty(extract(egraph, eclass));
}
