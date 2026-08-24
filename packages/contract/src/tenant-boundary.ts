// Retained forward-compat surface: the canonical schema-version anchor for the
// tenant-boundary contract. Unreferenced until a v2 forces a migration; do not
// remove — it is the version this contract advertises to consumers.
export const TENANT_BOUNDARY_SCHEMA_VERSION = 1 as const;

export const REQUIRED_TENANT_BOUNDARIES = [
  "api",
  "database",
  "graph",
  "workspace",
  "artifact",
  "cache",
] as const;

export type TenantBoundary = (typeof REQUIRED_TENANT_BOUNDARIES)[number];

export type TenantScope = Readonly<{
  tenantId: string;
  actorId: string;
  correlationId: string;
}>;

export type TenantOwnedResource = Readonly<{
  id: string;
  tenantId: string;
}>;

export type TenantBoundaryRegistration = Readonly<{
  boundary: TenantBoundary;
  requiresTenant: true;
  rejectsCrossTenant: true;
}>;

export type TenantIsolationProbe = Readonly<{
  boundary: TenantBoundary;
  ownerTenantId: string;
  attackerTenantId: string;
  denied: boolean;
  reason: "tenant_mismatch" | "tenant_scope_missing";
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function requiredId(value: string, error: string): string {
  if (!ID.test(value)) throw new Error(error);
  return value;
}

export function assertTenantScope(scope: TenantScope | undefined): TenantScope {
  if (!scope) throw new Error("tenant_scope_missing");
  requiredId(scope.tenantId, "tenant_id_invalid");
  requiredId(scope.actorId, "tenant_actor_invalid");
  requiredId(scope.correlationId, "tenant_correlation_invalid");
  return Object.freeze({ ...scope });
}

export function assertTenantResourceAccess<T extends TenantOwnedResource>(
  scope: TenantScope | undefined,
  resource: T,
): T {
  const validated = assertTenantScope(scope);
  requiredId(resource.id, "tenant_resource_id_invalid");
  requiredId(resource.tenantId, "tenant_resource_tenant_invalid");
  if (resource.tenantId !== validated.tenantId) {
    throw new Error("tenant_mismatch");
  }
  return resource;
}

/**
 * Shared launch gate for production boundaries. A boundary must explicitly
 * declare both tenant scope and cross-tenant denial; omitted controls fail
 * closed instead of becoming an unscoped production path.
 */
export class TenantBoundaryRegistry {
  readonly #registrations = new Map<TenantBoundary, TenantBoundaryRegistration>();

  register(input: TenantBoundaryRegistration): void {
    if (!REQUIRED_TENANT_BOUNDARIES.includes(input.boundary)) {
      throw new Error("tenant_boundary_unknown");
    }
    if (input.requiresTenant !== true || input.rejectsCrossTenant !== true) {
      throw new Error(`tenant_boundary_unscoped:${input.boundary}`);
    }
    this.#registrations.set(input.boundary, Object.freeze({ ...input }));
  }

  assertProductionCoverage(): readonly TenantBoundaryRegistration[] {
    const missing = REQUIRED_TENANT_BOUNDARIES.filter(
      (boundary) => !this.#registrations.has(boundary),
    );
    if (missing.length > 0) {
      throw new Error(`tenant_boundary_coverage_missing:${missing.join(",")}`);
    }
    return Object.freeze(
      REQUIRED_TENANT_BOUNDARIES.map((boundary) => this.#registrations.get(boundary)!),
    );
  }
}

export type TenantBoundaryAdapter = Readonly<{
  boundary: TenantBoundary;
  read: (scope: TenantScope | undefined, resourceId: string) => unknown;
}>;

/** Execute the same hostile cross-tenant read against every registered adapter. */
export function runTenantIsolationProbes(input: Readonly<{
  adapters: readonly TenantBoundaryAdapter[];
  ownerTenantId: string;
  attackerTenantId: string;
  resourceId: string;
  actorId: string;
  correlationId: string;
}>): readonly TenantIsolationProbe[] {
  if (input.ownerTenantId === input.attackerTenantId) {
    throw new Error("tenant_probe_distinct_tenants_required");
  }
  const byBoundary = new Map(input.adapters.map((adapter) => [adapter.boundary, adapter]));
  const missing = REQUIRED_TENANT_BOUNDARIES.filter((boundary) => !byBoundary.has(boundary));
  if (missing.length > 0) throw new Error(`tenant_probe_boundary_missing:${missing.join(",")}`);

  return Object.freeze(
    REQUIRED_TENANT_BOUNDARIES.map((boundary) => {
      const adapter = byBoundary.get(boundary)!;
      try {
        adapter.read(
          {
            tenantId: input.ownerTenantId,
            actorId: input.actorId,
            correlationId: input.correlationId,
          },
          input.resourceId,
        );
      } catch {
        throw new Error(`tenant_probe_owner_access_failed:${boundary}`);
      }
      let reason: TenantIsolationProbe["reason"] | undefined;
      try {
        adapter.read(
          {
            tenantId: input.attackerTenantId,
            actorId: input.actorId,
            correlationId: input.correlationId,
          },
          input.resourceId,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "tenant_mismatch" || message === "tenant_scope_missing") reason = message;
      }
      if (!reason) throw new Error(`tenant_probe_access_leak:${boundary}`);
      return Object.freeze({
        boundary,
        ownerTenantId: input.ownerTenantId,
        attackerTenantId: input.attackerTenantId,
        denied: true,
        reason,
      });
    }),
  );
}
