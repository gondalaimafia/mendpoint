import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";
import {
  internalErrorResponse,
  mappedErrorResponse,
  redactForStructuredLog,
} from "./error-boundary.js";
import { requestIdMiddleware } from "./production.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function failingApp(messages: Record<string, string>) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.onError((error, c) => internalErrorResponse(c, error));
  app.get("/validation", (c) => c.json({ error: "field_required", field: "name" }, 400));
  app.get("/:failure", (c) => {
    throw new Error(messages[c.req.param("failure")] ?? "unknown internal failure");
  });
  return app;
}

describe("API error boundary", () => {
  it("returns only a stable code and request id for representative internal failures", async () => {
    const sentinels = {
      database: "SQLITE_CONSTRAINT at tenants.secret_column for customer_acme",
      filesystem: "ENOENT C:\\customers\\acme\\private-source.ts",
      github: "GitHub installation token github_pat_SENTINEL for secret-org/private-repo",
      model: "Provider rejected prompt containing proprietary source SENTINEL_MODEL",
      internal: "TypeError in buildCampaignGraph at server.ts:2440 SENTINEL_INTERNAL",
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = failingApp(sentinels);

    for (const [failure, sentinel] of Object.entries(sentinels)) {
      const requestId = `request-${failure}`;
      const response = await app.request(`/${failure}`, {
        headers: { "X-Request-Id": requestId },
      });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({ error: "internal_error", requestId });
      expect(JSON.stringify(body)).not.toContain(sentinel);
    }

    const logged = log.mock.calls.map((call) => call.join(" ")).join("\n");
    for (const sentinel of Object.values(sentinels)) {
      expect(logged).not.toContain(sentinel);
    }
    expect(logged).not.toContain("private-source.ts");
    expect(logged).not.toContain("github_pat_SENTINEL");
  });

  it("does not reveal resource existence through different internal messages", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = failingApp({
      exists: "repository secret-org/private-repo exists but is inaccessible",
      missing: "repository secret-org/private-repo does not exist",
    });

    const responses = await Promise.all(["exists", "missing"].map(async (failure) => {
      const response = await app.request(`/${failure}`, {
        headers: { "X-Request-Id": "request-resource-check" },
      });
      return { status: response.status, body: await response.json() };
    }));

    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toEqual({
      status: 500,
      body: { error: "internal_error", requestId: "request-resource-check" },
    });
  });

  it("recursively redacts errors, causes, arrays, object keys and string values", () => {
    const cause = new Error("postgres://admin:password@db/internal");
    const error = new Error("C:\\customers\\acme\\source.ts", { cause });
    const value = {
      authorization: "Bearer secret-token",
      provider: { response: ["private model output", error] },
    };

    const redacted = JSON.stringify(redactForStructuredLog(value));

    expect(redacted).not.toContain("authorization");
    expect(redacted).not.toContain("secret-token");
    expect(redacted).not.toContain("private model output");
    expect(redacted).not.toContain("source.ts");
    expect(redacted).not.toContain("postgres://");
    expect(redacted).toContain("[redacted]");
  });

  it("preserves explicit allowlisted validation responses", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await failingApp({}).request("/validation");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "field_required", field: "name" });
    expect(log).not.toHaveBeenCalled();
  });

  it("exposes only exact reviewed domain codes and fails unknown errors closed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono<ApiEnv>();
    app.use("*", requestIdMiddleware());
    app.get("/:kind", (c) => mappedErrorResponse(
      c,
      new Error(c.req.param("kind") === "known" ? "field_invalid" : "SQLITE at C:\\private"),
      [{ internalCode: "field_invalid", status: 400 }],
    ));

    const known = await app.request("/known", {
      headers: { "X-Request-Id": "request-known" },
    });
    expect(known.status).toBe(400);
    expect(await known.json()).toEqual({ error: "field_invalid", requestId: "request-known" });

    const unknown = await app.request("/unknown", {
      headers: { "X-Request-Id": "request-unknown" },
    });
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toEqual({
      error: "internal_error",
      requestId: "request-unknown",
    });
    expect(log.mock.calls.flat().join(" ")).not.toContain("C:\\private");
  });
});
