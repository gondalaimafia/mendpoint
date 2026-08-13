/**
 * Self-serve tenant-private provider publishing (S1.1).
 *
 * Today the provider catalog is a shared, tenant-agnostic set of rows that only a system
 * tenant admin may mutate (see catalogMutationDenied / canMutateSystemCatalog). That blocks a
 * self-serve customer from adding their OWN OpenAPI source. This module carries the pure,
 * fully testable authority decision that lets a tenant owner/admin create and publish a
 * provider scoped to their own tenant (a non-null providers.tenant_id) WITHOUT touching the
 * shared system catalog — behind the MENDPOINT_SELF_SERVE_WARDEN flag.
 *
 * The whole tenant-scoped path is inert unless the flag is set, so with the flag off the
 * decision is byte-identical to the existing shared-catalog gate: shared/system-admin only.
 */
import { can, canMutateSystemCatalog, type Principal } from "@mendpoint/platform";

export const SELF_SERVE_WARDEN_FLAG = "MENDPOINT_SELF_SERVE_WARDEN" as const;

// The flag predicate is defined once, in self-serve-scan.ts, and re-exported here so
// both self-serve surfaces read the same helper (one source of truth for the flag).
export { selfServeWardenEnabled } from "./self-serve-scan.js";
import { selfServeWardenEnabled } from "./self-serve-scan.js";

/** Minimal provider shape the decision needs: its tenant owner (null = shared catalog). */
export type CatalogProviderOwnership = { tenant_id?: string | null };

export type CatalogMutationInput = {
  /** false when auth is off (open mode): no RBAC enforcement, today's allow-all behavior. */
  authEnforced: boolean;
  /** The authenticated principal (undefined only when auth is off). */
  principal: Principal | undefined;
  /**
   * The provider being mutated, or undefined when creating a brand-new provider. Its
   * tenant_id decides whether this is a shared-catalog mutation (system-admin only) or a
   * tenant-private one (self-serve owner only).
   */
  provider: CatalogProviderOwnership | undefined;
  /** MENDPOINT_SELF_SERVE_WARDEN gate. */
  selfServeEnabled: boolean;
  systemTenantId?: string;
};

export type CatalogMutationDecision =
  | {
      allowed: true;
      /** tenant_id to stamp on the mutated/created rows. null = shared system catalog. */
      tenantScope: string | null;
    }
  | { allowed: false };

/**
 * Decide whether a provider-catalog mutation is authorized and how it must be scoped.
 *
 * Precedence, chosen so the flag-off path is byte-identical to catalogMutationDenied:
 *  1. auth off            => allow, scope to the provider's own tenant (create => shared null).
 *  2. system catalog admin => allow, scope to the provider's own tenant (shared catalog authority).
 *  3. self-serve + tenant admin/owner (flag on) => allow ONLY for their own tenant-private
 *     provider, or a new provider they will own. Never for the shared catalog, never for
 *     another tenant's private provider.
 *  4. otherwise            => deny (identical 403 semantics to the legacy shared-catalog gate).
 */
export function decideCatalogMutation(
  input: CatalogMutationInput,
): CatalogMutationDecision {
  if (!input.authEnforced) {
    return { allowed: true, tenantScope: input.provider?.tenant_id ?? null };
  }
  const principal = input.principal;
  if (!principal) return { allowed: false };

  if (canMutateSystemCatalog(principal, input.systemTenantId)) {
    return { allowed: true, tenantScope: input.provider?.tenant_id ?? null };
  }

  if (
    input.selfServeEnabled &&
    principal.tenantId.trim() !== "" &&
    can(principal, "tenant:admin")
  ) {
    // Creating a new provider => tenant-private, owned by this tenant.
    if (input.provider === undefined) {
      return { allowed: true, tenantScope: principal.tenantId };
    }
    // Mutating an existing provider is allowed ONLY when it is this tenant's private one.
    if (
      input.provider.tenant_id &&
      input.provider.tenant_id === principal.tenantId
    ) {
      return { allowed: true, tenantScope: principal.tenantId };
    }
  }

  return { allowed: false };
}

/**
 * Read-side isolation: is this provider visible to the reader?
 *
 * Shared providers (tenant_id null) are visible to everyone (the shared catalog is public by
 * design). A tenant-private provider is visible only to its owning tenant. `tenantId`
 * undefined is the open/auth-off context (no tenancy to enforce).
 */
export function providerVisibleToTenant(
  provider: CatalogProviderOwnership,
  tenantId: string | undefined,
): boolean {
  if (!provider.tenant_id) return true;
  if (tenantId === undefined) return true;
  return provider.tenant_id === tenantId;
}
