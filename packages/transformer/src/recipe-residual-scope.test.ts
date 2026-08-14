import { describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  analyzeRecipe,
  applyRecipe,
  recipeReference,
  type RecipeFiles,
} from "./recipe.js";

const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);

// The four ROOT files the recipe is allowed to edit, all on Node 18. Mirrors the
// synthetic `regauge/runtime-upgrade` subject.
const ROOT_18: RecipeFiles = {
  "package.json": `${JSON.stringify(
    {
      name: "feed-ingestion-service",
      private: true,
      engines: { node: ">=18 <19" },
    },
    null,
    2,
  )}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine AS build\nWORKDIR /app\n\nFROM node:18-alpine AS runtime\n",
};

describe("recipe residual-scope detection (partial migration guard)", () => {
  it("surfaces an un-migrated CI Dockerfile as an incomplete result, not a clean success", () => {
    // The runtime-upgrade subject: the recipe reaches the four root files, but a
    // second Dockerfile at docker/Dockerfile.ci is pinned to node:18 and lies
    // outside allowedPaths.
    const input: RecipeFiles = {
      ...ROOT_18,
      "docker/Dockerfile.ci": "FROM node:18-alpine\nWORKDIR /app\nRUN npm run check && npm test\n",
      "src/index.ts": "export const runtime = process.versions.node;\n",
    };

    const analysis = analyzeRecipe(reference, input);
    expect(analysis.status).toBe("incomplete");
    expect([...analysis.residualPaths]).toEqual(["docker/Dockerfile.ci"]);
    expect(analysis.reasons).toContain("recipe_incomplete_residual:docker/Dockerfile.ci");
    // The reviewer still sees exactly what the recipe WOULD migrate.
    expect([...analysis.matchedPaths]).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);

    // Applying an incomplete migration is refused: it never reports success while
    // leaving CI pinned to the old runtime.
    expect(() => applyRecipe(reference, input)).toThrow(
      "recipe_incomplete_residual:docker/Dockerfile.ci",
    );
  });

  it("also detects residual nested package.json and .node-version pins", () => {
    const input: RecipeFiles = {
      ...ROOT_18,
      "packages/api/package.json": `${JSON.stringify({ engines: { node: "18.x" } }, null, 2)}\n`,
      "services/worker/.node-version": "18\n",
    };
    const analysis = analyzeRecipe(reference, input);
    expect(analysis.status).toBe("incomplete");
    expect([...analysis.residualPaths]).toEqual([
      "packages/api/package.json",
      "services/worker/.node-version",
    ]);
    expect(() => applyRecipe(reference, input)).toThrow("recipe_incomplete_residual");
  });

  it("reports a clean success when no residual site exists (no false alarm)", () => {
    const input: RecipeFiles = {
      ...ROOT_18,
      // A CI Dockerfile that is ALREADY on the target runtime is not residue.
      "docker/Dockerfile.ci": "FROM node:20-alpine\nWORKDIR /app\n",
      // An unrelated source file with no runtime pin is never flagged.
      "src/index.ts": "export const runtime = process.versions.node;\n",
    };

    const analysis = analyzeRecipe(reference, input);
    expect(analysis.status).toBe("applicable");
    expect(analysis.residualPaths).toEqual([]);
    expect(analysis.reasons).toEqual([]);
    expect([...analysis.matchedPaths]).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);

    const applied = applyRecipe(reference, input);
    expect(JSON.parse(applied.files["package.json"]!).engines.node).toBe(">=20 <21");
    // The recipe still only edits its allowlisted paths; the already-migrated CI
    // Dockerfile is left untouched.
    expect(applied.files["docker/Dockerfile.ci"]).toBe(input["docker/Dockerfile.ci"]);
    expect(applied.operations.map((operation) => operation.path).sort()).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);
  });

  it("only scans the whole snapshot to detect; it never widens what it edits", () => {
    const input: RecipeFiles = {
      ...ROOT_18,
      "docker/Dockerfile.ci": "FROM node:18-alpine\n",
    };
    // The residual detection reads docker/Dockerfile.ci but the recipe's
    // allowedPaths still exclude it, so it is never an operation target.
    expect(NODE_RUNTIME_18_TO_20_RECIPE.allowedPaths).not.toContain("docker/Dockerfile.ci");
    const analysis = analyzeRecipe(reference, input);
    expect(analysis.status).toBe("incomplete");
  });
});
