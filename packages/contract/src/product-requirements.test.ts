import { describe, expect, it } from "vitest";
import {
  canonicalTextSha256,
  FOUNDATIONAL_REGISTER_SET,
  PRODUCT_REGISTER_SETS,
  V4_PLATFORM_REGISTER_SET,
  V4_PLATFORM_REQUIREMENT_IDS,
  validateProductRequirements,
  type RegisterSetDefinition,
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
        implementationStatus: "documented",
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

  it("accepts a documented requirement whose only evidence is a specification", () => {
    // The base fixture mirrors a foundational ME-FND row: its evidence is a
    // product-contract document, so its honest status is `documented`, not
    // `verified`. A document-evidenced requirement is a complete, valid row.
    expect(validateProductRequirements(validManifest(), { expectedIds: [ID] })).toEqual([]);
  });

  it("rejects a verified requirement whose only evidence is a document", () => {
    // A document is a specification, not something a reachability or mutation
    // analysis can trace to running code. Marking such a requirement `verified`
    // is the exact dishonesty this rule prevents; the honest status is
    // `documented`. Deleting the VERIFIED_WITHOUT_CODE_EVIDENCE rule makes this
    // assertion fail.
    const manifest = validManifest() as any;
    manifest.requirements[0].implementationStatus = "verified";
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toContainEqual({
      code: "VERIFIED_WITHOUT_CODE_EVIDENCE",
      subject: ID,
      message:
        "verified requirements need evidence traceable to code, not documents alone; use the documented status when the only evidence is a specification",
    });
  });

  it("accepts a verified requirement backed by code-verifiable evidence", () => {
    const manifest = validManifest() as any;
    manifest.requirements[0].implementationStatus = "verified";
    manifest.requirements[0].acceptance[0].evidence = [
      {
        id: `${ID}-AC01-EV01`,
        type: "integration",
        locator: "packages/contract/src/product-requirements.test.ts",
      },
    ];
    expect(validateProductRequirements(manifest, { expectedIds: [ID] })).toEqual([]);
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
    manifest.requirements[0].implementationStatus = "verified";
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

const SECOND_SET_ID = "ME-FET-015";

const FIRST_SET: RegisterSetDefinition = {
  ...FOUNDATIONAL_REGISTER_SET,
  expectedIds: [ID],
};

const SECOND_SET: RegisterSetDefinition = {
  key: "v3-platform",
  title: "v3.0 platform baseline requirements",
  requirementIdPattern: /^ME-(FET|REG|CGR)-[0-9]{3}$/,
  gapIdPattern: /^(FET|REG|CGR)-[0-9]{3}$/,
  expectedIds: [SECOND_SET_ID],
};

const TWO_SETS = [FIRST_SET, SECOND_SET];

function secondSetRequirement() {
  return {
    id: SECOND_SET_ID,
    closureGapId: "FET-015",
    title: "Relationship materialization",
    owner: "graph",
    targetRelease: "warden-ga",
    availability: "planned",
    implementationStatus: "unimplemented",
    claimState: "roadmap_only",
    closureWorkstream: "FC-00",
    acceptance: [
      {
        id: `${SECOND_SET_ID}-AC01`,
        assertion: "Materialize stable provider to code relationships.",
        evidence: [
          {
            id: `${SECOND_SET_ID}-AC01-EV01`,
            type: "planned",
            locator: `planned:${SECOND_SET_ID}`,
          },
        ],
      },
    ],
    externalBlockers: null,
  };
}

function multiSetManifest() {
  const manifest = validManifest() as any;
  manifest.additionalRegisterSets = [
    {
      key: "v3-platform",
      closurePlan: {
        source: "spec-v3.md",
        auditedRevision: "abc1234",
        requirementCount: 1,
      },
      requirements: [secondSetRequirement()],
    },
  ];
  return manifest;
}

describe("multi-set product requirement validation", () => {
  it("accepts a manifest whose additional register set is complete and keyed", () => {
    expect(
      validateProductRequirements(multiSetManifest(), { registerSets: TWO_SETS }),
    ).toEqual([]);
  });

  it("leaves the foundational set unchanged: an unexpected foundational ID still fails closed", () => {
    const manifest = multiSetManifest();
    manifest.requirements.push({
      ...structuredClone(manifest.requirements[0]),
      id: "ME-FND-999",
    });
    const issues = validateProductRequirements(manifest, { registerSets: TWO_SETS });
    expect(issues).toContainEqual({
      code: "REQUIREMENT_UNEXPECTED",
      subject: "ME-FND-999",
      message: "requirement is not in the foundational register",
    });
  });

  it("fails closed on an unknown ID inside the additional register set", () => {
    const manifest = multiSetManifest();
    manifest.additionalRegisterSets[0].requirements.push({
      ...structuredClone(manifest.additionalRegisterSets[0].requirements[0]),
      id: "ME-FET-999",
      acceptance: [
        {
          id: "ME-FET-999-AC01",
          assertion: "Unknown row.",
          evidence: [{ id: "ME-FET-999-AC01-EV01", type: "planned", locator: "planned:x" }],
        },
      ],
    });
    manifest.additionalRegisterSets[0].closurePlan.requirementCount = 2;
    const issues = validateProductRequirements(manifest, { registerSets: TWO_SETS });
    expect(issues).toContainEqual({
      code: "REQUIREMENT_UNEXPECTED",
      subject: "ME-FET-999",
      message: "requirement is not in the v3-platform register",
    });
  });

  it("fails closed when a declared additional register set is absent", () => {
    const manifest = multiSetManifest();
    delete manifest.additionalRegisterSets;
    const issues = validateProductRequirements(manifest, { registerSets: TWO_SETS });
    expect(issues).toContainEqual({
      code: "REGISTER_SET_MISSING",
      subject: "v3-platform",
      message: "declared register set is absent from the manifest",
    });
  });

  it("rejects an additional register set whose key is not recognized", () => {
    const manifest = multiSetManifest();
    manifest.additionalRegisterSets[0].key = "made-up";
    const issues = validateProductRequirements(manifest, { registerSets: TWO_SETS });
    expect(issues).toContainEqual({
      code: "REGISTER_SET_UNKNOWN",
      subject: "made-up",
      message: "register set key is not recognized",
    });
  });

  it("requires provenance on every register set", () => {
    const manifest = multiSetManifest();
    manifest.additionalRegisterSets[0].closurePlan.source = "";
    manifest.additionalRegisterSets[0].closurePlan.auditedRevision = "";
    const issues = validateProductRequirements(manifest, { registerSets: TWO_SETS });
    expect(issues).toContainEqual({
      code: "CLOSURE_SOURCE",
      subject: "additionalRegisterSets:v3-platform",
      message: "closure plan source is required",
    });
    expect(issues).toContainEqual({
      code: "CLOSURE_REVISION",
      subject: "additionalRegisterSets:v3-platform",
      message: "closure plan auditedRevision is required",
    });
  });

  it("fails closed on a wrong count in the additional register set", () => {
    const manifest = multiSetManifest();
    manifest.additionalRegisterSets[0].closurePlan.requirementCount = 5;
    const issues = validateProductRequirements(manifest, { registerSets: TWO_SETS });
    expect(issues).toContainEqual({
      code: "REQUIREMENT_COUNT",
      subject: "additionalRegisterSets:v3-platform",
      message: "closure plan count must equal 1",
    });
  });
});

describe("v4-platform register set", () => {
  it("is enforced by default alongside the foundational and v3.0 sets", () => {
    const keys = PRODUCT_REGISTER_SETS.map((set) => set.key);
    expect(keys).toContain("v4-platform");
    expect(keys).toEqual(["foundational", "v3-platform", "v4-platform"]);
  });

  it("declares the eight persistent-context identifiers exactly", () => {
    expect(V4_PLATFORM_REGISTER_SET.expectedIds).toEqual(V4_PLATFORM_REQUIREMENT_IDS);
    expect(V4_PLATFORM_REQUIREMENT_IDS).toEqual([
      "ME-MCC-001",
      "ME-MSN-001",
      "ME-MSN-002",
      "ME-MSN-003",
      "ME-MTE-001",
      "ME-OMM-001",
      "ME-PEV-001",
      "ME-SXT-001",
    ]);
  });

  it("accepts its own identifiers and rejects foreign ones", () => {
    for (const id of V4_PLATFORM_REQUIREMENT_IDS) {
      expect(V4_PLATFORM_REGISTER_SET.requirementIdPattern.test(id)).toBe(true);
    }
    expect(V4_PLATFORM_REGISTER_SET.requirementIdPattern.test("ME-FND-001")).toBe(false);
    expect(V4_PLATFORM_REGISTER_SET.requirementIdPattern.test("ME-FET-015")).toBe(false);
    expect(V4_PLATFORM_REGISTER_SET.gapIdPattern.test("MSN-001")).toBe(true);
    expect(V4_PLATFORM_REGISTER_SET.gapIdPattern.test("SPEC-01")).toBe(false);
  });
});
