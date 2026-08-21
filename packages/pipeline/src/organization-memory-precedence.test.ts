import { describe, expect, it } from "vitest";
import {
  organizationMemoryPrecedenceLayer,
  PRECEDENCE_ORDER,
  resolveOrganizationDecision,
  toOrganizationMemoryReference,
  type OrganizationMemoryReference,
} from "./organization-memory-precedence.js";

const TENANT = "tenant-a";

function activeMemory(overrides: Partial<OrganizationMemoryReference> = {}): OrganizationMemoryReference {
  return {
    tenantId: TENANT,
    memoryId: "om:active",
    recordId: "omv1:active",
    status: "ACTIVE",
    statement: "Prefer the internal auth client",
    ...overrides,
  };
}

function candidateMemory(overrides: Partial<OrganizationMemoryReference> = {}): OrganizationMemoryReference {
  return {
    tenantId: TENANT,
    memoryId: "om:candidate",
    recordId: "omv1:candidate",
    status: "MEMORY_CANDIDATE",
    statement: "Maybe prefer feature flags",
    ...overrides,
  };
}

describe("Organization Memory precedence", () => {
  it("orders hard policy above everything", () => {
    const result = resolveOrganizationDecision({
      tenantId: TENANT,
      hardPolicy: { tenantId: TENANT, id: "sec-1", directive: "no external egress" },
      missionDecision: { tenantId: TENANT, id: "mission-1", directive: "migrate v1 to v2" },
      confirmedOrgMemory: activeMemory(),
      inferredCandidate: candidateMemory(),
    });
    expect(result.winner).toBe("hard_policy");
    expect(result.appliedMemory).toBeNull();
  });

  it("an inferred candidate cannot override a hard policy", () => {
    const result = resolveOrganizationDecision({
      tenantId: TENANT,
      hardPolicy: { tenantId: TENANT, id: "sec-1", directive: "no external egress" },
      inferredCandidate: candidateMemory(),
    });
    expect(result.winner).toBe("hard_policy");
    // The candidate is surfaced as overridden, never silently dropped.
    expect(result.overriddenMemory).toEqual([
      { layer: "inferred_candidate", memory: candidateMemory() },
    ]);
    expect(result.appliedMemory).toBeNull();
  });

  it("an inferred candidate cannot override a Mission decision", () => {
    const result = resolveOrganizationDecision({
      tenantId: TENANT,
      missionDecision: { tenantId: TENANT, id: "mission-1", directive: "explicit task requirement" },
      confirmedOrgMemory: activeMemory(),
      inferredCandidate: candidateMemory(),
    });
    expect(result.winner).toBe("mission_decision");
    expect(result.appliedMemory).toBeNull();
    expect(result.overriddenMemory.map((entry) => entry.layer)).toEqual([
      "confirmed_org_memory",
      "inferred_candidate",
    ]);
  });

  it("an inferred candidate from a DIFFERENT tenant is impossible to inject", () => {
    expect(() =>
      resolveOrganizationDecision({
        tenantId: TENANT,
        hardPolicy: { tenantId: TENANT, id: "sec-1", directive: "no external egress" },
        inferredCandidate: candidateMemory({ tenantId: "tenant-b" }),
      }),
    ).toThrow("organization_memory_precedence_tenant_mismatch");
  });

  it("confirmed Org Memory wins when no policy or mission is present, and is named", () => {
    const result = resolveOrganizationDecision({
      tenantId: TENANT,
      confirmedOrgMemory: activeMemory(),
      userPreference: { tenantId: TENANT, id: "pref-1", directive: "dark mode" },
      inferredCandidate: candidateMemory(),
    });
    expect(result.winner).toBe("confirmed_org_memory");
    // Resolution records WHICH memory influenced the decision.
    expect(result.appliedMemory).toEqual(activeMemory());
    expect(result.reason).toBe("confirmed_org_memory_wins");
    // The lower inferred candidate is surfaced as overridden.
    expect(result.overriddenMemory).toEqual([
      { layer: "inferred_candidate", memory: candidateMemory() },
    ]);
  });

  it("a user preference outranks an inferred candidate", () => {
    const result = resolveOrganizationDecision({
      tenantId: TENANT,
      userPreference: { tenantId: TENANT, id: "pref-1", directive: "verbose logs" },
      inferredCandidate: candidateMemory(),
    });
    expect(result.winner).toBe("user_preference");
    expect(result.appliedMemory).toBeNull();
    expect(result.overriddenMemory).toEqual([
      { layer: "inferred_candidate", memory: candidateMemory() },
    ]);
  });

  it("an inferred candidate governs only when nothing higher is present", () => {
    const result = resolveOrganizationDecision({
      tenantId: TENANT,
      inferredCandidate: candidateMemory(),
    });
    expect(result.winner).toBe("inferred_candidate");
    expect(result.appliedMemory).toEqual(candidateMemory());
  });

  it("resolves to none when no layer is present", () => {
    const result = resolveOrganizationDecision({ tenantId: TENANT });
    expect(result.winner).toBe("none");
    expect(result.appliedMemory).toBeNull();
  });

  it("the precedence order is the documented one", () => {
    expect([...PRECEDENCE_ORDER]).toEqual([
      "hard_policy",
      "mission_decision",
      "confirmed_org_memory",
      "user_preference",
      "inferred_candidate",
    ]);
  });
});

describe("Organization Memory layer classification", () => {
  it("only ACTIVE memory governs as confirmed Org Memory", () => {
    expect(organizationMemoryPrecedenceLayer({ status: "ACTIVE" })).toBe("confirmed_org_memory");
  });

  it("pending states are inferred candidates", () => {
    for (const status of ["OBSERVATION", "MEMORY_CANDIDATE", "VALIDATION", "CONFIRMED"] as const) {
      expect(organizationMemoryPrecedenceLayer({ status })).toBe("inferred_candidate");
    }
  });

  it("a disabled memory is excluded and stops influencing resolution immediately", () => {
    // A disabled memory classifies as excluded, so a consumer never builds it
    // into a precedence input — it cannot govern, with no redeploy.
    for (const status of ["DISABLED", "REJECTED", "DELETED", "STALE"] as const) {
      expect(organizationMemoryPrecedenceLayer({ status })).toBe("excluded");
    }
  });

  it("narrows a head record to a reference", () => {
    const ref = toOrganizationMemoryReference({
      tenantId: TENANT,
      memoryId: "om:x",
      recordId: "omv1:x",
      status: "ACTIVE",
      statement: "hello",
    });
    expect(ref).toEqual({
      tenantId: TENANT,
      memoryId: "om:x",
      recordId: "omv1:x",
      status: "ACTIVE",
      statement: "hello",
    });
  });
});
