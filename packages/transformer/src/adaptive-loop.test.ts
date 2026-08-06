import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ADAPTIVE_REPAIR_BOUNDS,
  runAdaptiveRepairLoop,
  type AdaptiveGate,
  type AdaptiveRepairPlanner,
  type AdaptiveRepairPlannerInput,
  type AdaptiveVerifierResult,
} from "./adaptive-loop.js";
import { recipeReference, NODE_RUNTIME_18_TO_20_RECIPE, type RecipeFiles } from "./recipe.js";

const RECIPE = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

const SOURCE: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({ name: "fixture", engines: { node: ">=18 <19" } }, null, 2)}\n`,
  "src/app.js": "// app: broken\nexport const ready = false;\n",
  "src/helper.js": "export const REQUIRED_TOKEN = 'h-42';\n",
});

// The recipe transformed package.json to node 20 but the app still fails the
// objective gate; adaptive repair starts from this recipe output.
const RECIPE_FILES: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({ name: "fixture", engines: { node: ">=20 <21" } }, null, 2)}\n`,
  "src/app.js": "// app: broken\nexport const ready = false;\n",
  "src/helper.js": "export const REQUIRED_TOKEN = 'h-42';\n",
});

const ALLOWED = ["src/app.js"] as const;

/** Gate passes only when the app file contains the FIXED marker. */
function markerGate(): AdaptiveGate {
  return async (files: RecipeFiles): Promise<AdaptiveVerifierResult> => {
    const app = files["src/app.js"] ?? "";
    const passed = app.includes("FIXED");
    return {
      passed,
      failingCommandId: passed ? null : "app-behavior",
      output: passed ? "ok" : "app-behavior: expected FIXED marker, got broken",
      implicatedPaths: ["src/app.js"],
    };
  };
}

function contextDigest(input: AdaptiveRepairPlannerInput, path: string): string {
  const file = input.context.find((entry) => entry.path === path);
  if (!file) throw new Error(`missing context for ${path}`);
  return file.digest;
}

