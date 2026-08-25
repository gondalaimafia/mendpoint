import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("rejects a proven guardrail backed by incomplete or nonpublic requirements", () => {
    const input = registry();
    input.claims[0].state = "proven";
    input.claims[0].claimKind = "guardrail";
    input.claims[0].requiredQualifier = null;

    const codes = validate(input, [
      requirement({ implementationStatus: "partial", claimState: "internal_only" }),
    ]).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "PROVEN_CAPABILITY_REQUIREMENT_INCOMPLETE",
        "PROVEN_CAPABILITY_REQUIREMENT_NON_PUBLIC",
      ]),
    );
  });

  it("does not apply the proven requirement gate to non-proven claims", () => {
    for (const state of ["limited_availability", "preview", "roadmap"] as const) {
      const input = registry();
      input.claims[0].state = state;
      input.claims[0].claimKind = "guardrail";
      if (state === "roadmap") {
        input.claims[0].requiredQualifier = null;
        input.claims[0].wording = "Draft delivery guardrails are planned for supported repositories.";
      } else {
        input.claims[0].requiredQualifier = "supported repositories";
        input.claims[0].wording = "On supported repositories, delivery stays draft only.";
      }
      const codes = validate(input, [
        requirement({ implementationStatus: "partial", claimState: "experimental_only" }),
      ]).map((issue) => issue.code);
      expect(codes).not.toContain("PROVEN_CAPABILITY_REQUIREMENT_INCOMPLETE");
      expect(codes).not.toContain("PROVEN_CAPABILITY_REQUIREMENT_NON_PUBLIC");
    }
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

  it("rejects live evidence whose freshUntil precedes observedAt", () => {
    const input = registry();
    const live = input.claims[0].evidence[0];
    if (live.type !== "live") throw new Error("expected live evidence");
    live.observedAt = "2026-08-02T10:00:00.000Z";
    live.freshUntil = "2026-08-02T09:00:00.000Z";
    expect(
      validate(input).some((issue) => issue.code === "LIVE_EVIDENCE_FRESHNESS_WINDOW"),
    ).toBe(true);
  });

  it("flags a second-resolution observedAt reused across live locators as a batch stamp", () => {
    const input = registry();
    const live = input.claims[0].evidence[0];
    if (live.type !== "live") throw new Error("expected live evidence");
    live.observedAt = "2026-08-02T10:00:00.000Z";
    input.claims[0].evidence.push({
      id: "CLM-001-EV02",
      type: "live",
      locator: "https://mendpoint-talal.fly.dev/healthz",
      observedAt: "2026-08-02T10:00:00.000Z",
      freshUntil: "2026-08-03T10:00:00.000Z",
      revision: AUDITED_REVISION,
    });
    const batch = validate(input).filter(
      (issue) => issue.code === "LIVE_EVIDENCE_BATCH_STAMP",
    );
    expect(batch.map((issue) => issue.subject).sort()).toEqual([
      "CLM-001-EV01",
      "CLM-001-EV02",
    ]);
    expect(batch[0].message).toContain("CLM-001-EV01");
    expect(batch[0].message).toContain("CLM-001-EV02");
  });

  it("accepts a shared sub-second observedAt across live locators (single probe run)", () => {
    const input = registry();
    const live = input.claims[0].evidence[0];
    if (live.type !== "live") throw new Error("expected live evidence");
    live.observedAt = "2026-08-02T10:00:00.565Z";
    input.claims[0].evidence.push({
      id: "CLM-001-EV02",
      type: "live",
      locator: "https://mendpoint-talal.fly.dev/healthz",
      observedAt: "2026-08-02T10:00:00.565Z",
      freshUntil: "2026-08-03T10:00:00.000Z",
      revision: AUDITED_REVISION,
    });
    expect(
      validate(input).some((issue) => issue.code === "LIVE_EVIDENCE_BATCH_STAMP"),
    ).toBe(false);
  });
});

describe("published no-auto-merge guardrail (CLM-006)", () => {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const publishedRegistry = JSON.parse(
    readFileSync(resolve(repoRoot, "docs/PUBLIC_CLAIMS.json"), "utf8"),
  ) as PublicClaimRegistry;

  const clm006 = publishedRegistry.claims.find((entry) => entry.id === "CLM-006");

  it("is a guardrail scoped to the availability its backing requirements support", () => {
    expect(clm006).toBeDefined();
    if (!clm006) throw new Error("CLM-006 is missing from the published registry");
    expect(clm006.claimKind).toBe("guardrail");
    // The guarantee is real, but its backing requirements (ME-WAR-004,
    // ME-SCM-003) are still partial/experimental_only, so it cannot sit at
    // "proven" under the corrected gate. It is published as limited_availability.
    expect(clm006.state).not.toBe("proven");
    expect(clm006.state).toBe("limited_availability");
    expect(clm006.requiredQualifier).toBeTruthy();
    expect(clm006.wording.toLowerCase()).toContain(
      String(clm006.requiredQualifier).toLowerCase(),
    );
    expect(clm006.wording).toMatch(/does not merge/i);
  });
});
