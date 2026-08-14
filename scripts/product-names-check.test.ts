import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findLegacyProductNames,
  findUnusedProductNameExceptions,
  productNameTokenCandidates,
  PRODUCT_NAME_COMPATIBILITY_EXCEPTIONS,
  scanProductNamesReport,
} from "./product-names-check.js";
import type { ProductNameCompatibilityException } from "./product-names-check.js";

function generatedDocsExceptions(
  path: string,
  sourceTexts: readonly string[],
): ProductNameCompatibilityException[] {
  return sourceTexts.map((sourceText) => ({
    path,
    sourceText,
    reason: "Generated docs preserve an existing route, command, manifest, or evidence locator.",
  }));
}

const GENERATED_DOCS_COMPATIBILITY_EXCEPTIONS = [
  ...generatedDocsExceptions("docs/website-upload/billing-usage.html", ["apps/worker/src/warden-model-accounting.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/billing-usage.md", ["apps/worker/src/warden-model-accounting.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/deployment-operations.html", ["fly.transformer.toml", "apps/worker/src/transformer-production-profile.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/deployment-operations.md", ["fly.transformer.toml", "apps/worker/src/transformer-production-profile.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/fettler.html", ["eval:warden", "apps/worker/src/warden-candidate-update.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/fettler.md", ["eval:warden", "apps/worker/src/warden-candidate-update.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/learning-system.html", ["apps/worker/src/transformer-learning.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/learning-system.md", ["apps/worker/src/transformer-learning.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/regauge.html", [
    "/transformer/missions.",
    "/transformer/missions",
    "/transformer/control-plane/campaigns/:campaignId/review",
    "/transformer/executions/:campaignId",
    "eval:transformer:canary",
    "packages/transformer/src/mission-planner.test.ts",
    "packages/transformer/src/pilot-execution.test.ts",
    "apps/worker/src/transformer-multinode-service.test.ts",
  ]),
  ...generatedDocsExceptions("docs/website-upload/regauge.md", [
    "/transformer/missions.",
    "/transformer/missions",
    "/transformer/control-plane/campaigns/:campaignId/review",
    "/transformer/executions/:campaignId",
    "eval:transformer:canary",
    "packages/transformer/src/mission-planner.test.ts",
    "packages/transformer/src/pilot-execution.test.ts",
    "apps/worker/src/transformer-multinode-service.test.ts",
  ]),
  ...generatedDocsExceptions("docs/website-upload/security-governance.html", ["scripts/customer-warden-profile.test.ts"]),
  ...generatedDocsExceptions("docs/website-upload/security-governance.md", ["scripts/customer-warden-profile.test.ts"]),
] satisfies readonly ProductNameCompatibilityException[];

describe("product names check", () => {
  it("detects legacy product names without case sensitivity", () => {
    expect(findLegacyProductNames("fixture.ts", [
      { sourceText: "wArDeN started", line: 4 },
      { sourceText: "TRANSFORMER ready", line: 8 },
    ], [])).toEqual([
      expect.objectContaining({ line: 4, legacyName: "wArDeN" }),
      expect.objectContaining({ line: 8, legacyName: "TRANSFORMER" }),
    ]);
  });

  it("suppresses only an exact documented compatibility string", () => {
    const [exception] = PRODUCT_NAME_COMPATIBILITY_EXCEPTIONS;
    expect(findLegacyProductNames(exception.path, [
      { sourceText: exception.sourceText, line: 1 },
      { sourceText: `${exception.sourceText} changed`, line: 2 },
    ])).toEqual([
      expect.objectContaining({ line: 2, legacyName: "Warden" }),
    ]);
  });

  it("rejects compatibility exceptions that no longer match an exact source string", () => {
    const exceptions = [
      { path: "fixture.ts", sourceText: "warden", reason: "Machine selector." },
      { path: "fixture.ts", sourceText: "/transformer", reason: "Compatibility route." },
    ] as const;
    expect(findUnusedProductNameExceptions([
      { path: "fixture.ts", candidates: [{ sourceText: "warden", line: 1 }] },
    ], exceptions)).toEqual([exceptions[1]]);
  });

  it("keeps every configured customer-visible surface on the new names", () => {
    const root = resolve(import.meta.dirname, "..");
    expect(scanProductNamesReport(root)).toEqual({ violations: [], unusedExceptions: [] });
  });

  it("keeps generated documentation prose on the new names", () => {
    const root = resolve(import.meta.dirname, "..");
    const bundleRoot = resolve(root, "docs/website-upload");
    const surfaces = readdirSync(bundleRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = `docs/website-upload/${entry.name}`;
        return {
          path,
          candidates: productNameTokenCandidates(readFileSync(resolve(root, path), "utf8")),
        };
      });
    const exceptions = GENERATED_DOCS_COMPATIBILITY_EXCEPTIONS;
    expect(surfaces.flatMap(({ path, candidates }) =>
      findLegacyProductNames(path, candidates, exceptions)
    )).toEqual([]);
    expect(findUnusedProductNameExceptions(surfaces, exceptions)).toEqual([]);
  });
});
