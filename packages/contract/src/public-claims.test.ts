import { describe, expect, it } from "vitest";
import {
  validatePublicClaimRegistry,
  type PublicClaimRegistry,
} from "./public-claims.js";

function registry(): PublicClaimRegistry {
  return {
    schemaVersion: 1,
    website: "https://www.mendpoint.ai/",
    auditedRevision: "94c91d3",
    claims: [
      {
        id: "CLM-001",
        surfaces: ["hero"],
        surfacePaths: ["apps/web/app/page.tsx"],
        wording: "Available as a Private Design Partner Preview.",
        owner: "product",
        evidenceOwner: "engineering",
        state: "preview",
        scope: "Private pilots",
        evidence: [{ id: "CLM-001-EV01", type: "live", locator: "https://mendpoint-talal.fly.dev/livez" }],
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
    expect(validatePublicClaimRegistry(registry())).toEqual([]);
  });

  it("rejects unsupported absolutes", () => {
    const input = registry();
    input.claims[0].wording = "Every repository is scanned.";
    expect(validatePublicClaimRegistry(input).some((issue) => issue.code === "UNSUPPORTED_ABSOLUTE")).toBe(true);
  });

  it("requires the qualifier in limited wording", () => {
    const input = registry();
    input.claims[0].wording = "Available now.";
    expect(validatePublicClaimRegistry(input).some((issue) => issue.code === "QUALIFIER_MISSING")).toBe(true);
  });

  it("rejects inert destinations", () => {
    const input = registry();
    input.destinations[0].href = "#";
    expect(validatePublicClaimRegistry(input).some((issue) => issue.code === "DESTINATION_HREF")).toBe(true);
  });

  it("requires roadmap labels in roadmap wording", () => {
    const input = registry();
    input.claims[0].state = "roadmap";
    input.claims[0].requiredQualifier = null;
    input.claims[0].wording = "GitLab delivery is available.";
    expect(validatePublicClaimRegistry(input).some((issue) => issue.code === "ROADMAP_LABEL")).toBe(true);
  });

  it("requires an exact source path for each mapped claim", () => {
    const input = registry();
    input.claims[0].surfacePaths = [];
    expect(
      validatePublicClaimRegistry(input).some(
        (issue) => issue.code === "SURFACE_PATHS_REQUIRED",
      ),
    ).toBe(true);
  });
});
