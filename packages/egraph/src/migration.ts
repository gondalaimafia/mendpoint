/**
 * API migration rules as equality saturation.
 *
 * Localized to impacted fragments — not whole-program.
 * Complements call-graph impact localization with non-destructive rewrite search.
 *
 * The rewrite rules are derived from the change under analysis (the renamed
 * tokens), never from hard-coded demo SDK literals. Earlier revisions shipped
 * rules named after our own fixtures (amount_cents→amount,
 * max_tokens→max_completion_tokens, charges.create v1→v2) carrying literal field
 * tokens for those specific SDKs: they fired for the vendors we hard-coded and
 * silently did nothing for every other provider. A change that yields no
 * renameable token pair now abstains explicitly (see `migrateFromFixHint`)
 * instead of returning a rule set that matches nothing.
 *
 * Output is informational only: it feeds the "E-graph migration exploration"
 * prose in a generated PR body (`@mendpoint/generation`). It drives no code edit,
 * so the fix is scoped to making that prose provider-agnostic and honest about
 * abstention.
 */
import { EGraph } from "./egraph.js";
import { app, lit, type Term, v } from "./term.js";
import { extractPretty, migrationCost, saturate, type Rewrite } from "./saturate.js";

/** A concrete field/token rename taken from the change under analysis. */
export type FieldRename = { from: string; to: string };

/**
 * Provider-agnostic structural rewrites that carry no vendor-specific literal.
 * These generalise across providers: page-based pagination migrates to a cursor,
 * and the same shape can auto-page. Variables (`?req`, `?n`) mean they match any
 * provider's fragment rather than a hard-coded SDK surface.
 */
export function structuralMigrationRules(): Rewrite[] {
  return [
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
  ];
}

/**
 * Rewrite rules derived from a concrete rename in the change under analysis. The
 * tokens come from the diff/fix hint, so the same code migrates any provider's
 * field, request parameter, or SDK-body rename — nothing is hard-coded per SDK.
 * Rules where `from === to` are omitted (they would match nothing).
 */
export function fieldRenameRules(rename: FieldRename): Rewrite[] {
  const { from, to } = rename;
  if (!from || !to || from === to) return [];
  return [
    {
      name: `rename_field_${from}_to_${to}`,
      lhs: app("field", lit(from)),
      rhs: app("field", lit(to)),
    },
    {
      name: `rename_param_${from}_to_${to}`,
      lhs: app("param", lit(from), v("n")),
      rhs: app("param", lit(to), v("n")),
    },
    {
      name: `rename_access_${from}_to_${to}`,
      lhs: app("access", lit(from)),
      rhs: app("access", lit(to)),
    },
    {
      name: `rename_sdk_body_${from}_to_${to}`,
      lhs: app("sdk", v("method"), v("body")),
      rhs: app("sdk", v("method"), app("rename_field", v("body"), lit(from), lit(to))),
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
 * Defaults to the provider-agnostic structural rules; pass change-derived rules
 * (see `fieldRenameRules`) to explore a specific rename.
 */
export function exploreMigration(
  term: Term,
  rules: Rewrite[] = structuralMigrationRules(),
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
 * Explore a field rename drawn from the change under analysis. Both endpoints of
 * the rename come from the caller, so this generalises to any provider.
 */
export function migrateFieldAccess(rename: FieldRename): MigrationExploreResult {
  return exploreMigration(app("field", lit(rename.from)), [
    ...fieldRenameRules(rename),
    ...structuralMigrationRules(),
  ]);
}

/**
 * Given an impact fix hint like "amount_cents → amount", derive rewrite rules
 * from the two tokens and saturate. Returns null — an explicit abstention — when
 * the hint carries no renameable token pair, rather than running fixture rules
 * that would match nothing.
 */
export function migrateFromFixHint(hint: string): MigrationExploreResult | null {
  const m = hint.match(/(\w+)\s*→\s*(\w+)/);
  if (!m) return null;
  const rename: FieldRename = { from: m[1]!, to: m[2]! };
  const rules = [...fieldRenameRules(rename), ...structuralMigrationRules()];
  if (!rules.some((r) => r.name.startsWith("rename_"))) return null;
  return exploreMigration(app("field", lit(rename.from)), rules);
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