describe("Transformer adaptive repair loop", () => {
  it("never engages when the recipe output already satisfies the gate", async () => {
    const gate: AdaptiveGate = async () => ({
      passed: true,
      failingCommandId: null,
      output: "ok",
      implicatedPaths: [],
    });
    const planner = vi.fn<AdaptiveRepairPlanner>();
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate,
      planner,
    });
    expect(outcome.status).toBe("not_engaged");
    expect(planner).not.toHaveBeenCalled();
    expect(outcome.usage.measured).toBe(false);
  });

  it("fixes the unit in one iteration and reports measured model usage", async () => {
    const planner: AdaptiveRepairPlanner = async (input) => ({
      plan: {
        edits: [
          {
            path: "src/app.js",
            observedContentDigest: contextDigest(input, "src/app.js"),
            nextContent: "// app: FIXED\nexport const ready = true;\n",
          },
        ],
      },
      usage: { modelCalled: true, promptTokens: 120, completionTokens: 40, totalTokens: 160, costUsd: 0.0021 },
    });
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: markerGate(),
      planner,
    });
    expect(outcome.status).toBe("converged");
    if (outcome.status !== "converged") return;
    expect(outcome.iterationsUsed).toBe(1);
    expect(outcome.changedPaths).toEqual(["src/app.js"]);
    expect(outcome.files["src/app.js"]).toContain("FIXED");
    expect(outcome.usage).toMatchObject({
      measured: true,
      modelCalls: 1,
      promptTokens: 120,
      completionTokens: 40,
      totalTokens: 160,
      costUsd: 0.0021,
    });
  });

  it("reports null usage for a deterministic run that never calls a model", async () => {
    const planner: AdaptiveRepairPlanner = async (input) => ({
      plan: {
        edits: [
          {
            path: "src/app.js",
            observedContentDigest: contextDigest(input, "src/app.js"),
            nextContent: "// app: FIXED\n",
          },
        ],
      },
      usage: { modelCalled: false },
    });
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: markerGate(),
      planner,
    });
    expect(outcome.status).toBe("converged");
    expect(outcome.usage).toEqual({
      measured: false,
      modelCalls: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  });

  it("escalates context: the first iteration lacks the helper, the second pulls it in and succeeds", async () => {
    // Gate now requires the helper's token to appear in the app file.
    const gate: AdaptiveGate = async (files) => {
      const app = files["src/app.js"] ?? "";
      const passed = app.includes("h-42");
      return {
        passed,
        failingCommandId: passed ? null : "app-uses-helper",
        output: passed ? "ok" : "app-uses-helper: REQUIRED_TOKEN not wired in",
        implicatedPaths: ["src/app.js"],
      };
    };
    const seenContextPaths: string[][] = [];
    const planner: AdaptiveRepairPlanner = async (input) => {
      seenContextPaths.push(input.context.map((file) => file.path).sort());
      const helper = input.context.find((file) => file.path === "src/helper.js");
      if (!helper) {
        // No helper in context yet — ask for it, make no edit.
        return { plan: { edits: [], requestContextPaths: ["src/helper.js"] } };
      }
      const match = /'([^']+)'/.exec(helper.content);
      const token = match?.[1] ?? "";
      return {
        plan: {
          edits: [
            {
              path: "src/app.js",
              observedContentDigest: contextDigest(input, "src/app.js"),
              nextContent: `// wired ${token}\nexport const ready = true;\n`,
            },
          ],
        },
      };
    };
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate,
      planner,
    });
    expect(outcome.status).toBe("converged");
    if (outcome.status !== "converged") return;
    expect(outcome.iterationsUsed).toBe(2);
    expect(outcome.files["src/app.js"]).toContain("h-42");
    // First prompt lacked the helper; the second included it after escalation.
    expect(seenContextPaths[0]).not.toContain("src/helper.js");
    expect(seenContextPaths[1]).toContain("src/helper.js");
  });

  it("stops cleanly on bound exhaustion, rolls the unit back, and emits a structured marker", async () => {
    let counter = 0;
    const planner: AdaptiveRepairPlanner = async (input) => ({
      // Always edits but never reaches FIXED — the gate keeps failing.
      plan: {
        edits: [
          {
            path: "src/app.js",
            observedContentDigest: contextDigest(input, "src/app.js"),
            nextContent: `// attempt ${(counter += 1)}\nexport const ready = false;\n`,
          },
        ],
      },
    });
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: markerGate(),
      planner,
      bounds: { maxIterationsPerUnit: 2 },
    });
    expect(outcome.status).toBe("unfixable");
    if (outcome.status !== "unfixable") return;
    expect(outcome.boundExhausted).toBe("iterations_per_unit");
    expect(outcome.iterationsUsed).toBe(2);
    expect(outcome.marker).toMatchObject({
      kind: "transformer.adaptive.unfixable",
      unitId: "unit-a",
      reason: "iterations_per_unit_exhausted",
      boundExhausted: "iterations_per_unit",
      failingCommandId: "app-behavior",
    });
    expect(outcome.marker.bestAttempt).not.toBeNull();
    // Rolled back: the returned files are byte-identical to the recipe output,
    // no partial adaptive edit is left behind.
    expect(outcome.files).toEqual(RECIPE_FILES);
    // The best failing attempt is still carried for human escalation.
    expect(outcome.bestAttemptFiles?.["src/app.js"]).toContain("attempt 2");
  });

  it("rejects a mutation whose observed content digest is stale (exact content fence)", async () => {
    const planner: AdaptiveRepairPlanner = async () => ({
      plan: {
        edits: [
          {
            path: "src/app.js",
            observedContentDigest: sha256("something the planner never actually observed"),
            nextContent: "// app: FIXED\n",
          },
        ],
      },
    });
    const gate = markerGate();
    const gateSpy = vi.fn(gate);
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: gateSpy,
      planner,
    });
    expect(outcome.status).toBe("unfixable");
    if (outcome.status !== "unfixable") return;
    expect(outcome.marker.reason).toBe("fence_violation");
    expect(outcome.files).toEqual(RECIPE_FILES);
    // The gate ran once to observe the initial failure but never on a
    // fence-violating candidate.
    expect(gateSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects a mutation outside the allowed path set", async () => {
    const planner: AdaptiveRepairPlanner = async () => ({
      plan: {
        edits: [
          {
            path: "src/helper.js",
            observedContentDigest: sha256(RECIPE_FILES["src/helper.js"]!),
            nextContent: "export const REQUIRED_TOKEN = 'tampered';\n",
          },
        ],
      },
    });
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: markerGate(),
      planner,
    });
    expect(outcome.status).toBe("unfixable");
    if (outcome.status !== "unfixable") return;
    expect(outcome.marker.reason).toBe("path_not_allowed");
    expect(outcome.files).toEqual(RECIPE_FILES);
  });

  it("does not blame the migration for a pre-existing failure unrelated to it", async () => {
    // A regression check that must have been green before the migration is
    // already red on the untouched source.
    const baselineGate: AdaptiveGate = async () => ({
      passed: false,
      failingCommandId: "flaky-suite",
      output: "flaky-suite: unrelated pre-existing failure on the source snapshot",
      implicatedPaths: ["src/app.js"],
    });
    const planner = vi.fn<AdaptiveRepairPlanner>();
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: markerGate(),
      baselineGate,
      planner,
    });
    expect(outcome.status).toBe("pre_existing_failure");
    if (outcome.status !== "pre_existing_failure") return;
    expect(outcome.marker.reason).toBe("pre_existing_failure");
    expect(outcome.marker.failingCommandId).toBe("flaky-suite");
    // No adaptive edits are attempted for a pre-existing failure.
    expect(planner).not.toHaveBeenCalled();
    expect(outcome.files).toEqual(RECIPE_FILES);
  });

  it("stops on total-iteration exhaustion counting prior units", async () => {
    const planner: AdaptiveRepairPlanner = async (input) => ({
      plan: {
        edits: [
          {
            path: "src/app.js",
            observedContentDigest: contextDigest(input, "src/app.js"),
            nextContent: "// still broken\nexport const ready = false;\n",
          },
        ],
      },
    });
    const outcome = await runAdaptiveRepairLoop({
      unitId: "unit-a",
      goal: "migrate",
      recipe: RECIPE,
      sourceFiles: SOURCE,
      recipeFiles: RECIPE_FILES,
      allowedMutationPaths: ALLOWED,
      gate: markerGate(),
      planner,
      priorTotalIterations: DEFAULT_ADAPTIVE_REPAIR_BOUNDS.maxTotalIterations - 1,
    });
    expect(outcome.status).toBe("unfixable");
    if (outcome.status !== "unfixable") return;
    expect(outcome.boundExhausted).toBe("total_iterations");
    expect(outcome.iterationsUsed).toBe(1);
  });
});
