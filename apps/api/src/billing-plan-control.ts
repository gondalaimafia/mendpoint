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

/**
 * S0-B self-serve plan change. Owner/admin may switch plans themselves; selecting a
 * plan provisions the tenant's entitlement (its MCU quota) via
 * `provisionEntitlementForPlan`. This does NOT require the manual-contract flag —
 * the whole self-serve path is instead gated by the self-serve billing flag
 * (`selfServeBillingEnabled`) the caller checks before choosing this decision.
 */
export type SelfServePlanChangeDecision =
  | Readonly<{ allowed: true; mode: "self_serve" }>
  | Readonly<{ allowed: false; error: "billing_plan_change_forbidden"; status: 403 }>;

export function selfServePlanChangeDecision(role: Role): SelfServePlanChangeDecision {
  if (role !== "owner" && role !== "admin") {
    return Object.freeze({ allowed: false, error: "billing_plan_change_forbidden", status: 403 });
  }
  return Object.freeze({ allowed: true, mode: "self_serve" });
}

/**
 * The current monthly billing period as text ISO boundaries (UTC calendar month).
 * The self-serve entitlement is provisioned for this window; `nowIso` falls inside
 * `[start, end)` so the run path's `getActiveUsageEntitlement` resolves it.
 */
export function monthlyBillingPeriod(nowIso: string): { start: string; end: string } {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new Error("billing_period_now_invalid");
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start: start.toISOString(), end: end.toISOString() };
}
