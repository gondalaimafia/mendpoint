import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STRIPE_NODE_V10_TO_V11_RECIPE,
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

const FIXTURE_ROOT = "../../../fixtures/consumers/stripe-node-v10-to-v11/";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(FIXTURE_ROOT + relative, import.meta.url)), "utf8");
}

function load(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = read(`${sub}/${path}`);
  return files;
}

const SUPPORTED_PATHS = ["package.json", "src/payments.js"] as const;
const reference = recipeReference(STRIPE_NODE_V10_TO_V11_RECIPE);

describe("stripe-node-v10-to-v11 recipe", () => {
  it("is a valid, registered, content-addressed recipe", () => {
    expect(() => validateRecipe(STRIPE_NODE_V10_TO_V11_RECIPE)).not.toThrow();
    expect(getRecipe("stripe-node-v10-to-v11", 1)).toBe(STRIPE_NODE_V10_TO_V11_RECIPE);
    expect(resolveRecipe(reference)).toBe(STRIPE_NODE_V10_TO_V11_RECIPE);
    expect(STRIPE_NODE_V10_TO_V11_RECIPE.allowedPaths).toEqual([
      "package.json",
      "src/payments.js",
    ]);
    expect(Object.isFrozen(STRIPE_NODE_V10_TO_V11_RECIPE)).toBe(true);
    for (const command of STRIPE_NODE_V10_TO_V11_RECIPE.verificationCommands) {
      expect(command.command).toMatch(/^node -e "[^"]+"$/);
    }
  });

  it("applies deterministically to the supported before fixture", () => {
    const before = load("before", SUPPORTED_PATHS);
    const after = load("after", SUPPORTED_PATHS);

    const analysis = analyzeRecipe(reference, before);
    expect(analysis.status).toBe("applicable");
    expect([...analysis.matchedPaths]).toEqual(["package.json", "src/payments.js"]);
    expect(analysis.reasons).toEqual([]);
    expect(analysis.estimatedOperations).toBe(2);

    const first = applyRecipe(reference, before);
    const second = applyRecipe(reference, { ...before });
    expect(first.files).toEqual(second.files);
    expect(first.operations.map((operation) => operation.path)).toEqual([
      "package.json",
      "src/payments.js",
    ]);

    // The on-disk after/ fixture is the exact deterministic output.
    expect(first.files["src/payments.js"]).toBe(after["src/payments.js"]);
    expect(first.files["package.json"]).toBe(after["package.json"]);

    // Shape checks: setters folded into the options object, no residual setters.
    expect(first.files["src/payments.js"]).toContain(
      "const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {",
    );
    expect(first.files["src/payments.js"]).toContain("apiVersion: \"2019-08-08\",");
    expect(first.files["src/payments.js"]).toContain("timeout: 20000,");
    expect(first.files["src/payments.js"]).toContain("maxNetworkRetries: 2,");
    expect(first.files["src/payments.js"]).not.toMatch(/\.setApiVersion\(/);
    expect(first.files["src/payments.js"]).not.toMatch(/\.setTimeout\(/);
    expect(JSON.parse(first.files["package.json"]!).dependencies["stripe"]).toBe("^11.0.0");
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

  it("abstains on the removed setApiKey setter (out-of-scope)", () => {
    const files = load("out-of-scope", SUPPORTED_PATHS);
    const analysis = analyzeRecipe(reference, files);
    expect(analysis.status).toBe("unsupported");
    expect(analysis.matchedPaths).toEqual([]);
    expect(analysis.reasons).toContain("recipe_stripe_unsupported_setter:setApiKey");
    expect(() => applyRecipe(reference, files)).toThrow(
      "recipe_stripe_unsupported_setter:setApiKey",
    );
  });

  it("abstains when a supported setter uses nested-parenthesis arguments", () => {
    const base = read("before/src/payments.js");
    const nested = base.replace(
      "stripe.setTimeout(20000);",
      "stripe.setTimeout(readTimeout(env));",
    );
    const analysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/payments.js": nested,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons.some((reason) => reason.startsWith("recipe_stripe_"))).toBe(true);
  });

  it("abstains when the constructor already carries an options object with setters", () => {
    const base = read("before/src/payments.js");
    const mixed = base.replace(
      "const stripe = Stripe(process.env.STRIPE_SECRET_KEY);",
      "const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { appInfo: {} });",
    );
    const analysis = analyzeRecipe(reference, {
      "package.json": read("before/package.json"),
      "src/payments.js": mixed,
    });
    expect(analysis.status).toBe("unsupported");
    expect(analysis.reasons).toContain("recipe_stripe_constructor_options_present");
  });
});
