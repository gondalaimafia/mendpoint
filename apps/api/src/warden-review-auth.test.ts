import { describe, expect, it } from "vitest";
import { isHumanWardenReviewer } from "./warden-review-auth.js";

describe("Warden human review authorization", () => {
  const human = { id: "human:issuer|subject", tenantId: "tenant-a", role: "engineer" as const };

  it("accepts only a tenant bound human identity and trust record", () => {
    expect(isHumanWardenReviewer(human, { kind: "human", tenant_id: "tenant-a" }, "tenant-a"))
      .toBe(true);
    expect(isHumanWardenReviewer(
      { id: "api-key:key-a", tenantId: "tenant-a", role: "owner" },
      { kind: "api_key", tenant_id: "tenant-a" },
      "tenant-a",
    )).toBe(false);
    expect(isHumanWardenReviewer(human, { kind: "human", tenant_id: "tenant-b" }, "tenant-a"))
      .toBe(false);
    expect(isHumanWardenReviewer(undefined, undefined, "tenant-a")).toBe(false);
  });

  it("rejects a delegated human actor synthesized by an API key request", () => {
    expect(isHumanWardenReviewer(
      human,
      { kind: "human", tenant_id: "tenant-a" },
      "tenant-a",
      "key-a",
    )).toBe(false);
  });
});
