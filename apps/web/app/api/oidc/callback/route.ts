import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  createOidcWebSession,
  OIDC_SESSION_MAX_AGE_SECONDS,
  WEB_SESSION_COOKIE,
} from "../../../../lib/proxy-auth";
import {
  OIDC_FLOW_COOKIE,
  discoverOidc,
  oidcClientConfig,
  readOidcFlow,
} from "../../../../lib/oidc-auth";

export const dynamic = "force-dynamic";

function clearFlow(response: NextResponse): void {
  response.cookies.set(OIDC_FLOW_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/oidc/callback",
    maxAge: 0,
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const state = request.nextUrl.searchParams.get("state") ?? "";
  const flowCookie = request.cookies.get(OIDC_FLOW_COOKIE)?.value ?? "";
  if (!secret || !code || !state || !flowCookie) {
    return Response.json({ error: "oidc_callback_invalid" }, { status: 400 });
  }
  const flow = await readOidcFlow({ cookie: flowCookie, secret, state });
  if (!flow) return Response.json({ error: "oidc_flow_invalid" }, { status: 400 });
  try {
    const config = oidcClientConfig();
    const discovery = await discoverOidc(config.issuer);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
    if (clientSecret) body.set("client_secret", clientSecret);
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const token = await tokenResponse.json().catch(() => null) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    } | null;
    if (
      !tokenResponse.ok ||
      !token?.access_token ||
      token.token_type?.toLowerCase() !== "bearer"
    ) throw new Error("oidc_token_exchange_failed");
    const maxAge = Math.max(1, Math.min(
      Math.floor(token.expires_in ?? OIDC_SESSION_MAX_AGE_SECONDS),
      OIDC_SESSION_MAX_AGE_SECONDS,
    ));
    const response = NextResponse.redirect(new URL(flow.returnTo, request.url));
    clearFlow(response);
    response.cookies.set(WEB_SESSION_COOKIE, await createOidcWebSession({
      accessToken: token.access_token,
      sessionSecret: secret,
      expiresInSeconds: maxAge,
    }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge,
    });
    return response;
  } catch (error) {
    const response = NextResponse.json({
      error: error instanceof Error ? error.message : "oidc_callback_failed",
    }, { status: 502 });
    clearFlow(response);
    return response;
  }
}
