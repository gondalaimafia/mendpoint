import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RecipeCatalogError,
  createProviderRecipeCatalog,
  createRecipeOutcomeEvent,
  recipeArtifactSha256,
  signProviderRecipe,
  verifyProviderRecipeSignature,
  type ProviderRecipeArtifact,
  type SignedProviderRecipe,
} from "./recipe-catalog.js";
import { getRecipe } from "./recipe.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const OTHER_KEYS = generateKeyPairSync("ed25519");
const KEY_ID = "fixture-key-2026-08";
const LEGACY_IMPLEMENTATION_RECIPE = getRecipe("node-runtime-18-to-20", 1);

function fixture(): ProviderRecipeArtifact {
  const raw = readFileSync(
    new URL("../fixtures/acme-payments-node-20.json", import.meta.url),
    "utf8",
  ).replace("RECIPE_DIGEST", LEGACY_IMPLEMENTATION_RECIPE.digest);
  return JSON.parse(raw) as ProviderRecipeArtifact;
}

function signed(artifact: ProviderRecipeArtifact = fixture()): SignedProviderRecipe {
  return signProviderRecipe(artifact, KEY_ID, privateKey);
}

function catalog(artifacts: readonly unknown[] = [signed()]) {
  return createProviderRecipeCatalog({
    artifacts,
    trustedKeys: [{ keyId: KEY_ID, algorithm: "ed25519", publicKey }],
    now: "2026-08-02T01:00:00.000Z",
  });
}

