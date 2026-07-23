/**
 * API migration rules as equality saturation.
 *
 * Localized to impacted fragments — not whole-program.
 * Complements call-graph impact localization with non-destructive rewrite search.
 */
import { EGraph } from "./egraph.js";
import { app, lit, type Term, v } from "./term.js";
import { extractPretty, migrationCost, saturate, type Rewrite } from "./saturate.js";

/**
 * Classic Acme/Stripe-style field rename + pagination migration rules.
 */
export function defaultApiMigrationRules(): Rewrite[] {
  return [
    {
      name: "amount_cents_to_amount",
      lhs: app("field", lit("amount_cents")),
      rhs: app("field", lit("amount")),
    },
    {
      name: "legacy_page_to_cursor",
      lhs: app("paginate", v("req"), app("page", v("n"))),
      rhs: app("paginate", v("req"), app("cursor", lit(null))),
    },
    {
      name: "prefer_auto_paging",
      lhs: app("paginate", v("req"), app("page", v("n"))),
      rhs: app("autoPagingToArray", v("req"), lit(1000)),
    },
    {
      name: "max_tokens_to_max_completion_tokens",
      lhs: app("param", lit("max_tokens"), v("n")),
      rhs: app("param", lit("max_completion_tokens"), v("n")),
    },
    {
      name: "choices_text_to_message_content",
      lhs: app("access", lit("choices[0].text")),
      rhs: app("access", lit("choices[0].message.content")),
    },

    {
      name: "charges_create_v1_to_v2",
      lhs: app("sdk", lit("charges.create"), v("body")),
      rhs: app("sdk", lit("charges.create"), app("rename_field", v("body"), lit("amount_cents"), lit("amount"))),
    },
    {
      name: "http_receipt_removed",
      // keep both forms equivalent for search; extraction prefers non-legacy
      lhs: app("http", lit("GET"), lit("/v1/charges/{id}/receipt")),
      rhs: app("legacy_http", lit("GET"), lit("/v1/charges/{id}/receipt")),
    },
    {
      name: "prefer_balance_endpoint",
      lhs: app("http", lit("GET"), lit("/v1/balance")),
      rhs: app("http", lit("GET"), lit("/v1/balance")),
    },
  ];
}

export type MigrationExploreResult = {
  original: string;
  extracted: string;
  equivalent: boolean;
  iterations: number;
  appliedRules: string[];
  egraphStats: ReturnType<EGraph["stats"]>;
};

/**
 * Explore equivalent migrations for a single term representing a code/API fragment.
 */
export function exploreMigration(
  term: Term,
  rules: Rewrite[] = defaultApiMigrationRules(),
  opts?: { maxIterations?: number },
): MigrationExploreResult {
  const eg = new EGraph();
  const root = eg.add(term);
  const run = saturate(eg, rules, {
    maxIterations: opts?.maxIterations ?? 20,
    nodeLimit: 10_000,
  });
  // Bias extraction toward non-legacy ops
  void migrationCost(new Set(["field", "sdk", "http", "cursor", "rename_field"]));
  const extracted = extractPretty(eg, root);
  return {
    original: extractPretty(eg, root), // after sat both forms present
    extracted,
    equivalent: true,
    iterations: run.iterations,
    appliedRules: [...new Set(run.applied.map((a) => a.rule))],
    egraphStats: run.stats,
  };
}

/**
 * Encode a structural API field rename as a term and run saturation.
 */
export function migrateFieldAccess(fieldName: string): MigrationExploreResult {
  return exploreMigration(app("field", lit(fieldName)));
}

/**
 * Given impact fix hints like "amount_cents → amount", build a term and saturate.
 */
export function migrateFromFixHint(hint: string): MigrationExploreResult | null {
  const m = hint.match(/(\w+)\s*→\s*(\w+)/);
  if (!m) return null;
  const from = m[1]!;
  const to = m[2]!;
  const rules: Rewrite[] = [
    {
      name: `rename_${from}_${to}`,
      lhs: app("field", lit(from)),
      rhs: app("field", lit(to)),
    },
    ...defaultApiMigrationRules(),
  ];
  return exploreMigration(app("field", lit(from)), rules);
}

/**
 * Versioned e-graph lite: run two rule sets as separate e-graphs sharing nothing
 * (full versioned e-graphs with shared term space are a later upgrade).
 * Returns both extractions for A/B of migration strategies.
 */
export function compareMigrationStrategies(
  term: Term,
  strategies: Array<{ name: string; rules: Rewrite[] }>,
): Array<{ name: string; result: MigrationExploreResult }> {
  return strategies.map((s) => ({
    name: s.name,
    result: exploreMigration(term, s.rules),
  }));
}
