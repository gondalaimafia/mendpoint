import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { cookies } from "next/headers";
import { ApiRequestError, apiGet, apiPost } from "./api";
import {
  createOidcWebSession,
  createSelfServeWebSession,
  createWebSessionV3,
  WEB_SESSION_COOKIE,
} from "./proxy-auth";
import { middleware } from "../middleware";
import ConsumerPage from "../app/consumer/page";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const secret = "test-web-session-secret";
const deploymentKey = "me_deployment_tenant_A_credential";
const customerKey = "me_customer_tenant_B_credential";

function cookieStore(value?: string) {
  return { get: (name: string) => name === WEB_SESSION_COOKIE && value
    ? { name, value }
    : undefined } as Awaited<ReturnType<typeof cookies>>;
}

async function customerCookie(key = customerKey, now?: Date) {
  return createSelfServeWebSession({
    apiKey: key, tenantId: "tenant-b", subject: "customer-b",
    sessionSecret: secret, now,
  });
}

beforeEach(() => {
  vi.stubEnv("MENDPOINT_WEB_ACCESS_TOKEN", secret);
  vi.stubEnv("MENDPOINT_API_KEY", deploymentKey);
  vi.mocked(cookies).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("server-rendered API session authority", () => {
  it("renders a signed-in customer's repositories without the deployment tenant's data", async () => {
    const value = await customerCookie();
    vi.mocked(cookies).mockResolvedValue(cookieStore(value));
    const request = new NextRequest("https://console.example/consumer", {
      headers: { Cookie: `${WEB_SESSION_COOKIE}=${value}` },
    });
    expect((await middleware(request)).headers.get("x-middleware-next")).toBe("1");
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization")!;
      sent.push(auth);
      return Response.json(new URL(url).pathname === "/consumers" ? [{
        id: "repo-1", name: auth === `Bearer ${customerKey}` ? "Customer B repository" : "Private A repository",
        githubOwner: "owner", githubRepo: "repo",
      }] : []);
    }));
    const html = renderToStaticMarkup(await ConsumerPage());
    expect(html).toContain("Customer B repository");
    expect(html).not.toContain("Private A repository");
    expect(sent).toEqual(Array(3).fill(`Bearer ${customerKey}`));
  });

  it("preserves the identity provider token and its upstream denial", async () => {
    const token = "oidc_restricted_viewer_token_for_test";
    vi.mocked(cookies).mockResolvedValue(cookieStore(await createOidcWebSession({
      accessToken: token, sessionSecret: secret,
    })));
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ error: "forbidden" }, { status: 403 });
    });
    vi.stubGlobal("fetch", upstream);
    await expect(apiGet("/tenants")).rejects.toMatchObject({ status: 403 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "tampered", "expired", "unconfigured"])("rejects %s sessions before upstream access", async (kind) => {
    let value: string | undefined;
    if (kind === "tampered") value = `${await customerCookie()}invalid`;
    if (kind === "expired") value = await customerCookie(customerKey, new Date(Date.now() - 9 * 60 * 60 * 1000));
    if (kind === "unconfigured") {
      value = await customerCookie();
      vi.stubEnv("MENDPOINT_WEB_ACCESS_TOKEN", "");
    }
    vi.mocked(cookies).mockResolvedValue(cookieStore(value));
    const upstream = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", upstream);
    // The refusal is an ApiRequestError (status 401), not a plain Error, so
    // pages that branch on error.status re-authenticate instead of showing a
    // generic failure.
    const error = await apiGet("/consumers").catch((thrown) => thrown);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401 });
    expect(String((error as Error).message)).toContain("web_session_required");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires a request context instead of falling back to deployment authority", async () => {
    vi.mocked(cookies).mockRejectedValue(new Error("request context unavailable"));
    const upstream = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", upstream);
    await expect(apiGet("/consumers")).rejects.toThrow("request context unavailable");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses the deployment credential only for a verified preview session", async () => {
    vi.mocked(cookies).mockResolvedValue(cookieStore(await createWebSessionV3({ accessToken: secret })));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${deploymentKey}`);
      return Response.json({ ok: true });
    }));
    await expect(apiGet("/status")).resolves.toEqual({ ok: true });
  });

  it("rejects a preview session without its deployment credential", async () => {
    vi.stubEnv("MENDPOINT_API_KEY", "");
    vi.mocked(cookies).mockResolvedValue(cookieStore(await createWebSessionV3({ accessToken: secret })));
    const upstream = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", upstream);
    const error = await apiGet("/status").catch((thrown) => thrown);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 503 });
    expect(String((error as Error).message)).toContain("proxy_api_key_not_configured");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps concurrent request credentials separate for reads and writes", async () => {
    const secondKey = "me_customer_tenant_C_credential";
    vi.mocked(cookies)
      .mockResolvedValueOnce(cookieStore(await customerCookie()))
      .mockResolvedValueOnce(cookieStore(await customerCookie(secondKey)));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(init.cache).toBe("no-store");
      return Response.json({ auth: new Headers(init.headers).get("authorization") });
    }));
    await expect(Promise.all([apiGet("/consumers"), apiPost("/consumers", { name: "C" })]))
      .resolves.toEqual([{ auth: `Bearer ${customerKey}` }, { auth: `Bearer ${secondKey}` }]);
  });
});
