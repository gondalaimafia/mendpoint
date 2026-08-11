import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  SAML_FLOW_COOKIE,
  SAML_FLOW_MAX_AGE_SECONDS,
  createSamlAuthnRequest,
  safeReturnTo,
  samlBridgeConfig,
  samlSpConfig,
} from "../../../../lib/saml-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim();
  if (!secret) return Response.json({ error: "web_access_not_configured" }, { status: 503 });
  try {
    const config = samlSpConfig();
    if (!config) return Response.json({ error: "saml_not_configured" }, { status: 503 });
    // The bridge must be configured for a SAML login to yield a usable session.
    samlBridgeConfig();
    const { redirectUrl, cookie } = await createSamlAuthnRequest({
      config,
      secret,
      returnTo: safeReturnTo(request.nextUrl.searchParams.get("next")),
      host: request.nextUrl.host,
    });
    const response = NextResponse.redirect(redirectUrl);
    const production = process.env.NODE_ENV === "production";
    // The IdP delivers the assertion via a cross-site top-level POST to the ACS.
    // A SameSite=lax cookie is not sent on a cross-site POST, so the correlation
    // cookie must be SameSite=none; Secure in production.
    response.cookies.set(SAML_FLOW_COOKIE, cookie, {
      httpOnly: true,
      secure: production,
      sameSite: production ? "none" : "lax",
      path: "/api/saml/acs",
      maxAge: SAML_FLOW_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "saml_start_failed",
    }, { status: 503 });
  }
}
