import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AWS_SDK_JS_V2_TO_V3_ARTIFACT,
  GOOGLEAPIS_V25_TO_V26_ARTIFACT,
  PUBLISHED_PROVIDER_RECIPE_ARTIFACTS,
  STRIPE_NODE_V10_TO_V11_ARTIFACT,
  createPublishedProviderRecipeCatalog,
  signPublishedProviderRecipes,
} from "./published-recipes.js";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
} from "./recipe.js";
import {
  recipeArtifactSha256,
  verifyProviderRecipeSignature,
  type ProviderRecipeResolution,
} from "./recipe-catalog.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "aws-recipe-key-2026-08";

const AWS_QUERY: ProviderRecipeResolution = {
  providerSlug: "aws-sdk-js",
  providerCategory: "cloud",
  changeTarget: "sdk",
  changeKind: "breaking",
  fromVersion: "2",
  toVersion: "3",
  language: "javascript",
  packageManager: "npm",
  repositoryKind: "service",
  runtime: { name: "node", major: 20 },
};

const STRIPE_QUERY: ProviderRecipeResolution = {
  providerSlug: "stripe-node",
  providerCategory: "payments",
  changeTarget: "sdk",
  changeKind: "breaking",
  fromVersion: "10",
  toVersion: "11",
  language: "javascript",
  packageManager: "npm",
  repositoryKind: "service",
  runtime: { name: "node", major: 20 },
};

const GOOGLEAPIS_QUERY: ProviderRecipeResolution = {
  providerSlug: "googleapis",
  providerCategory: "developer_platform",
  changeTarget: "sdk",
  changeKind: "breaking",
  fromVersion: "25",
  toVersion: "26",
  language: "javascript",
  packageManager: "npm",
  repositoryKind: "service",
  runtime: { name: "node", major: 20 },
};

function catalog() {
  return createPublishedProviderRecipeCatalog({
    signedArtifacts: signPublishedProviderRecipes({ keyId: KEY_ID, privateKey }),
    trustedKeys: [{ keyId: KEY_ID, algorithm: "ed25519", publicKey }],
    now: "2026-08-06T00:00:00.000Z",
  });
}

describe("published provider recipes", () => {
  it("publishes the three artifacts each bound to its executable recipe", () => {
    expect(PUBLISHED_PROVIDER_RECIPE_ARTIFACTS).toHaveLength(3);
    const bindings = [
      [AWS_SDK_JS_V2_TO_V3_ARTIFACT, AWS_SDK_JS_V2_TO_V3_RECIPE, "aws-sdk-js-v2-to-v3"],
      [STRIPE_NODE_V10_TO_V11_ARTIFACT, STRIPE_NODE_V10_TO_V11_RECIPE, "stripe-node-v10-to-v11"],
      [GOOGLEAPIS_V25_TO_V26_ARTIFACT, GOOGLEAPIS_V25_TO_V26_RECIPE, "googleapis-v25-to-v26"],
    ] as const;
    for (const [artifact, recipe, id] of bindings) {
      expect(artifact.recipeId).toBe(id);
      expect(artifact.boundedEdits.implementationRecipe.digest).toBe(recipe.digest);
      expect([...artifact.boundedEdits.allowedPaths].sort()).toEqual(
        [...recipe.allowedPaths].sort(),
      );
    }
  });

  it("signs and verifies every published artifact", () => {
    const signed = signPublishedProviderRecipes({ keyId: KEY_ID, privateKey });
    expect(signed).toHaveLength(3);
    for (const artifact of signed) {
      expect(verifyProviderRecipeSignature(artifact, publicKey)).toBe(true);
      expect(artifact.integrity.artifactSha256).toBe(recipeArtifactSha256(artifact.artifact));
    }
  });

  it("resolves each published migration to its executable recipe reference", () => {
    const resolver = catalog();
    const cases = [
      [AWS_QUERY, AWS_SDK_JS_V2_TO_V3_RECIPE, "aws-sdk-js-v2-to-v3"],
      [STRIPE_QUERY, STRIPE_NODE_V10_TO_V11_RECIPE, "stripe-node-v10-to-v11"],
      [GOOGLEAPIS_QUERY, GOOGLEAPIS_V25_TO_V26_RECIPE, "googleapis-v25-to-v26"],
    ] as const;
    for (const [query, recipe, id] of cases) {
      const resolved = resolver.resolve(query);
      expect(resolved.artifact.recipeId).toBe(id);
      expect(resolved.artifact.boundedEdits.implementationRecipe.digest).toBe(recipe.digest);
      expect(resolved.artifact.boundedEdits.implementationRecipe.id).toBe(recipe.id);
    }
  });

  it("fails closed when the signing key is not trusted", () => {
    const otherKeys = generateKeyPairSync("ed25519");
    expect(() =>
      createPublishedProviderRecipeCatalog({
        signedArtifacts: signPublishedProviderRecipes({ keyId: KEY_ID, privateKey }),
        trustedKeys: [{ keyId: KEY_ID, algorithm: "ed25519", publicKey: otherKeys.publicKey }],
        now: "2026-08-06T00:00:00.000Z",
      }),
    ).toThrow("recipe_signature_invalid");
  });

  it("does not resolve incompatible package managers", () => {
    expect(() => catalog().resolve({ ...AWS_QUERY, packageManager: "bun" })).toThrow(
      "recipe_incompatible",
    );
  });
});
