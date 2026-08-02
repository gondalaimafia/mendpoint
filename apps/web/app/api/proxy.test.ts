import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH, POST } from "./[...path]/route.js";
import {
  DELETE as logout,
  GET as sessionStatus,
  POST as login,
} from "./session/route.js";
import { middleware } from "../../middleware.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  MENDPOINT_API_KEY: process.env.MENDPOINT_API_KEY,
  MENDPOINT_API_URL: process.env.MENDPOINT_API_URL,
  MENDPOINT_WEB_ACCESS_TOKEN: process.env.MENDPOINT_WEB_ACCESS_TOKEN,
  MENDPOINT_WEB_ALLOWED_ORIGINS: process.env.MENDPOINT_WEB_ALLOWED_ORIGINS,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function mutationRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
) {
  return new NextRequest(url, {
    method: "PATCH",
    headers: {
      Origin: "https://console.example",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    },
    body: JSON.stringify({ title: "safe" }),
    ...init,
  });
}

async function sessionCookie(): Promise<string> {
  process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-secret";
  process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
  const response = await login(
    new NextRequest("https://console.example/api/session", {
      method: "POST",
      headers: {
        Origin: "https://console.example",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: "web-secret" }),
    }),
  );
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=strict");
  const cookie = setCookie.split(";")[0]!;
  expect(cookie).toMatch(/^mendpoint_web_session=v3\./);
  return cookie;
}

