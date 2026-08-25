import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const originalEnvironment = {
  apiKey: process.env.MENDPOINT_API_KEY,
  apiUrl: process.env.MENDPOINT_API_URL,
  allowedOrigins: process.env.MENDPOINT_WEB_ALLOWED_ORIGINS,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalEnvironment.apiKey === undefined) delete process.env.MENDPOINT_API_KEY;
  else process.env.MENDPOINT_API_KEY = originalEnvironment.apiKey;
  if (originalEnvironment.apiUrl === undefined) delete process.env.MENDPOINT_API_URL;
  else process.env.MENDPOINT_API_URL = originalEnvironment.apiUrl;
  if (originalEnvironment.allowedOrigins === undefined) delete process.env.MENDPOINT_WEB_ALLOWED_ORIGINS;
  else process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = originalEnvironment.allowedOrigins;
});
function request(body = JSON.stringify({ name: "Jordan Lee" }), headers: Record<string, string> = {}) {
  return new NextRequest("https://mendpoint.dev/api/design-partners", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://mendpoint.dev",
      referer: "https://mendpoint.dev/design-partners?source=home",
      "sec-fetch-site": "same-origin",
      "user-agent": "Mendpoint browser test",
      "x-request-id": "public-request-1",
      ...headers,
    },
    body,
  });
}

function configure() {
  process.env.MENDPOINT_API_KEY = "internal-application-api-key";
  process.env.MENDPOINT_API_URL = "https://api.mendpoint.dev/";
  process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://mendpoint.dev";
}

describe("public design partner application bridge", () => {
  it("forwards only bounded server-controlled metadata and returns only the reference", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      data: {
        applicationId: "application-reference-1",
        tenantId: "private-tenant",
        actorPrincipalId: "private-actor",
      },
      audit: { encryptedPayload: "private" },
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(undefined, {
      authorization: "Bearer attacker-token",
      "x-tenant-id": "tenant-victim",
      "x-user-id": "spoofed-user",
      "x-mendpoint-actor": "spoofed-actor",
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ applicationId: "application-reference-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mendpoint.dev/design-partner-applications");
    const forwarded = new Headers(init.headers);
    expect(forwarded.get("authorization")).toBe("Bearer internal-application-api-key");
    expect(forwarded.get("x-request-id")).toBe("public-request-1");
    expect(forwarded.get("x-mendpoint-application-bridge")).toBe("public-design-partner-v1");
    expect(forwarded.get("x-mendpoint-application-origin")).toBe("https://mendpoint.dev");
    expect(forwarded.get("x-mendpoint-application-referrer-path")).toBe("/design-partners?source=home");
    expect(forwarded.get("x-tenant-id")).toBeNull();
    expect(forwarded.get("x-user-id")).toBeNull();
    expect(forwarded.get("x-mendpoint-actor")).toBeNull();
  });

  it("rejects cross-origin and oversized requests without contacting the API", async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const crossOrigin = await POST(request(undefined, {
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }));
    expect(crossOrigin.status).toBe(403);
    const oversized = await POST(request("x".repeat(17_000)));
    expect(oversized.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels an undeclared streamed request at the byte limit", async () => {
    configure();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let cancelled = false;
    let index = 0;
    const chunks = [new Uint8Array(16 * 1_024), new Uint8Array([1])];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const streamed = new NextRequest("https://mendpoint.dev/api/design-partners", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://mendpoint.dev",
        "sec-fetch-site": "same-origin",
      },
      body,
      duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });

    const response = await POST(streamed);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without the server API key and redacts upstream failures", async () => {
    process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://mendpoint.dev";
    delete process.env.MENDPOINT_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const unconfigured = await POST(request());
    expect(unconfigured.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();

    configure();
    fetchMock.mockResolvedValue(Response.json({
      error: { code: "application_rate_limited", message: "private diagnostic" },
      tenantId: "private-tenant",
    }, { status: 429, headers: { "Retry-After": "120" } }));
    const limited = await POST(request());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("120");
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
  });

  it("rejects malformed successful upstream responses", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      data: { applicationId: "invalid application reference" },
    }, { status: 201 })));
    const response = await POST(request());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "application_service_unavailable" });
  });

  it("cancels an undeclared oversized upstream response", async () => {
    configure();
    let cancelled = false;
    let index = 0;
    const chunks = [new Uint8Array(16 * 1_024), new Uint8Array([1])];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      body: new ReadableStream({
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk) controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
      headers: new Headers(),
      ok: true,
      status: 201,
    }) as Response));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
  });

  it("keeps the upstream timeout active while consuming the response body", async () => {
    configure();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener("abort", () => {
            controller.error(new DOMException("request timed out", "AbortError"));
          }, { once: true });
        },
      }), { status: 201 });
    }));

    const responsePromise = POST(request());
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await responsePromise;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({
      error: "application_service_unavailable",
    });
  });
});
