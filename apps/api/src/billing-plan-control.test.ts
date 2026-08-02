import { describe, expect, it } from "vitest";
import { billingPlanChangeDecision } from "./billing-plan-control.js";

describe("billing plan change control", () => {
  it("fails closed until finance enables manual contract changes", () => {
    expect(billingPlanChangeDecision("owner", {})).toEqual({
      allowed: false,
      error: "billing_plan_change_disabled",
      status: 503,
    });
    expect(billingPlanChangeDecision("viewer", { MENDPOINT_MANUAL_PLAN_CHANGES_ENABLED: "1" })).toEqual({
      allowed: false,
      error: "billing_plan_change_forbidden",
      status: 403,
    });
    expect(billingPlanChangeDecision("admin", { MENDPOINT_MANUAL_PLAN_CHANGES_ENABLED: "1" })).toEqual({
      allowed: true,
      mode: "manual_contract",
    });
  });
});
