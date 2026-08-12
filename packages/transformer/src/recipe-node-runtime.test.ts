import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_20_TO_22_RECIPE,
  analyzeRecipe,
  applyInverseOperations,
  applyRecipe,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
  type RecipeFiles,
} from "./recipe.js";

const FIXTURE_ROOT = "../../../fixtures/consumers/node-runtime-20-to-22/";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_ROOT + relative, import.meta.url)), "utf8");
}

function load(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = read(`${sub}/${path}`);
  return files;
}

const SUPPORTED_PATHS = [".node-version", ".nvmrc", "Dockerfile", "package.json"] as const;
const reference = recipeReference(NODE_RUNTIME_20_TO_22_RECIPE);

describe("node-runtime-20-to-22 recipe", () => {
  it("is a valid, registered, content-addressed recipe", () => {
    expect(() => validateRecipe(NODE_RUNTIME_20_TO_22_RECIPE)).not.toThrow();
    expect(getRecipe("node-runtime-20-to-22", 1)).toBe(NODE_RUNTIME_20_TO_22_RECIPE);
    expect(resolveRecipe(reference)).toBe(NODE_RUNTIME_20_TO_22_RECIPE);
    expect(NODE_RUNTIME_20_TO_22_RECIPE.allowedPaths).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);
    expect(Object.isFrozen(NODE_RUNTIME_20_TO_22_RECIPE)).toBe(true);
    for (const command of NODE_RUNTIME_20_TO_22_RECIPE.verificationCommands) {
      expect(command.command).toMatch(/^node -e "[^"]+"$/);
    }
  });

  it("applies deterministically to the supported before fixture", () => {
    const before = load("before", SUPPORTED_PATHS);
    const after = load("after", SUPPORTED_PATHS);

    const analysis = analyzeRecipe(reference, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);
    expect(analysis.reasons).toEqual([]);
    expect(analysis.estimatedOperations).toBe(4);

    const first = applyRecipe(reference, before);
    const second = applyRecipe(reference, { ...before });
    expect(first.files).toEqual(second.files);
    expect(first.operations.map((operation) => operation.path).sort()).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);

    // The on-disk after/ fixture is the exact deterministic output.
    for (const path of SUPPORTED_PATHS) {
      expect(first.files[path]).toBe(after[path]);
    }

    // Shape checks: every recognized pin now reads Node 22.
    expect(JSON.parse(first.files["package.json"]!).engines.node).toBe(">=22 <23");
    expect(first.files[".nvmrc"]).toBe("22\n");
    expect(first.files[".node-version"]).toBe("22\n");
    expect(first.files["Dockerfile"]).toContain("FROM node:22-alpine");
    expect(first.files["Dockerfile"]).not.toContain("node:20");
  });

  it("is idempotent and reports already_applied on migrated sources", () => {
    const before = load("before", SUPPORTED_PATHS);
    const output = applyRecipe(reference, before);
    const reanalysis = analyzeRecipe(reference, output.files);
    expect(reanalysis.status).toBe("already_applied");
    expect(() => applyRecipe(reference, output.files)).toThrow("recipe_already_applied");
  });

  it("restores the exact input via inverse operations", () => {
    const before = load("before", SUPPORTED_PATHS);
    const output = applyRecipe(reference, before);
    const restored = applyInverseOperations(reference, output.files, output.operations);
    expect(recipeFilesDigest(restored)).toBe(output.inputDigest);
    expect(restored).toEqual(before);
  });

  it("abstains on a Dockerfile base image pinned to an unexpected major (out-of-scope)", () => {
    const files = load("out-of-scope", SUPPORTED_PATHS);
    const analysis = analyzeRecipe(reference, files);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_precondition_failed:Dockerfile:node_major");
    expect(() => applyRecipe(reference, files)).toThrow(
      "recipe_precondition_failed:Dockerfile:node_major",
    );
  });

  it("abstains on a ranged engines value it cannot safely rewrite", () => {
    const analysis = analyzeRecipe(reference, {
      "package.json": `${JSON.stringify({ engines: { node: ">=20" } }, null, 2)}\n`,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain(
      "recipe_precondition_failed:package.json:/engines/node",
    );
  });

  it("reports already_applied when the engines pin already reads Node 22", () => {
    const analysis = analyzeRecipe(reference, {
      "package.json": `${JSON.stringify({ engines: { node: ">=22 <23" } }, null, 2)}\n`,
    });
    expect(analysis.status).toBe("already_applied");
  });
});
