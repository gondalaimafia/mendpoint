import { describe, expect, it } from "vitest";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  RecipeAnalysisCache,
  analyzeRecipe,
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
  it("applies node-runtime-18-to-20@2 deterministically", () => {
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
    expect(reference.version).toBe(2);
    expect(first.verificationCommands[0]).toMatchObject({ id: "runtime-declarations" });
    expect(first.verificationCommands[0]?.command).not.toContain("process.versions");
    expect(Object.isFrozen(NODE_RUNTIME_18_TO_20_RECIPE)).toBe(true);
    expect(Object.isFrozen(NODE_RUNTIME_18_TO_20_RECIPE.transforms)).toBe(true);
    expect(Object.isFrozen(first.operations)).toBe(true);
    expect(Object.isFrozen(first.files)).toBe(true);
  });

  it("classifies applicability before mutation with deterministic provenance", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const first = analyzeRecipe(reference, INPUT);
    const second = analyzeRecipe(reference, { ...INPUT });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      recipe: reference,
      sourceDigest: recipeFilesDigest(INPUT),
      status: "applicable",
      estimatedOperations: 4,
      cacheHit: false,
    });
    expect(first.matchedPaths).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);
    expect(first.reasons).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("distinguishes already applied and unsupported sources without changing input", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const applied = applyRecipe(reference, INPUT);
    const before = { ...applied.files };

    expect(analyzeRecipe(reference, applied.files)).toMatchObject({
      status: "already_applied",
      estimatedOperations: 0,
    });
    expect(() => applyRecipe(reference, applied.files)).toThrow("recipe_already_applied");

    const unsupported = { ...INPUT, ".nvmrc": "22\n" };
    expect(analyzeRecipe(reference, unsupported)).toMatchObject({
      status: "unsupported",
      reasons: ["recipe_precondition_failed:.nvmrc:node_major"],
    });
    expect(applied.files).toEqual(before);
  });

  it("reuses only bounded tenant scoped derived analysis metadata", () => {
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const cache = new RecipeAnalysisCache(1);

    expect(cache.analyze("tenant-a", reference, INPUT).cacheHit).toBe(false);
    expect(cache.analyze("tenant-a", reference, { ...INPUT }).cacheHit).toBe(true);
    expect(cache.apply("tenant-a", reference, INPUT).analysis.cacheHit).toBe(false);
    expect(cache.hits).toBe(2);
    expect(cache.misses).toBe(1);
    expect(cache.analyze("tenant-b", reference, INPUT).cacheHit).toBe(false);
    expect(cache.size).toBe(1);
    expect(JSON.stringify(cache)).not.toContain("payments-api");
    expect(JSON.stringify(cache)).not.toContain("console.log");
  });

  it("rejects unknown recipe versions", () => {
    expect(() => getRecipe("node-runtime-18-to-20", 3)).toThrow(
      "recipe_not_found:node-runtime-18-to-20@3",
    );
    expect(() => getRecipe("node-runtime-18-to-20", 0)).toThrow("recipe_version_invalid");
  });

  it("preserves the immutable v1 recipe and digest for persisted references", () => {
    const legacy = getRecipe("node-runtime-18-to-20", 1);

    expect(legacy.digest).toBe(
      "sha256:2f492907bfd67299218da62d1907ddc503bd7bfec7c1f881b554a0482ef4468f",
    );
    expect(legacy.verificationCommands[0]).toMatchObject({ id: "node-major" });
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(resolveRecipe(recipeReference(legacy))).toBe(legacy);
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

    const commandTampered = {
      ...NODE_RUNTIME_18_TO_20_RECIPE,
      verificationCommands: NODE_RUNTIME_18_TO_20_RECIPE.verificationCommands.map(
        (command, index) => index === 0
          ? { ...command, command: "node -e \"process.exit(0)\"" }
          : command,
      ),
    } as MigrationRecipeContract;
    expect(() => validateRecipe(commandTampered)).toThrow("recipe_digest_mismatch");
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

  it("rejects bidirectional and format control characters but accepts spaces and CJK filenames", () => {
    // U+202E (right-to-left override) can make an executable render as a text file to an operator
    // reading review output. Named by code point so no control character is embedded in source.
    const rloPath = `src/${String.fromCodePoint(0x202e)}gnp.js`;
    expect(() => assertRecipePathAllowed(NODE_RUNTIME_18_TO_20_RECIPE, rloPath)).toThrow("recipe_path_invalid:");

    // Legitimate paths must still pass structural validation: they reach the allowlist check and
    // are rejected there as not-allowed, never as structurally invalid. A path with a space and a
    // CJK filename (built by code point) both stay valid.
    const spacePath = "src/my file.js";
    const cjkPath = `src/${String.fromCodePoint(0x65e5, 0x672c, 0x8a9e)}.js`;
    expect(() => assertRecipePathAllowed(NODE_RUNTIME_18_TO_20_RECIPE, spacePath)).toThrow("recipe_path_not_allowed:");
    expect(() => assertRecipePathAllowed(NODE_RUNTIME_18_TO_20_RECIPE, cjkPath)).toThrow("recipe_path_not_allowed:");
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
