import { describe, expect, it } from "vitest";
import {
  REQUIRED_TENANT_BOUNDARIES,
  TenantBoundaryRegistry,
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

  it("fails launch if API, DB, graph, workspace, artifact, or cache is unscoped", () => {
    const registry = new TenantBoundaryRegistry();
    for (const boundary of REQUIRED_TENANT_BOUNDARIES.slice(0, -1)) {
      registry.register({ boundary, requiresTenant: true, rejectsCrossTenant: true });
    }
    expect(() => registry.assertProductionCoverage()).toThrow(
      "tenant_boundary_coverage_missing:cache",
    );
    registry.register({ boundary: "cache", requiresTenant: true, rejectsCrossTenant: true });
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
    expect(results).toHaveLength(6);
    expect(results.every((result) => result.denied)).toBe(true);
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
