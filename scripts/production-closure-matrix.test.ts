import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductRequirementManifest } from "@mendpoint/contract";
import {
  releaseTrainObservationIssues,
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

    // The invariant is that the matrix and the canonical register agree with
    // each other, not that either equals a fixed number. Pinning a magic count
    // would turn the first legitimate new requirement into a red ga:check for
    // every other open PR; the validator's REQUIREMENT_MISSING /
    // REQUIREMENT_UNKNOWN rules are what actually detect drift, and asserting
    // the validator returns no issues confirms they see none here.
    expect(requirementCount).toBeGreaterThan(0);
    expect(matrix.requirements).toHaveLength(requirementCount);
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

  it("fails GA promotion without canonical live evidence", () => {
    // The "verified needs code-verifiable evidence" case is covered upstream by
    // the contract's stricter VERIFIED_WITHOUT_CODE_EVIDENCE rule (spec:check);
    // the redundant closure-side check was removed, so it is not asserted here.
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

  it("accepts a fresh, reachable live observation", () => {
    const matrix = loadMatrix();
    expect(
      releaseTrainObservationIssues(matrix, {
        revisionExists: () => true,
        now: new Date(matrix.releaseTrain.observedAt),
      }),
    ).toEqual([]);
  });

  it("rejects an observedMainRevision that is not a commit", () => {
    const matrix = loadMatrix();
    matrix.releaseTrain.observedMainRevision =
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const codes = releaseTrainObservationIssues(matrix, {
      revisionExists: () => false,
      now: new Date(matrix.releaseTrain.observedAt),
    }).map((issue) => issue.code);

    expect(codes).toContain("RELEASE_REVISION_UNREACHABLE");
  });

  it("rejects a whole-second batch stamp for observedAt", () => {
    const matrix = loadMatrix();
    matrix.releaseTrain.observedAt = "2026-08-20T00:00:00.000Z";
    const codes = releaseTrainObservationIssues(matrix, {
      revisionExists: () => true,
      now: new Date(matrix.releaseTrain.observedAt),
    }).map((issue) => issue.code);

    expect(codes).toContain("RELEASE_TIMESTAMP_BATCH_STAMP");
  });

  it("rejects a live observation older than the staleness bound", () => {
    const matrix = loadMatrix();
    const observedMs = Date.parse(matrix.releaseTrain.observedAt);
    const codes = releaseTrainObservationIssues(matrix, {
      revisionExists: () => true,
      now: new Date(observedMs + 15 * 24 * 60 * 60 * 1000),
    }).map((issue) => issue.code);

    expect(codes).toContain("RELEASE_SNAPSHOT_STALE");
  });
});
