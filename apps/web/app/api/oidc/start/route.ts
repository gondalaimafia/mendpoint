import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  OIDC_FLOW_COOKIE,
  OIDC_FLOW_MAX_AGE_SECONDS,
  createOidcFlow,
  discoverOidc,
  oidcClientConfig,
  oidcRedirectUri,
  safeReturnTo,
} from "../../../../lib/oidc-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!secret) return Response.json({ error: "web_access_not_configured" }, { status: 503 });
  try {
    const config = oidcClientConfig();
    const redirectUri = oidcRedirectUri(request);
    const discovery = await discoverOidc(config.issuer);
    const flow = await createOidcFlow({
      secret,
      redirectUri,
      returnTo: safeReturnTo(request.nextUrl.searchParams.get("next")),
    });
    const authorization = new URL(discovery.authorization_endpoint);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("redirect_uri", redirectUri);
    authorization.searchParams.set("scope", "openid profile email");
    authorization.searchParams.set("audience", config.audience);
    authorization.searchParams.set("state", flow.state);
    authorization.searchParams.set("code_challenge", flow.challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    const response = NextResponse.redirect(authorization);
    response.cookies.set(OIDC_FLOW_COOKIE, flow.cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/oidc/callback",
      maxAge: OIDC_FLOW_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "oidc_start_failed",
    }, { status: 503 });
  }
}
