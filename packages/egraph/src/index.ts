/**
 * @mendpoint/egraph
 *
 * E-graphs for equality saturation — non-destructive rewrite exploration
 * used in the API migration / PR generation stage (not a call-graph replacement).
 *
 * Core algorithms: hash-cons, union-find, e-matching, deferred rebuild,
 * equality saturation, greedy extraction, e-class analyses (facts lattice).
 */

export { UnionFind } from "./union-find.js";

export {
  type Term,
  type Pattern,
  type Subst,
  v,
  app,
  lit,
  sym,
  termKey,
  pretty,
  applySubst,
  isGround,
} from "./term.js";

export {
  EGraph,
  type EClassId,
  type ENode,
  type EClassData,
  type EClassAnalysis,
  type EGraphStats,
} from "./egraph.js";

export {
  saturate,
  extract,
  extractPretty,
  astSizeCost,
  migrationCost,
  type Rewrite,
  type RunnerConfig,
  type RunnerResult,
  type CostFn,
} from "./saturate.js";

export {
  defaultApiMigrationRules,
  exploreMigration,
  migrateFieldAccess,
  migrateFromFixHint,
  compareMigrationStrategies,
  type MigrationExploreResult,
} from "./migration.js";
