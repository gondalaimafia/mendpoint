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

  it("accepts null external blockers and implementation evidence for a partial requirement", () => {
    const manifest = validManifest() as any;
    manifest.requirements[0].implementationStatus = "partial";
    manifest.requirements[0].externalBlockers = null;
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toEqual([]);
  });

  it("accepts external evidence only when every named blocker is declared", () => {
    const manifest = validManifest() as any;
    manifest.requirements[0].implementationStatus = "blocked_external";
    manifest.requirements[0].externalBlockers = [
      "GitHub App production credentials",
      "private canary repository",
    ];
    manifest.requirements[0].acceptance[0].evidence[0] = {
      id: `${ID}-AC01-EV01`,
      type: "external",
      locator: "external:GitHub App production credentials,private canary repository",
    };
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toEqual([]);
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

  it("rejects malformed external blocker containers and values", () => {
    const malformedContainer = validManifest() as any;
    malformedContainer.requirements[0].externalBlockers = "private canary repository";
    expect(
      validateProductRequirements(malformedContainer, { expectedIds: [ID] }),
    ).toContainEqual({
      code: "EXTERNAL_BLOCKERS_TYPE",
      subject: ID,
      message: "externalBlockers must be null or an array",
    });

    const malformedValues = validManifest() as any;
    malformedValues.requirements[0].externalBlockers = [
      "",
      "   ",
      7,
      "private canary repository",
      "private canary repository",
    ];
    const issues = validateProductRequirements(malformedValues, { expectedIds: [ID] });
    expect(issues.filter((issue) => issue.code === "EXTERNAL_BLOCKER_VALUE")).toHaveLength(3);
    expect(issues).toContainEqual({
      code: "EXTERNAL_BLOCKER_DUPLICATE",
      subject: ID,
      message: "external blocker is duplicated: private canary repository",
    });
  });

  it("rejects partial requirements supported only by planned, external, or live evidence", () => {
    const manifest = validManifest() as any;
    manifest.requirements[0].implementationStatus = "partial";
    manifest.requirements[0].externalBlockers = ["private canary repository"];
    manifest.requirements[0].acceptance[0].evidence = [
      { id: `${ID}-AC01-EV01`, type: "planned", locator: "planned:ME-FND-001" },
      {
        id: `${ID}-AC01-EV02`,
        type: "external",
        locator: "external:private canary repository",
      },
      { id: `${ID}-AC01-EV03`, type: "live", locator: "live:unverified" },
    ];
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toContainEqual({
      code: "PARTIAL_IMPLEMENTATION_EVIDENCE",
      subject: ID,
      message: "partial requirements need implementation evidence",
    });
  });

  it("rejects external evidence that does not name a declared blocker", () => {
    const manifest = validManifest() as any;
    manifest.requirements[0].implementationStatus = "blocked_external";
    manifest.requirements[0].externalBlockers = ["private canary repository"];
    manifest.requirements[0].acceptance[0].evidence[0] = {
      id: `${ID}-AC01-EV01`,
      type: "external",
      locator: "external:GitHub App production credentials",
    };
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toContainEqual({
      code: "EXTERNAL_EVIDENCE_BLOCKER",
      subject: `${ID}-AC01-EV01`,
      message: "external evidence names an undeclared blocker: GitHub App production credentials",
    });
  });

  it("rejects verified requirements with externally dependent acceptance", () => {
    const manifest = validManifest() as any;
    manifest.requirements[0].externalBlockers = ["private canary repository"];
    manifest.requirements[0].acceptance[0].evidence[0] = {
      id: `${ID}-AC01-EV01`,
      type: "external",
      locator: "external:private canary repository",
    };
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toContainEqual({
      code: "EXTERNAL_ACCEPTANCE_VERIFIED",
      subject: `${ID}-AC01`,
      message: "externally dependent acceptance cannot be verified",
    });
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
