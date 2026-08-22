import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRateLimits } from "@mendpoint/ops";
import { createDb } from "@mendpoint/db";
import {
  mutationAdmissionMiddleware,
  requestBodyLimitMiddleware,
  rateLimitMiddleware,
} from "./production.js";
import { initializeApiRuntime, synchronousPipelineExecutionAllowed } from "./api-runtime.js";
import type { ApiEnv } from "./auth.js";

const originalEnv = {
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  TRUST_PROXY: process.env.TRUST_PROXY,
  TRUST_PROXY_SECRET: process.env.TRUST_PROXY_SECRET,
};
const temporaryRoots: string[] = [];

afterEach(() => {
  clearRateLimits();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
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
  it("disables synchronous pipeline execution in the Transformer coordinator", () => {
    expect(synchronousPipelineExecutionAllowed({
      MENDPOINT_PROCESS_ROLE: "transformer_coordinator",
    })).toBe(false);
    expect(synchronousPipelineExecutionAllowed({ MENDPOINT_PROCESS_ROLE: "api" })).toBe(true);
    expect(synchronousPipelineExecutionAllowed({})).toBe(true);
  });
  it("rejects declared and streamed request bodies above the API ceiling", async () => {
    const app = new Hono<ApiEnv>();
    app.use("*", requestBodyLimitMiddleware({ maxBytes: 32 }));
    app.post("/private", async (c) => c.json({ body: await c.req.text() }));

    const declared = await app.request("/private", {
      method: "POST",
      headers: { "content-length": "33" },
      body: "x",
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "request_payload_too_large" });

    const streamed = new Request("http://localhost/private", {
      method: "POST",
      headers: { "transfer-encoding": "chunked" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(33)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const streamedResponse = await app.request(streamed);
    expect(streamedResponse.status).toBe(413);
    expect(await streamedResponse.json()).toEqual({ error: "request_payload_too_large" });
  });

  it("does not construct standalone API stores while a customer backup is exclusive", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-api-startup-fence-"));
    temporaryRoots.push(root);
    const fenceRoot = join(root, "fence");
    const databasePath = join(root, "api.sqlite");
    const changeSourcePath = join(root, "change-sources.sqlite");
    const transformerCampaignPath = join(root, "transformer-control-plane.sqlite");
    const transformerExecutionPath = join(root, "transformer-pilot.sqlite");
    mkdirSync(fenceRoot, { recursive: true });
    writeFileSync(join(fenceRoot, "exclusive.json"), "{}\n");

    expect(() =>
      initializeApiRuntime({
        ...process.env,
        MENDPOINT_DEPLOYMENT_PROFILE: "customer",
        MENDPOINT_BACKUP_FENCE_ROOT: fenceRoot,
        DB_PATH: databasePath,
        MENDPOINT_CHANGE_SOURCE_DB_PATH: changeSourcePath,
        MENDPOINT_REGAUGE_CONTROL_PLANE_DB_PATH: transformerCampaignPath,
        MENDPOINT_REGAUGE_PILOT_DB_PATH: transformerExecutionPath,
        MENDPOINT_APPLICATION_DATA_KEY: "0".repeat(64),
      }),
    ).toThrow("customer_startup_blocked_by_backup");
    for (const path of [
      databasePath,
      changeSourcePath,
      transformerCampaignPath,
      transformerExecutionPath,
    ]) expect(existsSync(path)).toBe(false);
  });

  it("holds an API writer lease and returns retryable unavailability during backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-api-backup-fence-"));
    temporaryRoots.push(root);
    const fenceRoot = join(root, "fence");
    const app = new Hono<ApiEnv>();
    app.use("*", mutationAdmissionMiddleware({ enabled: true, fenceRoot }));
    app.get("/private", (c) => c.json({ ok: true }));
    app.get("/health", (c) => c.json({ ok: true }));

    expect((await app.request("/private")).status).toBe(200);
    expect(readdirSync(join(fenceRoot, "writers"))).toEqual([]);
    writeFileSync(join(fenceRoot, "exclusive.json"), "{}\n");

    const blocked = await app.request("/private");
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("Retry-After")).toBe("1");
    expect(await blocked.json()).toEqual({ error: "backup_in_progress" });
    expect((await app.request("/health")).status).toBe(200);
  });

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
