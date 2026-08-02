import type { Role } from "@mendpoint/platform";

export type BillingPlanChangeDecision =
  | Readonly<{ allowed: true; mode: "manual_contract" }>
  | Readonly<{ allowed: false; error: "billing_plan_change_forbidden"; status: 403 }>
  | Readonly<{ allowed: false; error: "billing_plan_change_disabled"; status: 503 }>;

export function billingPlanChangeDecision(
  role: Role,
  env: NodeJS.ProcessEnv = process.env,
): BillingPlanChangeDecision {
  if (role !== "owner" && role !== "admin") {
    return Object.freeze({ allowed: false, error: "billing_plan_change_forbidden", status: 403 });
  }
  if (env.MENDPOINT_MANUAL_PLAN_CHANGES_ENABLED !== "1") {
    return Object.freeze({ allowed: false, error: "billing_plan_change_disabled", status: 503 });
  }
  return Object.freeze({ allowed: true, mode: "manual_contract" });
}
