import {
  BILLING_PLANS,
  getTenant,
  getTenantBySlug,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import { canMutateSystemCatalog, type Principal } from "@mendpoint/platform";

export type TenantCreationErrorCode =
  | "catalog_authority_required"
  | "tenant_fields_required"
  | "tenant_plan_invalid"
  | "tenant_slug_taken";

export class TenantCreationError extends Error {
  constructor(
    readonly code: TenantCreationErrorCode,
    readonly status: 400 | 403 | 409,
  ) {
    super(
      code === "tenant_plan_invalid"
        ? "invalid plan"
        : code.replaceAll("_", " "),
    );
    this.name = "TenantCreationError";
  }
}

export function createTopLevelTenant(
  db: AppDb,
  options: Readonly<{
    principal: Principal;
    input: { slug: string; name: string; plan?: string };
    id: string;
    createdAt: string;
  }>,
) {
  if (!canMutateSystemCatalog(options.principal)) {
    throw new TenantCreationError("catalog_authority_required", 403);
  }
  if (!options.input.slug?.trim() || !options.input.name?.trim()) {
    throw new TenantCreationError("tenant_fields_required", 400);
  }
  const plan = options.input.plan ?? "free";
  const planMeta = BILLING_PLANS.find((candidate) => candidate.id === plan);
  if (!planMeta) {
    throw new TenantCreationError("tenant_plan_invalid", 400);
  }
  if (getTenantBySlug(db, options.input.slug)) {
    throw new TenantCreationError("tenant_slug_taken", 409);
  }
  insertTenant(db, {
    id: options.id,
    slug: options.input.slug,
    name: options.input.name,
    plan,
    seatLimit: planMeta.seatLimit,
    createdAt: options.createdAt,
  });
  return getTenant(db, options.id)!;
}
