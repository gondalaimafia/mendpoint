import { describe, expect, it } from "vitest";
import { assertTenant, GLOBAL_CATALOG_RESOURCES, type Principal } from "./index.js";

const principal: Principal = {
  id: "human:owner@example.com",
  tenantId: "tenant-a",
  role: "owner",
};

describe("assertTenant tenant isolation", () => {
  it("allows a resource that belongs to the principal's tenant", () => {
    expect(() => assertTenant(principal, "tenant-a")).not.toThrow();
  });

  it("denies a resource owned by another tenant", () => {
    expect(() => assertTenant(principal, "tenant-b")).toThrow(
      "rbac_tenant_mismatch",
    );
  });

  it("fails closed on an empty or undefined resource tenant (no global-allow)", () => {
    expect(() => assertTenant(principal, "")).toThrow("rbac_tenant_scope_required");
    expect(() => assertTenant(principal, "   ")).toThrow("rbac_tenant_scope_required");
    expect(() => assertTenant(principal, undefined)).toThrow(
      "rbac_tenant_scope_required",
    );
    expect(() => assertTenant(principal, null)).toThrow("rbac_tenant_scope_required");
  });

  it("still denies an empty tenant for a non-allowlisted resource type", () => {
    expect(() => assertTenant(principal, "", "migration_pr")).toThrow(
      "rbac_tenant_scope_required",
    );
  });

  it("permits an empty tenant only for explicitly allowlisted shared-catalog resources", () => {
    for (const resource of GLOBAL_CATALOG_RESOURCES) {
      expect(() => assertTenant(principal, undefined, resource)).not.toThrow();
      expect(() => assertTenant(principal, "", resource)).not.toThrow();
    }
    expect(GLOBAL_CATALOG_RESOURCES.has("api_changes")).toBe(true);
  });

  it("still enforces the tenant match even for allowlisted resource types when a tenant is present", () => {
    // An allowlisted type that nonetheless carries a foreign tenant is still denied.
    expect(() => assertTenant(principal, "tenant-b", "api_changes")).toThrow(
      "rbac_tenant_mismatch",
    );
  });
});
