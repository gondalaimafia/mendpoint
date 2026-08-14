import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { WEB_PROXY_RESPONSE_BYTES } from "@mendpoint/shared";
import { GET, PATCH, POST } from "./[...path]/route.js";
import {
  DELETE as logout,
  GET as sessionStatus,
  POST as login,
} from "./session/route.js";
import { middleware } from "../../middleware.js";
import { createOidcWebSession } from "../../lib/proxy-auth.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  MENDPOINT_API_KEY: process.env.MENDPOINT_API_KEY,
  MENDPOINT_API_URL: process.env.MENDPOINT_API_URL,
  MENDPOINT_DEPLOYMENT_PROFILE: process.env.MENDPOINT_DEPLOYMENT_PROFILE,
  MENDPOINT_WEB_ACCESS_TOKEN: process.env.MENDPOINT_WEB_ACCESS_TOKEN,
  MENDPOINT_WEB_ALLOWED_ORIGINS: process.env.MENDPOINT_WEB_ALLOWED_ORIGINS,
  TRUST_PROXY_SECRET: process.env.TRUST_PROXY_SECRET,
};

const MAX_PROXY_REQUEST_BYTES = 256 * 1024;

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

function byteStream(
  chunks: readonly Uint8Array[],
  onCancel?: () => void,
  closeAfterChunks = true,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else if (closeAfterChunks) controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function streamedMutationRequest(
  chunks: readonly Uint8Array[],
  input: Readonly<{ cookie?: string; contentLength?: number; onCancel?: () => void }> = {},
  closeAfterChunks = true,
): NextRequest {
  const headers = new Headers({
    Origin: "https://console.example",
    "Sec-Fetch-Site": "same-origin",
    "Content-Type": "application/octet-stream",
  });
  if (input.cookie) headers.set("Cookie", input.cookie);
  if (input.contentLength !== undefined) {
    headers.set("Content-Length", String(input.contentLength));
  }
  return new NextRequest("https://console.example/api/platform/plans/run-1", {
    method: "PATCH",
    headers,
    body: byteStream(chunks, input.onCancel, closeAfterChunks),
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
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

    const githubReturn = await middleware(
      new NextRequest(
        "https://console.example/github/setup?installation_id=123&setup_action=install&state=opaque",
      ),
    );
    expect(githubReturn.headers.get("x-middleware-next")).toBe("1");
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

  it("exports tenant audit evidence through the authenticated same origin proxy", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (url: URL) => {
      expect(url.toString()).toBe(
        "http://api.internal:3001/audit/export?format=json",
      );
      return new Response(JSON.stringify({ audit: [] }), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="audit.json"',
        },
      });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await GET(
      new NextRequest(
        "https://console.example/api/audit/export?format=json",
        { headers: { Cookie: cookie } },
      ),
      { params: Promise.resolve({ path: ["audit", "export"] }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("audit.json");
    await expect(response.json()).resolves.toEqual({ audit: [] });
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

  it("allows authenticated same origin consumer creation", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.toString()).toBe("http://api.internal:3001/consumers");
      expect(init?.method).toBe("POST");
      expect(await new Response(init?.body).json()).toMatchObject({
        githubOwner: "gondalaimafia",
        githubRepo: "private-repo",
      });
      return Response.json({ id: "consumer-a" }, { status: 201 });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/consumers", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Private repository",
          githubOwner: "gondalaimafia",
          githubRepo: "private-repo",
          repoKey: "private-repo",
        }),
      }),
      { params: Promise.resolve({ path: ["consumers"] }) },
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "consumer-a" });
  });

  it("forwards the OIDC bearer for the reference only Warden pilot", async () => {
    process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-secret";
    process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const oidcAccessToken = "oidc-access-token-for-tenant-owner";
    const oidcSession = await createOidcWebSession({
      accessToken: oidcAccessToken,
      sessionSecret: "web-secret",
      now: new Date(),
    });
    const upstream = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.toString()).toBe("http://api.internal:3001/warden/pilot");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${oidcAccessToken}`);
      expect(headers.get("idempotency-key")).toBe("warden-pilot-browser-1");
      expect(await new Response(init?.body).json()).toEqual({
        providerSlug: "stripe",
        consumerId: "consumer-a",
      });
      return Response.json({ jobId: "job-a", status: "pending", replayed: false }, { status: 202 });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/warden/pilot", {
        method: "POST",
        headers: {
          Cookie: `mendpoint_web_session=${oidcSession}`,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": "warden-pilot-browser-1",
        },
        body: JSON.stringify({ providerSlug: "stripe", consumerId: "consumer-a" }),
      }),
      { params: Promise.resolve({ path: ["warden", "pilot"] }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "job-a" });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("keeps preview access read only for Warden pilot intake", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/warden/pilot", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": "warden-pilot-preview-1",
        },
        body: JSON.stringify({ providerSlug: "stripe", consumerId: "consumer-a" }),
      }),
      { params: Promise.resolve({ path: ["warden", "pilot"] }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "company_identity_required" });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("blocks the raw Warden authority route in customer mode", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/agent/runs", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          goal: "Try to widen authority",
          consumerId: "consumer-a",
          allowedChangedPaths: ["private.ts"],
        }),
      }),
      { params: Promise.resolve({ path: ["agent", "runs"] }) },
    );

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("allows only the exact tenant membership administration routes", async () => {
    const previewCookie = await sessionCookie();
    const preview = await GET(
      new NextRequest("https://console.example/api/tenants/memberships", {
        headers: { Cookie: previewCookie },
      }),
      { params: Promise.resolve({ path: ["tenants", "memberships"] }) },
    );
    expect(preview.status).toBe(403);
    await expect(preview.json()).resolves.toEqual({ error: "company_identity_required" });

    const oidcAccessToken = "oidc-access-token-for-membership-admin";
    const oidcSession = await createOidcWebSession({
      accessToken: oidcAccessToken,
      sessionSecret: "web-secret",
      now: new Date(),
    });
    const cookie = `mendpoint_web_session=${oidcSession}`;
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (_url: URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${oidcAccessToken}`);
      return Response.json({ data: [] });
    });
    vi.stubGlobal("fetch", upstream);

    const allowed: Array<{
      method: "GET" | "POST" | "PATCH";
      path: string[];
    }> = [
      { method: "GET", path: ["tenants", "memberships"] },
      { method: "POST", path: ["tenants", "memberships"] },
      { method: "POST", path: ["tenants", "memberships", "bootstrap"] },
      { method: "PATCH", path: ["tenants", "memberships", "role"] },
      { method: "POST", path: ["tenants", "memberships", "offboard"] },
    ];
    for (const entry of allowed) {
      const handler = entry.method === "GET" ? GET : entry.method === "PATCH" ? PATCH : POST;
      const response = await handler(
        new NextRequest(`https://console.example/api/${entry.path.join("/")}`, {
          method: entry.method,
          headers: {
            Cookie: cookie,
            Origin: "https://console.example",
            "Sec-Fetch-Site": "same-origin",
            "Content-Type": "application/json",
          },
          body: entry.method === "GET" ? undefined : JSON.stringify({}),
        }),
        { params: Promise.resolve({ path: entry.path }) },
      );
      expect(response.status).toBe(200);
    }

    const denied = await POST(
      new NextRequest("https://console.example/api/tenants/memberships/owner", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
        },
      }),
      { params: Promise.resolve({ path: ["tenants", "memberships", "owner"] }) },
    );
    expect(denied.status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(allowed.length);
  });

  it("allows candidate reads and same origin human review", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toMatch(/^\/agent\/runs\/run-a\/candidate(?:\/review)?$/);
      return Response.json({ ok: true, method: init?.method });
    });
    vi.stubGlobal("fetch", upstream);

    const read = await GET(
      new NextRequest("https://console.example/api/agent/runs/run-a/candidate", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["agent", "runs", "run-a", "candidate"] }) },
    );
    expect(read.status).toBe(200);

    const review = await POST(
      new NextRequest("https://console.example/api/agent/runs/run-a/candidate/review", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      { params: Promise.resolve({ path: ["agent", "runs", "run-a", "candidate", "review"] }) },
    );
    expect(review.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("preserves the private no-store cache directives on candidate source reads", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async () =>
      new Response(JSON.stringify({ candidate: "source" }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store, max-age=0",
          Pragma: "no-cache",
        },
      }),
    );
    vi.stubGlobal("fetch", upstream);

    const read = await GET(
      new NextRequest("https://console.example/api/agent/runs/run-a/candidate", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["agent", "runs", "run-a", "candidate"] }) },
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(read.headers.get("pragma")).toBe("no-cache");
    expect(upstream).toHaveBeenCalledOnce();
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

    const adaptiveCandidates = await GET(
      new NextRequest("https://console.example/api/transformer/adaptive-candidates", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["transformer", "adaptive-candidates"] }) },
    );
    expect(adaptiveCandidates.status).toBe(200);

    const adaptiveCandidate = await GET(
      new NextRequest("https://console.example/api/transformer/adaptive-candidates/tfadapt-a", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["transformer", "adaptive-candidates", "tfadapt-a"] }) },
    );
    expect(adaptiveCandidate.status).toBe(200);

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
    expect(upstream).toHaveBeenCalledTimes(6);
  });

  it("allows same origin adaptive candidate review mutations without synthesizing a human", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(url.pathname).toBe("/transformer/adaptive-candidates/tfadapt-a/review");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-mendpoint-actor")).toBeNull();
      expect(headers.get("idempotency-key")).toBe("adaptive-review-a");
      return Response.json({ status: "approved" });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/transformer/adaptive-candidates/tfadapt-a/review", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": "adaptive-review-a",
        },
        body: JSON.stringify({ decision: "approve" }),
      }),
      {
        params: Promise.resolve({
          path: ["transformer", "adaptive-candidates", "tfadapt-a", "review"],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
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
    process.env.TRUST_PROXY_SECRET = "proxy-secret";
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
          "Fly-Client-IP": "198.51.100.42",
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "X-Request-Id": "browser-request-1",
        },
      }),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );
    expect(response.status).toBe(200);
    expect(forwardedHeaders?.get("authorization")).toBe("Bearer api-secret");
    expect(forwardedHeaders?.get("x-mendpoint-proxy-secret")).toBe("proxy-secret");
    expect(forwardedHeaders?.get("x-forwarded-for")).toBe("198.51.100.42");
    expect(forwardedHeaders?.get("x-mendpoint-web-session")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(forwardedHeaders?.get("x-request-id")).toBe("browser-request-1");
    expect(forwardedHeaders?.get("x-mendpoint-actor")).toBeNull();
    expect(forwardedHeaders?.get("x-mendpoint-actor-timestamp")).toBeNull();
    expect(forwardedHeaders?.get("x-mendpoint-actor-signature")).toBeNull();
    expect(response.headers.get("content-disposition")).toContain("audit.json");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("99");
    expect(response.headers.get("server-timing")).toBe("total;dur=4");
    expect(response.headers.get("x-request-id")).toBe("upstream-request");
  });

  it("rejects a declared oversized request before forwarding and cancels its body", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    let cancelled = false;

    const response = await PATCH(
      streamedMutationRequest([new Uint8Array([1])], {
        cookie,
        contentLength: MAX_PROXY_REQUEST_BYTES + 1,
        onCancel: () => { cancelled = true; },
      }),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "payload_too_large" });
    expect(cancelled).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("stops an undeclared streamed request at the maximum plus one byte", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    let cancelled = false;

    const response = await PATCH(
      streamedMutationRequest([
        new Uint8Array(MAX_PROXY_REQUEST_BYTES),
        new Uint8Array([1]),
      ], {
        cookie,
        onCancel: () => { cancelled = true; },
      }, false),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "payload_too_large" });
    expect(cancelled).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("forwards an undeclared request exactly at the byte boundary", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async (_url: URL, init?: RequestInit) => {
      const forwarded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      expect(forwarded.byteLength).toBe(MAX_PROXY_REQUEST_BYTES);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await PATCH(
      streamedMutationRequest([new Uint8Array(MAX_PROXY_REQUEST_BYTES)], { cookie }),
      { params: Promise.resolve({ path: ["platform", "plans", "run-1"] }) },
    );

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("rejects a declared oversized upstream response before consuming it", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      byteStream([new Uint8Array([1])], () => { cancelled = true; }),
      { headers: { "Content-Length": String(WEB_PROXY_RESPONSE_BYTES + 1) } },
    )));

    const response = await GET(
      new NextRequest("https://console.example/api/status", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["status"] }) },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "upstream_response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("stops an undeclared streamed upstream response at the maximum plus one byte", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(byteStream([
      new Uint8Array(WEB_PROXY_RESPONSE_BYTES),
      new Uint8Array([1]),
    ], () => { cancelled = true; }, false))));

    const response = await GET(
      new NextRequest("https://console.example/api/status", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["status"] }) },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "upstream_response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("returns an undeclared upstream response exactly at the byte boundary", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      byteStream([new Uint8Array(WEB_PROXY_RESPONSE_BYTES)]),
      { headers: { "Content-Type": "application/octet-stream" } },
    )));

    const response = await GET(
      new NextRequest("https://console.example/api/status", {
        headers: { Cookie: cookie },
      }),
      { params: Promise.resolve({ path: ["status"] }) },
    );

    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(WEB_PROXY_RESPONSE_BYTES);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
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

  it("permits the Regauge canonical read paths alongside the legacy Transformer aliases", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", upstream);

    const cases: Array<string[]> = [
      ["regauge", "gate"],
      ["transformer", "gate"],
      ["regauge", "adaptive-candidates"],
      ["transformer", "adaptive-candidates"],
      ["regauge", "control-plane", "campaigns", "campaign-a"],
      ["transformer", "control-plane", "campaigns", "campaign-a"],
    ];
    for (const segments of cases) {
      const response = await GET(
        new NextRequest(`https://console.example/api/${segments.join("/")}`, {
          headers: { Cookie: cookie },
        }),
        { params: Promise.resolve({ path: segments }) },
      );
      expect(response.status).toBe(200);
    }
    expect(upstream).toHaveBeenCalledTimes(cases.length);
  });

  it("forwards the Fettler pilot canonical path with OIDC company identity", async () => {
    process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-secret";
    process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const oidcAccessToken = "oidc-access-token-for-fettler-owner";
    const oidcSession = await createOidcWebSession({
      accessToken: oidcAccessToken,
      sessionSecret: "web-secret",
      now: new Date(),
    });
    const upstream = vi.fn(async (url: URL) => {
      expect(url.toString()).toBe("http://api.internal:3001/fettler/pilot");
      return Response.json({ jobId: "job-a", status: "pending", replayed: false }, { status: 202 });
    });
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/fettler/pilot", {
        method: "POST",
        headers: {
          Cookie: `mendpoint_web_session=${oidcSession}`,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": "fettler-pilot-browser-1",
        },
        body: JSON.stringify({ providerSlug: "stripe", consumerId: "consumer-a" }),
      }),
      { params: Promise.resolve({ path: ["fettler", "pilot"] }) },
    );

    expect(response.status).toBe(202);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("keeps the Fettler pilot canonical path behind company identity for preview sessions", async () => {
    const cookie = await sessionCookie();
    process.env.MENDPOINT_API_KEY = "api-secret";
    process.env.MENDPOINT_API_URL = "http://api.internal:3001";
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const response = await POST(
      new NextRequest("https://console.example/api/fettler/pilot", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
          "Idempotency-Key": "fettler-pilot-preview-1",
        },
        body: JSON.stringify({ providerSlug: "stripe", consumerId: "consumer-a" }),
      }),
      { params: Promise.resolve({ path: ["fettler", "pilot"] }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "company_identity_required" });
    expect(upstream).not.toHaveBeenCalled();
  });
});
