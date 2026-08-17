/**
 * Phase 4 — ReGauge runner.
 *
 * Invokes ReGauge through its deterministic recipe engine core: for every
 * shipped recipe it calls `analyzeRecipe` (@mendpoint/transformer) against a
 * snapshot of the repo, exactly as the production planner/executor does before
 * it would apply anything. `analyzeRecipe` runs the real preconditions,
 * matched-path detection, and residual-site detection — the same components the
 * worker's `executeRecipeInWorkspace` wraps. We stop at analyze (do not apply)
 * because applying requires a fenced workspace + verification sandbox; the
 * engine's DECISION (which recipe matches, or abstain-by-absence) is the signal
 * we grade and is fully observable here.
 *
 * Not exercised (recorded as unmeasured, not bypassed): recipe apply +
 * verification-gate execution, inverse/rollback, the adaptive LLM repair loop,
 * and draft-PR delivery. The recipe engine core is deterministic (no LLM), so
 * model/provider/tokens/cost are genuinely null.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  analyzeRecipe,
  recipeReference,
  getRecipe,
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  type MigrationRecipeContract,
  type RecipeFiles,
} from "@mendpoint/transformer";
import type { ScenarioConfig } from "../scenarios/index.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import { gradeRegauge, type ObservedRecipe } from "../graders/regauge-graders.js";
import type { RunRecord } from "./types.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next"]);
const BINARY_EXT = /\.(png|jpe?g|gif|zip|gz|tar|pdf|ico|woff2?|ttf|eot|wasm|node|class|jar)$/i;
const MAX_FILE_BYTES = 512 * 1024;

/** True if the content contains a NUL byte (a cheap binary-content signal). */
function hasNullByte(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  return false;
}

/** Read all text files as a posix-keyed RecipeFiles snapshot. */
function snapshotRepo(root: string): { files: RecipeFiles; count: number; skipped: number } {
  const out: Record<string, string> = {};
  let skipped = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs); // resolves symlinks; if broken, skip
      } catch {
        skipped++;
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walk(abs);
        continue;
      }
      if (!st.isFile()) continue;
      if (BINARY_EXT.test(name) || st.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        skipped++;
        continue;
      }
      if (hasNullByte(content)) {
        skipped++; // binary content that slipped past the extension filter
        continue;
      }
      const key = relative(root, abs).split(sep).join("/");
      out[key] = content;
    }
  };
  walk(root);
  return { files: out, count: Object.keys(out).length, skipped };
}

/** The shipped recipes the engine would consider. The 7 exported constants
 *  cover every migration family; the registry-only internal-api variants are
 *  resolved best-effort so the abstention-by-absence claim is defensible. */
function shippedRecipes(): MigrationRecipeContract[] {
  const exported: MigrationRecipeContract[] = [
    NODE_RUNTIME_18_TO_20_RECIPE,
    NODE_RUNTIME_20_TO_22_RECIPE,
    AWS_SDK_JS_V2_TO_V3_RECIPE,
    STRIPE_NODE_V10_TO_V11_RECIPE,
    GOOGLEAPIS_V25_TO_V26_RECIPE,
    REACT_DOM_17_TO_18_RECIPE,
    INTERNAL_API_ACME_USER_RENAME_RECIPE,
  ];
  const registryOnly = [
    "internal-api-orders-place-to-submit",
    "internal-api-auth-verify-to-check",
    "internal-api-warden-ishuman-reviewer-rename",
    "internal-api-order-record-to-order-row",
    "internal-api-review-decision-type-rename",
  ];
  const extra: MigrationRecipeContract[] = [];
  for (const id of registryOnly) {
    for (const version of [1, 2]) {
      try {
        extra.push(getRecipe(id, version));
        break;
      } catch {
        /* not registered at this version; try next */
      }
    }
  }
  const seen = new Set<string>();
  return [...exported, ...extra].filter((r) => {
    const k = `${r.id}@${r.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function runRegauge(
  cfg: ScenarioConfig,
  gt: GroundTruth,
  ctx: { gitCommit: string; productVersion: string },
): Promise<RunRecord> {
  const started = Date.now();
  const base: Omit<RunRecord, "latency_ms"> = {
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    git_commit: ctx.gitCommit,
    product: "regauge",
    product_version: ctx.productVersion,
    scenario_id: cfg.scenario_id,
    scenario_version: "1",
    invocation_path:
      "transformer.analyzeRecipe over the shipped recipe registry (analyze-only; apply/verify not run)",
    model: null,
    model_provider: null,
    routing_decisions: [],
    tokens: null,
    estimated_cost_usd: null,
    activity: { filesExamined: 0 },
    findings: [],
    confidence: null,
    produced_edit: false,
    grader_results: [],
    failures: [],
    passed: false,
    unmeasured_dimensions: [
      "recipe_apply + verification_gate (analyze-only)",
      "idempotency (apply-then-reapply not run)",
      "inverse/rollback (not run)",
      "adaptive_repair token_cost / model_routing (LLM path not exercised)",
    ],
  };

  try {
    const snap = snapshotRepo(cfg.repoPath);
    const recipes = shippedRecipes();
    const observed: ObservedRecipe[] = [];
    for (const recipe of recipes) {
      const analysis = analyzeRecipe(recipeReference(recipe), snap.files);
      observed.push({
        recipeId: recipe.id,
        version: recipe.version,
        status: analysis.status,
        matchedPaths: [...analysis.matchedPaths],
        residualPaths: [...analysis.residualPaths],
      });
    }
    const grade = gradeRegauge(observed, gt);
    const matched = observed.filter(
      (r) => r.status === "applicable" || r.status === "incomplete",
    );

    return {
      ...base,
      latency_ms: Date.now() - started,
      activity: {
        filesExamined: snap.count,
        recipesEvaluated: recipes.length,
        notes: [
          `snapshot_files=${snap.count}`,
          `skipped_binary_or_large=${snap.skipped}`,
          `matched=${grade.matchedRecipes.join(", ") || "none"}`,
        ],
      },
      findings: matched.flatMap((r) => r.matchedPaths),
      confidence: null,
      produced_edit: false,
      grader_results: grade.grader_results,
      failures: grade.failures,
      passed: grade.passed,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      latency_ms: Date.now() - started,
      error: message,
      grader_results: [
        { dimension: "engine_completes", passed: false, score: 0, detail: `threw: ${message}` },
      ],
      failures: [
        {
          category: "ROBUSTNESS_FAILURE",
          severity: "P1",
          dimension: "engine_completes",
          observed: `analyze threw: ${message}`,
          expected: "complete analysis without crashing",
        },
      ],
      passed: false,
    };
  }
}
