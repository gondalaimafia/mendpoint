import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { clearRateLimits } from "@mendpoint/ops";
import { rateLimitMiddleware } from "./production.js";
import type { ApiEnv } from "./auth.js";

const originalEnv = {
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  TRUST_PROXY: process.env.TRUST_PROXY,
  TRUST_PROXY_SECRET: process.env.TRUST_PROXY_SECRET,
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

  it("does not let callers rotate unverified credentials to evade a network bucket", async () => {
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
    ).toBe(429);
    expect(
      (
        await app.request("/private", {
          headers: { Authorization: "Bearer key-one" },
        })
      ).status,
    ).toBe(429);
  });

  it("trusts forwarding headers only with the configured proxy secret", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.TRUST_PROXY = "1";
    process.env.TRUST_PROXY_SECRET = "proxy-secret";
    const app = limitedApp();

    expect(
      (
        await app.request("/private", {
          headers: { "X-Forwarded-For": "198.51.100.1" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/private", {
          headers: { "X-Forwarded-For": "198.51.100.2" },
        })
      ).status,
    ).toBe(429);

    clearRateLimits();
    expect(
      (
        await app.request("/private", {
          headers: {
            "X-Forwarded-For": "198.51.100.1",
            "X-Mendpoint-Proxy-Secret": "proxy-secret",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/private", {
          headers: {
            "X-Forwarded-For": "198.51.100.2",
            "X-Mendpoint-Proxy-Secret": "proxy-secret",
          },
        })
      ).status,
    ).toBe(200);
  });

  it("applies a second bucket using the authenticated stored API key id", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("apiKeyId", c.req.header("x-test-key-id") ?? undefined);
      await next();
    });
    app.use("*", rateLimitMiddleware({ identity: "principal" }));
    app.get("/private", (c) => c.json({ ok: true }));

    expect(
      (await app.request("/private", { headers: { "X-Test-Key-Id": "key-a" } })).status,
    ).toBe(200);
    expect(
      (await app.request("/private", { headers: { "X-Test-Key-Id": "key-b" } })).status,
    ).toBe(200);
    expect(
      (await app.request("/private", { headers: { "X-Test-Key-Id": "key-a" } })).status,
    ).toBe(429);
  });

  it("isolates web sessions that authenticate through the same server API key", async () => {
    process.env.RATE_LIMIT_MAX = "1";
    process.env.TRUST_PROXY = "1";
    process.env.TRUST_PROXY_SECRET = "proxy-secret";
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("apiKeyId", "shared-web-key");
      c.set("principal", {
        id: "api-key:shared-web-key",
        tenantId: "tenant-a",
        role: "owner",
      });
      await next();
    });
    app.use("*", rateLimitMiddleware({ identity: "principal" }));
    app.get("/private", (c) => c.json({ ok: true }));
    const headers = (session: string) => ({
      "X-Mendpoint-Proxy-Secret": "proxy-secret",
      "X-Mendpoint-Web-Session": session.repeat(64),
    });

    expect((await app.request("/private", { headers: headers("a") })).status).toBe(200);
    expect((await app.request("/private", { headers: headers("b") })).status).toBe(200);
    expect((await app.request("/private", { headers: headers("a") })).status).toBe(429);
  });
});
