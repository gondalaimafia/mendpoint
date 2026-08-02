import { describe, expect, it } from "vitest";
import {
  canonicalTextSha256,
  validateProductRequirements,
} from "./product-requirements.js";

const ID = "ME-FND-001";

function validManifest() {
  return {
    schemaVersion: 1,
    spec: {
      path: "docs/FOUNDATIONAL_PRODUCT_SPEC.md",
      version: "1.0",
      sha256: "a".repeat(64),
    },
    closurePlan: {
      source: "closure.md",
      auditedRevision: "7756d4c",
      requirementCount: 1,
    },
    closureWorkstreams: [{ id: "FC-00", title: "Product contract" }],
    requirements: [
      {
        id: ID,
        closureGapId: "SPEC-01",
        title: "Canonical specification",
        owner: "product",
        targetRelease: "warden-pilot",
        availability: "internal",
        implementationStatus: "verified",
        claimState: "internal_only",
        closureWorkstream: "FC-00",
        acceptance: [
          {
            id: `${ID}-AC01`,
            assertion: "The specification is versioned in the repository.",
            evidence: [
              {
                id: `${ID}-AC01-EV01`,
                type: "document",
                locator: "docs/FOUNDATIONAL_PRODUCT_SPEC.md",
              },
            ],
          },
        ],
        externalBlockers: [],
      },
    ],
  };
}

describe("product requirement validation", () => {
  it("hashes LF, CRLF, and CR text identically", () => {
    const lf = "# Product spec\n\nOne line\nTwo lines\n";
    expect(canonicalTextSha256(lf.replaceAll("\n", "\r\n")))
      .toBe(canonicalTextSha256(lf));
    expect(canonicalTextSha256(lf.replaceAll("\n", "\r")))
      .toBe(canonicalTextSha256(lf));
  });

  it("accepts a complete traceable requirement", () => {
    expect(validateProductRequirements(validManifest(), { expectedIds: [ID] })).toEqual([]);
  });

  it("rejects duplicate requirement IDs", () => {
    const manifest = validManifest();
    manifest.requirements.push(structuredClone(manifest.requirements[0]));
    const issues = validateProductRequirements(manifest, { expectedIds: [ID] });
    expect(issues.some((issue) => issue.code === "REQUIREMENT_DUPLICATE")).toBe(true);
  });

  it("rejects acceptance evidence that does not belong to its criterion", () => {
    const manifest = validManifest();
    manifest.requirements[0].acceptance[0].evidence[0].id = "ME-FND-002-AC01-EV01";
    const issues = validateProductRequirements(manifest, { expectedIds: [ID] });
    expect(issues.some((issue) => issue.code === "EVIDENCE_ID")).toBe(true);
  });

  it("rejects GA claims without verified implementation", () => {
    const manifest = validManifest();
    manifest.requirements[0].availability = "ga";
    manifest.requirements[0].implementationStatus = "partial";
    const issues = validateProductRequirements(manifest, { expectedIds: [ID] });
    expect(issues.some((issue) => issue.code === "GA_STATUS")).toBe(true);
  });

  it("rejects public claims for planned requirements", () => {
    const manifest = validManifest();
    manifest.requirements[0].availability = "planned";
    manifest.requirements[0].implementationStatus = "unimplemented";
    manifest.requirements[0].claimState = "public_current";
    const issues = validateProductRequirements(manifest, { expectedIds: [ID] });
    expect(issues.some((issue) => issue.code === "CLAIM_EXCEEDS_AVAILABILITY")).toBe(true);
  });

  it("rejects unnamed external blockers", () => {
    const manifest = validManifest();
    manifest.requirements[0].implementationStatus = "blocked_external";
    const issues = validateProductRequirements(manifest, { expectedIds: [ID] });
    expect(issues.some((issue) => issue.code === "EXTERNAL_BLOCKER")).toBe(true);
  });

  it("rejects an empty declared closure workstream", () => {
    const manifest = validManifest();
    manifest.closureWorkstreams.push({ id: "FC-08", title: "Learning lifecycle" });
    const issues = validateProductRequirements(manifest, { expectedIds: [ID] });
    expect(issues).toContainEqual({
      code: "WORKSTREAM_EMPTY",
      subject: "FC-08",
      message: "declared workstream must own at least one requirement",
    });
  });
});
