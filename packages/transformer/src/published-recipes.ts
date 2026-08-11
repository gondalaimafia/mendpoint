import type { KeyLike } from "node:crypto";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
} from "./recipe.js";
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

export const STRIPE_NODE_V10_TO_V11_ARTIFACT: ProviderRecipeArtifact = Object.freeze({
  schemaVersion: PROVIDER_RECIPE_SCHEMA_VERSION,
  recipeId: "stripe-node-v10-to-v11",
  version: 1,
  publishedAt: "2026-08-05T00:00:00.000Z",
  provider: {
    slug: "stripe-node",
    category: "payments",
  },
  change: {
    target: "sdk",
    kind: "breaking",
    fromVersion: "10",
    toVersion: "11",
  },
  detection: {
    allOf: [
      {
        kind: "manifest_value",
        path: "package.json",
        selector: "/dependencies/stripe",
        expected: "present at a v10 range",
        evidenceRequired: true,
      },
      {
        kind: "source_pattern",
        path: "src/payments.js",
        selector: "removed stripe config setter calls",
        expected: "stripe client with .setApiVersion/.setTimeout style setter calls",
        evidenceRequired: true,
      },
    ],
  },
  preconditions: [
    {
      id: "stripe-dependency",
      kind: "manifest_value",
      path: "package.json",
      selector: "/dependencies/stripe",
      expected: "present",
    },
    {
      id: "stripe-v10-source",
      kind: "source_pattern",
      path: "src/payments.js",
      selector: "supported stripe v10 setter surface",
      expected: "single stripe construction with supported config setter calls",
    },
  ],
  boundedEdits: {
    implementationRecipe: {
      id: STRIPE_NODE_V10_TO_V11_RECIPE.id,
      version: STRIPE_NODE_V10_TO_V11_RECIPE.version,
      digest: STRIPE_NODE_V10_TO_V11_RECIPE.digest,
    },
    allowedPaths: ["package.json", "src/payments.js"],
    allowedOperationKinds: ["replace_file"],
    maxFilesChanged: 2,
    maxBytesChanged: 65536,
  },
  verification: [
    {
      id: "unit-and-typecheck",
      command: "npm test && npm run typecheck",
      timeoutMs: 900000,
      successCriteria: "Consumer tests and typecheck pass on the migrated v11 sources",
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

export const GOOGLEAPIS_V25_TO_V26_ARTIFACT: ProviderRecipeArtifact = Object.freeze({
  schemaVersion: PROVIDER_RECIPE_SCHEMA_VERSION,
  recipeId: "googleapis-v25-to-v26",
  version: 1,
  publishedAt: "2026-08-05T00:00:00.000Z",
  provider: {
    slug: "googleapis",
    category: "developer_platform",
  },
  change: {
    target: "sdk",
    kind: "breaking",
    fromVersion: "25",
    toVersion: "26",
  },
  detection: {
    allOf: [
      {
        kind: "manifest_value",
        path: "package.json",
        selector: "/dependencies/googleapis",
        expected: "present at a v25 range",
        evidenceRequired: true,
      },
      {
        kind: "source_pattern",
        path: "src/client.js",
        selector: "default googleapis import",
        expected: "const google = require('googleapis') or import google from 'googleapis'",
        evidenceRequired: true,
      },
    ],
  },
  preconditions: [
    {
      id: "googleapis-dependency",
      kind: "manifest_value",
      path: "package.json",
      selector: "/dependencies/googleapis",
      expected: "present",
    },
    {
      id: "googleapis-v25-source",
      kind: "source_pattern",
      path: "src/client.js",
      selector: "supported googleapis default import",
      expected: "default require or import binding of googleapis",
    },
  ],
  boundedEdits: {
    implementationRecipe: {
      id: GOOGLEAPIS_V25_TO_V26_RECIPE.id,
      version: GOOGLEAPIS_V25_TO_V26_RECIPE.version,
      digest: GOOGLEAPIS_V25_TO_V26_RECIPE.digest,
    },
    allowedPaths: ["package.json", "src/client.js"],
    allowedOperationKinds: ["replace_file"],
    maxFilesChanged: 2,
    maxBytesChanged: 65536,
  },
  verification: [
    {
      id: "unit-and-typecheck",
      command: "npm test && npm run typecheck",
      timeoutMs: 900000,
      successCriteria: "Consumer tests and typecheck pass on the migrated v26 sources",
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

export const REACT_DOM_17_TO_18_ARTIFACT: ProviderRecipeArtifact = Object.freeze({
  schemaVersion: PROVIDER_RECIPE_SCHEMA_VERSION,
  recipeId: "react-dom-17-to-18",
  version: 1,
  publishedAt: "2026-08-05T00:00:00.000Z",
  provider: {
    slug: "react-dom",
    category: "developer_platform",
  },
  change: {
    target: "framework",
    kind: "breaking",
    fromVersion: "17",
    toVersion: "18",
  },
  detection: {
    allOf: [
      {
        kind: "manifest_value",
        path: "package.json",
        selector: "/dependencies/react-dom",
        expected: "present at a v17 range",
        evidenceRequired: true,
      },
      {
        kind: "source_pattern",
        path: "src/index.jsx",
        selector: "legacy react-dom render entry point",
        expected: "default react-dom import with ReactDOM.render or ReactDOM.hydrate",
        evidenceRequired: true,
      },
    ],
  },
  preconditions: [
    {
      id: "react-dom-dependency",
      kind: "manifest_value",
      path: "package.json",
      selector: "/dependencies/react-dom",
      expected: "present",
    },
    {
      id: "react-dom-17-source",
      kind: "source_pattern",
      path: "src/index.jsx",
      selector: "supported react-dom legacy render surface",
      expected: "default react-dom import with render or hydrate into two arguments",
    },
  ],
  boundedEdits: {
    implementationRecipe: {
      id: REACT_DOM_17_TO_18_RECIPE.id,
      version: REACT_DOM_17_TO_18_RECIPE.version,
      digest: REACT_DOM_17_TO_18_RECIPE.digest,
    },
    allowedPaths: ["package.json", "src/index.jsx", "src/index.tsx"],
    allowedOperationKinds: ["replace_file"],
    maxFilesChanged: 3,
    maxBytesChanged: 65536,
  },
  verification: [
    {
      id: "unit-and-typecheck",
      command: "npm test && npm run typecheck",
      timeoutMs: 900000,
      successCriteria: "Consumer tests and typecheck pass on the migrated v18 sources",
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

export const NODE_RUNTIME_20_TO_22_ARTIFACT: ProviderRecipeArtifact = Object.freeze({
  schemaVersion: PROVIDER_RECIPE_SCHEMA_VERSION,
  recipeId: "node-runtime-20-to-22",
  version: 1,
  publishedAt: "2026-08-05T00:00:00.000Z",
  provider: {
    slug: "node",
    category: "developer_platform",
  },
  change: {
    target: "runtime",
    kind: "breaking",
    fromVersion: "20",
    toVersion: "22",
  },
  detection: {
    allOf: [
      {
        kind: "manifest_value",
        path: "package.json",
        selector: "/engines/node",
        expected: "present at a recognized Node 20 selector",
        evidenceRequired: true,
      },
      {
        kind: "source_pattern",
        path: "Dockerfile",
        selector: "node base image pin",
        expected: "FROM node:20 base image tag",
        evidenceRequired: true,
      },
    ],
  },
  preconditions: [
    {
      id: "node-engine",
      kind: "manifest_value",
      path: "package.json",
      selector: "/engines/node",
      expected: "recognized Node 20 selector",
    },
    {
      id: "node-runtime-declarations",
      kind: "source_pattern",
      path: "Dockerfile",
      selector: "supported Node 20 pin surface",
      expected: "node:20 base image and optional .nvmrc/.node-version at major 20",
    },
  ],
  boundedEdits: {
    implementationRecipe: {
      id: NODE_RUNTIME_20_TO_22_RECIPE.id,
      version: NODE_RUNTIME_20_TO_22_RECIPE.version,
      digest: NODE_RUNTIME_20_TO_22_RECIPE.digest,
    },
    allowedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
    allowedOperationKinds: ["replace_file"],
    maxFilesChanged: 4,
    maxBytesChanged: 65536,
  },
  verification: [
    {
      id: "unit-and-typecheck",
      command: "npm test && npm run typecheck",
      timeoutMs: 900000,
      successCriteria: "Consumer tests and typecheck pass on the migrated Node 22 pins",
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
      minMajor: 20,
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
  STRIPE_NODE_V10_TO_V11_ARTIFACT,
  GOOGLEAPIS_V25_TO_V26_ARTIFACT,
  REACT_DOM_17_TO_18_ARTIFACT,
  NODE_RUNTIME_20_TO_22_ARTIFACT,
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
