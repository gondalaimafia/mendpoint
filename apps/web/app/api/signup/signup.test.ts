import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as signupPost } from "./route.js";
import { GET as sessionStatus } from "../session/route.js";
import { middleware } from "../../../middleware.js";
import { authenticatedWebCredential } from "../../../lib/proxy-auth.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  MENDPOINT_WEB_ACCESS_TOKEN: process.env.MENDPOINT_WEB_ACCESS_TOKEN,
  MENDPOINT_WEB_ALLOWED_ORIGINS: process.env.MENDPOINT_WEB_ALLOWED_ORIGINS,
  MENDPOINT_API_URL: process.env.MENDPOINT_API_URL,
  MENDPOINT_SELF_SERVE_SIGNUP: process.env.MENDPOINT_SELF_SERVE_SIGNUP,
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function configure(): void {
  process.env.MENDPOINT_WEB_ACCESS_TOKEN = "web-session-secret";
  process.env.MENDPOINT_WEB_ALLOWED_ORIGINS = "https://console.example";
  process.env.MENDPOINT_API_URL = "http://api.internal:3001";
}

function cookieFrom(response: Response, name: string): string {
  const value = response.headers.get("set-cookie")?.match(
    new RegExp(`(?:^|, )${name}=([^;]+)`),
  )?.[1];
  if (!value) throw new Error(`${name}_cookie_missing`);
  return `${name}=${value}`;
}

function signupRequest(): NextRequest {
  return new NextRequest("https://console.example/api/signup", {
    method: "POST",
    headers: {
      Origin: "https://console.example",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: "founder@acme.test", workspaceName: "Acme" }),
  });
}

describe("self-serve signup web route", () => {
  it("is inert (404) when the flag is unset", async () => {
    configure();
    delete process.env.MENDPOINT_SELF_SERVE_SIGNUP;
    const response = await signupPost(signupRequest());
    expect(response.status).toBe(404);
  });

  it("provisions via the API and seals the key into a per-user session cookie", async () => {
    configure();
    process.env.MENDPOINT_SELF_SERVE_SIGNUP = "1";
    let upstreamUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      upstreamUrl = String(input);
      return Response.json({
        tenant: { id: "tenant_ss_abc", slug: "ss-abc", name: "Acme", plan: "free" },
        owner: { issuer: "https://self-serve.mendpoint.ai", subject: "founder@acme.test", email: "founder@acme.test", displayName: "Acme", role: "owner" },
        apiKey: { token: "me_selfservetoken0123456789abcdef", prefix: "me_selfse" },
      }, { status: 201 });
    }));

    const response = await signupPost(signupRequest());
    expect(response.status).toBe(200);
    expect(upstreamUrl).toBe("http://api.internal:3001/auth/signup");

    const bodyText = JSON.stringify(await response.clone().json());
    // The plaintext key is never echoed back to the browser.
    expect(bodyText).not.toContain("me_selfservetoken");
    expect(bodyText).toContain("tenant_ss_abc");

    const cookie = cookieFrom(response, "mendpoint_web_session");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");

    // The session round-trips as a real per-user self-serve identity carrying the tenant key.
    const credential = await authenticatedWebCredential(
      new NextRequest("https://console.example/api/session", { headers: { Cookie: cookie } }),
    );
    expect(credential?.subject.kind).toBe("self_serve");
    expect(credential?.upstreamAccessToken).toBe("me_selfservetoken0123456789abcdef");
    expect(credential?.subject).toMatchObject({ tenantId: "tenant_ss_abc", subject: "founder@acme.test" });

    const status = await sessionStatus(
      new NextRequest("https://console.example/api/session", { headers: { Cookie: cookie } }),
    );
    await expect(status.json()).resolves.toMatchObject({ authenticated: true, subject: { kind: "self_serve" } });
  });

  it("forwards a 409 from the API when the account already exists", async () => {
    configure();
    process.env.MENDPOINT_SELF_SERVE_SIGNUP = "1";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "self_serve_account_exists" }, { status: 409 })));
    const response = await signupPost(signupRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "self_serve_account_exists" });
  });
});

describe("middleware self-serve gating", () => {
  function protectedRequest(path: string): NextRequest {
    return new NextRequest(`https://console.example${path}`);
  }

  it("leaves the preview gate byte-for-byte unchanged when the flag is unset", async () => {
    configure();
    delete process.env.MENDPOINT_SELF_SERVE_SIGNUP;
    // Signup surfaces fall through to the normal shared-token gate.
    const page = await middleware(protectedRequest("/signup"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toContain("/access");
    const api = await middleware(protectedRequest("/api/signup"));
    expect(api.status).toBe(401);
    // Existing public paths are untouched.
    expect((await middleware(protectedRequest("/access"))).status).toBe(200);
  });

  it("opens the signup surfaces only when the flag is set", async () => {
    configure();
    process.env.MENDPOINT_SELF_SERVE_SIGNUP = "1";
    expect((await middleware(protectedRequest("/signup"))).status).toBe(200);
    expect((await middleware(protectedRequest("/api/signup"))).status).toBe(200);
    // An unrelated protected path still requires the shared token.
    const console = await middleware(protectedRequest("/console"));
    expect(console.status).toBe(307);
    expect(console.headers.get("location")).toContain("/access");
  });
});
