import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { clearRateLimits } from "@mendpoint/ops";
import { rateLimitMiddleware } from "./production.js";
import type { ApiEnv } from "./auth.js";

const originalEnv = {
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  TRUST_PROXY: process.env.TRUST_PROXY,
};

afterEach(() => {
  clearRateLimits();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function limitedApp() {
  const app = new Hono<ApiEnv>();
  app.use("*", rateLimitMiddleware());
  app.get("/private", (c) => c.json({ ok: true }));
  return app;
}

describe("production rate limit identity", () => {
  it("ignores spoofed forwarding headers unless TRUST_PROXY is enabled", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    delete process.env.TRUST_PROXY;
    const app = limitedApp();

    const first = await app.request("/private", {
      headers: { "X-Forwarded-For": "198.51.100.1" },
    });
    const second = await app.request("/private", {
      headers: { "X-Forwarded-For": "198.51.100.2" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("uses a stable credential fingerprint before authentication", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    const app = limitedApp();

    expect(
      (
        await app.request("/private", {
          headers: { Authorization: "Bearer key-one" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/private", {
          headers: { Authorization: "Bearer key-two" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/private", {
          headers: { Authorization: "Bearer key-one" },
        })
      ).status,
    ).toBe(429);
  });
});
