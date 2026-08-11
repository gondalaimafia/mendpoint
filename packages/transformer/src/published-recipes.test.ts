import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AWS_SDK_JS_V2_TO_V3_ARTIFACT,
  PUBLISHED_PROVIDER_RECIPE_ARTIFACTS,
  createPublishedProviderRecipeCatalog,
  signPublishedProviderRecipes,
} from "./published-recipes.js";
import { AWS_SDK_JS_V2_TO_V3_RECIPE } from "./recipe.js";
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

function catalog() {
  return createPublishedProviderRecipeCatalog({
    signedArtifacts: signPublishedProviderRecipes({ keyId: KEY_ID, privateKey }),
    trustedKeys: [{ keyId: KEY_ID, algorithm: "ed25519", publicKey }],
    now: "2026-08-06T00:00:00.000Z",
  });
}

describe("published provider recipes", () => {
  it("publishes exactly the aws-sdk-js artifact bound to the executable recipe", () => {
    expect(PUBLISHED_PROVIDER_RECIPE_ARTIFACTS).toHaveLength(1);
    expect(AWS_SDK_JS_V2_TO_V3_ARTIFACT.recipeId).toBe("aws-sdk-js-v2-to-v3");
    expect(AWS_SDK_JS_V2_TO_V3_ARTIFACT.boundedEdits.implementationRecipe.digest).toBe(
      AWS_SDK_JS_V2_TO_V3_RECIPE.digest,
    );
    expect([...AWS_SDK_JS_V2_TO_V3_ARTIFACT.boundedEdits.allowedPaths].sort()).toEqual(
      [...AWS_SDK_JS_V2_TO_V3_RECIPE.allowedPaths].sort(),
    );
  });

  it("signs and verifies the published artifact", () => {
    const [signed] = signPublishedProviderRecipes({ keyId: KEY_ID, privateKey });
    expect(verifyProviderRecipeSignature(signed!, publicKey)).toBe(true);
    expect(signed!.integrity.artifactSha256).toBe(recipeArtifactSha256(signed!.artifact));
  });

  it("resolves the aws-sdk-js v2 to v3 migration to the executable recipe reference", () => {
    const resolved = catalog().resolve(AWS_QUERY);
    expect(resolved.artifact.recipeId).toBe("aws-sdk-js-v2-to-v3");
    expect(resolved.artifact.boundedEdits.implementationRecipe.digest).toBe(
      AWS_SDK_JS_V2_TO_V3_RECIPE.digest,
    );
    expect(resolved.artifact.boundedEdits.implementationRecipe.id).toBe(
      AWS_SDK_JS_V2_TO_V3_RECIPE.id,
    );
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