describe("signed provider recipe catalog", () => {
  it("retains immutable copies without freezing caller owned objects", () => {
    const source = fixture();
    const signedCopy = signProviderRecipe(source, KEY_ID, privateKey);
    expect(() => {
      (source.compatibility.languages as string[]).push("javascript");
    }).not.toThrow();
    expect(signedCopy.artifact.compatibility.languages).toEqual(["typescript"]);
  });

  it("loads a signed immutable fixture and resolves an exact compatible recipe", () => {
    const artifact = signed();
    expect(verifyProviderRecipeSignature(artifact, publicKey)).toBe(true);
    expect(artifact.integrity.artifactSha256).toBe(recipeArtifactSha256(artifact.artifact));

    const resolved = catalog().resolve({
      providerSlug: "acme-payments",
      providerCategory: "payments",
      changeTarget: "runtime",
      changeKind: "breaking",
      fromVersion: "18",
      toVersion: "20",
      language: "typescript",
      packageManager: "npm",
      repositoryKind: "service",
      runtime: { name: "node", major: 18 },
    });

    expect(resolved.integrity.artifactSha256).toBe(artifact.integrity.artifactSha256);
    expect(resolved.artifact.boundedEdits.implementationRecipe.digest).toBe(
      LEGACY_IMPLEMENTATION_RECIPE.digest,
    );
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.artifact.boundedEdits.allowedPaths)).toBe(true);
  });

  it("links outcome telemetry to the immutable recipe artifact", () => {
    const artifact = catalog().list()[0]!;
    const event = createRecipeOutcomeEvent(artifact, {
      tenantId: "tenant-a",
      campaignId: "campaign-a",
      runId: "run-a",
      observedAt: "2026-08-02T02:00:00.000Z",
      metrics: {
        accepted: true,
        reviewerEditRatio: 0.04,
        verificationPassed: true,
        rollbackRequired: false,
      },
    });

    expect(event.recipeArtifactSha256).toBe(artifact.integrity.artifactSha256);
    expect(event.recipeId).toBe(artifact.artifact.recipeId);
    expect(event.recipeVersion).toBe(1);
    expect(Object.isFrozen(event.metrics)).toBe(true);
  });

  it("fails closed on unsigned, tampered, untrusted, and revoked artifacts", () => {
    expect(() => catalog([fixture()])).toThrowError(new RecipeCatalogError("recipe_unsigned"));

    const tampered = structuredClone(signed()) as SignedProviderRecipe;
    (tampered.artifact.change as { toVersion: string }).toVersion = "22";
    expect(() => catalog([tampered])).toThrow("recipe_artifact_digest_mismatch");

    const untrusted = signProviderRecipe(fixture(), "other-key", OTHER_KEYS.privateKey);
    expect(() => catalog([untrusted])).toThrow("recipe_signing_key_untrusted");

    const revoked = signed();
    expect(() =>
      createProviderRecipeCatalog({
        artifacts: [revoked],
        trustedKeys: [{ keyId: KEY_ID, algorithm: "ed25519", publicKey }],
        revokedArtifactSha256: [revoked.integrity.artifactSha256],
        now: "2026-08-02T01:00:00.000Z",
      }),
    ).toThrow("recipe_revoked");
  });

  it("rejects malformed, duplicate, ambiguous, and incompatible recipes", () => {
    const malformed = structuredClone(fixture()) as ProviderRecipeArtifact & { unexpected?: true };
    malformed.unexpected = true;
    expect(() => signProviderRecipe(malformed, KEY_ID, privateKey)).toThrow("recipe_field_unknown");

    const first = signed();
    expect(() => catalog([first, first])).toThrow("recipe_duplicate");

    const competing = signed({ ...fixture(), recipeId: "competing-node-migration" });
    const ambiguous = catalog([first, competing]);
    expect(() =>
      ambiguous.resolve({
        providerSlug: "acme-payments",
        providerCategory: "payments",
        changeTarget: "runtime",
        changeKind: "breaking",
        fromVersion: "18",
        toVersion: "20",
        language: "typescript",
        packageManager: "npm",
        repositoryKind: "service",
        runtime: { name: "node", major: 18 },
      }),
    ).toThrow("recipe_ambiguous");

    expect(() =>
      catalog().resolve({
        providerSlug: "acme-payments",
        providerCategory: "payments",
        changeTarget: "runtime",
        changeKind: "breaking",
        fromVersion: "18",
        toVersion: "20",
        language: "typescript",
        packageManager: "pnpm",
        repositoryKind: "service",
        runtime: { name: "node", major: 18 },
      }),
    ).toThrow("recipe_incompatible");
  });

  it("rejects catalog signal paths carrying invisible format or tag characters", () => {
    // safePath in recipe-catalog shares the forbidden-path set with recipe.ts so
    // the two validators cannot drift. U+2028 (line separator) and a U+E0000-range
    // tag character (invisible ASCII smuggling) must both be rejected. Named by
    // code point so no control character is embedded in source.
    const lineSep = structuredClone(fixture()) as ProviderRecipeArtifact;
    (lineSep.detection.allOf[0] as { path: string }).path = `package${String.fromCodePoint(0x2028)}.json`;
    expect(() => signProviderRecipe(lineSep, KEY_ID, privateKey)).toThrow("recipe_path_invalid");

    const tagged = structuredClone(fixture()) as ProviderRecipeArtifact;
    (tagged.detection.allOf[0] as { path: string }).path = `package${String.fromCodePoint(0xe0041)}.json`;
    expect(() => signProviderRecipe(tagged, KEY_ID, privateKey)).toThrow("recipe_path_invalid");
  });

  it("rejects incompatible implementation bounds and undeclared telemetry metrics", () => {
    const incompatible = structuredClone(fixture()) as ProviderRecipeArtifact;
    (incompatible.boundedEdits.allowedPaths as string[]).push("src/unbounded.ts");
    expect(() => signProviderRecipe(incompatible, KEY_ID, privateKey)).toThrow(
      "recipe_implementation_path_incompatible",
    );

    const underBounded = structuredClone(fixture()) as ProviderRecipeArtifact;
    (underBounded.boundedEdits as { maxFilesChanged: number }).maxFilesChanged = 3;
    expect(() => signProviderRecipe(underBounded, KEY_ID, privateKey)).toThrow(
      "recipe_edit_bound_invalid",
    );

    const artifact = catalog().list()[0]!;
    expect(() =>
      createRecipeOutcomeEvent(artifact, {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        runId: "run-a",
        observedAt: "2026-08-02T02:00:00.000Z",
        metrics: { inventedMetric: 1 },
      }),
    ).toThrow("recipe_outcome_metric_undeclared");

    const tampered = structuredClone(artifact) as SignedProviderRecipe;
    (tampered.artifact.change as { toVersion: string }).toVersion = "22";
    expect(() =>
      createRecipeOutcomeEvent(tampered, {
        tenantId: "tenant-a",
        campaignId: "campaign-a",
        runId: "run-a",
        observedAt: "2026-08-02T02:00:00.000Z",
        metrics: { accepted: true },
      }),
    ).toThrow("recipe_artifact_digest_mismatch");
  });
});
