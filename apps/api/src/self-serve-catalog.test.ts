/**
 * S1.1 self-serve provider-catalog authority decision.
 *
 * Pins the pure gate that lets a self-serve tenant owner/admin create and publish a provider
 * private to their own tenant (behind MENDPOINT_SELF_SERVE_WARDEN) WITHOUT weakening the
 * shared system catalog, and proves the flag-off path is byte-identical to the legacy
 * shared-catalog gate (system-admin only).
 */
import type { Principal } from "@mendpoint/platform";
import { describe, expect, it } from "vitest";
import {
  decideCatalogMutation,
  providerVisibleToTenant,
  selfServeWardenEnabled,
} from "./self-serve-catalog.js";

const SYSTEM_TENANT = "tenant_default";

function principal(tenantId: string, role: Principal["role"]): Principal {
  return { id: `user@${tenantId}`, tenantId, role };
}

const systemAdmin = principal(SYSTEM_TENANT, "admin");
const tenantAdmin = principal("tenant-a", "admin");
const tenantOwner = principal("tenant-a", "owner");
const tenantEngineer = principal("tenant-a", "engineer");

describe("selfServeWardenEnabled", () => {
  it("is off by default and only 1 enables it", () => {
    expect(selfServeWardenEnabled({})).toBe(false);
    expect(selfServeWardenEnabled({ MENDPOINT_SELF_SERVE_WARDEN: "0" })).toBe(false);
    expect(selfServeWardenEnabled({ MENDPOINT_SELF_SERVE_WARDEN: "true" })).toBe(false);
    expect(selfServeWardenEnabled({ MENDPOINT_SELF_SERVE_WARDEN: "1" })).toBe(true);
  });
});

describe("decideCatalogMutation — flag OFF (byte-identical to legacy shared-catalog gate)", () => {
  const base = { selfServeEnabled: false, systemTenantId: SYSTEM_TENANT } as const;

  it("allows the system catalog admin to create a shared provider (null scope)", () => {
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: systemAdmin, provider: undefined }),
    ).toEqual({ allowed: true, tenantScope: null });
  });

  it("denies a non-system tenant admin (no self-serve escape hatch)", () => {
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: tenantAdmin, provider: undefined }),
    ).toEqual({ allowed: false });
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: tenantOwner, provider: undefined }),
    ).toEqual({ allowed: false });
  });

  it("allows every mutation when auth is off (open mode, scope follows the provider)", () => {
    expect(
      decideCatalogMutation({ ...base, authEnforced: false, principal: undefined, provider: undefined }),
    ).toEqual({ allowed: true, tenantScope: null });
    expect(
      decideCatalogMutation({
        ...base,
        authEnforced: false,
        principal: undefined,
        provider: { tenant_id: "tenant-a" },
      }),
    ).toEqual({ allowed: true, tenantScope: "tenant-a" });
  });
});

describe("decideCatalogMutation — flag ON (self-serve tenant-private path)", () => {
  const base = { selfServeEnabled: true, systemTenantId: SYSTEM_TENANT } as const;

  it("lets a tenant admin/owner create a provider private to their own tenant", () => {
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: tenantAdmin, provider: undefined }),
    ).toEqual({ allowed: true, tenantScope: "tenant-a" });
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: tenantOwner, provider: undefined }),
    ).toEqual({ allowed: true, tenantScope: "tenant-a" });
  });

  it("lets a tenant admin mutate their own private provider", () => {
    expect(
      decideCatalogMutation({
        ...base,
        authEnforced: true,
        principal: tenantAdmin,
        provider: { tenant_id: "tenant-a" },
      }),
    ).toEqual({ allowed: true, tenantScope: "tenant-a" });
  });

  it("denies mutating another tenant's private provider (isolation)", () => {
    expect(
      decideCatalogMutation({
        ...base,
        authEnforced: true,
        principal: tenantAdmin,
        provider: { tenant_id: "tenant-b" },
      }),
    ).toEqual({ allowed: false });
  });

  it("denies a tenant admin mutating the SHARED catalog (stays system-admin only)", () => {
    expect(
      decideCatalogMutation({
        ...base,
        authEnforced: true,
        principal: tenantAdmin,
        provider: { tenant_id: null },
      }),
    ).toEqual({ allowed: false });
  });

  it("denies a non-admin tenant role even with the flag on", () => {
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: tenantEngineer, provider: undefined }),
    ).toEqual({ allowed: false });
  });

  it("denies a principal carrying a blank tenant rather than minting a blank-owned provider", () => {
    expect(
      decideCatalogMutation({
        ...base,
        authEnforced: true,
        principal: principal("", "admin"),
        provider: undefined,
      }),
    ).toEqual({ allowed: false });
  });

  it("still gives the system catalog admin full shared-catalog authority", () => {
    expect(
      decideCatalogMutation({ ...base, authEnforced: true, principal: systemAdmin, provider: undefined }),
    ).toEqual({ allowed: true, tenantScope: null });
  });
});

describe("providerVisibleToTenant", () => {
  it("shows shared providers to everyone", () => {
    expect(providerVisibleToTenant({ tenant_id: null }, "tenant-a")).toBe(true);
    expect(providerVisibleToTenant({ tenant_id: null }, undefined)).toBe(true);
  });

  it("shows a private provider only to its owning tenant", () => {
    expect(providerVisibleToTenant({ tenant_id: "tenant-a" }, "tenant-a")).toBe(true);
    expect(providerVisibleToTenant({ tenant_id: "tenant-a" }, "tenant-b")).toBe(false);
  });

  it("treats the auth-off (undefined tenant) context as open", () => {
    expect(providerVisibleToTenant({ tenant_id: "tenant-a" }, undefined)).toBe(true);
  });
});
