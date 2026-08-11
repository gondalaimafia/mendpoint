import type { KeyLike } from "node:crypto";
import { AWS_SDK_JS_V2_TO_V3_RECIPE } from "./recipe.js";
import {
  PROVIDER_RECIPE_SCHEMA_VERSION,
  createProviderRecipeCatalog,
  signProviderRecipe,
  type ProviderRecipeArtifact,
  type SignedProviderRecipe,
} from "./recipe-catalog.js";

/**
 * Canonical, immutable provider-recipe artifacts published by Mendpoint. This
 * module is the single seam that populates {@link createProviderRecipeCatalog}
 * in the run path: nothing else supplies artifacts to the catalog today. Each
 * artifact binds to an executable {@link AWS_SDK_JS_V2_TO_V3_RECIPE}-style
 * recipe registered in `recipe.ts`, so catalog resolution yields an
 * `implementationRecipe` reference that the workspace executor can run behind
 * the enablement gate.
 *
 * Signing keys are never embedded here. In production the offline recipe
 * signing private key (held in a secret manager / KMS) signs these artifacts
 * and the deploy supplies the pre-signed artifacts plus the trusted public
 * keys via configuration. {@link signPublishedProviderRecipes} is the signing
 * helper used by that trusted signing context (and by tests/evals with an
 * ephemeral key); {@link createPublishedProviderRecipeCatalog} builds the
 * run-path catalog from already-signed artifacts and trusted public keys.
 */
export const AWS_SDK_JS_V2_TO_V3_ARTIFACT: ProviderRecipeArtifact = Object.freeze({
  schemaVersion: PROVIDER_RECIPE_SCHEMA_VERSION,
  recipeId: "aws-sdk-js-v2-to-v3",
  version: 1,
  publishedAt: "2026-08-05T00:00:00.000Z",
  provider: {
    slug: "aws-sdk-js",
    category: "cloud",
  },
  change: {
    target: "sdk",
    kind: "breaking",
    fromVersion: "2",
    toVersion: "3",
  },
  detection: {
    allOf: [
      {
        kind: "manifest_value",
        path: "package.json",
        selector: "/dependencies/aws-sdk",
        expected: "present",
        evidenceRequired: true,
      },
      {
        kind: "source_pattern",
        path: "src/s3.js",
        selector: "aws-sdk v2 default import and client usage",
        expected: "require or import of aws-sdk with new AWS.S3 or DocumentClient",
        evidenceRequired: true,
      },
    ],
  },
  preconditions: [
    {
      id: "aws-sdk-dependency",
      kind: "manifest_value",
      path: "package.json",
      selector: "/dependencies/aws-sdk",
      expected: "present",
    },
    {
      id: "aws-sdk-v2-source",
      kind: "source_pattern",
      path: "src/s3.js",
      selector: "supported aws-sdk v2 surface",
      expected: "S3 or DocumentClient promise-style operations within the supported set",
    },
  ],
  boundedEdits: {
    implementationRecipe: {
      id: AWS_SDK_JS_V2_TO_V3_RECIPE.id,
      version: AWS_SDK_JS_V2_TO_V3_RECIPE.version,
      digest: AWS_SDK_JS_V2_TO_V3_RECIPE.digest,
    },
    allowedPaths: ["package.json", "src/dynamo.js", "src/s3.js"],
    allowedOperationKinds: ["replace_file"],
    maxFilesChanged: 3,
    maxBytesChanged: 65536,
  },
  verification: [
    {
      id: "unit-and-typecheck",
      command: "npm test && npm run typecheck",
      timeoutMs: 900000,
      successCriteria: "Consumer tests and typecheck pass on the migrated v3 sources",
      required: true,
    },
  ],
  rollback: {
    strategy: "inverse_operations",
    verificationIds: ["unit-and-typecheck"],
    maxRecoveryMinutes: 30,
  },
  evidence: {
    requiredSourceKinds: ["provider_release", "provider_documentation", "repository_snapshot"],
    retainInputSnapshot: true,
    retainOperationDiffs: true,
    retainVerificationOutput: true,
  },
  ownership: {
    team: "change-intelligence",
    maintainerPrincipalId: "human:recipe-maintainer",
    securityReviewerPrincipalId: "human:security-reviewer",
  },
  compatibility: {
    languages: ["javascript", "typescript"],
    packageManagers: ["npm", "pnpm", "yarn"],
    repositoryKinds: ["service", "library"],
    runtime: {
      name: "node",
      minMajor: 16,
      maxMajor: 22,
    },
  },
  outcomeTelemetry: {
    schemaVersion: 1,
    eventName: "provider_recipe_outcome",
    correlationFields: ["tenantId", "campaignId", "runId", "recipeArtifactSha256"],
    metricIds: ["accepted", "reviewerEditRatio", "verificationPassed", "rollbackRequired"],
    retentionDays: 90,
  },
} as const);

/** All provider-recipe artifacts Mendpoint publishes into the run-path catalog. */
export const PUBLISHED_PROVIDER_RECIPE_ARTIFACTS: readonly ProviderRecipeArtifact[] = Object.freeze([
  AWS_SDK_JS_V2_TO_V3_ARTIFACT,
]);

export type ProviderRecipeSigningKey = Readonly<{ keyId: string; privateKey: KeyLike }>;

export type ProviderRecipeTrustedKey = Readonly<{
  keyId: string;
  algorithm: "ed25519";
  publicKey: KeyLike;
}>;

/**
 * Sign every published artifact with the supplied ed25519 signing key. Run in a
 * trusted signing context (offline release tooling) or in tests/evals with an
 * ephemeral key. The private key is never persisted by this module.
 */
export function signPublishedProviderRecipes(
  key: ProviderRecipeSigningKey,
): readonly SignedProviderRecipe[] {
  return Object.freeze(
    PUBLISHED_PROVIDER_RECIPE_ARTIFACTS.map((artifact) =>
      signProviderRecipe(artifact, key.keyId, key.privateKey),
    ),
  );
}

export type CreatePublishedProviderRecipeCatalogInput = Readonly<{
  signedArtifacts: readonly SignedProviderRecipe[];
  trustedKeys: readonly ProviderRecipeTrustedKey[];
  now: string;
  revokedArtifactSha256?: readonly string[];
  revokedRecipeVersions?: readonly string[];
  revokedKeyIds?: readonly string[];
}>;

/**
 * Build the run-path provider-recipe catalog from pre-signed published
 * artifacts and the trusted public keys supplied at deploy time. This is the
 * minimal wiring that lets a campaign resolve `aws-sdk-js@v2 -> v3` and reach
 * the executable recipe reference, mirroring how the Node recipe reaches
 * execution.
 */
export function createPublishedProviderRecipeCatalog(
  input: CreatePublishedProviderRecipeCatalogInput,
) {
  return createProviderRecipeCatalog({
    artifacts: input.signedArtifacts,
    trustedKeys: input.trustedKeys,
    now: input.now,
    ...(input.revokedArtifactSha256 ? { revokedArtifactSha256: input.revokedArtifactSha256 } : {}),
    ...(input.revokedRecipeVersions ? { revokedRecipeVersions: input.revokedRecipeVersions } : {}),
    ...(input.revokedKeyIds ? { revokedKeyIds: input.revokedKeyIds } : {}),
  });
}
