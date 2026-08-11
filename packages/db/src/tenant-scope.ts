/**
 * Mandatory tenant scoping for customer-owned rows.
 *
 * The fail-open pattern `${tenantId ? "AND tenant_id = ?" : ""}` silently drops the
 * tenant predicate whenever `tenantId` is falsy. A principal that reaches a scoped
 * query with a blank tenant (for example an empty `x-tenant-id` header, which yields
 * `principal.tenantId === ""`) would then read across every tenant. `assertTenantScope`
 * closes that hole: a present-but-blank tenant is a hard error (`tenant_scope_required`).
 *
 * `undefined` remains the EXPLICIT, allowlisted global/system read path. The genuinely
 * global callers are, exhaustively:
 *  - GitHub webhook PR matching (no authenticated principal; tenant derived from the row),
 *  - internal graph/pipeline builders invoked in dogfood/system context,
 *  - the background worker's cross-tenant job sweep (recoverExpiredJobs / claimNextJob),
 *  - admin cross-tenant list/metrics endpoints.
 * Those callers omit the argument on purpose. A blank string is never a legitimate value.
 */
export function assertTenantScope(tenantId: string | undefined | null): void {
  if (tenantId === undefined || tenantId === null) return; // explicit global/system read
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("tenant_scope_required");
  }
}
