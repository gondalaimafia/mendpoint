/**
 * Scenario registry — the "how to run" config for every scenario.
 *
 * This is deliberately separate from the ground truth in
 * `evals/ground-truth/`. This file holds only run configuration (which repo,
 * which product, which spec pair, which provider slug hint). The answer key
 * (expected findings, traps, difficulty) lives in the ground-truth JSON and is
 * loaded only by the grader, after the product has run.
 *
 * Corpus repos live OUTSIDE this git repo (default `C:/Users/Talal/dev`), so a
 * run cannot accidentally read a repo's own ground truth — there is none inside
 * the repo under test.
 */
import { resolve } from "node:path";
import type { Product } from "../ground-truth/schema.js";
// The corpus root is resolved in one place so this reader and
// `scripts/impact-grade.ts` cannot diverge in how they treat an empty/unset
// MENDPOINT_CORPUS_ROOT (see corpus-root.ts for the footgun this closes).
import { CORPUS_ROOT, CORPUS_ROOT_CONFIGURED } from "./corpus-root.js";

export { CORPUS_ROOT, CORPUS_ROOT_CONFIGURED };

export interface ScenarioConfig {
  scenario_id: string;
  product: Product;
  /** Absolute path to the repository under test. */
  repoPath: string;
  /** Provider slug hint for the Fettler change-intel path (optional). */
  slug?: string;
  /** Old/new OpenAPI spec, repo-relative (Fettler only; defaults in runner). */
  oldSpec?: string;
  newSpec?: string;
  /**
   * Wall-clock budget in ms. When set, the scenario runs in an isolated child
   * process and is hard-killed if it exceeds the budget, recording a
   * SCALE_FAILURE. Used for scenarios where the product can block for an
   * unreasonable time (large repositories) — measuring that is the point.
   */
  budgetMs?: number;
}

const p = (rel: string): string => resolve(CORPUS_ROOT, rel);

export const SCENARIOS: readonly ScenarioConfig[] = [
  // ---- Fettler (impact analysis; source -> payment_method) ----
  {
    scenario_id: "fettler-ts-payments-rename",
    product: "fettler",
    repoPath: p("synthetic-payments-svc"),
    slug: "meridian",
  },
  {
    scenario_id: "fettler-python-billing-rename",
    product: "fettler",
    repoPath: p("synthetic-corpus/lang/python-billing"),
  },
  {
    scenario_id: "fettler-go-ledger-rename",
    product: "fettler",
    repoPath: p("synthetic-corpus/lang/go-ledger"),
  },
  {
    scenario_id: "fettler-java-settlement-rename",
    product: "fettler",
    repoPath: p("synthetic-corpus/lang/java-settlement"),
    slug: "acme",
  },
  {
    scenario_id: "fettler-node-cjs-rename",
    product: "fettler",
    repoPath: p("synthetic-corpus/lang/node-cjs-legacy"),
    slug: "northwind",
  },
  {
    scenario_id: "fettler-ts-monorepo-rename",
    product: "fettler",
    repoPath: p("synthetic-corpus/lang/ts-monorepo"),
  },
  {
    scenario_id: "fettler-edge-already-migrated",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/already-migrated"),
    slug: "acmepay",
  },
  {
    scenario_id: "fettler-edge-ambiguous",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/ambiguous"),
    slug: "acmepay",
  },
  {
    scenario_id: "fettler-edge-binary-encoding",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/binary-and-encoding"),
    slug: "acmepay",
  },
  {
    scenario_id: "fettler-edge-deep-indirection",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/deep-indirection"),
    slug: "acmepay",
  },
  {
    scenario_id: "fettler-edge-generated-code",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/generated-code"),
    slug: "acme",
  },
  {
    scenario_id: "fettler-edge-huge-monorepo",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/huge-monorepo"),
    slug: "acmepay",
    budgetMs: 120_000,
  },
  {
    scenario_id: "fettler-edge-no-test-command",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/no-test-command"),
    slug: "acmepay",
  },
  {
    scenario_id: "fettler-edge-pnpm-workspace",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/pnpm-workspace"),
    slug: "acmepay",
  },
  {
    scenario_id: "fettler-edge-vendored-sdk",
    product: "fettler",
    repoPath: p("synthetic-corpus/edge/vendored-sdk"),
    slug: "acmepay",
  },
  // ---- ReGauge (migration recipe engine) ----
  {
    scenario_id: "regauge-runtime-upgrade",
    product: "regauge",
    repoPath: p("synthetic-corpus/regauge/runtime-upgrade"),
  },
  {
    scenario_id: "regauge-sdk-upgrade",
    product: "regauge",
    repoPath: p("synthetic-corpus/regauge/sdk-upgrade"),
  },
  {
    scenario_id: "regauge-framework-upgrade",
    product: "regauge",
    repoPath: p("synthetic-corpus/regauge/framework-upgrade"),
  },
  {
    scenario_id: "regauge-internal-api-rename",
    product: "regauge",
    repoPath: p("synthetic-corpus/regauge/internal-api-rename"),
  },
  {
    scenario_id: "regauge-partial-campaign",
    product: "regauge",
    repoPath: p("synthetic-corpus/regauge/partial-campaign"),
  },
  {
    scenario_id: "regauge-should-abstain",
    product: "regauge",
    repoPath: p("synthetic-corpus/regauge/should-abstain"),
  },
];

export function scenarioById(id: string): ScenarioConfig | undefined {
  return SCENARIOS.find((s) => s.scenario_id === id);
}
