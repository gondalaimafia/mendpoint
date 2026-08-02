import { describe, expect, it } from "vitest";
import {
  validatePublicClaimRegistry,
  type PublicClaimRegistry,
  type PublicClaimRequirement,
} from "./public-claims.js";

const AUDITED_REVISION = "94c91d3e95dd6c85cb0b54d9131f0366ddcca9b3";
const AS_OF = new Date("2026-08-02T12:00:00.000Z");

function requirement(
  overrides: Partial<PublicClaimRequirement> = {},
): PublicClaimRequirement {
  return {
    id: "ME-WAR-003",
    implementationStatus: "verified",
    claimState: "public_current",
    ...overrides,
  };
}

function validate(
  input: unknown,
  requirements: readonly PublicClaimRequirement[] = [requirement()],
) {
  return validatePublicClaimRegistry(input, { requirements, asOf: AS_OF });
}

function registry(): PublicClaimRegistry {
  return {
    schemaVersion: 2,
    website: "https://www.mendpoint.ai/",
    websiteStatus: "replacement_candidate",
    auditedRevision: AUDITED_REVISION,
    claims: [
      {
        id: "CLM-001",
        claimKind: "capability",
        requirementIds: ["ME-WAR-003"],
        surfaces: ["hero"],
        surfacePaths: ["apps/web/app/page.tsx"],
        wording: "Available as a Private Design Partner Preview.",
        owner: "product",
        evidenceOwner: "engineering",
        state: "preview",
        scope: "Private pilots",
        evidence: [{
          id: "CLM-001-EV01",
          type: "live",
          locator: "https://mendpoint-talal.fly.dev/livez",
          observedAt: "2026-08-02T10:00:00.000Z",
          freshUntil: "2026-08-03T10:00:00.000Z",
          revision: AUDITED_REVISION,
        }],
        limitations: ["Approval required"],
        requiredQualifier: "Private Design Partner Preview",
        lastVerifiedAt: "2026-08-01",
        expiresAt: null,
      },
    ],
    destinations: [
      {
        id: "DST-001",
        label: "Apply",
        href: "/design-partners",
        purpose: "Design partner application",
        claimId: "CLM-001",
      },
    ],
  };
}

describe("public claim registry validation", () => {
  it("accepts a qualified claim and working destination", () => {
    expect(validate(registry())).toEqual([]);
  });

  it("rejects unsupported absolutes", () => {
    const input = registry();
    input.claims[0].wording = "Every repository is scanned.";
    expect(validate(input).some((issue) => issue.code === "UNSUPPORTED_ABSOLUTE")).toBe(true);
  });

  it("requires the qualifier in limited wording", () => {
    const input = registry();
    input.claims[0].wording = "Available now.";
    expect(validate(input).some((issue) => issue.code === "QUALIFIER_MISSING")).toBe(true);
  });

  it("rejects inert destinations", () => {
    const input = registry();
    input.destinations[0].href = "#";
    expect(validate(input).some((issue) => issue.code === "DESTINATION_HREF")).toBe(true);
  });

  it("requires roadmap labels in roadmap wording", () => {
    const input = registry();
    input.claims[0].state = "roadmap";
    input.claims[0].requiredQualifier = null;
    input.claims[0].wording = "GitLab delivery is available.";
    expect(validate(input).some((issue) => issue.code === "ROADMAP_LABEL")).toBe(true);
  });

  it("requires an exact source path for each mapped claim", () => {
    const input = registry();
    input.claims[0].surfacePaths = [];
    expect(
      validate(input).some(
        (issue) => issue.code === "SURFACE_PATHS_REQUIRED",
      ),
    ).toBe(true);
  });

  it("requires an explicit claim kind", () => {
    const input = registry() as unknown as { claims: Array<Record<string, unknown>> };
    delete input.claims[0].claimKind;
    expect(validate(input).some((issue) => issue.code === "CLAIM_KIND")).toBe(true);
  });

  it("requires an explicit website publication state", () => {
    const input = registry() as unknown as Record<string, unknown>;
    delete input.websiteStatus;
    expect(validate(input).some((issue) => issue.code === "WEBSITE_STATUS")).toBe(true);
  });

  it("requires nonempty unique requirement IDs on every claim", () => {
    const missing = registry();
    missing.claims[0].requirementIds = [];
    expect(validate(missing).some((issue) => issue.code === "REQUIREMENT_IDS_REQUIRED")).toBe(true);

    const duplicate = registry();
    duplicate.claims[0].requirementIds = ["ME-WAR-003", "ME-WAR-003"];
    expect(validate(duplicate).some((issue) => issue.code === "REQUIREMENT_ID_DUPLICATE")).toBe(true);
  });

  it("rejects requirement IDs missing from the product requirement register", () => {
    const input = registry();
    input.claims[0].requirementIds = ["ME-WAR-999"];
    expect(validate(input).some((issue) => issue.code === "REQUIREMENT_REFERENCE")).toBe(true);
  });

  it("rejects a proven capability backed by incomplete or nonpublic requirements", () => {
    const input = registry();
    input.claims[0].state = "proven";
    input.claims[0].requiredQualifier = null;

    expect(
      validate(input, [requirement({ implementationStatus: "partial" })]).some(
        (issue) => issue.code === "PROVEN_CAPABILITY_REQUIREMENT_INCOMPLETE",
      ),
    ).toBe(true);
    expect(
      validate(input, [requirement({ claimState: "internal_only" })]).some(
        (issue) => issue.code === "PROVEN_CAPABILITY_REQUIREMENT_NON_PUBLIC",
      ),
    ).toBe(true);
  });

  it("allows an explicitly typed proven guardrail to reference incomplete internal capability work", () => {
    const input = registry();
    input.claims[0].state = "proven";
    input.claims[0].claimKind = "guardrail";
    input.claims[0].requiredQualifier = null;
    expect(
      validate(input, [
        requirement({ implementationStatus: "partial", claimState: "internal_only" }),
      ]),
    ).toEqual([]);
  });

  it("requires fresh live evidence bound to the exact audited revision", () => {
    const missing = registry() as unknown as { claims: Array<{ evidence: Array<Record<string, unknown>> }> };
    delete missing.claims[0].evidence[0].observedAt;
    delete missing.claims[0].evidence[0].freshUntil;
    delete missing.claims[0].evidence[0].revision;
    const missingCodes = validate(missing).map((issue) => issue.code);
    expect(missingCodes).toEqual(
      expect.arrayContaining([
        "LIVE_EVIDENCE_OBSERVED_AT",
        "LIVE_EVIDENCE_FRESH_UNTIL",
        "LIVE_EVIDENCE_REVISION",
      ]),
    );

    const wrongRevision = registry();
    const live = wrongRevision.claims[0].evidence[0];
    if (live.type !== "live") throw new Error("expected live evidence");
    live.revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(validate(wrongRevision).some((issue) => issue.code === "LIVE_EVIDENCE_REVISION_MISMATCH")).toBe(true);

    const stale = registry();
    const staleLive = stale.claims[0].evidence[0];
    if (staleLive.type !== "live") throw new Error("expected live evidence");
    staleLive.freshUntil = "2026-08-02T11:59:59.000Z";
    expect(validate(stale).some((issue) => issue.code === "LIVE_EVIDENCE_STALE")).toBe(true);
  });
});
