import { afterEach, describe, expect, it } from "vitest";
import {
  clearTenantQuotas,
  tenantQuota,
  tenantQuotaBucketCount,
} from "./tenant-quota.js";

const SAVED = {
  max: process.env.TENANT_QUOTA_MAX,
  window: process.env.TENANT_QUOTA_WINDOW_MS,
};

afterEach(() => {
  clearTenantQuotas();
  if (SAVED.max === undefined) delete process.env.TENANT_QUOTA_MAX;
  else process.env.TENANT_QUOTA_MAX = SAVED.max;
  if (SAVED.window === undefined) delete process.env.TENANT_QUOTA_WINDOW_MS;
  else process.env.TENANT_QUOTA_WINDOW_MS = SAVED.window;
});

describe("per-tenant quota", () => {
  it("is disabled and permissive by default (no env, no bucket state)", () => {
    delete process.env.TENANT_QUOTA_MAX;
    const r = tenantQuota("tenant-a");
    expect(r.enabled).toBe(false);
    expect(r.allowed).toBe(true);
    // Disabled path must not allocate buckets.
    expect(tenantQuotaBucketCount()).toBe(0);
  });

  it("enforces the configured budget and then denies (no fail-open)", () => {
    const r1 = tenantQuota("tenant-a", { limit: 2, windowMs: 60_000 });
    const r2 = tenantQuota("tenant-a", { limit: 2, windowMs: 60_000 });
    const r3 = tenantQuota("tenant-a", { limit: 2, windowMs: 60_000 });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);
    expect(r3.enabled).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("budgets each tenant independently", () => {
    tenantQuota("tenant-a", { limit: 1 });
    const aSecond = tenantQuota("tenant-a", { limit: 1 });
    const bFirst = tenantQuota("tenant-b", { limit: 1 });
    expect(aSecond.allowed).toBe(false); // tenant-a exhausted
    expect(bFirst.allowed).toBe(true); // tenant-b unaffected
  });

  it("reads the budget from TENANT_QUOTA_MAX when no explicit limit is given", () => {
    process.env.TENANT_QUOTA_MAX = "1";
    expect(tenantQuota("tenant-a").allowed).toBe(true);
    expect(tenantQuota("tenant-a").allowed).toBe(false);
  });

  it("rejects a blank tenant rather than pooling one anonymous bucket", () => {
    expect(() => tenantQuota("", { limit: 5 })).toThrow("tenant_quota_tenant_required");
    expect(() => tenantQuota("   ", { limit: 5 })).toThrow("tenant_quota_tenant_required");
  });
});
