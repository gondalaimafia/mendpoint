import { describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  applyInverseOperations,
  applyRecipe,
  assertRecipePathAllowed,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  resolveRecipe,
  validateRecipe,
  type MigrationRecipeContract,
  type RecipeFiles,
} from "./recipe.js";

const INPUT: RecipeFiles = {
  "src/server.js": "console.log('payments')\n",
  "package.json": JSON.stringify(
    {
      name: "payments-api",
      private: true,
      engines: { node: ">=18 <19" },
      scripts: { check: "node src/server.js" },
    },
    null,
    2,
  ) + "\n",
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
};

describe("immutable Transformer recipes", () => {
  it("applies node-runtime-18-to-20@1 deterministically", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const first = applyRecipe(reference, INPUT);
    const second = applyRecipe(reference, { ...INPUT });

    expect(first).toEqual(second);
    expect(first.outputDigest).not.toBe(first.inputDigest);
    expect(JSON.parse(first.files["package.json"]!).engines.node).toBe(">=20 <21");
    expect(first.files[".nvmrc"]).toBe("20\n");
    expect(first.files[".node-version"]).toBe("20\n");
    expect(first.files.Dockerfile).toContain("FROM node:20-alpine");
    expect(first.files["src/server.js"]).toBe(INPUT["src/server.js"]);
    expect(first.verificationCommands).toHaveLength(2);
    expect(Object.isFrozen(NODE_RUNTIME_18_TO_20_RECIPE)).toBe(true);
    expect(Object.isFrozen(NODE_RUNTIME_18_TO_20_RECIPE.transforms)).toBe(true);
    expect(Object.isFrozen(first.operations)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
  });

  it("rejects unknown recipe versions", () => {
    expect(() => getRecipe("node-runtime-18-to-20", 2)).toThrow(
      "recipe_not_found:node-runtime-18-to-20@2",
    );
    expect(() => getRecipe("node-runtime-18-to-20", 0)).toThrow("recipe_version_invalid");
  });

  it("rejects a reference or contract with a mismatched digest", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    expect(() => resolveRecipe({ ...reference, digest: `sha256:${"0".repeat(64)}` })).toThrow(
      "recipe_digest_mismatch",
    );

    const tampered = {
      ...NODE_RUNTIME_18_TO_20_RECIPE,
      target: "node@22",
    } as MigrationRecipeContract;
    expect(() => validateRecipe(tampered)).toThrow("recipe_digest_mismatch");
  });

  it("fails when the declared Node 18 preconditions are not satisfied", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const packageJson = JSON.parse(INPUT["package.json"]!) as Record<string, unknown>;
    packageJson.engines = { node: ">=20 <21" };
    expect(() =>
      applyRecipe(reference, { ...INPUT, "package.json": JSON.stringify(packageJson) }),
    ).toThrow("recipe_precondition_failed:package.json:/engines/node");

    expect(() => applyRecipe(reference, { ...INPUT, ".nvmrc": "22\n" })).toThrow(
      "recipe_precondition_failed:.nvmrc:node_major",
    );
  });

  it("enforces safe allowlisted mutation paths", () => {
    expect(() => assertRecipePathAllowed(NODE_RUNTIME_18_TO_20_RECIPE, "src/server.js")).toThrow(
      "recipe_path_not_allowed:src/server.js",
    );
    expect(() => assertRecipePathAllowed(NODE_RUNTIME_18_TO_20_RECIPE, "../package.json")).toThrow(
      "recipe_path_invalid:../package.json",
    );
    expect(() =>
      applyRecipe(recipeReference(NODE_RUNTIME_18_TO_20_RECIPE), {
        ...INPUT,
        "../outside": "blocked",
      }),
    ).toThrow("recipe_path_invalid:../outside");
  });

  it("restores the exact input through verified inverse operations", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const applied = applyRecipe(reference, INPUT);
    const restored = applyInverseOperations(reference, applied.files, applied.operations);

    expect(restored).toEqual(INPUT);
    expect(recipeFilesDigest(restored)).toBe(applied.inputDigest);
    expect(() =>
      applyInverseOperations(
        reference,
        { ...applied.files, Dockerfile: "FROM node:22-alpine\n" },
        applied.operations,
      ),
    ).toThrow("recipe_inverse_drift:Dockerfile");
  });
});
