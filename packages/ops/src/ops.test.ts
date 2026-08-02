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

  it("rejects typoed GitHub mode and unsupported database URLs", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "rea1",
      DATABASE_URL: "postgres://db.example/mendpoint",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("GITHUB_MODE"))).toBe(true);
    expect(r.errors.some((e) => e.includes("SQLite"))).toBe(true);
  });

  it("rejects an implicit production GitHub mode", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      WEB_URL: "https://mendpoint.example",
    });
    expect(r.errors.some((e) => e.includes("explicitly set"))).toBe(true);
  });

  it("accepts a durable mock mode production configuration", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "mock",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(r.ok).toBe(true);
  });

  it("fails closed when trusted proxy mode has no shared secret", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "mock",
      TRUST_PROXY: "1",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
    });
    expect(r.errors).toContain(
      "TRUST_PROXY_SECRET is required when TRUST_PROXY=1 in production",
    );
  });

  it("requires a PAT for real GitHub delivery", () => {
    const appOnly = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(appOnly.errors.some((e) => e.includes("GITHUB_TOKEN"))).toBe(true);

    const patBacked = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_TOKEN: "fine-grained-pat",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(patBacked.ok).toBe(true);
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
