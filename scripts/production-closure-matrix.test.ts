import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductRequirementManifest } from "@mendpoint/contract";
import {
  validateProductionClosureMatrix,
  type ProductionClosureMatrix,
} from "./production-closure-matrix.js";

const root = resolve(import.meta.dirname, "..");

function loadManifest(): ProductRequirementManifest {
  return JSON.parse(
    readFileSync(resolve(root, "docs", "PRODUCT_REQUIREMENTS.json"), "utf8"),
  ) as ProductRequirementManifest;
}

function loadMatrix(): ProductionClosureMatrix {
  return JSON.parse(
    readFileSync(resolve(root, "docs", "PRODUCTION_CLOSURE_MATRIX.json"), "utf8"),
  ) as ProductionClosureMatrix;
}

function codes(
  manifest: ProductRequirementManifest,
  matrix: ProductionClosureMatrix,
): string[] {
  return validateProductionClosureMatrix(manifest, matrix).map((issue) => issue.code);
}

describe("production closure matrix", () => {
  it("covers every requirement across every canonical register set", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    const requirementCount =
      manifest.requirements.length +
      (manifest.additionalRegisterSets ?? []).reduce(
        (total, set) => total + set.requirements.length,
        0,
      );

    expect(requirementCount).toBe(101);
    expect(matrix.requirements).toHaveLength(101);
    expect(validateProductionClosureMatrix(manifest, matrix)).toEqual([]);
  });

  it("fails when a registered requirement is missing", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.requirements.pop();

    expect(codes(manifest, matrix)).toContain("REQUIREMENT_MISSING");
  });

  it("fails when a matrix status drifts from the canonical register", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.requirements[0].status.implementationStatus = "verified";

    expect(codes(manifest, matrix)).toContain("STATUS_DRIFT");
  });

  it("fails unknown requirement links and malformed pull request references", () => {
    const manifest = loadManifest();
    const matrix = loadMatrix();
    matrix.releaseTrain.openPullRequests[0].requirementIds.push("ME-UNKNOWN-999");
    matrix.requirements[0].pullRequests.push(0);

    expect(codes(manifest, matrix)).toEqual(
      expect.arrayContaining(["UNKNOWN_REQUIREMENT_REFERENCE", "PR_REFERENCE"]),
    );
  });

  it("fails verified or GA promotion without canonical evidence", () => {
    const verifiedManifest = loadManifest();
    const verifiedMatrix = loadMatrix();
    const verifiedRequirement = verifiedManifest.requirements[0];
    verifiedRequirement.implementationStatus = "verified";
    verifiedRequirement.acceptance[0].evidence = [];
    verifiedMatrix.requirements[0].status.implementationStatus = "verified";

    expect(codes(verifiedManifest, verifiedMatrix)).toContain(
      "VERIFIED_EVIDENCE_REQUIRED",
    );

    const gaManifest = loadManifest();
    const gaMatrix = loadMatrix();
    const gaRequirement = gaManifest.requirements[0];
    gaRequirement.implementationStatus = "verified";
    gaRequirement.availability = "ga";
    gaRequirement.acceptance[0].evidence = [
      {
        id: `${gaRequirement.acceptance[0].id}-EV99`,
        type: "unit",
        locator: "packages/contract/src/product-requirements.test.ts",
      },
    ];
    gaMatrix.requirements[0].status = {
      implementationStatus: "verified",
      availability: "ga",
      claimState: gaRequirement.claimState,
    };

    expect(codes(gaManifest, gaMatrix)).toContain(
      "GA_PRODUCTION_EVIDENCE_REQUIRED",
    );
  });
});
