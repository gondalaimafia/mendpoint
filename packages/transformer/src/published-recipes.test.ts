import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AWS_SDK_JS_V2_TO_V3_ARTIFACT,
  GOOGLEAPIS_V25_TO_V26_ARTIFACT,
  INTERNAL_API_ACME_USER_RENAME_ARTIFACT,
  NODE_RUNTIME_20_TO_22_ARTIFACT,
  PUBLISHED_PROVIDER_RECIPE_ARTIFACTS,
  REACT_DOM_17_TO_18_ARTIFACT,
  STRIPE_NODE_V10_TO_V11_ARTIFACT,
  createPublishedProviderRecipeCatalog,
  signPublishedProviderRecipes,
} from "./published-recipes.js";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
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

const REACT_QUERY: ProviderRecipeResolution = {
  providerSlug: "react-dom",
  providerCategory: "developer_platform",
  changeTarget: "framework",
  changeKind: "breaking",
  fromVersion: "17",
  toVersion: "18",
  language: "javascript",
  packageManager: "npm",
  repositoryKind: "service",
  runtime: { name: "node", major: 20 },
};

const NODE_RUNTIME_QUERY: ProviderRecipeResolution = {
  providerSlug: "node",
  providerCategory: "developer_platform",
  changeTarget: "runtime",
  changeKind: "breaking",
  fromVersion: "20",
  toVersion: "22",
  language: "javascript",
  packageManager: "npm",
  repositoryKind: "service",
  runtime: { name: "node", major: 20 },
};

const INTERNAL_API_QUERY: ProviderRecipeResolution = {
  providerSlug: "acme-internal-user-api",
  providerCategory: "identity",
  changeTarget: "api",
  changeKind: "breaking",
  fromVersion: "1",
  toVersion: "2",
  language: "typescript",
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
  it("publishes the six artifacts each bound to its executable recipe", () => {
    expect(PUBLISHED_PROVIDER_RECIPE_ARTIFACTS).toHaveLength(6);
    const bindings = [
      [AWS_SDK_JS_V2_TO_V3_ARTIFACT, AWS_SDK_JS_V2_TO_V3_RECIPE, "aws-sdk-js-v2-to-v3"],
      [STRIPE_NODE_V10_TO_V11_ARTIFACT, STRIPE_NODE_V10_TO_V11_RECIPE, "stripe-node-v10-to-v11"],
      [GOOGLEAPIS_V25_TO_V26_ARTIFACT, GOOGLEAPIS_V25_TO_V26_RECIPE, "googleapis-v25-to-v26"],
      [REACT_DOM_17_TO_18_ARTIFACT, REACT_DOM_17_TO_18_RECIPE, "react-dom-17-to-18"],
      [NODE_RUNTIME_20_TO_22_ARTIFACT, NODE_RUNTIME_20_TO_22_RECIPE, "node-runtime-20-to-22"],
      [
        INTERNAL_API_ACME_USER_RENAME_ARTIFACT,
        INTERNAL_API_ACME_USER_RENAME_RECIPE,
        "internal-api-acme-user-getuser-to-fetchuser",
      ],
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
    expect(signed).toHaveLength(6);
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
      [REACT_QUERY, REACT_DOM_17_TO_18_RECIPE, "react-dom-17-to-18"],
      [NODE_RUNTIME_QUERY, NODE_RUNTIME_20_TO_22_RECIPE, "node-runtime-20-to-22"],
      [
        INTERNAL_API_QUERY,
        INTERNAL_API_ACME_USER_RENAME_RECIPE,
        "internal-api-acme-user-getuser-to-fetchuser",
      ],
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
