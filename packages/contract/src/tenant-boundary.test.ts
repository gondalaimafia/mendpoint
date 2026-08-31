import { describe, expect, it } from "vitest";
import {
  REQUIRED_TENANT_BOUNDARIES,
  PRODUCTION_TENANT_BOUNDARY_REGISTRATIONS,
  TenantBoundaryRegistry,
  assertProductionTenantBoundaryCoverage,
  assertTenantResourceAccess,
  assertTenantScope,
  runTenantIsolationProbes,
  type TenantBoundaryAdapter,
  type TenantBoundary,
  type TenantOwnedResource,
} from "./tenant-boundary.js";

function adapters(resource: TenantOwnedResource): TenantBoundaryAdapter[] {
  return REQUIRED_TENANT_BOUNDARIES.map((boundary) => ({
    boundary,
    read: (scope, resourceId) =>
      assertTenantResourceAccess(scope, { ...resource, id: resourceId }),
  }));
}

describe("tenant boundary launch contract", () => {
  it("requires explicit scope and attributable context", () => {
    expect(() => assertTenantScope(undefined)).toThrow("tenant_scope_missing");
    expect(() =>
      assertTenantScope({ tenantId: "tenant-a", actorId: "", correlationId: "trace-a" }),
    ).toThrow("tenant_actor_invalid");
    expect(() =>
      assertTenantScope({ tenantId: "tenant-a", actorId: "actor-a", correlationId: "" }),
    ).toThrow("tenant_correlation_invalid");
  });

  it("fails launch if any required tenant boundary is absent", () => {
    const registry = new TenantBoundaryRegistry();
    for (const boundary of REQUIRED_TENANT_BOUNDARIES.slice(0, -1)) {
      registry.register({
        boundary,
        requiresTenant: true,
        rejectsCrossTenant: true,
        adversarialTestId: `test-${boundary}`,
      });
    }
    expect(() => registry.assertProductionCoverage()).toThrow(
      "tenant_boundary_coverage_missing:observability",
    );
    for (const boundary of REQUIRED_TENANT_BOUNDARIES.slice(-1)) {
      registry.register({
        boundary,
        requiresTenant: true,
        rejectsCrossTenant: true,
        adversarialTestId: `test-${boundary}`,
      });
    }
    expect(registry.assertProductionCoverage().map((entry) => entry.boundary)).toEqual(
      REQUIRED_TENANT_BOUNDARIES,
    );
  });

  it.each(REQUIRED_TENANT_BOUNDARIES)("rejects cross-tenant %s reads", (boundary) => {
    const adapter = adapters({ id: "resource-a", tenantId: "tenant-a" }).find(
      (candidate) => candidate.boundary === boundary,
    )!;
    expect(() =>
      adapter.read(
        { tenantId: "tenant-b", actorId: "actor-b", correlationId: "trace-b" },
        "resource-a",
      ),
    ).toThrow("tenant_mismatch");
  });

  it("runs one adversarial suite across every shared boundary contract", () => {
    const results = runTenantIsolationProbes({
      adapters: adapters({ id: "resource-a", tenantId: "tenant-a" }),
      ownerTenantId: "tenant-a",
      attackerTenantId: "tenant-b",
      resourceId: "resource-a",
      actorId: "actor-b",
      correlationId: "trace-b",
    });
    expect(results).toHaveLength(REQUIRED_TENANT_BOUNDARIES.length);
    expect(results.every((result) => result.denied)).toBe(true);
  });

  it("mounts the complete production contract and rejects a mutated registration", () => {
    expect(assertProductionTenantBoundaryCoverage()).toHaveLength(
      REQUIRED_TENANT_BOUNDARIES.length,
    );
    const withoutLearning = PRODUCTION_TENANT_BOUNDARY_REGISTRATIONS.filter(
      (entry) => entry.boundary !== "learning",
    );
    expect(() => assertProductionTenantBoundaryCoverage(withoutLearning)).toThrow(
      "tenant_boundary_coverage_missing:learning",
    );
    const unscopedExport = PRODUCTION_TENANT_BOUNDARY_REGISTRATIONS.map((entry) =>
      entry.boundary === "export"
        ? { ...entry, rejectsCrossTenant: false as never }
        : entry,
    );
    expect(() => assertProductionTenantBoundaryCoverage(unscopedExport)).toThrow(
      "tenant_boundary_unscoped:export",
    );
  });

  it("fails the harness when any boundary leaks or is absent", () => {
    const base = adapters({ id: "resource-a", tenantId: "tenant-a" });
    const leaking: TenantBoundaryAdapter = {
      boundary: "cache",
      read: () => ({ secret: "tenant-a" }),
    };
    const withLeak = [...base.filter((item) => item.boundary !== "cache"), leaking];
    expect(() =>
      runTenantIsolationProbes({
        adapters: withLeak,
        ownerTenantId: "tenant-a",
        attackerTenantId: "tenant-b",
        resourceId: "resource-a",
        actorId: "actor-b",
        correlationId: "trace-b",
      }),
    ).toThrow("tenant_probe_access_leak:cache");
    expect(() =>
      runTenantIsolationProbes({
        adapters: base.filter((item) => item.boundary !== ("graph" as TenantBoundary)),
        ownerTenantId: "tenant-a",
        attackerTenantId: "tenant-b",
        resourceId: "resource-a",
        actorId: "actor-b",
        correlationId: "trace-b",
      }),
    ).toThrow("tenant_probe_boundary_missing:graph");
  });

  it("does not mistake a boundary that denies every tenant for isolation", () => {
    const base = adapters({ id: "resource-a", tenantId: "tenant-a" });
    const unusable: TenantBoundaryAdapter = {
      boundary: "workspace",
      read: () => {
        throw new Error("tenant_mismatch");
      },
    };
    expect(() =>
      runTenantIsolationProbes({
        adapters: [...base.filter((item) => item.boundary !== "workspace"), unusable],
        ownerTenantId: "tenant-a",
        attackerTenantId: "tenant-b",
        resourceId: "resource-a",
        actorId: "actor-a",
        correlationId: "trace-a",
      }),
    ).toThrow("tenant_probe_owner_access_failed:workspace");
  });
});
