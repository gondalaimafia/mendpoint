import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, PATCH } from "./[...path]/route.js";
import {
  DELETE as logout,
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
  return setCookie.split(";")[0]!;
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
  });

  it("creates and clears a same-origin HttpOnly session", async () => {
    const cookie = await sessionCookie();
    expect(cookie).toMatch(/^mendpoint_web_session=/);

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL, init?: RequestInit) => {
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
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await responsePromise).status).toBe(504);
  });
});
