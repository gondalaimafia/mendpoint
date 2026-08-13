import { describe, expect, it } from "vitest";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  classifyRecipeContract,
  classifyRecipeReference,
  recipeReference,
} from "./recipe.js";

describe("recipe classification", () => {
  it("classifies each registered recipe deterministically by family/provider/framework", () => {
    expect(classifyRecipeReference(recipeReference(AWS_SDK_JS_V2_TO_V3_RECIPE))).toEqual({
      family: "sdk",
      provider: "aws-sdk-js",
      framework: null,
    });
    expect(classifyRecipeReference(recipeReference(STRIPE_NODE_V10_TO_V11_RECIPE))).toEqual({
      family: "sdk",
      provider: "stripe",
      framework: null,
    });
    expect(classifyRecipeReference(recipeReference(GOOGLEAPIS_V25_TO_V26_RECIPE))).toEqual({
      family: "sdk",
      provider: "googleapis",
      framework: null,
    });
    expect(classifyRecipeReference(recipeReference(REACT_DOM_17_TO_18_RECIPE))).toEqual({
      family: "framework",
      provider: "react-dom",
      framework: "react-dom",
    });
    expect(classifyRecipeReference(recipeReference(NODE_RUNTIME_18_TO_20_RECIPE))).toEqual({
      family: "runtime",
      provider: "node",
      framework: null,
    });
    expect(classifyRecipeReference(recipeReference(NODE_RUNTIME_20_TO_22_RECIPE))).toEqual({
      family: "runtime",
      provider: "node",
      framework: null,
    });
    expect(classifyRecipeReference(recipeReference(INTERNAL_API_ACME_USER_RENAME_RECIPE))).toEqual({
      family: "internal_api",
      provider: null,
      framework: null,
    });
  });

  it("fails closed to all-null for an unresolvable reference (never throws)", () => {
    expect(
      classifyRecipeReference({
        id: "does-not-exist",
        version: 1,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    ).toEqual({ family: null, provider: null, framework: null });
    // A registered id at a drifted digest is also undeterminable, not a throw.
    expect(
      classifyRecipeReference({
        id: AWS_SDK_JS_V2_TO_V3_RECIPE.id,
        version: AWS_SDK_JS_V2_TO_V3_RECIPE.version,
        digest: `sha256:${"1".repeat(64)}`,
      }),
    ).toEqual({ family: null, provider: null, framework: null });
  });

  it("classifies a contract with no recognized identifying transform as all-null", () => {
    const contract = {
      ...NODE_RUNTIME_18_TO_20_RECIPE,
      transforms: [] as never,
    };
    expect(classifyRecipeContract(contract)).toEqual({
      family: null,
      provider: null,
      framework: null,
    });
  });
});
