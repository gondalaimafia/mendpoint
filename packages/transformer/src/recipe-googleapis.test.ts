import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GOOGLEAPIS_V25_TO_V26_RECIPE,
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

const FIXTURE_ROOT = "../../../fixtures/consumers/googleapis-v25-to-v26/";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_ROOT + relative, import.meta.url)), "utf8");
}

function load(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = read(`${sub}/${path}`);
  return files;
}

const SUPPORTED_PATHS = ["package.json", "src/client.js"] as const;
const reference = recipeReference(GOOGLEAPIS_V25_TO_V26_RECIPE);

describe("googleapis-v25-to-v26 recipe", () => {
  it("is a valid, registered, content-addressed recipe", () => {
    expect(() => validateRecipe(GOOGLEAPIS_V25_TO_V26_RECIPE)).not.toThrow();
    expect(getRecipe("googleapis-v25-to-v26", 1)).toBe(GOOGLEAPIS_V25_TO_V26_RECIPE);
    expect(resolveRecipe(reference)).toBe(GOOGLEAPIS_V25_TO_V26_RECIPE);
    expect(GOOGLEAPIS_V25_TO_V26_RECIPE.allowedPaths).toEqual([
      "package.json",
      "src/client.js",
    ]);
    expect(Object.isFrozen(GOOGLEAPIS_V25_TO_V26_RECIPE)).toBe(true);
    for (const command of GOOGLEAPIS_V25_TO_V26_RECIPE.verificationCommands) {
      expect(command.command).toMatch(/^node -e "[^"]+"$/);
    }
  });

  it("applies deterministically to the supported before fixture", () => {
    const before = load("before", SUPPORTED_PATHS);
    const after = load("after", SUPPORTED_PATHS);

    const analysis = analyzeRecipe(reference, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["package.json", "src/client.js"]);
    expect(analysis.reasons).toEqual([]);
    expect(analysis.estimatedOperations).toBe(2);

    const first = applyRecipe(reference, before);
    const second = applyRecipe(reference, { ...before });
    expect(first.files).toEqual(second.files);
    expect(first.operations.map((operation) => operation.path)).toEqual([
      "package.json",
      "src/client.js",
    ]);

    // The on-disk after/ fixture is the exact deterministic output.
    expect(first.files["src/client.js"]).toBe(after["src/client.js"]);
    expect(first.files["package.json"]).toBe(after["package.json"]);

    // Shape checks: named import, no default import, usage unchanged.
    expect(first.files["src/client.js"]).toContain('const { google } = require("googleapis");');
    expect(first.files["src/client.js"]).not.toMatch(
      /(?:const|let|var)\s+google\s*=\s*require\(/,
    );
    expect(first.files["src/client.js"]).toContain("google.gmail({ version: \"v1\", auth })");
    expect(JSON.parse(first.files["package.json"]!).dependencies["googleapis"]).toBe("^26.0.0");
  });

  it("rewrites a renamed default binding and the ESM default import", () => {
    const renamedCjs = applyRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/client.js": [
        'const gapi = require("googleapis");',
        "",
        "module.exports = () => gapi.drive({ version: \"v3\" });",
        "",
      ].join("\n"),
    });
    expect(renamedCjs.files["src/client.js"]).toContain(
      'const { google: gapi } = require("googleapis");',
    );

    const esm = applyRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/client.js": [
        'import google from "googleapis";',
        "",
        "export const drive = google.drive({ version: \"v3\" });",
        "",
      ].join("\n"),
    });
    expect(esm.files["src/client.js"]).toContain('import { google } from "googleapis";');
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

  it("abstains on a namespace import (out-of-scope)", () => {
    const files = load("out-of-scope", SUPPORTED_PATHS);
    const analysis = analyzeRecipe(reference, files);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_googleapis_import_unrecognized");
    expect(() => applyRecipe(reference, files)).toThrow("recipe_googleapis_import_unrecognized");
  });

  it("abstains when the default binding already reads .google (v26 manual form)", () => {
    const manual = [
      'const googleapis = require("googleapis");',
      "",
      "module.exports = () => googleapis.google.drive({ version: \"v3\" });",
      "",
    ].join("\n");
    const analysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/client.js": manual,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_googleapis_named_access_present");
  });
});
