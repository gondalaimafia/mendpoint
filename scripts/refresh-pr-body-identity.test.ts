import { describe, expect, it } from "vitest";
import type { RefreshOpenDraftBodiesResult, RefreshTenantResult } from "@mendpoint/pipeline";
import { reportRefresh, tenantHasReport } from "./refresh-pr-body-identity-report.js";

// Production-shaped 64-hex tenant ids.
const T_REVOKED = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const T_CLEAN = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3f0e4a1b7c2d9e6f3a1b2c3d4";

function tenant(overrides: Partial<RefreshTenantResult> & Pick<RefreshTenantResult, "tenantId" | "tenantSlug">): RefreshTenantResult {
  return {
    affected: 0,
    updated: 0,
    skippedForeignHead: [],
    skippedHumanEdited: [],
    skippedClosed: [],
    skippedNoArtifact: [],
    blocked: [],
    failed: [],
    ...overrides,
  };
}

function resultOf(tenants: RefreshTenantResult[]): RefreshOpenDraftBodiesResult {
  return {
    dryRun: true,
    tenants,
    totalAffected: tenants.reduce((s, t) => s + t.affected, 0),
    totalUpdated: tenants.reduce((s, t) => s + t.updated, 0),
  };
}

describe("refresh-pr-body-identity operator report (#730 follow-up)", () => {
  it("prints the failed URL for a tenant with affected=0 (a fully revoked/403 tenant)", () => {
    // The revoked-installation / 403 case: the draft fails BEFORE it is counted
    // affected, so the tenant has affected=0 but a non-empty `failed` list.
    const failedUrl = "https://github.com/org/shop-revoked/pull/7";
    const result = resultOf([
      tenant({ tenantId: T_REVOKED, tenantSlug: "shop-tenant", affected: 0, failed: [`${failedUrl} (Error)`] }),
    ]);

    const lines: string[] = [];
    const failedCount = reportRefresh(result, { dryRun: true }, (line) => lines.push(line));
    const out = lines.join("\n");

    // The tenant line is printed even though nothing was affected, and the URL is visible.
    expect(out).toContain(`tenant=shop-tenant (${T_REVOKED})`);
    expect(out).toContain(`failed (1): ${failedUrl} (Error)`);
    expect(failedCount).toBe(1);
  });

  it("still omits a tenant that has nothing to report (affected=0 and every list empty)", () => {
    const result = resultOf([tenant({ tenantId: T_CLEAN, tenantSlug: "clean-tenant" })]);
    const lines: string[] = [];
    reportRefresh(result, { dryRun: true }, (line) => lines.push(line));
    expect(lines.join("\n")).not.toContain("clean-tenant");
  });

  it("tenantHasReport is false only when affected=0 and every outcome list is empty", () => {
    expect(tenantHasReport(tenant({ tenantId: T_CLEAN, tenantSlug: "x" }))).toBe(false);
    expect(tenantHasReport(tenant({ tenantId: T_CLEAN, tenantSlug: "x", affected: 1 }))).toBe(true);
    expect(tenantHasReport(tenant({ tenantId: T_CLEAN, tenantSlug: "x", failed: ["u (Error)"] }))).toBe(true);
    expect(tenantHasReport(tenant({ tenantId: T_CLEAN, tenantSlug: "x", blocked: ["u"] }))).toBe(true);
    expect(tenantHasReport(tenant({ tenantId: T_CLEAN, tenantSlug: "x", skippedForeignHead: ["u"] }))).toBe(true);
  });
});
