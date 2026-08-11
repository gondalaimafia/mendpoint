import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as oidcStart } from "./start/route.js";
import { GET as oidcCallback } from "./callback/route.js";
import { GET as sessionStatus } from "../session/route.js";
import { POST as proxyPost } from "../[...path]/route.js";
import { safeLocalReturn } from "../../../lib/safe-return.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  MENDPOINT_WEB_ACCESS_TOKEN: process.env.MENDPOINT_WEB_ACCESS_TOKEN,
  MENDPOINT_API_KEY: process.env.MENDPOINT_API_KEY,
  MENDPOINT_API_URL: process.env.MENDPOINT_API_URL,
  MENDPOINT_WEB_ALLOWED_ORIGINS: process.env.MENDPOINT_WEB_ALLOWED_ORIGINS,
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  OIDC_AUDIENCE: process.env.OIDC_AUDIENCE,
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET,
  OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configureOidc(): void {
  process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-session-secret";
  process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
  process.env.MENDPOINT_API_URL = "http://api.internal:3001";
  delete process.env.MENDPOINT_API_KEY;
  process.env.OIDC_ISSUER = "https://identity.example";
  process.env.OIDC_AUDIENCE = "mendpoint-api";
  process.env.OIDC_CLIENT_ID = "mendpoint-web";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  process.env.OIDC_REDIRECT_URI = "https://console.example/api/oidc/callback";
}

function cookieFrom(response: Response, name: string): string {
  const value = response.headers.get("set-cookie")?.match(
    new RegExp(`(?:^|, )${name}=([^;]+)`),
  )?.[1];
  if (!value) throw new Error(`${name}_cookie_missing`);
  return `${name}=${value}`;
}

describe("browser OIDC authorization code flow", () => {
  it.each([
    "/\\evil.example/path",
    "//evil.example/path",
    "/\u0000evil",
    "https://evil.example/path",
  ])("rejects an off origin return path", (value) => {
    expect(safeLocalReturn(value)).toBe("/console");
  });

  it("preserves a local GitHub setup return", () => {
    expect(
      safeLocalReturn(
        "/github/setup?installation_id=123&setup_action=install&state=opaque",
      ),
    ).toBe(
      "/github/setup?installation_id=123&setup_action=install&state=opaque",
    );
  });
  it("uses PKCE, keeps the access token server side, and delegates the human bearer token", async () => {
    configureOidc();
    const accessToken = "human-access-token-with-safe-length";
    const identityFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          authorization_endpoint: "https://identity.example/authorize",
          token_endpoint: "https://identity.example/oauth/token",
        });
      }
      expect(url.pathname).toBe("/oauth/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(body.get("client_secret")).toBe("client-secret");
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 900,
      });
    });
    vi.stubGlobal("fetch", identityFetch);

    const started = await oidcStart(new NextRequest(
      "https://console.example/api/oidc/start?next=%2Fconsumer%2Fprs%2Fpr-1",
    ));
    expect(started.status).toBe(307);
    const authorization = new URL(started.headers.get("location")!);
    expect(authorization.pathname).toBe("/authorize");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("audience")).toBe("mendpoint-api");
    const state = authorization.searchParams.get("state")!;
    const flowCookie = cookieFrom(started, "mendpoint_oidc_flow");
    expect(started.headers.get("set-cookie")).toContain("HttpOnly");
    expect(started.headers.get("set-cookie")).toContain("SameSite=lax");

    const completed = await oidcCallback(new NextRequest(
      `https://0.0.0.0:3000/api/oidc/callback?code=authorization-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: flowCookie } },
    ));
    expect(completed.status).toBe(307);
    expect(completed.headers.get("location")).toBe("https://console.example/consumer/prs/pr-1");
    const humanCookie = cookieFrom(completed, "mendpoint_web_session");
    expect(humanCookie).not.toContain(accessToken);

    const status = await sessionStatus(new NextRequest(
      "https://console.example/api/session",
      { headers: { Cookie: humanCookie } },
    ));
    await expect(status.json()).resolves.toMatchObject({
      authenticated: true,
      subject: { kind: "human_oidc" },
    });

    let forwardedAuthorization = "";
    vi.stubGlobal("fetch", vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      forwardedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ id: "review-1", reviewer: { kind: "human" } }, { status: 201 });
    }));
    const decision = await proxyPost(new NextRequest(
      "https://console.example/api/prs/pr-1/reviews",
      {
        method: "POST",
        headers: {
          Cookie: humanCookie,
          Origin: "https://console.example",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ decision: "approve", rationale: "Evidence is complete" }),
      },
    ), { params: Promise.resolve({ path: ["prs", "pr-1", "reviews"] }) });
    expect(decision.status).toBe(201);
    expect(forwardedAuthorization).toBe(`Bearer ${accessToken}`);
    expect(identityFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a callback when state does not match the encrypted flow", async () => {
    configureOidc();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      authorization_endpoint: "https://identity.example/authorize",
      token_endpoint: "https://identity.example/oauth/token",
    })));
    const started = await oidcStart(new NextRequest("https://console.example/api/oidc/start"));
    const response = await oidcCallback(new NextRequest(
      "https://console.example/api/oidc/callback?code=authorization-code&state=wrong-state",
      { headers: { Cookie: cookieFrom(started, "mendpoint_oidc_flow") } },
    ));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "oidc_flow_invalid" });
  });
});
