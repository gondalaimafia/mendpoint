import type { AppDb } from "./index.js";
import type { UsageEntitlement } from "./usage.js";
import { createUsageEntitlement, createUsagePriceVersion } from "./usage.js";
import { MCU_MICROS } from "./usage-run.js";

/**
 * Plan -> entitlement provisioning.
 *
 * Maps a subscription plan to a monthly MCU quota and provisions the tenant's active
 * `UsageEntitlement` for a period by reusing the existing ledger primitives
 * (createUsagePriceVersion + createUsageEntitlement). This is the bridge that makes
 * "150 MCUs/seat/month" real: a plan becomes a concrete quota the run path enforces.
 *
 * IMPORTANT: the MCU allowances and the indicative price below are configurable and
 * NOT contractual figures. They live in this one place. No marketing dollar amount is
 * encoded in enforcement logic; the price version exists only so settled usage can be
 * costed by the existing gross-margin/usage-summary math.
 */

export type UsagePlanId = "free" | "pro" | "teams" | "enterprise";

export type UsagePlanAllowance = "flat" | "per_seat";

export type UsagePlanSpec = Readonly<{
  id: UsagePlanId;
  name: string;
  allowance: UsagePlanAllowance;
  /** Monthly MCU allowance in micros. When allowance is per_seat this is per seat. */
  monthlyMcuMicros: number;
  features: readonly string[];
}>;

/** Indicative unit price used only to cost settled usage. Configurable, not a quote. */
export const USAGE_PLAN_PRICE_PER_MCU_MONEY_MICROS = 20_000; // $0.02 / MCU (indicative)
export const USAGE_PLAN_CURRENCY = "USD";
export const USAGE_PLAN_FORMULA_VERSION = "mcu-v1";

export const USAGE_PLAN_CATALOG: Readonly<Record<UsagePlanId, UsagePlanSpec>> = Object.freeze({
  free: Object.freeze({
    id: "free",
    name: "Free",
    allowance: "flat",
    monthlyMcuMicros: 15 * MCU_MICROS, // 15 MCU/month, flat
    features: Object.freeze(["warden"]),
  }),
  pro: Object.freeze({
    id: "pro",
    name: "Pro",
    allowance: "per_seat",
    monthlyMcuMicros: 150 * MCU_MICROS, // 150 MCU/seat/month
    features: Object.freeze(["warden", "continuous_feeds"]),
  }),
  teams: Object.freeze({
    id: "teams",
    name: "Teams",
    allowance: "per_seat",
    monthlyMcuMicros: 400 * MCU_MICROS, // 400 MCU/seat/month
    features: Object.freeze(["warden", "continuous_feeds", "policy_packs"]),
  }),
  enterprise: Object.freeze({
    id: "enterprise",
    name: "Enterprise",
    allowance: "per_seat",
    // Indicative default only; real Enterprise quotas are set per contract.
    monthlyMcuMicros: 2_000 * MCU_MICROS,
    features: Object.freeze(["warden", "continuous_feeds", "policy_packs", "sso"]),
  }),
});

export function getUsagePlanSpec(plan: string): UsagePlanSpec | undefined {
  return (USAGE_PLAN_CATALOG as Record<string, UsagePlanSpec>)[plan];
}

export function resolvePlanQuotaMcuMicros(spec: UsagePlanSpec, seats: number): number {
  if (spec.allowance === "flat") return spec.monthlyMcuMicros;
  if (!Number.isSafeInteger(seats) || seats < 1) throw new Error("usage_plan_seats_invalid");
  const quota = spec.monthlyMcuMicros * seats;
  if (!Number.isSafeInteger(quota)) throw new Error("usage_plan_quota_overflow");
  return quota;
}

/**
 * Idempotently create/refresh the tenant's active entitlement for a period from its
 * plan. Deterministic ids mean a re-run for the same (tenant, plan, period) returns
 * the existing rows instead of double-provisioning.
 */
export function provisionEntitlementForPlan(
  db: AppDb,
  input: {
    tenantId: string;
    plan: string;
    periodStart: string;
    periodEnd: string;
    seats?: number;
    now: string;
    contractReference?: string;
  },
): UsageEntitlement {
  const spec = getUsagePlanSpec(input.plan);
  if (!spec) throw new Error("usage_plan_unknown");
  const seats = input.seats ?? 1;
  const quotaMcuMicros = resolvePlanQuotaMcuMicros(spec, seats);
  const contractReference = input.contractReference ?? `usage-plan:${spec.id}`;

  const priceVersionId = `usage-plan-price:${input.tenantId}:${spec.id}:${input.periodStart}`;
  createUsagePriceVersion(db, {
    id: priceVersionId,
    tenantId: input.tenantId,
    formulaVersion: USAGE_PLAN_FORMULA_VERSION,
    currency: USAGE_PLAN_CURRENCY,
    pricePerMcuMoneyMicros: USAGE_PLAN_PRICE_PER_MCU_MONEY_MICROS,
    effectiveAt: input.periodStart,
    expiresAt: input.periodEnd,
    contractReference,
    createdAt: input.now,
  });

  const entitlementId = `usage-plan-entitlement:${input.tenantId}:${spec.id}:${input.periodStart}`;
  return createUsageEntitlement(db, {
    id: entitlementId,
    tenantId: input.tenantId,
    priceVersionId,
    quotaMcuMicros,
    features: [...spec.features],
    contractReference,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    createdAt: input.now,
  });
}