describe("web credential proxy", () => {
  it("guards server rendered operator pages with the same session", async () => {
    process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-secret";
    const denied = await middleware(
      new NextRequest("https://console.example/metrics"),
    );
    expect(denied.status).toBe(307);
    expect(denied.headers.get("location")).toContain("/access?next=%2Fmetrics");

    const cookie = await sessionCookie();
    const allowed = await middleware(
      new NextRequest("https://console.example/metrics", {
        headers: { Cookie: cookie },
      }),
    );
    expect(allowed.headers.get("x-middleware-next")).toBe("1");

    const icon = await middleware(
      new NextRequest("https://console.example/icon.svg"),
    );
    expect(icon.headers.get("x-middleware-next")).toBe("1");
  });

  it("creates and clears a same-origin HttpOnly session", async () => {
    const cookie = await sessionCookie();
    const status = await sessionStatus(
      new NextRequest("https://console.example/api/session", {
        headers: { Cookie: cookie },
      }),
    );
    await expect(status.json()).resolves.toMatchObject({
      authenticated: true,
      subject: { kind: "preview_access" },
    });

    const response = logout(
      new NextRequest("https://console.example/api/session", {
        method: "DELETE",
        headers: {
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not accept caller asserted identity and rejects legacy, tampered, and expired cookies", async () => {
    process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-secret";
    process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
    const assertedIdentity = await login(
      new NextRequest("https://console.example/api/session", {
        method: "POST",
        headers: {
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: "web-secret", operatorId: "attacker@example.com" }),
      }),
    );
    expect(assertedIdentity.status).toBe(200);
    await expect(assertedIdentity.json()).resolves.toEqual({ authenticated: true });

    const legacy = await middleware(
      new NextRequest("https://console.example/metrics", {
        headers: { Cookie: "mendpoint_web_session=legacy-v1-value" },
      }),
    );
    expect(legacy.status).toBe(307);

    const cookie = await sessionCookie();
    const [name, value] = cookie.split("=");
    const parts = value!.split(".");
    const tamperedCookie = `${name}=${parts[0]}.${parts[1]}A.${parts[2]}`;
    const tampered = await middleware(
      new NextRequest("https://console.example/metrics", {
        headers: { Cookie: tamperedCookie },
      }),
    );
    expect(tampered.status).toBe(307);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const expired = await middleware(
      new NextRequest("https://console.example/metrics", {
        headers: { Cookie: cookie },
      }),
    );
    expect(expired.status).toBe(307);
  });

  it("allows the authenticated status readiness probe", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (url: URL) => {
      expect(url.toString()).toBe("http://api.internal:3001/status");
      return Response.json({ ready: true });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await GET(
      new NextRequest("https://console.example/api/status", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["status"] }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("allows authenticated recovery reads and controls", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    const summary = await GET(
      new NextRequest("https://console.example/api/recovery/summary", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["recovery", "summary"] }) },
    );
    expect(summary.status).toBe(200);

    const retry = await POST(
      new NextRequest("https://console.example/api/jobs/job-1/retry", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "test" }),
      }),
      { params: Promise.resolve({ path: ["jobs", "job-1", "retry"] }) },
    );
    expect(retry.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("allows tenant scoped Transformer reads and forwards required mutation evidence", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-mendpoint-actor")).toBeNull();
      if (init?.method === "POST") {
        expect(headers.get("idempotency-key")).toBe("campaign-a-pause");
        expect(headers.get("x-mendpoint-evidence-refs")).toBe("operator:pause");
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", upstream);

    const gate = await GET(
      new NextRequest("https://console.example/api/transformer/gate", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["transformer", "gate"] }) },
    );
    expect(gate.status).toBe(200);

    const view = await GET(
      new NextRequest("https://console.example/api/transformer/control-plane/campaigns/campaign-a", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["transformer", "control-plane", "campaigns", "campaign-a"] }) },
    );
    expect(view.status).toBe(200);

    const events = await GET(
      new NextRequest("https://console.example/api/transformer/control-plane/campaigns/campaign-a/events", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["transformer", "control-plane", "campaigns", "campaign-a", "events"] }) },
    );
    expect(events.status).toBe(200);

    const pause = await POST(
      new NextRequest("https://console.example/api/transformer/control-plane/campaigns/campaign-a/transitions", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": "campaign-a-pause",
          "X-Mendpoint-Evidence-Refs": "operator:pause",
        },
        body: JSON.stringify({ state: "paused", expectedRevision: 3 }),
      }),
      { params: Promise.resolve({ path: ["transformer", "control-plane", "campaigns", "campaign-a", "transitions"] }) },
    );
    expect(pause.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it("does not turn preview access into a delegated human identity", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe("/prs/pr-1/reviews");
      expect(new Headers(init?.headers).get("x-mendpoint-actor")).toBeNull();
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", upstream);

    const read = await GET(
      new NextRequest("https://console.example/api/prs/pr-1/reviews", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["prs", "pr-1", "reviews"] }) },
    );
    expect(read.status).toBe(200);

    const decision = await POST(
      new NextRequest("https://console.example/api/prs/pr-1/reviews", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approve", rationale: "Evidence is complete" }),
      }),
      { params: Promise.resolve({ path: ["prs", "pr-1", "reviews"] }) },
    );
    expect(decision.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("rejects unauthenticated and cross-origin mutations", async () => {
    process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-secret";
    process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
    expect(
      (
        await PATCH(mutationRequest("https://console.example/api/platform/plans/run-1"), {
          params: Promise.resolve({ path: ["platform", "plans", "run-1"] }),
        })
      ).status,
    ).toBe(401);

    const cookie = await sessionCookie();
    const response = await PATCH(
      mutationRequest("https://console.example/api/platform/plans/run-1", {
        headers: {
          Cookie: cookie,
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );
    expect(response.status).toBe(403);
  });

  it("bounds the bridge and preserves safe observability headers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T15:16:17.123Z"));
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    let forwardedHeaders: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        forwardedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": 'attachment; filename="audit.json"',
            "X-Request-Id": "upstream-request",
            "X-RateLimit-Limit": "100",
            "X-RateLimit-Remaining": "99",
            "X-RateLimit-Reset": "123",
            "Server-Timing": "total;dur=4",
          },
        });
      }),
    );

    const response = await PATCH(
      mutationRequest("https://console.example/api/platform/plans/run-1", {
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "X-Request-Id": "browser-request-1",
        },
      }),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );
    expect(response.status).toBe(200);
    expect(forwardedHeaders?.get("authorization")).toBe("Bearer api-secret");
    expect(forwardedHeaders?.get("x-request-id")).toBe("browser-request-1");
    expect(forwardedHeaders?.get("x-mendpoint-actor")).toBeNull();
    expect(forwardedHeaders?.get("x-mendpoint-actor-timestamp")).toBeNull();
    expect(forwardedHeaders?.get("x-mendpoint-actor-signature")).toBeNull();
    expect(response.headers.get("content-disposition")).toContain("audit.json");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("99");
    expect(response.headers.get("server-timing")).toBe("total;dur=4");
    expect(response.headers.get("x-request-id")).toBe("upstream-request");
  });

  it("keeps the abort active while consuming the upstream body", async () => {
    vi.useFakeTimers();
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
        markFetchStarted();
        const signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(new DOMException("aborted", "AbortError"));
              });
            },
          }),
        );
      }),
    );
    const responsePromise = PATCH(
      mutationRequest("https://console.example/api/platform/plans/run-1", {
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await responsePromise).status).toBe(504);
  });
});
