import { describe, expect, it, beforeEach } from "vitest";
import {
  RELEASE,
  validateApiEnv,
  rateLimit,
  clearRateLimits,
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

  it("rate limits after max", () => {
    for (let i = 0; i < 5; i++) {
      const r = rateLimit("t1", { limit: 5, windowMs: 60_000 });
      expect(r.allowed).toBe(true);
    }
    const blocked = rateLimit("t1", { limit: 5, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);
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
