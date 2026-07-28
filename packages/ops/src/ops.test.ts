import { describe, expect, it, beforeEach } from "vitest";
import {
  RELEASE,
  validateApiEnv,
  rateLimit,
  clearRateLimits,
  rateLimitBucketCount,
  isFeatureEnabled,
  featureMatrix,
  liveness,
  readiness,
} from "./index.js";

describe("ops GA", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  it("release is GA 1.0.0", () => {
    expect(RELEASE.version).toBe("1.0.0");
    expect(RELEASE.channel).toBe("ga");
    expect(RELEASE.gaFeatures.length).toBeGreaterThan(5);
  });

  it("production requires API_AUTH", () => {
    const prev = process.env.NODE_ENV;
    const auth = process.env.API_AUTH;
    process.env.NODE_ENV = "production";
    delete process.env.API_AUTH;
    const r = validateApiEnv(process.env);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("API_AUTH"))).toBe(true);
    process.env.NODE_ENV = prev;
    if (auth !== undefined) process.env.API_AUTH = auth;
    else delete process.env.API_AUTH;
  });

  it("production real GitHub mode requires a webhook secret", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "real",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("GITHUB_WEBHOOK_SECRET"))).toBe(true);
  });

  it("rate limits after max", () => {
    for (let i = 0; i < 5; i++) {
      const r = rateLimit("t1", { limit: 5, windowMs: 60_000 });
      expect(r.allowed).toBe(true);
    }
    const blocked = rateLimit("t1", { limit: 5, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);
  });

  it("bounds retained rate limit identities", () => {
    const previous = process.env.RATE_LIMIT_MAX_BUCKETS;
    process.env.RATE_LIMIT_MAX_BUCKETS = "3";
    try {
      for (let i = 0; i < 10; i++) {
        rateLimit(`identity-${i}`, { limit: 1, windowMs: 60_000 });
      }
      expect(rateLimitBucketCount()).toBeLessThanOrEqual(3);
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_MAX_BUCKETS;
      else process.env.RATE_LIMIT_MAX_BUCKETS = previous;
    }
  });

  it("GA features on; experimental off by default", () => {
    expect(isFeatureEnabled("migration_pr_review_first")).toBe(true);
    expect(isFeatureEnabled("firecracker_vm_backend")).toBe(false);
    const m = featureMatrix();
    expect(m.filter((f) => f.tier === "ga").every((f) => f.enabled)).toBe(true);
  });

  it("liveness and readiness return structured probes", () => {
    expect(liveness().status).toBe("ok");
    const r = readiness();
    expect(["ok", "degraded", "fail"]).toContain(r.status);
    expect(r.release.version).toBe("1.0.0");
  });
});
